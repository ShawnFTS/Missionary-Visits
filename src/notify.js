// Texting the missionaries when a visit is cancelled (or booked). Texts only: one channel, one thing to set up (the Twilio number the family reminders already use).
//
// Never awaited by the request and never fatal: the cancellation is the record,
// the message is a courtesy about it — same rule the daily-report Chat post and the
// Orders@ mail follow elsewhere. Every attempt, good or bad, lands in notification_log
// so "did they actually get told?" has an answer on the admin screen.
import { fmtDay, fmtTime, sundayOf } from "./time.js";
import { displayFamily, formatPhone, normalizePhone } from "./people.js";
import { wardForWeek } from "./slots.js";

export function describe(kind, b, cfg, by) {
  const day = fmtDay(b.slot_date, { weekday: "short", month: "short", day: "numeric" });
  const fam = displayFamily(b.family);
  const who = `${fam}, ${day} ${fmtTime(b.slot_time)}`;
  if (kind === "cancel") {
    const link = cfg.selfUrl ? ` ${cfg.selfUrl}/?start=${sundayOf(b.slot_date)}` : "";
    return { sms: `Missionary Visits: visit cancelled, ${who} (${formatPhone(b.phone)}). The time is open again for another family.${link}` };
  }
  return { sms: `Missionary Visits: new visit, ${who}${b.address ? `, ${b.address}` : ""} (${formatPhone(b.phone)}).` };
}

// The missionaries' shared phone (the number shown at the bottom of the page, set in Settings)
// is always a recipient; extra people on the contact list are optional. One text per number:
// if someone is on both, their flags are combined.
export function recipients(db, cfg, kind) {
  const want = kind === "cancel" ? "cancel" : "signup";
  const byPhone = new Map();
  const add = (phone, name, id, cancel, signup) => {
    const cur = byPhone.get(phone) || { phone, name, id, cancel: false, signup: false };
    byPhone.set(phone, { ...cur, cancel: cur.cancel || cancel, signup: cur.signup || signup });
  };
  const main = normalizePhone(cfg.missionaryPhone);
  if (main) add(main, "Missionaries' phone", null, !!cfg.notifyCancel, !!cfg.notifySignup);
  for (const c of db.prepare(`SELECT * FROM missionary_contacts WHERE active = 1 AND phone IS NOT NULL`).all()) add(c.phone, c.name, c.id, !!c.notify_cancel, !!c.notify_signup);
  return [...byPhone.values()].filter((r) => r[want]);
}

export async function notifyMissionaries({ db, cfg, sendSms, now = () => Date.now() }, kind, booking, by = "family") {
  const list = recipients(db, cfg, kind);
  if (!list.length) return;
  const msg = describe(kind, booking, cfg, by);
  const log = db.prepare(`INSERT INTO notification_log (ts, kind, booking_id, contact_id, contact_name, channel, ok, error) VALUES (?,?,?,?,?,?,?,?)`);
  for (const c of list) {
    if (!sendSms) { log.run(now(), kind, booking.id, c.id, c.name, "text", 0, "Texting isn't set up yet"); continue; }
    try { await sendSms(c.phone, msg.sms); log.run(now(), kind, booking.id, c.id, c.name, "text", 1, null); }
    catch (e) { log.run(now(), kind, booking.id, c.id, c.name, "text", 0, String(e.message).slice(0, 300)); console.error(`[notify] text to ${c.name}: ${e.message}`); }
  }
}
