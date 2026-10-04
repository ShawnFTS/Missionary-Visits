import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zonedToUtc, fmtDay, fmtTime, isDate, todayInZone, dowOf, sundayOf } from "./time.js";
import { slotProblem, buildWeek, wardForWeek, nextWardWeek } from "./slots.js";
import { cleanFamily, normalizePhone, maskPhone, displayFamily, cleanAddress, formatPhone } from "./people.js";
import { buildIcs, buildMissionaryIcs, googleCalendarUrl } from "./ics.js";
import { smsConfigured } from "./sms.js";
import * as analytics from "./analytics.js";
import * as settings from "./settings.js";
import * as waitlist from "./waitlist.js";
import { notifyMissionaries } from "./notify.js";
import { makeTwilioSender } from "./sms.js";
import { allTimes, slotTimesOn } from "./config.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const sha = (s) => crypto.createHash("sha256").update(s).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

export function createApp({ db, cfg, now = () => Date.now(), sendSms }) {
  settings.loadStored(db, cfg); // saved admin settings win over env defaults
  // Injected in tests; otherwise the real Twilio sender when configured, null (inert) when not.
  sendSms = sendSms !== undefined ? sendSms : smsConfigured(cfg) ? makeTwilioSender(cfg) : null;
  const tell = (kind, booking, by) => {
    if (kind === "cancel" && booking.start_utc <= now()) return; // nobody needs to hear about a past visit
    (async () => {
      // The wait-list hears first (and the freed time is held for them); then the missionaries.
      if (kind === "cancel") await waitlist.onCancel({ db, cfg, sendSms, now }, booking);
      await notifyMissionaries({ db, cfg, sendSms, now }, kind, booking, by);
    })().catch((e) => console.error("[notify]", e));
  };
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10kb" }));
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    // A booking link is a credential; keep it out of Referer headers.
    res.set("Referrer-Policy", "no-referrer");
    next();
  });

  const activeBookings = () => db.prepare(`SELECT * FROM bookings WHERE cancelled_at IS NULL`).all();
  const blockedSet = () => new Set(db.prepare(`SELECT slot_date, slot_time FROM blocks`).all().map((r) => `${r.slot_date} ${r.slot_time}`));
  const byToken = (t) => db.prepare(`SELECT * FROM bookings WHERE token = ?`).get(String(t));

  // ---- public ---------------------------------------------------------
  app.get("/healthz", (req, res) => { db.prepare("SELECT 1").get(); res.send("ok"); }); // Railway checks this before switching traffic
  app.get("/api/config", (req, res) => {
    res.json({
      tz: cfg.tz, smsAvailable: smsConfigured(cfg), minutes: cfg.minutes,
      missionaryPhone: cfg.missionaryPhone, helpName: cfg.helpName, helpPhone: cfg.helpPhone,
    });
  });

  // Beacon fired by the sign-up page. It needs JavaScript to run, which quietly drops
  // link-preview fetchers and most scanners. ?notrack on the page's address makes
  // this browser invisible (for you, so your own visits don't count).
  app.post("/api/hit", (req, res) => {
    const off = "mv=off; Max-Age=315360000; Path=/; SameSite=Lax";
    let id = analytics.readCookie(req, "mv");
    if (req.body?.off === true) { res.set("Set-Cookie", off); return res.status(204).end(); }
    if (id === "off" || analytics.isBot(req.get("user-agent"))) return res.status(204).end();
    if (!/^[\w-]{10,32}$/.test(id)) id = analytics.newVisitorId();
    res.set("Set-Cookie", `mv=${id}; Max-Age=31536000; Path=/; SameSite=Lax; HttpOnly${req.secure ? "; Secure" : ""}`);
    analytics.record(db, {
      kind: "view", visitor: id, ua: req.get("user-agent"), now: now(),
      src: analytics.cleanSrc(req.body?.src), ref: analytics.refHost(req.body?.ref, req.get("host")),
    });
    res.status(204).end();
  });

  app.get("/api/week", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(buildWeek(cfg, now(), req.query.start, activeBookings(), blockedSet(), waitlist.activeHolds(db, now())));
  });

  // Slow down somebody hammering the booking endpoint; in-memory is plenty here.
  const hits = new Map();
  const limited = (ip) => {
    const t = now();
    const recent = (hits.get(ip) || []).filter((x) => t - x < 3600_000);
    recent.push(t);
    hits.set(ip, recent);
    return recent.length > 20;
  };

  // Shared by the public form and the admin "add a visit" form. Returns { token } or { status, error }.
  function createBooking(body, { allowReminders, bypassHold = false }) {
    const { date, time } = body || {};
    const problem = slotProblem(cfg, date, time, now());
    if (problem) return { status: 400, error: problem };
    const family = cleanFamily(body.family);
    if (!family) return { status: 400, error: "Please enter your family name." };
    const phone = normalizePhone(body.phone);
    if (!phone) return { status: 400, error: "Please enter a 10-digit mobile number." };
    if (blockedSet().has(`${date} ${time}`)) return { status: 409, error: "That time is no longer available." };
    const heldUntil = bypassHold ? null : waitlist.holdUntil(db, date, time, now());
    if (heldUntil) return { status: 409, error: `That time just opened up and is being offered to the wait-list first. It opens to everyone in about ${Math.max(1, Math.ceil((heldUntil - now()) / 60_000))} minutes.` };

    const wantsText = allowReminders && smsConfigured(cfg);
    const token = crypto.randomBytes(16).toString("base64url");
    try {
      db.prepare(
        `INSERT INTO bookings (token, slot_date, slot_time, start_utc, family, phone, address, remind_day, remind_hour, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(token, date, time, zonedToUtc(date, time, cfg.tz), family, phone, cleanAddress(body.address),
        wantsText && body.remindDay === true ? 1 : 0,
        wantsText && body.remindHour === true ? 1 : 0, now());
    } catch (e) {
      if (String(e.code).startsWith("SQLITE_CONSTRAINT")) {
        return { status: 409, error: "Someone just signed up for that time. Please pick another." };
      }
      throw e;
    }
    waitlist.markBooked(db, phone, sundayOf(date), now(), token); // got a visit by any route: stop waiting
    return { token };
  }

  app.post("/api/book", (req, res) => {
    if (limited(req.ip)) return res.status(429).json({ error: "Too many attempts. Please try again in a little while." });
    const r = createBooking(req.body, { allowReminders: true });
    if (r.error) return res.status(r.status).json({ error: r.error });
    tell("signup", byToken(r.token), "family");
    const id = analytics.readCookie(req, "mv");
    if (/^[\w-]{10,32}$/.test(id) && id !== "off") analytics.record(db, { kind: "signup", visitor: id, ua: req.get("user-agent"), now: now() });
    res.status(201).json({ token: r.token });
  });

  const present = (b) => ({
    token: b.token,
    family: displayFamily(b.family),
    phone: maskPhone(b.phone),
    dayLabel: fmtDay(b.slot_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
    timeLabel: fmtTime(b.slot_time),
    remindDay: !!b.remind_day,
    remindHour: !!b.remind_hour,
    cancelled: b.cancelled_at != null,
    past: b.start_utc <= now(),
    googleUrl: googleCalendarUrl(b, cfg),
  });

  app.get("/api/booking/:token", (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = byToken(req.params.token);
    if (!b) return res.status(404).json({ error: "We couldn't find that sign-up." });
    res.json(present(b));
  });

  app.get("/api/booking/:token/ics", (req, res) => {
    const b = byToken(req.params.token);
    if (!b || b.cancelled_at != null) return res.status(404).send("Not found");
    res.set({
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="missionary-visit.ics"',
      "Cache-Control": "no-store",
    });
    res.send(buildIcs(b, cfg, now()));
  });

  app.post("/api/booking/:token/cancel", (req, res) => {
    const b = byToken(req.params.token);
    if (!b) return res.status(404).json({ error: "We couldn't find that sign-up." });
    const done = db.prepare(`UPDATE bookings SET cancelled_at = ?, cancelled_by = 'family' WHERE id = ? AND cancelled_at IS NULL`).run(now(), b.id);
    if (done.changes === 1) tell("cancel", b, "family"); // once: pressing Cancel twice must not text them twice
    res.json({ ok: true });
  });

  // ---- wait-list -------------------------------------------------------
  app.post("/api/waitlist", (req, res) => {
    if (limited(req.ip)) return res.status(429).json({ error: "Too many attempts. Please try again in a little while." });
    if (!sendSms) return res.status(503).json({ error: "The wait-list isn't available yet." });
    const b = req.body || {};
    if (b.consent !== true) return res.status(400).json({ error: "Please tick the box to agree to be texted." });
    const week = isDate(b.weekStart) ? buildWeek(cfg, now(), b.weekStart, activeBookings(), blockedSet(), waitlist.activeHolds(db, now())) : null;
    if (!week || week.weekStart !== b.weekStart) return res.status(400).json({ error: "Pick a week from the calendar." });
    if (!week.full) return res.status(400).json({ error: "There are still open times this week, so you can book one directly." });
    const family = cleanFamily(b.family);
    if (!family) return res.status(400).json({ error: "Please enter your family name." });
    const phone = normalizePhone(b.phone);
    if (!phone) return res.status(400).json({ error: "Please enter a 10-digit mobile number." });
    const r = waitlist.join(db, { weekStart: week.weekStart, family, phone, address: cleanAddress(b.address) }, now());
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.status(201).json({ token: r.token });
  });

  const waitView = (e) => {
    const week = buildWeek(cfg, now(), e.week_start, activeBookings(), blockedSet(), waitlist.activeHolds(db, now()));
    const times = week.days.flatMap((d) => d.slots.filter((s) => s.status === "open" || s.status === "held").map((s) => ({
      date: d.date, time: s.time, status: s.status,
      dayLabel: fmtDay(d.date, { weekday: "long", month: "short", day: "numeric" }), timeLabel: s.label,
      minutesLeft: s.status === "held" ? Math.max(1, Math.ceil((waitlist.holdUntil(db, d.date, s.time, now()) - now()) / 60_000)) : null,
    })));
    return {
      family: displayFamily(e.family), status: e.status, ward: week.ward, range: week.range, weekStart: e.week_start,
      position: e.status === "waiting" ? waitlist.position(db, e) : null, times, bookingToken: e.booking_token,
    };
  };
  app.get("/api/waitlist/:token", (req, res) => {
    res.set("Cache-Control", "no-store");
    const e = waitlist.byToken(db, req.params.token);
    if (!e) return res.status(404).json({ error: "We couldn't find that wait-list entry." });
    res.json(waitView(e));
  });
  app.post("/api/waitlist/:token/book", (req, res) => {
    const e = waitlist.byToken(db, req.params.token);
    if (!e) return res.status(404).json({ error: "We couldn't find that wait-list entry." });
    if (e.status !== "waiting") return res.status(409).json({ error: "You're no longer on the wait-list." });
    const { date, time } = req.body || {};
    if (!isDate(date) || sundayOf(date) !== e.week_start) return res.status(400).json({ error: "That time isn't in the week you're waiting for." });
    const r = createBooking({ date, time, family: e.family, phone: e.phone, address: e.address }, { allowReminders: false, bypassHold: true });
    if (r.error) return res.status(r.status).json({ error: r.status === 409 ? "Sorry, someone else just took that time." : r.error });
    tell("signup", byToken(r.token), "family");
    res.status(201).json({ token: r.token });
  });
  app.post("/api/waitlist/:token/leave", (req, res) => {
    db.prepare(`UPDATE waitlist SET status = 'left', done_at = ? WHERE token = ? AND status = 'waiting'`).run(now(), String(req.params.token));
    res.json({ ok: true });
  });
  app.get("/w/:token", (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    res.sendFile(path.join(root, "public", "waitlist.html"));
  });

  // ---- missionaries ---------------------------------------------------
  // A private link, /m/<key>: the one place phone numbers are shown outside admin.
  // Off entirely until MISSIONARY_KEY is set. The key is the only credential.
  const upcoming = () => db.prepare(`SELECT * FROM bookings WHERE cancelled_at IS NULL AND start_utc > ? ORDER BY start_utc`).all(now() - 3 * 3600_000);
  const wardOf = (b) => wardForWeek(cfg, sundayOf(b.slot_date));
  function requireKey(req, res, next) {
    if (!cfg.missionaryKey || !same(String(req.params.key), cfg.missionaryKey)) return res.status(404).send("Not found");
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    next();
  }
  const calHeaders = (res, name) => res.set({ "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `inline; filename="${name}"` });

  app.get("/m/:key", requireKey, (req, res) => res.sendFile(path.join(root, "private", "missionaries.html")));

  app.get("/api/m/:key/visits", requireKey, (req, res) => {
    res.json({
      visits: upcoming().map((b) => ({
        id: b.id, family: displayFamily(b.family), phone: formatPhone(b.phone), address: b.address, ward: wardOf(b),
        dayLabel: fmtDay(b.slot_date, { weekday: "long", month: "short", day: "numeric" }), timeLabel: fmtTime(b.slot_time),
        week: sundayOf(b.slot_date),
      })),
    });
  });

  // ?ids=1,2,3 for a picked set; no ids = everything upcoming.
  app.get("/api/m/:key/visits.ics", requireKey, (req, res) => {
    const ids = req.query.ids ? new Set(String(req.query.ids).split(",").map(Number).filter(Number.isInteger)) : null;
    const list = upcoming().filter((b) => !ids || ids.has(b.id));
    calHeaders(res, "missionary-visits.ics").set("Content-Disposition", 'attachment; filename="missionary-visits.ics"');
    res.send(buildMissionaryIcs(list, cfg, wardOf, now()));
  });

  // Subscribe once (webcal://…/m/<key>/feed.ics); new and cancelled visits follow automatically.
  app.get("/m/:key/feed.ics", requireKey, (req, res) => {
    calHeaders(res, "feed.ics").send(buildMissionaryIcs(upcoming(), cfg, wardOf, now()));
  });

  // ---- admin ----------------------------------------------------------
  // Off entirely until ADMIN_PASSWORD is set; one shared password, because the
  // person running this is one ward mission leader, not a staff of people.
  function requireAdmin(req, res, next) {
    if (!cfg.adminPassword) return res.status(404).send("Not found");
    const m = /^Basic (.+)$/.exec(req.get("authorization") || "");
    const pass = m ? Buffer.from(m[1], "base64").toString().split(":").slice(1).join(":") : "";
    if (m && same(pass, cfg.adminPassword)) return next();
    res.set("WWW-Authenticate", 'Basic realm="Missionary visits admin"').status(401).send("Sign in required");
  }

  app.get("/admin", requireAdmin, (req, res) => res.sendFile(path.join(root, "private", "admin.html")));

  app.get("/api/admin/state", requireAdmin, (req, res) => {
    const t = now();
    const bookings = db.prepare(`SELECT * FROM bookings WHERE cancelled_at IS NULL AND start_utc > ? ORDER BY start_utc`).all(t - 6 * 3600_000)
      .map((b) => ({
        id: b.id, family: displayFamily(b.family), phone: formatPhone(b.phone), address: b.address,
        weekStart: sundayOf(b.slot_date), ward: wardOf(b),
        dayLabel: fmtDay(b.slot_date, { weekday: "short", month: "short", day: "numeric" }),
        timeLabel: fmtTime(b.slot_time), remindDay: !!b.remind_day, remindHour: !!b.remind_hour, smsError: b.sms_error,
      }));
    const blocks = db.prepare(`SELECT * FROM blocks ORDER BY slot_date, slot_time`).all()
      .filter((x) => x.slot_date >= todayInZone(t, cfg.tz))
      .map((x) => ({ date: x.slot_date, time: x.slot_time, label: `${fmtDay(x.slot_date)} at ${fmtTime(x.slot_time)}` }));
    const base = cfg.selfUrl || `${req.protocol}://${req.get("host")}`;
    // The missionaries' private page and live feed (/m/<MISSIONARY_KEY>); nothing to show until the key is set.
    const feedUrl = cfg.missionaryKey ? `${base}/m/${cfg.missionaryKey}/feed.ics` : null;
    res.json({
      pageUrl: cfg.missionaryKey ? `${base}/m/${cfg.missionaryKey}` : null,
      bookings, blocks, times: allTimes(cfg).map((v) => ({ value: v, label: fmtTime(v) })), smsAvailable: smsConfigured(cfg),
      feedUrl, webcalUrl: feedUrl && feedUrl.replace(/^https?:/, "webcal:"),
    });
  });

  // Admin-entered visits (a family who phoned instead of using the page). No text
  // reminders: nobody ticked the consent box.
  app.post("/api/admin/book", requireAdmin, (req, res) => {
    const r = createBooking(req.body, { allowReminders: false, bypassHold: true }); // an admin can book a held time
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.status(201).json({ ok: true });
  });

  const csvCell = (v) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // a family name must not become a spreadsheet formula
    return `"${s.replace(/"/g, '""')}"`;
  };
  app.get("/api/admin/export.csv", requireAdmin, (req, res) => {
    const rows = db.prepare(`SELECT * FROM bookings ORDER BY slot_date, slot_time`).all();
    const head = ["Date", "Time", "Ward", "Family", "Phone", "Address", "Day reminder", "Hour reminder", "Status", "Signed up"];
    const lines = [head, ...rows.map((b) => [
      b.slot_date, fmtTime(b.slot_time), wardOf(b) || "", displayFamily(b.family), formatPhone(b.phone), b.address || "",
      b.remind_day ? "yes" : "", b.remind_hour ? "yes" : "",
      b.cancelled_at ? `cancelled (${b.cancelled_by})` : "booked", new Date(b.created_at).toISOString(),
    ])].map((r) => r.map(csvCell).join(","));
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="missionary-visits.csv"' });
    res.send(lines.join("\r\n") + "\r\n");
  });

  app.get("/api/admin/stats", requireAdmin, (req, res) => res.json(analytics.stats(db, cfg, now())));

  // ---- settings: schedule, rotation, contact info ----------------------
  app.get("/api/admin/settings", requireAdmin, (req, res) => res.json(settings.editableView(cfg)));
  app.post("/api/admin/settings", requireAdmin, (req, res) => {
    const r = settings.save(db, cfg, req.body || {}, now());
    if (r.errors) return res.status(400).json({ errors: r.errors });
    res.json({ ok: true, warnings: r.warnings, settings: settings.editableView(cfg) });
  });

  // ---- who is told about cancellations ---------------------------------
  const contactRow = (c) => ({ id: c.id, name: c.name, email: c.email || "", phone: c.phone ? formatPhone(c.phone) : "", notifyCancel: !!c.notify_cancel, notifySignup: !!c.notify_signup });
  app.get("/api/admin/contacts", requireAdmin, (req, res) => {
    const log = db.prepare(`SELECT * FROM notification_log ORDER BY id DESC LIMIT 25`).all().map((l) => ({
      when: new Date(l.ts).toLocaleString("en-US", { timeZone: cfg.tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      kind: l.kind, who: l.contact_name, ok: !!l.ok, error: l.error,
    }));
    const main = normalizePhone(cfg.missionaryPhone);
    res.json({
      main: { phone: main ? formatPhone(main) : "", raw: cfg.missionaryPhone, valid: !!main, notifyCancel: !!cfg.notifyCancel, notifySignup: !!cfg.notifySignup },
      contacts: db.prepare(`SELECT * FROM missionary_contacts WHERE active = 1 ORDER BY name`).all().map(contactRow), textReady: !!sendSms, log,
    });
  });
  // Notifications are texts, so a mobile number is required. Email is kept as an optional
  // contact detail for the admin's records only; nothing here sends mail.
  app.post("/api/admin/contacts", requireAdmin, (req, res) => {
    const b = req.body || {};
    const name = String(b.name ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 60);
    const email = String(b.email ?? "").trim().toLowerCase();
    const phone = normalizePhone(b.phone);
    if (!name) return res.status(400).json({ error: "Enter a name." });
    if (!phone) return res.status(400).json({ error: "Enter a 10-digit mobile number. Notifications are sent as texts." });
    if (email && (email.length > 120 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email))) return res.status(400).json({ error: "That email address doesn't look right." });
    const dupe = db.prepare(`SELECT id FROM missionary_contacts WHERE active = 1 AND phone = ? AND id != ?`).get(phone, Number(b.id) || 0);
    if (dupe) return res.status(409).json({ error: "That mobile number is already on the list." });
    const vals = [name, email || null, phone, b.notifyCancel === false ? 0 : 1, b.notifySignup ? 1 : 0];
    if (b.id) {
      const done = db.prepare(`UPDATE missionary_contacts SET name=?, email=?, phone=?, sms=1, notify_cancel=?, notify_signup=? WHERE id = ? AND active = 1`).run(...vals, Number(b.id));
      if (!done.changes) return res.status(404).json({ error: "That person isn't on the list any more." });
    } else {
      db.prepare(`INSERT INTO missionary_contacts (name, email, phone, sms, notify_cancel, notify_signup, created_at) VALUES (?,?,?,1,?,?,?)`).run(...vals, now());
    }
    res.json({ ok: true });
  });
  app.post("/api/admin/contacts/:id/remove", requireAdmin, (req, res) => {
    db.prepare(`UPDATE missionary_contacts SET active = 0 WHERE id = ?`).run(Number(req.params.id));
    res.json({ ok: true });
  });
  // Test text to the missionaries' shared phone.
  app.post("/api/admin/notify-test", requireAdmin, async (req, res) => {
    const to = normalizePhone(cfg.missionaryPhone);
    if (!to) return res.json({ results: ["The missionaries' phone number in Settings isn't a valid 10-digit mobile number."] });
    if (!sendSms) return res.json({ results: ["text: not set up yet"] });
    try { await sendSms(to, "Test from Missionary Visits: you'll get a text like this when a visit is cancelled."); res.json({ results: ["text: sent"] }); }
    catch (e) { res.json({ results: [`text: failed — ${e.message}`] }); }
  });
  // A harmless test text so setup can be checked without cancelling a real visit.
  app.post("/api/admin/contacts/:id/test", requireAdmin, async (req, res) => {
    const c = db.prepare(`SELECT * FROM missionary_contacts WHERE id = ? AND active = 1`).get(Number(req.params.id));
    if (!c || !c.phone) return res.status(404).json({ error: "Not found." });
    if (!sendSms) return res.json({ results: ["text: not set up yet"] });
    try { await sendSms(c.phone, "Test from Missionary Visits: you'll get a text like this when a visit is cancelled."); res.json({ results: ["text: sent"] }); }
    catch (e) { res.json({ results: [`text: failed — ${e.message}`] }); }
  });

  app.get("/api/admin/waitlist", requireAdmin, (req, res) => {
    res.json({
      holdMinutes: cfg.waitlistHoldMinutes, textReady: !!sendSms,
      entries: db.prepare(`SELECT * FROM waitlist WHERE status = 'waiting' ORDER BY week_start, id`).all().map((e) => ({
        id: e.id, family: displayFamily(e.family), phone: formatPhone(e.phone), ward: wardForWeek(cfg, e.week_start),
        week: fmtDay(e.week_start, { month: "short", day: "numeric" }),
        joined: new Date(e.created_at).toLocaleString("en-US", { timeZone: cfg.tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      })),
    });
  });
  app.post("/api/admin/waitlist/:id/remove", requireAdmin, (req, res) => {
    db.prepare(`UPDATE waitlist SET status = 'removed', done_at = ? WHERE id = ? AND status = 'waiting'`).run(now(), Number(req.params.id));
    res.json({ ok: true });
  });

  app.post("/api/admin/cancel/:id", requireAdmin, (req, res) => {
    const b = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(Number(req.params.id));
    const done = db.prepare(`UPDATE bookings SET cancelled_at = ?, cancelled_by = 'admin' WHERE id = ? AND cancelled_at IS NULL`).run(now(), Number(req.params.id));
    if (b && done.changes === 1) tell("cancel", b, "admin");
    res.json({ ok: true });
  });

  app.post("/api/admin/block", requireAdmin, (req, res) => {
    const { date, time } = req.body || {};
    if (!isDate(date) || !slotTimesOn(cfg, dowOf(date)).includes(time)) return res.status(400).json({ error: "Pick a date and a time." });
    if (db.prepare(`SELECT 1 FROM bookings WHERE slot_date = ? AND slot_time = ? AND cancelled_at IS NULL`).get(date, time)) {
      return res.status(409).json({ error: "A family has already signed up for that time. Cancel their visit first." });
    }
    db.prepare(`INSERT OR IGNORE INTO blocks (slot_date, slot_time) VALUES (?, ?)`).run(date, time);
    res.json({ ok: true });
  });

  app.post("/api/admin/unblock", requireAdmin, (req, res) => {
    const { date, time } = req.body || {};
    db.prepare(`DELETE FROM blocks WHERE slot_date = ? AND slot_time = ?`).run(String(date), String(time));
    res.json({ ok: true });
  });

  // ---- pages ----------------------------------------------------------
  app.get("/b/:token", (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    res.sendFile(path.join(root, "public", "booking.html"));
  });
  // Permalinks: /SP, /FF, /OT, ... jump to that ward's next week with an open time.
  app.get(/^\/([A-Za-z]{2})$/, (req, res, next) => {
    const ward = cfg.wardCodes[req.params[0].toUpperCase()];
    if (!ward) return next();
    const start = nextWardWeek(cfg, now(), ward, activeBookings(), blockedSet());
    res.set("Cache-Control", "no-store").redirect(302, start ? `/?start=${start}` : "/");
  });
  app.use(express.static(path.join(root, "public"), { index: "index.html", extensions: ["html"] }));
  app.use((req, res) => res.status(404).send("Not found"));
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });
  return app;
}
