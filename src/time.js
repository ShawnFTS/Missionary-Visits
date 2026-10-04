// Slots are stored as a local calendar date + wall-clock time ("2026-10-07",
// "17:00") in the stake's zone, and converted to a real instant only when
// something needs one (reminders, the calendar file). Doing the arithmetic on
// the local strings means "5 PM" stays 5 PM across the November clock change.

const pad = (n) => String(n).padStart(2, "0");

function partsInZone(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute };
}

// Wall-clock time in `tz` -> epoch ms. Settles the zone's offset twice because
// a day containing a daylight-saving change is where one pass is an hour out.
export function zonedToUtc(date, time, tz) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = partsInZone(guess, tz);
    guess += want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return guess;
}

export function todayInZone(ms, tz) {
  const p = partsInZone(ms, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

export function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // "2026-13-45" is the right shape but not a date; toISOString() would throw on it.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(date, n) {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export const dowOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

export function mondayOf(date) {
  const dow = dowOf(date);
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

export function sundayOf(date) {
  return addDays(date, -dowOf(date));
}

export function fmtDay(date, opts = { weekday: "short", month: "short", day: "numeric" }) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

export function fmtTime(time) {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

// 20261007T230000Z
export const compactUtc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
