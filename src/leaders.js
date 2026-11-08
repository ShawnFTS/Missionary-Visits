// The missionary coordination meeting: when it is, who came, what was said, and who is reminded.
//
// Everything here is keyed on the date the rule schedules a meeting on ("2nd Thursday"). A meeting that
// gets cancelled or moved keeps that key, so its attendance, board posts and already-sent reminders
// stay attached to it instead of orphaning.
//
// Texting leaders is a message type the Twilio verification does not cover yet, so it is off until an
// admin turns on `textsEnabled`, and it only ever reaches people recorded as having agreed to it.
import crypto from "node:crypto";
import { zonedToUtc, addDays, dowOf, isDate, fmtDay, fmtTime, todayInZone } from "./time.js";
import { normalizePhone, formatPhone } from "./people.js";
import { parseTime } from "./settings.js";

const pad = (n) => String(n).padStart(2, "0");
const HOUR = 3600_000;
const MEETING_LENGTH = 3 * HOUR; // still "the current meeting" for a while after it starts
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const clean1 = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩<>]/g, "").trim().slice(0, max); // keeps newlines for messages

export const wardChoices = (cfg) => [...cfg.wards, "Stake"];
export const YOUTH = "Youth"; // a calling, but the one that changes how a person is shown and shared

// ---- when -------------------------------------------------------------------------------------

export function nthWeekday(year, month, weekday, nth) {
  const first = `${year}-${pad(month)}-01`;
  return addDays(first, ((weekday - dowOf(first) + 7) % 7) + (nth - 1) * 7);
}

// Every date the rule schedules a meeting on between two dates (inclusive), oldest first.
export function scheduledDates(cfg, from, to) {
  const L = cfg.leaders;
  const out = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4)), endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    const d = nthWeekday(y, m, L.weekday, L.nth);
    if (d >= from && d <= to) out.push(d);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

export function meetingFor(db, cfg, date) {
  const row = db.prepare(`SELECT * FROM leaders_meetings WHERE date = ?`).get(date);
  const L = cfg.leaders;
  const effectiveDate = row?.moved_date || date;
  const time = row?.moved_time || L.time;
  const place = row?.place || L.place;
  return {
    date, effectiveDate, time, place, cancelled: !!row?.cancelled, note: row?.note || "",
    moved: effectiveDate !== date || time !== L.time || place !== L.place,
    startUtc: zonedToUtc(effectiveDate, time, cfg.tz),
    dayLabel: fmtDay(effectiveDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
    shortLabel: fmtDay(effectiveDate, { weekday: "short", month: "short", day: "numeric" }),
    timeLabel: fmtTime(time),
  };
}

// A date is a real meeting if the rule schedules it or the books already know it (the rule can change later).
export function isKnownMeeting(db, cfg, date) {
  if (!isDate(date)) return false;
  if (db.prepare(`SELECT 1 FROM leaders_meetings WHERE date = ? UNION SELECT 1 FROM leaders_attendance WHERE meeting_date = ?`).get(date, date)) return true;
  const today = todayInZone(Date.now(), cfg.tz);
  return scheduledDates(cfg, addDays(today, -400), addDays(today, 400)).includes(date);
}

export function meetingLists(db, cfg, nowMs) {
  const today = todayInZone(nowMs, cfg.tz);
  const dates = new Set(scheduledDates(cfg, addDays(today, -400), addDays(today, 200)));
  for (const r of db.prepare(`SELECT date FROM leaders_meetings UNION SELECT meeting_date FROM leaders_attendance`).all()) dates.add(r.date);
  const all = [...dates].sort().map((d) => meetingFor(db, cfg, d));
  const counts = new Map(db.prepare(`SELECT meeting_date d, COUNT(*) n FROM leaders_attendance GROUP BY meeting_date`).all().map((r) => [r.d, r.n]));
  const withCount = (m) => ({ ...m, attendees: counts.get(m.date) || 0 });
  const upcoming = all.filter((m) => m.startUtc + MEETING_LENGTH > nowMs).slice(0, 4).map(withCount);
  const past = all.filter((m) => m.startUtc + MEETING_LENGTH <= nowMs).reverse().slice(0, 14).map(withCount);
  return { upcoming, past };
}

// ---- settings (the meeting rule, the callings list, reminder timing) ---------------------------

export const time24 = (raw) => {
  const s = String(raw ?? "").trim();
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) return s;
  return parseTime(s);
};

