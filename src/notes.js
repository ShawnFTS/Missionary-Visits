// Visit notes: planned / taught / commitments / follow-up. Written by the missionaries (their private
// page) or the admin; read only by those two and by the missionaries' own calendar feed.
import { zonedToUtc, isDate, todayInZone, addDays } from "./time.js";

const MAX = 2000;
// Keep line breaks and tabs, drop other control characters.
export const clean = (v) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, MAX);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const EMPTY = { planned: "", taught: "", commitments: "", followupDate: "", followupTime: "", updatedAt: null };

export function view(row) {
  if (!row) return { ...EMPTY };
  return {
    planned: row.planned || "", taught: row.taught || "", commitments: row.commitments || "",
    followupDate: row.followup_date || "", followupTime: row.followup_time || "", updatedAt: row.updated_at,
  };
}

export const get = (db, bookingId) => view(db.prepare(`SELECT * FROM visit_notes WHERE booking_id = ?`).get(bookingId));

/** Notes for many bookings at once: Map(booking_id -> view). */
export function forBookings(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = db.prepare(`SELECT * FROM visit_notes WHERE booking_id IN (${ids.map(() => "?").join(",")})`).all(...ids);
  for (const r of rows) out.set(r.booking_id, view(r));
  return out;
}

/** Returns { ok: true } or { error }. An entirely empty form removes the row. */
export function save(db, cfg, bookingId, body, now, by) {
  const b = body || {};
  const planned = clean(b.planned), taught = clean(b.taught), commitments = clean(b.commitments);
  const date = String(b.followupDate ?? "").trim();
  const time = String(b.followupTime ?? "").trim();
  if (date && !isDate(date)) return { error: "That follow-up date doesn't look right." };
  if (time && !TIME.test(time)) return { error: "That follow-up time doesn't look right." };
  if (time && !date) return { error: "Pick a date for the follow-up, or clear the time." };
  if (!planned && !taught && !commitments && !date) {
    db.prepare(`DELETE FROM visit_notes WHERE booking_id = ?`).run(bookingId);
    return { ok: true };
  }
  const utc = date ? zonedToUtc(date, time || "09:00", cfg.tz) : null;
  db.prepare(
    `INSERT INTO visit_notes (booking_id, planned, taught, commitments, followup_date, followup_time, followup_utc, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(booking_id) DO UPDATE SET planned = excluded.planned, taught = excluded.taught, commitments = excluded.commitments,
       followup_date = excluded.followup_date, followup_time = excluded.followup_time, followup_utc = excluded.followup_utc,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(bookingId, planned || null, taught || null, commitments || null, date || null, time || null, utc, now, by);
  return { ok: true };
}

export const remove = (db, bookingId) => db.prepare(`DELETE FROM visit_notes WHERE booking_id = ?`).run(bookingId);

/** Follow-ups still ahead (or from yesterday), joined to the family, for the missionaries' calendar feed. */
export function followups(db, cfg, now) {
  const since = addDays(todayInZone(now, cfg.tz), -1);
  return db.prepare(
    `SELECT n.*, b.token, b.family, b.phone, b.address, b.slot_date
       FROM visit_notes n JOIN bookings b ON b.id = n.booking_id
      WHERE b.cancelled_at IS NULL AND n.followup_date IS NOT NULL AND n.followup_date >= ?
      ORDER BY n.followup_date, n.followup_time`
  ).all(since);
}
