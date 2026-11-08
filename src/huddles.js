// Ward missionary huddles: when each ward meets, who is expected (names and numbers, youth included), and who came.
//
// The point is a list that stays true. Three things work toward that:
//  - Adults who are already on the leaders list are LINKED, not copied, so their name, number and calling are read
//    live from there and cannot drift between the two lists.
//  - A ward's list carries a "confirmed" date, and the screen says plainly how old it is.
//  - Attendance is recorded per huddle, so "who actually comes" is a record rather than a memory.
//
// Nothing here can send a text. Youth are on these lists, and a text to a minor needs a parent's say-so that this
// section has no way to capture, so there is simply no path from a huddle list to a message. The list that is sent
// OUT is a read-only page behind a random key, with youth phone numbers hidden unless someone turns that on.
import crypto from "node:crypto";
import { addDays, dowOf, isDate, fmtDay, fmtTime, todayInZone } from "./time.js";
import { normalizePhone, formatPhone } from "./people.js";
import { time24, clean, nthWeekday, WEEKDAYS, YOUTH } from "./leaders.js";

const STALE_DAYS = 60;

// ---- when ---------------------------------------------------------------------------------------

export function scheduleFor(db, ward) {
  const r = db.prepare(`SELECT * FROM huddle_schedule WHERE ward = ?`).get(ward);
  return r ? { ward, freq: r.freq, weekday: r.weekday, nth: r.nth, time: r.time, place: r.place || "", note: r.note || "", confirmedAt: r.confirmed_at, set: r.weekday != null && !!r.time }
           : { ward, freq: "weekly", weekday: null, nth: null, time: null, place: "", note: "", confirmedAt: null, set: false };
}

// A ward's schedule in words. Never invented: an unset ward says so.
export function whenLabel(s) {
  if (!s.set) return "Day and time not set yet";
  const day = WEEKDAYS[s.weekday];
  const t = fmtTime(s.time);
  return s.freq === "nth" ? `The ${["", "1st", "2nd", "3rd", "4th"][s.nth]} ${day} of each month at ${t}` : `${day}s at ${t}`;
}

// Every date the schedule gives between two dates (inclusive).
export function huddleDates(s, from, to) {
  if (!s.set) return [];
  const out = [];
  if (s.freq === "nth") {
    let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
    const ey = Number(to.slice(0, 4)), em = Number(to.slice(5, 7));
    while (y < ey || (y === ey && m <= em)) {
      const d = nthWeekday(y, m, s.weekday, s.nth);
      if (d >= from && d <= to) out.push(d);
      if (++m > 12) { m = 1; y++; }
    }
  } else {
    for (let d = from; d <= to; d = addDays(d, 1)) if (dowOf(d) === s.weekday) out.push(d);
  }
  return out;
}

export function saveSchedule(db, ward, body, nowMs) {
  const freq = body.freq === "nth" ? "nth" : "weekly";
  const weekday = Number(body.weekday), nth = freq === "nth" ? Number(body.nth) : null;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { status: 400, error: "Pick the day of the week." };
  if (freq === "nth" && (!Number.isInteger(nth) || nth < 1 || nth > 4)) return { status: 400, error: "Pick which week of the month." };
  const time = time24(body.time);
  if (!time) return { status: 400, error: "Enter the time, like 9:00 AM." };
  const place = clean(body.place, 60) || null, note = clean(body.note, 200) || null;
  // Changing when a ward meets is itself a reason to look at the list again, but it does not count as confirming it.
  db.prepare(`INSERT INTO huddle_schedule (ward, freq, weekday, nth, time, place, note, updated_at) VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(ward) DO UPDATE SET freq=excluded.freq, weekday=excluded.weekday, nth=excluded.nth, time=excluded.time, place=excluded.place, note=excluded.note, updated_at=excluded.updated_at`)
    .run(ward, freq, weekday, nth, time, place, note, nowMs);
  return { ok: true };
}