export function validateLeaders(input, { allowTexts = false } = {}) {
  const errors = [], v = {};
  if (input.nth !== undefined) {
    const n = Number(input.nth);
    if (!Number.isInteger(n) || n < 1 || n > 4) errors.push("Pick 1st, 2nd, 3rd or 4th for which week of the month.");
    else v.nth = n;
  }
  if (input.weekday !== undefined) {
    const n = Number(input.weekday);
    if (!Number.isInteger(n) || n < 0 || n > 6) errors.push("Pick a day of the week.");
    else v.weekday = n;
  }
  if (input.time !== undefined) { const t = time24(input.time); if (!t) errors.push("The meeting time isn't a time. Write it like 8:00 PM."); else v.time = t; }
  if (input.place !== undefined) { const p = clean(input.place, 60); if (!p) errors.push("Enter where the meeting is."); else v.place = p; }
  if (input.callings !== undefined) {
    const list = (Array.isArray(input.callings) ? input.callings : String(input.callings).split("\n")).map((c) => clean(c, 50)).filter(Boolean);
    if (!list.length) errors.push("Add at least one calling.");
    else if (list.length > 40) errors.push("At most 40 callings.");
    else if (new Set(list.map((c) => c.toLowerCase())).size !== list.length) errors.push("Each calling can only be listed once.");
    else v.callings = list;
  }
  if (input.reminderDays !== undefined) {
    const n = Number(input.reminderDays);
    if (!Number.isInteger(n) || n < 0 || n > 14) errors.push("Days before must be a whole number from 0 to 14 (0 turns it off).");
    else v.reminderDays = n;
  }
  if (input.reminderAt !== undefined) { const t = time24(input.reminderAt); if (!t) errors.push("The reminder time isn't a time. Write it like 9:00 AM."); else v.reminderAt = t; }
  if (input.reminderHours !== undefined) {
    const n = Number(input.reminderHours);
    if (!Number.isInteger(n) || n < 0 || n > 24) errors.push("Hours before must be a whole number from 0 to 24 (0 turns it off).");
    else v.reminderHours = n;
  }
  if (allowTexts && input.textsEnabled !== undefined) v.textsEnabled = input.textsEnabled === true || input.textsEnabled === "true";
  return { errors, values: v };
}

export function loadLeaders(db, cfg) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'leaders'`).get();
  if (!row) return;
  try { Object.assign(cfg.leaders, JSON.parse(row.value)); } catch (e) { console.error("[leaders] ignoring unreadable saved settings:", e.message); }
}

export function saveLeaders(db, cfg, input, nowMs, opts) {
  const { errors, values } = validateLeaders(input, opts);
  if (errors.length) return { errors };
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'leaders'`).get();
  const merged = { ...(row ? JSON.parse(row.value) : {}), ...values };
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('leaders', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(JSON.stringify(merged), nowMs);
  Object.assign(cfg.leaders, values);
  return { ok: true };
}

export function leadersView(cfg) {
  const L = cfg.leaders;
  return {
    nth: L.nth, weekday: L.weekday, time: L.time, place: L.place, callings: L.callings,
    reminderDays: L.reminderDays, reminderAt: L.reminderAt, reminderHours: L.reminderHours, textsEnabled: L.textsEnabled,
    weekdays: WEEKDAYS, wards: wardChoices(cfg),
    rule: `${["", "1st", "2nd", "3rd", "4th"][L.nth]} ${WEEKDAYS[L.weekday]} of the month at ${fmtTime(L.time)}, ${L.place}`,
  };
}

