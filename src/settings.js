// Admin-editable settings: schedule, visit length, ward rotation, contact info.
// Env vars give the defaults; what is saved here overrides them and is applied to
// the live config object, so a change is visible on the sign-up page immediately.
// A change never touches existing bookings: a visit is stored as an absolute date and
// time, so moving the schedule or rotation cannot move, hide or cancel anyone.
import { isDate, dowOf, addDays, fmtDay, fmtTime, todayInZone } from "./time.js";
import { wardCodes } from "./config.js";
import { windowEnd, wardForWeek } from "./slots.js";
import { slotTimesOn } from "./config.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n) => String(n).padStart(2, "0");

// "7:30 PM", "7pm", "19:30" -> "19:30". A bare "7:30" is ambiguous and refused.
export function parseTime(raw) {
  const s = String(raw).trim();
  let m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m?\.?$/i.exec(s);
  if (m) {
    let h = Number(m[1]); const mi = Number(m[2] || 0);
    if (h < 1 || h > 12 || mi > 59) return null;
    h = (h % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
    return `${pad(h)}:${pad(mi)}`;
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m && (Number(m[1]) >= 13 || m[1] === "00" || m[1] === "0") && Number(m[1]) < 24 && Number(m[2]) < 60) return `${pad(Number(m[1]))}:${m[2]}`;
  return null;
}

function parseTimeList(day, raw) {
  const parts = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[,;\n]+/)).map((x) => String(x).trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const t = parseTime(p);
    if (!t) return { error: `${DAYS[day]}: "${p}" isn't a time. Write it like 7:30 PM (include AM or PM).` };
    out.push(t);
  }
  if (out.length > 8) return { error: `${DAYS[day]}: at most 8 times a day.` };
  return { times: [...new Set(out)].sort() };
}

const text = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

// Validates only the fields present, so the screen can save one section at a time.
export function validate(input) {
  const errors = [];
  const v = {};
  if (input.schedule !== undefined) {
    const sched = {};
    for (let d = 0; d < 7; d++) {
      const r = parseTimeList(d, input.schedule?.[d] ?? input.schedule?.[String(d)] ?? "");
      if (r.error) errors.push(r.error); else sched[d] = r.times;
    }
    if (!errors.length && !Object.values(sched).some((t) => t.length)) errors.push("Add at least one time on at least one day.");
    v.schedule = sched;
  }
  if (input.minutes !== undefined) {
    const n = Number(input.minutes);
    if (!Number.isInteger(n) || n < 15 || n > 240) errors.push("Visit length must be a whole number of minutes between 15 and 240.");
    else v.minutes = n;
  }
  if (input.wards !== undefined) {
    const list = (Array.isArray(input.wards) ? input.wards : String(input.wards).split(/\n/)).map((w) => text(w, 40).replace(/,/g, "")).filter(Boolean);
    const lower = list.map((w) => w.toLowerCase());
    if (!list.length) errors.push("Add at least one ward.");
    else if (list.length > 30) errors.push("At most 30 wards.");
    else if (new Set(lower).size !== list.length) errors.push("Each ward can only appear once in the list.");
    else v.wards = list;
  }
  if (input.rotationStart !== undefined) {
    if (!isDate(input.rotationStart)) errors.push("Start date isn't a valid date.");
    else if (dowOf(input.rotationStart) !== 0) errors.push("The rotation has to start on a Sunday (weeks run Sunday to Saturday).");
    else v.rotationStart = input.rotationStart;
  }
  if (input.rotationCycles !== undefined) {
    const n = Number(input.rotationCycles);
    if (!Number.isInteger(n) || n < 1 || n > 20) errors.push("Number of cycles must be a whole number from 1 to 20.");
    else v.rotationCycles = n;
  }
  for (const [k, max] of [["missionaryPhone", 30], ["helpName", 60], ["helpPhone", 30]]) if (input[k] !== undefined) v[k] = text(input[k], max);
  return { errors, values: v };
}

export function apply(cfg, v) {
  Object.assign(cfg, v);
  if (v.wards) cfg.wardCodes = wardCodes(cfg.wards, v.wards ? "" : cfg.wardCodesRaw); // new list: codes follow the new names
}

export function loadStored(db, cfg) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'overrides'`).get();
  if (!row) return;
  try { apply(cfg, JSON.parse(row.value)); } catch (e) { console.error("[settings] ignoring unreadable saved settings:", e.message); }
}

export function save(db, cfg, input, nowMs) {
  const { errors, values } = validate(input);
  if (!errors.length) {
    const cand = { ...cfg, ...values };
    if (cand.wards.length * cand.rotationCycles > 156) errors.push("That rotation runs longer than three years; use fewer cycles.");
  }
  if (errors.length) return { errors };
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'overrides'`).get();
  const merged = { ...(row ? JSON.parse(row.value) : {}), ...values };
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('overrides', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(JSON.stringify(merged), nowMs);
  apply(cfg, values);
  return { ok: true, warnings: warnings(db, cfg, nowMs) };
}

// Things a person should hear about right after saving, never reasons to refuse.
function warnings(db, cfg, nowMs) {
  const out = [];
  const today = todayInZone(nowMs, cfg.tz);
  const end = windowEnd(cfg);
  const future = db.prepare(`SELECT slot_date, slot_time FROM bookings WHERE cancelled_at IS NULL AND start_utc > ?`).all(nowMs);
  const offSchedule = future.filter((b) => !slotTimesOn(cfg, dowOf(b.slot_date)).includes(b.slot_time)).length;
  const outsideWindow = future.filter((b) => b.slot_date > end || b.slot_date < cfg.rotationStart).length;
  if (offSchedule) out.push(`${offSchedule} booked visit${offSchedule > 1 ? "s are" : " is"} at a time that is no longer on the schedule. ${offSchedule > 1 ? "They stay" : "It stays"} booked and visible; nobody was cancelled.`);
  if (outsideWindow) out.push(`${outsideWindow} booked visit${outsideWindow > 1 ? "s fall" : " falls"} outside the new rotation dates. ${outsideWindow > 1 ? "They stay" : "It stays"} booked.`);
  if (end < today) out.push("The rotation now ends in the past, so nothing can be booked. Add cycles or move the start date.");
  return out;
}

export function editableView(cfg) {
  const schedule = {};
  for (let d = 0; d < 7; d++) schedule[d] = slotTimesOn(cfg, d).map(fmtTime).join(", ");
  const weeks = [];
  const total = cfg.wards.length * cfg.rotationCycles;
  for (let i = 0; i < total; i++) {
    const start = addDays(cfg.rotationStart, i * 7);
    weeks.push({ n: i + 1, cycle: Math.floor(i / cfg.wards.length) + 1, start: fmtDay(start, { month: "short", day: "numeric", year: "numeric" }), ward: wardForWeek(cfg, start) });
  }
  return {
    days: DAYS, schedule, minutes: cfg.minutes, wards: cfg.wards, rotationStart: cfg.rotationStart, rotationCycles: cfg.rotationCycles,
    missionaryPhone: cfg.missionaryPhone, helpName: cfg.helpName, helpPhone: cfg.helpPhone,
    ends: fmtDay(windowEnd(cfg), { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
    totalWeeks: total, weeks,
  };
}