export function confirmWard(db, ward, nowMs) {
  db.prepare(`INSERT INTO huddle_schedule (ward, updated_at, confirmed_at) VALUES (?,?,?)
              ON CONFLICT(ward) DO UPDATE SET confirmed_at = excluded.confirmed_at`).run(ward, nowMs, nowMs);
}

// ---- who ----------------------------------------------------------------------------------------

const isYouth = (calling) => calling === YOUTH;

// A ward's list: linked adults read live from the leaders list, the rest as typed. A linked person who has since been
// removed from the leaders list drops off here too.
export function roster(db, ward) {
  const rows = db.prepare(`
    SELECT hp.id, hp.leader_id leaderId, hp.created_at,
           COALESCE(lp.name, hp.name) name, COALESCE(lp.phone, hp.phone) phone, COALESCE(lp.calling, hp.calling) calling
      FROM huddle_people hp LEFT JOIN leaders_people lp ON lp.id = hp.leader_id AND lp.active = 1
     WHERE hp.ward = ? AND hp.active = 1 AND (hp.leader_id IS NULL OR lp.id IS NOT NULL)
     ORDER BY (COALESCE(lp.calling, hp.calling) = ?), name COLLATE NOCASE`).all(ward, YOUTH);
  return rows.map((r) => ({ id: r.id, leaderId: r.leaderId, name: r.name, calling: r.calling || "", phone: r.phone || "", youth: isYouth(r.calling), linked: r.leaderId != null }));
}

// Adults already on the leaders list for this ward who are not on its huddle list yet: one tap to add.
export function suggestions(db, ward) {
  return db.prepare(`SELECT id, name, calling FROM leaders_people lp
                      WHERE lp.active = 1 AND lp.ward = ?
                        AND NOT EXISTS (SELECT 1 FROM huddle_people hp WHERE hp.leader_id = lp.id AND hp.ward = ? AND hp.active = 1)
                      ORDER BY name COLLATE NOCASE`).all(ward, ward);
}

const callingChoices = (cfg) => [...new Set([...cfg.leaders.callings, YOUTH])];

export function addPerson(db, cfg, ward, body, nowMs) {
  if (body.leaderId) {
    const lp = db.prepare(`SELECT id FROM leaders_people WHERE id = ? AND active = 1`).get(Number(body.leaderId));
    if (!lp) return { status: 404, error: "That person isn't on the leaders list any more." };
    if (db.prepare(`SELECT 1 FROM huddle_people WHERE ward = ? AND leader_id = ? AND active = 1`).get(ward, lp.id)) return { status: 409, error: "They're already on this ward's list." };
    const r = db.prepare(`INSERT INTO huddle_people (ward, leader_id, created_at) VALUES (?,?,?)`).run(ward, lp.id, nowMs);
    return { id: Number(r.lastInsertRowid) };
  }
  const name = clean(body.name, 60);
  if (!name) return { status: 400, error: "Enter a name." };
  const calling = clean(body.calling, 50);
  if (!callingChoices(cfg).includes(calling)) return { status: 400, error: "Pick a calling from the list." };
  const phone = body.phone ? normalizePhone(body.phone) : null;
  if (body.phone && !phone) return { status: 400, error: "Enter a 10-digit number, or leave it blank." };
  if (db.prepare(`SELECT 1 FROM huddle_people WHERE ward = ? AND active = 1 AND leader_id IS NULL AND lower(name) = lower(?)`).get(ward, name)) return { status: 409, error: "Someone with that name is already on this ward's list." };
  const r = db.prepare(`INSERT INTO huddle_people (ward, name, phone, calling, created_at) VALUES (?,?,?,?,?)`).run(ward, name, phone, calling, nowMs);
  return { id: Number(r.lastInsertRowid) };
}