// ---- people -----------------------------------------------------------------------------------

const personRow = (p) => ({
  id: p.id, name: p.name, calling: p.calling, ward: p.ward,
  phone: p.phone ? formatPhone(p.phone) : "", smsOk: !!p.sms_ok && !!p.phone, smsSource: p.sms_ok ? p.sms_ok_source || "" : "",
});
export const listPeople = (db) => db.prepare(`SELECT * FROM leaders_people WHERE active = 1 ORDER BY name COLLATE NOCASE`).all().map(personRow);

export function savePerson(db, cfg, body, nowMs) {
  const name = clean(body.name, 60);
  if (!name) return { status: 400, error: "Pick or enter a name." };
  const calling = clean(body.calling, 50), ward = clean(body.ward, 40);
  if (!cfg.leaders.callings.includes(calling)) return { status: 400, error: "Pick a calling from the list." };
  if (!wardChoices(cfg).includes(ward)) return { status: 400, error: "Pick a ward from the list." };
  const phone = body.phone ? normalizePhone(body.phone) : null;
  if (body.phone && !phone) return { status: 400, error: "Enter a 10-digit mobile number, or leave it blank." };
  if (body.smsOk && !phone) return { status: 400, error: "Add their mobile number to record that they agreed to texts." };
  const id = Number(body.id) || 0;
  const dupe = db.prepare(`SELECT id FROM leaders_people WHERE active = 1 AND lower(name) = lower(?) AND id != ?`).get(name, id);
  if (dupe) return { status: 409, error: "Someone with that name is already on the list.", id: dupe.id };
  if (id) {
    const cur = db.prepare(`SELECT * FROM leaders_people WHERE id = ? AND active = 1`).get(id);
    if (!cur) return { status: 404, error: "That person isn't on the list any more." };
    // Consent keeps the moment it was given unless it is withdrawn or newly given.
    const smsOk = body.smsOk && phone ? 1 : 0;
    const at = smsOk ? (cur.sms_ok && cur.phone === phone ? cur.sms_ok_at : nowMs) : null;
    const keep = smsOk && cur.sms_ok && cur.phone === phone; // unchanged consent keeps how it was given
    db.prepare(`UPDATE leaders_people SET name=?, calling=?, ward=?, phone=?, sms_ok=?, sms_ok_at=?, sms_ok_source=?, sms_ok_text=? WHERE id=?`)
      .run(name, calling, ward, phone, smsOk, at, smsOk ? (keep ? cur.sms_ok_source : "recorded by an admin") : null, keep ? cur.sms_ok_text : null, id);
    return { id };
  }
  const smsOk = body.smsOk && phone ? 1 : 0;
  const r = db.prepare(`INSERT INTO leaders_people (name, calling, ward, phone, sms_ok, sms_ok_at, sms_ok_source, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(name, calling, ward, phone, smsOk, smsOk ? nowMs : null, smsOk ? "recorded by an admin" : null, nowMs);
  return { id: Number(r.lastInsertRowid) };
}

export const removePerson = (db, id) => db.prepare(`UPDATE leaders_people SET active = 0 WHERE id = ?`).run(Number(id));

// People who may be texted: a mobile on file AND recorded as having agreed.
export const textable = (db) => db.prepare(`SELECT * FROM leaders_people WHERE active = 1 AND phone IS NOT NULL AND sms_ok = 1 ORDER BY name`).all();

// ---- attendance -------------------------------------------------------------------------------

export function addAttendance(db, cfg, date, body, nowMs) {
  let person = null;
  if (body.personId) person = db.prepare(`SELECT * FROM leaders_people WHERE id = ? AND active = 1`).get(Number(body.personId));
  if (body.personId && !person) return { status: 404, error: "That person isn't on the list any more." };
  const calling = clean(body.calling || person?.calling, 50), ward = clean(body.ward || person?.ward, 40);
  if (!person) {
    // "Someone new": the name was typed into the dropdown's last option, so they join the list too.
    const name = clean(body.name, 60);
    person = name && db.prepare(`SELECT * FROM leaders_people WHERE active = 1 AND lower(name) = lower(?)`).get(name);
    if (!person) {
      const r = savePerson(db, cfg, { name, calling, ward }, nowMs);
      if (r.error) return r;
      person = db.prepare(`SELECT * FROM leaders_people WHERE id = ?`).get(r.id);
    }
  }
  if (!cfg.leaders.callings.includes(calling)) return { status: 400, error: "Pick a calling from the list." };
  if (!wardChoices(cfg).includes(ward)) return { status: 400, error: "Pick a ward from the list." };
  try {
    const r = db.prepare(`INSERT INTO leaders_attendance (meeting_date, person_id, name, calling, ward, created_at) VALUES (?,?,?,?,?,?)`)
      .run(date, person.id, person.name, calling, ward, nowMs);
    return { id: Number(r.lastInsertRowid) };
  } catch (e) {
    if (String(e.code).startsWith("SQLITE_CONSTRAINT")) return { status: 409, error: `${person.name} is already on this meeting's list.` };
    throw e;
  }
}

