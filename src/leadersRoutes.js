// /leaders — the missionary coordination meeting. Mounted from server.js.
//
// The backend (the roster, attendance lists, board and settings) is behind the ADMIN login, like /admin. With no
// admin password set it answers 404. The only public piece is the QR sign-in a person uses to put themselves on the
// list, and that is gated by the random key on the printed card and by the meeting actually being on (see leaders.js).
// JSON bodies only, so a form on another site cannot post through an admin's cached sign-in.
import path from "node:path";
import QRCode from "qrcode";
import { isDate } from "./time.js";
import { smsConfigured } from "./sms.js";
import * as L from "./leaders.js";
import { attendanceHistory, attendancePdf } from "./attendanceReport.js";

export function mountLeaders({ app, db, cfg, now, sendSms, same, root, requireAdmin }) {
  const ctx = () => ({ db, cfg, sendSms, now });
  const reply = (res, r, okStatus = 200) => (r.error ? res.status(r.status || 400).json({ error: r.error, saved: r.saved }) : res.status(okStatus).json(r));
  // Only real meetings: one the rule schedules, or one the books already hold. Stops junk dates making rows.
  const meetingDate = (req, res) => {
    const d = String(req.params.date);
    if (isDate(d) && L.isKnownMeeting(db, cfg, d)) return d;
    res.status(404).json({ error: "That isn't a meeting date." });
    return null;
  };

  app.get("/leaders", requireAdmin, (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    res.sendFile(path.join(root, "private", "leaders.html"));
  });

  const signInUrl = (req) => `${cfg.selfUrl || `${req.protocol}://${req.get("host")}`}/leaders/in/${L.signInKey(db, cfg)}`;

  app.get("/api/leaders/state", requireAdmin, (req, res) => {
    res.set("Cache-Control", "no-store");
    const st = L.signInStatus(db, cfg, now());
    res.json({
      signin: { url: signInUrl(req), open: st.open, openNow: st.open ? st.meeting.dayLabel : null, opensText: st.opensText || "", consent: L.CONSENT_TEXT },
      settings: L.leadersView(cfg),
      people: L.listPeople(db),
      meetings: L.meetingLists(db, cfg, now()),
      messages: L.listMessages(db, cfg),
      texts: { enabled: cfg.leaders.textsEnabled, ready: L.textsReady(cfg, sendSms), recipients: L.textable(db).length, smsConfigured: smsConfigured(cfg) },
    });
  });

  app.get("/api/leaders/meetings/:date", requireAdmin, (req, res) => {
    const d = meetingDate(req, res); if (!d) return;
    res.set("Cache-Control", "no-store");
    res.json(L.meetingDetail(db, cfg, d));
  });

  // Attendance history: counts per meeting, by ward, by person, and a trend. Read-only; the PDF is the same data.
  app.get("/api/leaders/history", requireAdmin, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(attendanceHistory(db, cfg, now(), req.query.months));
  });
  app.get("/api/leaders/history.pdf", requireAdmin, (req, res) => {
    const h = attendanceHistory(db, cfg, now(), req.query.months);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="meeting-attendance-${h.to}.pdf"`, "Cache-Control": "no-store" });
    attendancePdf(h).pipe(res);
  });

  app.post("/api/leaders/meetings/:date/attendance", requireAdmin, (req, res) => {
    const d = meetingDate(req, res); if (!d) return;
    reply(res, L.addAttendance(db, cfg, d, req.body || {}, now()), 201);
  });
  app.put("/api/leaders/meetings/:date/attendance/:id", requireAdmin, (req, res) => {
    const d = meetingDate(req, res); if (!d) return;
    reply(res, L.updateAttendance(db, cfg, d, req.params.id, req.body || {}));
  });
  app.delete("/api/leaders/meetings/:date/attendance/:id", requireAdmin, (req, res) => {
    const d = meetingDate(req, res); if (!d) return;
    L.removeAttendance(db, d, req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/leaders/meetings/:date/update", requireAdmin, async (req, res) => {
    const d = meetingDate(req, res); if (!d) return;
    reply(res, await L.updateMeeting(ctx(), d, req.body || {}));
  });
  app.post("/api/leaders/meetings/:date/remind", requireAdmin, async (req, res) => {
    const d = meetingDate(req, res); if (!d) return;
    reply(res, await L.remindNow(ctx(), d));
  });

  app.post("/api/leaders/people", requireAdmin, (req, res) => {
    const r = L.savePerson(db, cfg, req.body || {}, now());
    reply(res, r, req.body?.id ? 200 : 201);
  });
  app.post("/api/leaders/people/:id/remove", requireAdmin, (req, res) => {
    L.removePerson(db, req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/leaders/messages", requireAdmin, async (req, res) => {
    const b = req.body || {};
    reply(res, await L.postMessage(ctx(), { fromId: b.fromId, body: b.body, meetingDate: b.meetingDate, alsoText: b.alsoText === true, recipientIds: b.recipientIds }), 201);
  });

  // The meeting rule, callings and reminder timing. The texting switch is deliberately not settable here.
  app.post("/api/leaders/settings", requireAdmin, (req, res) => {
    const r = L.saveLeaders(db, cfg, req.body || {}, now(), { allowTexts: false });
    if (r.errors) return res.status(400).json({ error: r.errors.join(" ") });
    res.json({ ok: true, settings: L.leadersView(cfg) });
  });

  // ---- the QR sign-in (public, but only with the key on the printed card, and only while a meeting is on) ----
  const hits = new Map();
  const tooMany = (ip) => {
    const t = now();
    const recent = (hits.get(ip) || []).filter((x) => t - x < 3600_000);
    recent.push(t); hits.set(ip, recent);
    return recent.length > 30;
  };
  const keyed = (req, res, next) => (L.keyMatches(db, cfg, req.params.key) ? next() : res.status(404).json({ error: "Not found" }));

  app.get("/leaders/in/:key", (req, res) => {
    if (!L.keyMatches(db, cfg, req.params.key)) return res.status(404).send("Not found");
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    res.sendFile(path.join(root, "private", "leaders-in.html"));
  });
  app.get("/api/signin/:key", keyed, (req, res) => {
    res.set("Cache-Control", "no-store");
    const st = L.signInStatus(db, cfg, now());
    res.json({
      open: st.open, opensText: st.opensText || "",
      meeting: st.open ? { dayLabel: st.meeting.dayLabel, timeLabel: st.meeting.timeLabel, place: st.meeting.place } : null,
      callings: cfg.leaders.callings, wards: L.wardChoices(cfg), consent: L.CONSENT_TEXT,
    });
  });
  app.post("/api/signin/:key", keyed, (req, res) => {
    if (tooMany(req.ip)) return res.status(429).json({ error: "Too many tries. Please wait a little and try again." });
    reply(res, L.signIn(db, cfg, req.body || {}, now()), 201);
  });
  // Retire every printed card and make a fresh code.
  app.post("/api/leaders/signin/rotate", requireAdmin, (req, res) => {
    const r = L.rotateSignInKey(db, cfg, now());
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, url: signInUrl(req) });
  });
  // The QR image for the printed card (admin only; the link inside it is the credential).
  app.get("/api/leaders/qr.svg", requireAdmin, async (req, res) => {
    const svg = await QRCode.toString(signInUrl(req), { type: "svg", margin: 2, width: 360, errorCorrectionLevel: "M" });
    res.set({ "Content-Type": "image/svg+xml", "Cache-Control": "no-store" }).send(svg);
  });

  // ---- admin: where the page lives, and the texting switch ----
  app.get("/api/admin/leaders", requireAdmin, (req, res) => {
    const base = cfg.selfUrl || `${req.protocol}://${req.get("host")}`;
    res.json({
      url: `${base}/leaders`, signInUrl: `${base}/leaders/in/${L.signInKey(db, cfg)}`,
      textsEnabled: cfg.leaders.textsEnabled, smsConfigured: smsConfigured(cfg), recipients: L.textable(db).length, people: L.listPeople(db).length,
    });
  });
  app.post("/api/admin/leaders", requireAdmin, (req, res) => {
    const r = L.saveLeaders(db, cfg, { textsEnabled: req.body?.textsEnabled === true }, now(), { allowTexts: true });
    if (r.errors) return res.status(400).json({ error: r.errors.join(" ") });
    res.json({ ok: true, textsEnabled: cfg.leaders.textsEnabled });
  });
}
