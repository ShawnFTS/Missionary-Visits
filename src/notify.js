// Telling the missionaries when a visit is cancelled (or booked).
//
// Never awaited by the request and never fatal: the cancellation is the record,
// the message is a courtesy about it — same rule the daily-report Chat post and the
// Orders@ mail follow elsewhere. Every attempt, good or bad, lands in notification_log
// so "did they actually get told?" has an answer on the admin screen.
import { fmtDay, fmtTime, sundayOf } from "./time.js";
import { displayFamily, formatPhone } from "./people.js";
import { wardForWeek } from "./slots.js";

export function describe(kind, b, cfg, by) {
  const when = `${fmtDay(b.slot_date, { weekday: "long", month: "long", day: "numeric" })} at ${fmtTime(b.slot_time)}`;
  const ward = wardForWeek(cfg, sundayOf(b.slot_date));
  const fam = displayFamily(b.family);
  const link = cfg.selfUrl ? `${cfg.selfUrl}/?start=${sundayOf(b.slot_date)}` : "";
  const detail = [`Phone: ${formatPhone(b.phone)}`, b.address ? `Address: ${b.address}` : null, ward ? `Ward: ${ward}` : null].filter(Boolean).join("\n");
  if (kind === "cancel") {
    return {
      subject: `Cancelled: ${fam}, ${fmtDay(b.slot_date, { weekday: "short", month: "short", day: "numeric" })} ${fmtTime(b.slot_time)}`,
      email: `${fam} has cancelled their visit on ${when}.\n\n${detail}\n\n` +
        (by === "admin" ? "It was cancelled by an administrator.\n\n" : "They cancelled using the link on their confirmation page.\n\n") +
        `That time is open again, so another family can sign up for it.${link ? `\n${link}` : ""}\n\nThis is an automatic message.`,
      sms: `Visit cancelled: ${fam}, ${fmtDay(b.slot_date, { weekday: "short", month: "short", day: "numeric" })} ${fmtTime(b.slot_time)}. The time is open again.`,
    };
  }
  return {
    subject: `New visit: ${fam}, ${fmtDay(b.slot_date, { weekday: "short", month: "short", day: "numeric" })} ${fmtTime(b.slot_time)}`,
    email: `${fam} signed up to host you on ${when}.\n\n${detail}\n\nThis is an automatic message.`,
    sms: `New visit: ${fam}, ${fmtDay(b.slot_date, { weekday: "short", month: "short", day: "numeric" })} ${fmtTime(b.slot_time)}.`,
  };
}

export async function notifyMissionaries({ db, cfg, sendEmail, sendSms, now = () => Date.now() }, kind, booking, by = "family") {
  const flag = kind === "cancel" ? "notify_cancel" : "notify_signup";
  const contacts = db.prepare(`SELECT * FROM missionary_contacts WHERE active = 1 AND ${flag} = 1`).all();
  if (!contacts.length) return;
  const msg = describe(kind, booking, cfg, by);
  const log = db.prepare(`INSERT INTO notification_log (ts, kind, booking_id, contact_id, contact_name, channel, ok, error) VALUES (?,?,?,?,?,?,?,?)`);
  for (const c of contacts) {
    const attempts = [];
    if (c.email) attempts.push(["email", sendEmail && (() => sendEmail({ to: c.email, subject: msg.subject, text: msg.email }))]);
    if (c.sms && c.phone) attempts.push(["text", sendSms && (() => sendSms(c.phone, msg.sms))]);
    for (const [channel, run] of attempts) {
      if (!run) { log.run(now(), kind, booking.id, c.id, c.name, channel, 0, `${channel === "email" ? "Email" : "Texting"} isn't set up yet`); continue; }
      try { await run(); log.run(now(), kind, booking.id, c.id, c.name, channel, 1, null); }
      catch (e) { log.run(now(), kind, booking.id, c.id, c.name, channel, 0, String(e.message).slice(0, 300)); console.error(`[notify] ${channel} to ${c.name}: ${e.message}`); }
    }
  }
}