export function updateAttendance(db, cfg, date, id, body) {
  const calling = clean(body.calling, 50), ward = clean(body.ward, 40);
  if (!cfg.leaders.callings.includes(calling)) return { status: 400, error: "Pick a calling from the list." };
  if (!wardChoices(cfg).includes(ward)) return { status: 400, error: "Pick a ward from the list." };
  const r = db.prepare(`UPDATE leaders_attendance SET calling = ?, ward = ? WHERE id = ? AND meeting_date = ?`).run(calling, ward, Number(id), date);
  return r.changes ? { ok: true } : { status: 404, error: "That attendee isn't on this meeting's list." };
}

export const removeAttendance = (db, date, id) => db.prepare(`DELETE FROM leaders_attendance WHERE id = ? AND meeting_date = ?`).run(Number(id), date);

export function meetingDetail(db, cfg, date) {
  const attendees = db.prepare(`SELECT id, person_id personId, name, calling, ward, source FROM leaders_attendance WHERE meeting_date = ? ORDER BY ward, name COLLATE NOCASE`).all(date);
  const here = new Set(attendees.map((a) => a.ward));
  const wards = cfg.wards;
  return { meeting: meetingFor(db, cfg, date), attendees, represented: wards.filter((w) => here.has(w)), missing: wards.filter((w) => !here.has(w)) };
}

// ---- QR sign-in -------------------------------------------------------------------------------
//
// Each person scans a QR code at the meeting and signs THEMSELVES in: name and mobile typed, calling and ward picked
// from the same lists as everywhere else, and a checkbox for texts. That is how consent is captured: by the person,
// on a form that shows exactly what they agree to, with that wording stored beside their name.
//
// The link carries a random key that is stored here and has NOTHING to do with the admin password. (An earlier version
// derived it from the password; every leader who scanned the card could then test password guesses offline, so a weak
// password would have been recoverable from the QR code.) The printed card works every month; "Make a new code" on the
// page retires every old card. The link also only works while a meeting is actually on (a couple of hours before to a
// few hours after), so a copy of it cannot invent attendance for some other night.
export const SIGNIN_OPENS_BEFORE = 2 * HOUR;
export const SIGNIN_CLOSES_AFTER = 6 * HOUR;

export const CONSENT_TEXT =
  "By checking this box you agree to receive text messages from Missionary Visits (operated by FIDUS Technology Solutions LLC) " +
  "with reminders for future missionary coordination meetings and updates about them. Message frequency varies, about 2 to 4 a month. " +
  "Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of signing in.";

const newKey = () => crypto.randomBytes(16).toString("base64url"); // 128 bits of randomness, 22 characters

