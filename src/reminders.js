import { fmtDay, fmtTime } from "./time.js";
import { displayFamily } from "./people.js";

const DAY = 24 * 3600_000;
const HOUR = 3600_000;

export function reminderText(b, cfg) {
  // Explicit day and time rather than "tomorrow": if the server was down and
  // this goes out late, a relative word would be wrong; a date never is.
  const link = cfg.selfUrl ? ` Manage or cancel: ${cfg.selfUrl}/b/${b.token}` : "";
  return `Missionary Visits reminder: ${displayFamily(b.family)}, ` +
    `${fmtDay(b.slot_date, { weekday: "long", month: "short", day: "numeric" })} at ${fmtTime(b.slot_time)}.${link} Reply STOP to opt out.`;
}

// One pass. Safe to run any number of times: each reminder is claimed in the
// database before the request, so a crash or overlap can lose a text but never
// double one — a channel that repeats itself gets muted.
export async function runReminders({ db, cfg, send, nowMs = Date.now() }) {
  if (!send) return 0;
  const rows = db.prepare(
    `SELECT * FROM bookings WHERE cancelled_at IS NULL AND start_utc > ? AND (remind_day = 1 OR remind_hour = 1)`
  ).all(nowMs);
  let sent = 0;
  const kinds = [
    // `due >= created_at`: someone who books for tomorrow morning has just been
    // told when it is; a "1 day before" text seconds later would be noise.
    // The 3h floor stops a late "day before" text arriving on the day itself.
    { flag: "remind_day", col: "day_sent_at", lead: DAY, minLeft: 3 * HOUR },
    { flag: "remind_hour", col: "hour_sent_at", lead: HOUR, minLeft: 0 },
  ];
  for (const b of rows) {
    for (const k of kinds) {
      const due = b.start_utc - k.lead;
      if (!b[k.flag] || b[k.col] != null || due > nowMs || due < b.created_at || b.start_utc - nowMs <= k.minLeft) continue;
      const claim = db.prepare(`UPDATE bookings SET ${k.col} = ? WHERE id = ? AND ${k.col} IS NULL`).run(nowMs, b.id);
      if (claim.changes !== 1) continue;
      try {
        await send(b.phone, reminderText(b, cfg));
        sent++;
      } catch (e) {
        db.prepare(`UPDATE bookings SET sms_error = ? WHERE id = ?`).run(String(e.message).slice(0, 300), b.id);
        console.error(`[reminders] booking ${b.id}: ${e.message}`);
      }
    }
  }
  return sent;
}

export function startReminders(opts) {
  const tick = () => runReminders(opts).catch((e) => console.error("[reminders]", e));
  tick();
  return setInterval(tick, 60_000);
}
