import { zonedToUtc, todayInZone, addDays, dowOf, sundayOf, isDate, fmtDay, fmtTime } from "./time.js";
import { slotTimesOn } from "./config.js";

// Last bookable day: the Saturday ending the final week of the final cycle.
export const windowEnd = (cfg) => addDays(cfg.rotationStart, cfg.wards.length * cfg.rotationCycles * 7 - 1);

// null when (date, time) is bookable right now, else a sentence for the person.
export function slotProblem(cfg, date, time, nowMs) {
  if (!isDate(date) || !slotTimesOn(cfg, dowOf(date)).includes(time)) {
    return "That time is not one of the available slots.";
  }
  const today = todayInZone(nowMs, cfg.tz);
  if (date > windowEnd(cfg)) return "That date is too far ahead to sign up for yet.";
  if (zonedToUtc(date, time, cfg.tz) <= nowMs) return "That time has already passed.";
  return null;
}

// Which ward's week this is, or null before the rotation began.
export function wardForWeek(cfg, sunday) {
  if (!cfg.wards.length) return null;
  const weeks = Math.round((Date.parse(`${sunday}T00:00:00Z`) - Date.parse(`${cfg.rotationStart}T00:00:00Z`)) / (7 * 86400_000));
  if (weeks < 0 || weeks >= cfg.wards.length * cfg.rotationCycles) return null;
  return cfg.wards[weeks % cfg.wards.length];
}

// What the calendar screen draws for one week. Phone numbers never appear here.
export function buildWeek(cfg, nowMs, startParam, bookings, blocked) {
  const today = todayInZone(nowMs, cfg.tz);
  const first = sundayOf(today);
  const last = sundayOf(windowEnd(cfg));
  let start = sundayOf(isDate(startParam) ? startParam : today);
  if (start < first) start = first;
  if (start > last) start = last;

  const byKey = new Map(bookings.map((b) => [`${b.slot_date} ${b.slot_time}`, b]));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    days.push({
      date,
      label: fmtDay(date, { weekday: "short" }),
      sub: fmtDay(date, { month: "short", day: "numeric" }),
      isToday: date === today,
      slots: slotTimesOn(cfg, dowOf(date)).map((time) => {
        const key = `${date} ${time}`;
        const b = byKey.get(key);
        let status = "open";
        if (b) status = "booked";
        else if (zonedToUtc(date, time, cfg.tz) <= nowMs || date > windowEnd(cfg)) status = "past";
        else if (blocked.has(key)) status = "blocked";
        return { time, label: fmtTime(time), status, family: b ? b.family : undefined };
      }),
    });
  }
  const end = addDays(start, 6);
  return {
    weekStart: start,
    ward: wardForWeek(cfg, start),
    isCurrent: start === first,
    range: `${fmtDay(start, { month: "short", day: "numeric" })} – ${fmtDay(end, { month: "short", day: "numeric" })}`,
    prev: start > first ? addDays(start, -7) : null,
    next: addDays(start, 7) <= windowEnd(cfg) ? addDays(start, 7) : null,
    days,
  };
}

// First Sunday-start week, from this week on, that belongs to `ward` and still has an open time.
export function nextWardWeek(cfg, nowMs, ward, bookings, blocked) {
  let start = sundayOf(todayInZone(nowMs, cfg.tz));
  const last = sundayOf(windowEnd(cfg));
  for (; start <= last; start = addDays(start, 7)) {
    if (wardForWeek(cfg, start) !== ward) continue;
    const week = buildWeek(cfg, nowMs, start, bookings, blocked);
    if (week.days.some((d) => d.slots.some((s) => s.status === "open"))) return start;
  }
  return null;
}