export function updatePerson(db, cfg, ward, id, body) {
  const cur = db.prepare(`SELECT * FROM huddle_people WHERE id = ? AND ward = ? AND active = 1`).get(Number(id), ward);
  if (!cur) return { status: 404, error: "That person isn't on this ward's list." };
  if (cur.leader_id) return { status: 409, error: "This person comes from the leaders list. Change them there." };
  const name = clean(body.name, 60), calling = clean(body.calling, 50);
  if (!name) return { status: 400, error: "Enter a name." };
  if (!callingChoices(cfg).includes(calling)) return { status: 400, error: "Pick a calling from the list." };
  const phone = body.phone ? normalizePhone(body.phone) : null;
  if (body.phone && !phone) return { status: 400, error: "Enter a 10-digit number, or leave it blank." };
  db.prepare(`UPDATE huddle_people SET name = ?, phone = ?, calling = ? WHERE id = ?`).run(name, phone, calling, cur.id);
  return { ok: true };
}

export const removePerson = (db, ward, id) => db.prepare(`UPDATE huddle_people SET active = 0 WHERE id = ? AND ward = ?`).run(Number(id), ward);

// ---- who came -----------------------------------------------------------------------------------

export function isHuddleDate(db, ward, date, nowMs, tz) {
  if (!isDate(date)) return false;
  if (db.prepare(`SELECT 1 FROM huddle_log WHERE ward = ? AND date = ?`).get(ward, date)) return true;
  const today = todayInZone(nowMs, tz);
  return huddleDates(scheduleFor(db, ward), addDays(today, -400), addDays(today, 400)).includes(date);
}