// The current key: LEADERS_SIGNIN_KEY if one is pinned, else the stored random one (made the first time it is needed).
export function signInKey(db, cfg) {
  if (cfg.leadersKey) return cfg.leadersKey;
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'leaders_signin_key'`).get();
  if (row) return row.value;
  const k = newKey();
  db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('leaders_signin_key', ?, ?)`).run(k, Date.now());
  return db.prepare(`SELECT value FROM settings WHERE key = 'leaders_signin_key'`).get().value;
}

// Throw away the old key: every printed card stops working. (No-op when a key is pinned by the environment.)
export function rotateSignInKey(db, cfg, nowMs) {
  if (cfg.leadersKey) return { error: "The key is set by LEADERS_SIGNIN_KEY in Railway, so change it there.", status: 409 };
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('leaders_signin_key', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(newKey(), nowMs);
  return { ok: true };
}

// Off entirely when there is no admin login: nobody could see the QR code to scan, so nothing public should answer.
export function keyMatches(db, cfg, given) {
  if (!cfg.adminPassword && !cfg.leadersKey) return false;
  const k = signInKey(db, cfg), g = String(given ?? "");
  if (!k || k.length !== g.length) return false;
  return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(g));
}

// "18:00" wall-clock for an instant in the stake's zone.
const wallClock = (ms, tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

// The meeting that is on right now, or none (plus the next one, so the form can say when sign-in opens).
export function signInStatus(db, cfg, nowMs) {
  const today = todayInZone(nowMs, cfg.tz);
  const meetings = scheduledDates(cfg, addDays(today, -40), addDays(today, 60)).map((d) => meetingFor(db, cfg, d)).sort((a, b) => a.startUtc - b.startUtc);
  const live = meetings.find((m) => !m.cancelled && nowMs >= m.startUtc - SIGNIN_OPENS_BEFORE && nowMs <= m.startUtc + SIGNIN_CLOSES_AFTER);
  if (live) return { open: true, meeting: live };
  const next = meetings.find((m) => !m.cancelled && m.startUtc - SIGNIN_OPENS_BEFORE > nowMs);
  return { open: false, next: next || null, opensText: next ? `${fmtDay(zonedDate(next.startUtc - SIGNIN_OPENS_BEFORE, cfg.tz), { weekday: "long", month: "long", day: "numeric" })} at ${fmtTime(wallClock(next.startUtc - SIGNIN_OPENS_BEFORE, cfg.tz))}` : "" };
}
const zonedDate = (ms, tz) => todayInZone(ms, tz);

export function signIn(db, cfg, body, nowMs) {
  const st = signInStatus(db, cfg, nowMs);
  if (!st.open) return { status: 409, error: st.next ? `Sign-in isn't open yet. It opens ${st.opensText}.` : "There's no meeting to sign in to right now." };
  const name = clean(body.name, 60);
  if (!name) return { status: 400, error: "Please type your name." };
  const calling = clean(body.calling, 50), ward = clean(body.ward, 40);
  if (!cfg.leaders.callings.includes(calling)) return { status: 400, error: "Please choose your calling." };
  if (!wardChoices(cfg).includes(ward)) return { status: 400, error: "Please choose your ward." };
  const phone = body.phone ? normalizePhone(body.phone) : null;
  if (body.phone && !phone) return { status: 400, error: "Please enter a 10-digit mobile number, or leave it blank." };
  const consent = body.consent === true;
  if (consent && !phone) return { status: 400, error: "Add your mobile number to get texts, or untick the box." };

  // Same person returning? A phone number is the best match, a name the next best (names are unique on the roster).
  let person = phone && db.prepare(`SELECT * FROM leaders_people WHERE active = 1 AND phone = ?`).get(phone);
  if (!person) person = db.prepare(`SELECT * FROM leaders_people WHERE active = 1 AND lower(name) = lower(?)`).get(name);
  const tx = db.transaction(() => {
    let id;
    if (person) {
      id = person.id;
      const clash = db.prepare(`SELECT 1 FROM leaders_people WHERE active = 1 AND lower(name) = lower(?) AND id != ?`).get(name, id);
      const keepPhone = phone || person.phone;
      const had = !!person.sms_ok && person.phone === keepPhone;
      const grant = consent && !had;
      // Ticking grants consent. Not ticking never silently takes it away; replying STOP is how it is withdrawn.
      db.prepare(`UPDATE leaders_people SET name = ?, calling = ?, ward = ?, phone = ?, sms_ok = ?, sms_ok_at = ?, sms_ok_source = ?, sms_ok_text = ? WHERE id = ?`)
        .run(clash ? person.name : name, calling, ward, keepPhone, had || grant ? 1 : 0,
          grant ? nowMs : had ? person.sms_ok_at : null, grant ? "self sign-in (QR)" : had ? person.sms_ok_source : null, grant ? CONSENT_TEXT : had ? person.sms_ok_text : null, id);
    } else {
      id = Number(db.prepare(`INSERT INTO leaders_people (name, calling, ward, phone, sms_ok, sms_ok_at, sms_ok_source, sms_ok_text, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(name, calling, ward, phone, consent ? 1 : 0, consent ? nowMs : null, consent ? "self sign-in (QR)" : null, consent ? CONSENT_TEXT : null, nowMs).lastInsertRowid);
    }
    const already = !!db.prepare(`SELECT 1 FROM leaders_attendance WHERE meeting_date = ? AND person_id = ?`).get(st.meeting.date, id);
    db.prepare(`INSERT INTO leaders_attendance (meeting_date, person_id, name, calling, ward, source, created_at) VALUES (?,?,?,?,?, 'qr', ?)
                ON CONFLICT(meeting_date, person_id) DO UPDATE SET calling = excluded.calling, ward = excluded.ward`)
      .run(st.meeting.date, id, name, calling, ward, nowMs);
    return { id, already };
  });
  const r = tx();
  const texts = !!db.prepare(`SELECT sms_ok FROM leaders_people WHERE id = ?`).get(r.id).sms_ok;
  return { ok: true, already: r.already, name, texts, meeting: { dayLabel: st.meeting.dayLabel, timeLabel: st.meeting.timeLabel, place: st.meeting.place } };
}

// ---- messages and texting ---------------------------------------------------------------------

const BRAND = "Missionary Visits";

export const meetingTextLine = (cfg, m) => `${m.dayLabel.replace(/, \d{4}$/, "")} at ${m.timeLabel}, ${m.place}`;

// Sends one text per person, logging each; never throws. Returns counts for the message row.
async function textPeople({ db, sendSms, now }, messageId, people, body) {
  let texted = 0, failed = 0;
  const log = db.prepare(`INSERT INTO leaders_text_log (message_id, person_id, person_name, ok, error) VALUES (?,?,?,?,?)`);
  for (const p of people) {
    try { await sendSms(p.phone, body); texted++; log.run(messageId, p.id, p.name, 1, null); }
    catch (e) { failed++; log.run(messageId, p.id, p.name, 0, String(e.message).slice(0, 300)); console.error(`[leaders] text to ${p.name}: ${e.message}`); }
  }
  db.prepare(`UPDATE leaders_messages SET texted = ?, failed = ? WHERE id = ?`).run(texted, failed, messageId);
  return { texted, failed };
}

export const textsReady = (cfg, sendSms) => !!(cfg.leaders.textsEnabled && sendSms);

export async function postMessage(ctx, { fromId, body, meetingDate, alsoText, recipientIds }) {
  const { db, cfg, sendSms, now } = ctx;
  const text = clean1(body, 400);
  if (!text) return { status: 400, error: "Write a message first." };
  const from = fromId ? db.prepare(`SELECT name FROM leaders_people WHERE id = ? AND active = 1`).get(Number(fromId)) : null;
  const author = from?.name || "";
  let people = [];
  if (alsoText) {
    if (!textsReady(cfg, sendSms)) return { status: 400, error: "Texting leaders isn't turned on yet. The message can still be posted here." };
    const day = db.prepare(`SELECT COUNT(*) n FROM leaders_messages WHERE texted + failed > 0 AND ts > ?`).get(now() - 24 * HOUR).n;
    if (day >= 20) return { status: 429, error: "That's a lot of text messages for one day. Try again tomorrow." };
    const ids = Array.isArray(recipientIds) ? new Set(recipientIds.map(Number)) : null;
    people = textable(db).filter((p) => !ids || ids.has(p.id));
    if (!people.length) return { status: 400, error: "No one is set up to get texts. Add a mobile number and tick that they agreed on the People tab." };
  }
  const r = db.prepare(`INSERT INTO leaders_messages (ts, kind, author, body, meeting_date) VALUES (?, 'post', ?, ?, ?)`)
    .run(now(), author || null, text, isDate(meetingDate) ? meetingDate : null);
  const id = Number(r.lastInsertRowid);
  const counts = people.length ? await textPeople(ctx, id, people, `${BRAND} leaders: ${author ? author + ": " : ""}${text} Reply STOP to opt out.`) : { texted: 0, failed: 0 };
  return { id, ...counts };
}

export function listMessages(db, cfg, limit = 40) {
  return db.prepare(`SELECT * FROM leaders_messages ORDER BY id DESC LIMIT ?`).all(limit).map((m) => ({
    id: m.id, kind: m.kind, author: m.author || "", body: m.body, texted: m.texted, failed: m.failed,
    when: new Date(m.ts).toLocaleString("en-US", { timeZone: cfg.tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
  }));
}

// A change to one meeting (cancelled, moved, new place). Optionally told to everyone who agreed to texts.
export async function updateMeeting(ctx, date, body) {
  const { db, cfg, sendSms, now } = ctx;
  const cur = db.prepare(`SELECT * FROM leaders_meetings WHERE date = ?`).get(date);
  const L = cfg.leaders;
  const movedDate = body.movedDate ? String(body.movedDate) : null;
  if (movedDate && !isDate(movedDate)) return { status: 400, error: "That isn't a valid date." };
  let movedTime = null;
  if (body.movedTime) { movedTime = time24(body.movedTime); if (!movedTime) return { status: 400, error: "That isn't a valid time." }; }
  const place = clean(body.place, 60) || null;
  const note = clean(body.note, 200) || null;
  const cancelled = body.cancelled ? 1 : 0;
  const changed = (cur?.cancelled ? 1 : 0) !== cancelled || (cur?.moved_date || null) !== (movedDate && movedDate !== date ? movedDate : null)
    || (cur?.moved_time || null) !== (movedTime && movedTime !== L.time ? movedTime : null) || (cur?.place || null) !== (place && place !== L.place ? place : null);
  db.prepare(`INSERT INTO leaders_meetings (date, cancelled, note, moved_date, moved_time, place, updated_at) VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(date) DO UPDATE SET cancelled=excluded.cancelled, note=excluded.note, moved_date=excluded.moved_date, moved_time=excluded.moved_time, place=excluded.place, updated_at=excluded.updated_at`)
    .run(date, cancelled, note, movedDate && movedDate !== date ? movedDate : null, movedTime && movedTime !== L.time ? movedTime : null, place && place !== L.place ? place : null, now());
  // A moved meeting starts its reminders over: the old ones were about the old time.
  if (changed) db.prepare(`DELETE FROM leaders_reminders_sent WHERE meeting_date = ?`).run(date);
  const m = meetingFor(db, cfg, date);
  let notified = null;
  if (body.notify && changed) {
    if (!textsReady(cfg, sendSms)) return { status: 400, error: "The change was saved, but texting leaders isn't turned on, so no one was texted.", saved: true };
    const people = textable(db);
    const line = m.cancelled ? `the missionary coordination meeting on ${fmtDay(date, { weekday: "long", month: "short", day: "numeric" })} is cancelled.` : `the missionary coordination meeting is now ${meetingTextLine(cfg, m)}.`;
    const text = `${line}${m.note ? " " + m.note : ""}`;
    const r = db.prepare(`INSERT INTO leaders_messages (ts, kind, author, body, meeting_date) VALUES (?, 'change', NULL, ?, ?)`).run(now(), text[0].toUpperCase() + text.slice(1), date);
    notified = await textPeople(ctx, Number(r.lastInsertRowid), people, `${BRAND}: ${text} Reply STOP to opt out.`);
  }
  return { ok: true, meeting: m, notified };
}

// ---- reminders --------------------------------------------------------------------------------

// When each reminder is due for one meeting. Days-before goes out at a set time of day; hours-before is relative.
export function reminderPlan(cfg, m) {
  const L = cfg.leaders, out = [];
  if (L.reminderDays > 0) out.push({ kind: "days", dueUtc: zonedToUtc(addDays(m.effectiveDate, -L.reminderDays), L.reminderAt, cfg.tz), lateAfter: m.startUtc - 3 * HOUR });
  if (L.reminderHours > 0) out.push({ kind: "hours", dueUtc: m.startUtc - L.reminderHours * HOUR, lateAfter: m.startUtc });
  return out;
}

export const reminderText = (cfg, m) => `${BRAND}: missionary coordination meeting ${meetingTextLine(cfg, m)}. Reply STOP to opt out.`;

// One pass; safe to run as often as you like. Each reminder is claimed before the texts go out.
export async function runLeaderReminders({ db, cfg, send, nowMs = Date.now() }) {
  if (!send || !cfg.leaders.textsEnabled) return 0;
  const today = todayInZone(nowMs, cfg.tz);
  let sent = 0;
  // Look at meetings by the date the rule gave them, but judge them by when they actually happen: a meeting
  // moved a week later still belongs to the earlier date's row.
  for (const date of scheduledDates(cfg, addDays(today, -40), addDays(today, 40))) {
    const m = meetingFor(db, cfg, date);
    if (m.cancelled || m.startUtc < nowMs - 24 * HOUR || m.startUtc > nowMs + 21 * 24 * HOUR) continue;
    for (const r of reminderPlan(cfg, m)) {
      // A "2 days before" text that is only reaching us 2 hours before the meeting is noise; skip it.
      if (nowMs < r.dueUtc || nowMs >= r.lateAfter) continue;
      const claim = db.prepare(`INSERT OR IGNORE INTO leaders_reminders_sent (meeting_date, kind, sent_at) VALUES (?,?,?)`).run(date, r.kind, nowMs);
      if (claim.changes !== 1) continue;
      const text = reminderText(cfg, m);
      const msg = db.prepare(`INSERT INTO leaders_messages (ts, kind, author, body, meeting_date) VALUES (?, 'reminder', NULL, ?, ?)`)
        .run(nowMs, `Reminder sent: ${meetingTextLine(cfg, m)}`, date);
      await textPeople({ db, sendSms: send, now: () => nowMs }, Number(msg.lastInsertRowid), textable(db), text);
      sent++;
    }
  }
  return sent;
}

export function startLeaderReminders(opts) {
  const tick = () => runLeaderReminders(opts).catch((e) => console.error("[leaders reminders]", e));
  tick();
  return setInterval(tick, 60_000);
}

// "Send a reminder now" button: same text, any time, no claim (a person pressed it).
export async function remindNow(ctx, date) {
  const { db, cfg, sendSms, now } = ctx;
  if (!textsReady(cfg, sendSms)) return { status: 400, error: "Texting leaders isn't turned on yet." };
  const m = meetingFor(db, cfg, date);
  if (m.cancelled) return { status: 400, error: "That meeting is cancelled." };
  const people = textable(db);
  if (!people.length) return { status: 400, error: "No one is set up to get texts yet." };
  const msg = db.prepare(`INSERT INTO leaders_messages (ts, kind, author, body, meeting_date) VALUES (?, 'reminder', NULL, ?, ?)`)
    .run(now(), `Reminder sent: ${meetingTextLine(cfg, m)}`, date);
  return textPeople(ctx, Number(msg.lastInsertRowid), people, reminderText(cfg, m));
}
