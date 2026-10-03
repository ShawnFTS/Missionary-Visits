import { compactUtc } from "./time.js";
import { displayFamily } from "./people.js";

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// RFC 5545: lines over 75 octets are folded with CRLF + space.
function fold(line) {
  const out = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function bookingEnd(b, minutes) {
  return b.start_utc + minutes * 60_000;
}

export function buildIcs(b, cfg, nowMs = Date.now()) {
  const title = `Missionary visit — ${displayFamily(b.family)}`;
  const desc = "The full-time missionaries are visiting your home." +
    (cfg.selfUrl ? ` Manage or cancel: ${cfg.selfUrl}/b/${b.token}` : "");
  const alarm = (trigger, text) => [
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(text)}`, `TRIGGER:${trigger}`, "END:VALARM",
  ];
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Eagle Mountain West Stake//Missionary Member Visits//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:visit-${b.token}@missionary-visits`,
    `DTSTAMP:${compactUtc(nowMs)}`,
    `DTSTART:${compactUtc(b.start_utc)}`,
    `DTEND:${compactUtc(bookingEnd(b, cfg.minutes))}`,
    `SUMMARY:${esc(title)}`,
    `DESCRIPTION:${esc(desc)}`,
    "STATUS:CONFIRMED",
    ...alarm("-P1D", "Missionaries visit tomorrow"),
    ...alarm("-PT1H", "Missionaries visit in 1 hour"),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function googleCalendarUrl(b, cfg) {
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: `Missionary visit — ${displayFamily(b.family)}`,
    dates: `${compactUtc(b.start_utc)}/${compactUtc(bookingEnd(b, cfg.minutes))}`,
    details: "The full-time missionaries are visiting your home.",
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}