export function sheet(db, ward, date) {
  const log = db.prepare(`SELECT * FROM huddle_log WHERE ward = ? AND date = ?`).get(ward, date);
  const present = new Set(db.prepare(`SELECT person_id FROM huddle_attendance WHERE ward = ? AND date = ?`).all(ward, date).map((r) => r.person_id));
  return { date, label: fmtDay(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" }), recorded: !!log, held: log ? !!log.held : null, note: log?.note || "",
           people: roster(db, ward).map((p) => ({ id: p.id, name: p.name, calling: p.calling, youth: p.youth, present: present.has(p.id) })) };
}

export function saveSheet(db, ward, date, body, nowMs) {
  const held = body.held !== false;
  const ids = held && Array.isArray(body.presentIds) ? [...new Set(body.presentIds.map(Number))] : [];
  const people = new Map(roster(db, ward).map((p) => [p.id, p]));
  for (const id of ids) if (!people.has(id)) return { status: 400, error: "Someone on that list isn't on this ward's list." };
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM huddle_attendance WHERE ward = ? AND date = ?`).run(ward, date);
    const ins = db.prepare(`INSERT INTO huddle_attendance (ward, date, person_id, name) VALUES (?,?,?,?)`);
    for (const id of ids) ins.run(ward, date, id, people.get(id).name);
    db.prepare(`INSERT INTO huddle_log (ward, date, held, note, updated_at) VALUES (?,?,?,?,?)
                ON CONFLICT(ward, date) DO UPDATE SET held = excluded.held, note = excluded.note, updated_at = excluded.updated_at`)
      .run(ward, date, held ? 1 : 0, clean(body.note, 200) || null, nowMs);
  });
  tx();
  return { ok: true, present: ids.length, expected: people.size };
}

// ---- the whole picture --------------------------------------------------------------------------

const ago = (ms, nowMs) => Math.floor((nowMs - ms) / 86400_000);

export function wardView(db, cfg, ward, nowMs) {
  const s = scheduleFor(db, ward);
  const today = todayInZone(nowMs, cfg.tz);
  const dates = huddleDates(s, addDays(today, -84), addDays(today, 21));
  const past = dates.filter((d) => d <= today).slice(-8).reverse();
  const next = dates.find((d) => d > today) || null;
  const logs = new Map(db.prepare(`SELECT date, held FROM huddle_log WHERE ward = ?`).all(ward).map((r) => [r.date, r.held]));
  const counts = new Map(db.prepare(`SELECT date, COUNT(*) n FROM huddle_attendance WHERE ward = ? GROUP BY date`).all(ward).map((r) => [r.date, r.n]));
  const people = roster(db, ward);
  const mk = (d) => ({ date: d, label: fmtDay(d, { weekday: "short", month: "short", day: "numeric" }), recorded: logs.has(d), held: logs.has(d) ? !!logs.get(d) : null, present: counts.get(d) || 0 });
  // Dates that were logged but no longer match the rule (the schedule changed) still show, so history is not lost.
  const extra = [...logs.keys()].filter((d) => !dates.includes(d) && d <= today).sort().reverse().slice(0, 4);
  const recent = [...new Set([...past, ...extra])].sort().reverse().map(mk);
  const heldRecent = recent.filter((r) => r.held);
  return {
    ward, schedule: { ...s, label: whenLabel(s) }, people, suggestions: suggestions(db, ward),
    next: next ? { date: next, label: fmtDay(next, { weekday: "long", month: "long", day: "numeric" }) } : null,
    recent, today: dates.includes(today) ? today : null,
    average: heldRecent.length ? Math.round((10 * heldRecent.reduce((a, r) => a + r.present, 0)) / heldRecent.length) / 10 : null,
    confirmed: s.confirmedAt ? { date: new Date(s.confirmedAt).toLocaleDateString("en-US", { timeZone: cfg.tz, month: "short", day: "numeric", year: "numeric" }), daysAgo: ago(s.confirmedAt, nowMs), stale: ago(s.confirmedAt, nowMs) >= STALE_DAYS } : { date: null, daysAgo: null, stale: true },
  };
}

export const allWards = (db, cfg, nowMs) => cfg.wards.map((w) => wardView(db, cfg, w, nowMs));

// ---- the list that gets sent out ----------------------------------------------------------------

const newKey = () => crypto.randomBytes(16).toString("base64url");
const row = (db, k) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(k)?.value;
const put = (db, k, v, nowMs) => db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(k, v, nowMs);

export function shareState(db) {
  const key = row(db, "huddles_share_key") || "";
  let opts = {};
  try { opts = JSON.parse(row(db, "huddles_share_opts") || "{}"); } catch { /* ignore */ }
  return { key, showYouthPhones: opts.showYouthPhones === true };
}

export function saveShare(db, body, nowMs) {
  const cur = shareState(db);
  if (body.action === "off") db.prepare(`DELETE FROM settings WHERE key = 'huddles_share_key'`).run();
  else if (body.action === "rotate" || (body.action === "create" && !cur.key)) put(db, "huddles_share_key", newKey(), nowMs);
  if (body.showYouthPhones !== undefined) put(db, "huddles_share_opts", JSON.stringify({ showYouthPhones: body.showYouthPhones === true }), nowMs);
  return shareState(db);
}

export function keyMatches(db, given) {
  const k = shareState(db).key, g = String(given ?? "");
  if (!k || k.length !== g.length) return false;
  return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(g));
}

// What the public, read-only page and the CSV carry. Youth numbers only if the admin chose to include them.
export function shareable(db, cfg, nowMs, { youthPhones = shareState(db).showYouthPhones } = {}) {
  const wards = allWards(db, cfg, nowMs).map((w) => ({
    ward: w.ward, when: w.schedule.label, place: w.schedule.place, note: w.schedule.note,
    confirmed: w.confirmed.date ? `Confirmed ${w.confirmed.date}` : "Not confirmed yet",
    people: w.people.map((p) => ({ name: p.name, calling: p.calling, youth: p.youth, phone: p.phone ? (p.youth && !youthPhones ? "" : formatPhone(p.phone)) : "" })),
  }));
  return { wards, youthPhonesHidden: !youthPhones, generated: fmtDay(todayInZone(nowMs, cfg.tz), { weekday: "long", month: "long", day: "numeric", year: "numeric" }) };
}

const csvCell = (v) => { let s = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
export function csv(db, cfg, nowMs) {
  const rows = [["Ward", "Meets", "Place", "Name", "Calling", "Youth", "Phone"]];
  for (const w of allWards(db, cfg, nowMs)) {
    if (!w.people.length) rows.push([w.ward, w.schedule.label, w.schedule.place, "", "", "", ""]);
    for (const p of w.people) rows.push([w.ward, w.schedule.label, w.schedule.place, p.name, p.calling, p.youth ? "yes" : "", p.phone ? formatPhone(p.phone) : ""]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
