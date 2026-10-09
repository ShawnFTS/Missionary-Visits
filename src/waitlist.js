// The wait-list: families who want a week that is full, and who hear FIRST when a
// visit in that week cancels.
//
// "First" is made real with a short hold. When a visit cancels and somebody is
// waiting, the freed time is held for the wait-list for `waitlistHoldMinutes` and
// every waiting family in that week is texted a private link. The public sheet shows
// the time as held, so a family who happens to be looking at the page cannot beat
// the people who asked to be told. After the hold it opens to everyone. First to
// press Book wins (the unique index on bookings decides, as it does for the public).
import crypto from "node:crypto";
import { fmtDay, fmtTime, sundayOf } from "./time.js";
import { displayFamily } from "./people.js";
import { wardForWeek } from "./slots.js";

const MAX_WAITING_PER_WEEK = 20;

export function activeHolds(db, nowMs) {
  return new Set(db.prepare(`SELECT slot_date, slot_time FROM slot_holds WHERE until_ts > ?`).all(nowMs).map((r) => `${r.slot_date} ${r.slot_time}`));
}
export const holdUntil = (db, date, time, nowMs) =>
  db.prepare(`SELECT until_ts FROM slot_holds WHERE slot_date = ? AND slot_time = ? AND until_ts > ?`).get(date, time, nowMs)?.until_ts ?? null;

export function join(db, { weekStart, family, phone, address }, nowMs) {
  const waiting = db.prepare(`SELECT COUNT(*) n FROM waitlist WHERE week_start = ? AND status = 'waiting'`).get(weekStart).n;
  if (waiting >= MAX_WAITING_PER_WEEK) return { status: 409, error: "The wait-list for this week is full." };
  const token = crypto.randomBytes(16).toString("base64url");
  try {
    db.prepare(`INSERT INTO waitlist (token, week_start, family, phone, address, created_at) VALUES (?,?,?,?,?,?)`).run(token, weekStart, family, phone, address, nowMs);
  } catch (e) {
    if (String(e.code).startsWith("SQLITE_CONSTRAINT")) return { status: 409, error: "That phone number is already on the wait-list for this week." };
    throw e;
  }
  return { token };
}

export const byToken = (db, token) => db.prepare(`SELECT * FROM waitlist WHERE token = ?`).get(String(token));

// Position among the families still waiting for the same week (1 = first).
export const position = (db, e) =>
  db.prepare(`SELECT COUNT(*) n FROM waitlist WHERE week_start = ? AND status = 'waiting' AND id <= ?`).get(e.week_start, e.id).n;

// A family who got a visit by any route stops waiting.
export function markBooked(db, phone, weekStart, nowMs, bookingToken) {
  db.prepare(`UPDATE waitlist SET status = 'booked', done_at = ?, booking_token = ? WHERE phone = ? AND week_start = ? AND status = 'waiting'`)
    .run(nowMs, bookingToken, phone, weekStart);
}

export function offerText(b, e, cfg, minutes) {
  const day = fmtDay(b.slot_date, { weekday: "short", month: "short", day: "numeric" });
  const ward = wardForWeek(cfg, sundayOf(b.slot_date));
  const first = minutes > 0 ? ` You have first pick for the next ${minutes} minutes.` : "";
  const link = cfg.selfUrl ? ` ${cfg.selfUrl}/w/${e.token}` : "";
  return `Missionary Visits: a visit time opened up${ward ? ` in ${ward} Ward's week` : ""}: ${day} ${fmtTime(b.slot_time)}.${first}${link} Reply STOP to opt out.`;
}

// Called when a future visit is cancelled. Never throws into the request.
export async function onCancel({ db, cfg, sendSms, now = () => Date.now() }, booking) {
  const weekStart = sundayOf(booking.slot_date);
  const waiting = db.prepare(`SELECT * FROM waitlist WHERE week_start = ? AND status = 'waiting' ORDER BY id`).all(weekStart);
  if (!waiting.length || !sendSms) return; // nobody to tell, or no way to tell them: don't hold a time for people who were never told
  const minutes = cfg.waitlistHoldMinutes;
  if (minutes > 0) {
    db.prepare(`INSERT INTO slot_holds (slot_date, slot_time, until_ts) VALUES (?,?,?) ON CONFLICT(slot_date, slot_time) DO UPDATE SET until_ts = excluded.until_ts`)
      .run(booking.slot_date, booking.slot_time, now() + minutes * 60_000);
  }
  const log = db.prepare(`INSERT INTO notification_log (ts, kind, booking_id, contact_id, contact_name, channel, ok, error) VALUES (?,?,?,?,?,?,?,?)`);
  for (const e of waiting) {
    try { await sendSms(e.phone, offerText(booking, e, cfg, minutes)); log.run(now(), "waitlist", booking.id, null, displayFamily(e.family), "text", 1, null); }
    catch (err) { log.run(now(), "waitlist", booking.id, null, displayFamily(e.family), "text", 0, String(err.message).slice(0, 300)); console.error(`[waitlist] text to ${e.family}: ${err.message}`); }
  }
}
