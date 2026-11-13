// Attendance history for the missionary coordination meeting: a count per meeting, who came from which ward,
// and a simple trend. Read-only: it only reads what /leaders already records. Also draws the PDF report.
import PDFDocument from "pdfkit";
import { addDays, todayInZone } from "./time.js";
import { scheduledDates, meetingFor } from "./leaders.js";

const HELD_AFTER = 3 * 3600_000; // a meeting counts as held once it has started and a few hours have passed
export const RANGES = [3, 6, 12, 24];

// A short label like "Nov 12" (+ "'26" when it isn't this year) from a YYYY-MM-DD.
const monthDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const mdy = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const round1 = (n) => Math.round(n * 10) / 10;

export function attendanceHistory(db, cfg, nowMs, months = 12) {
  months = RANGES.includes(Number(months)) ? Number(months) : 12;
  const today = todayInZone(nowMs, cfg.tz);
  const from = addDays(today, -Math.round(months * 30.4));
  const dates = new Set(scheduledDates(cfg, from, today));
  for (const r of db.prepare(`SELECT date FROM leaders_meetings WHERE date >= ? UNION SELECT meeting_date FROM leaders_attendance WHERE meeting_date >= ?`).all(from, from)) dates.add(r.date);

  const rows = db.prepare(`SELECT meeting_date d, person_id pid, name, calling, ward FROM leaders_attendance WHERE meeting_date >= ?`).all(from);
  const byDate = new Map();
  for (const r of rows) (byDate.get(r.d) || byDate.set(r.d, []).get(r.d)).push(r);

  // Held meetings only: already over, not cancelled, and with attendance recorded. A past meeting with nobody
  // recorded is left out (and counted in `unrecorded`) so months from before anyone used the list don't read as zeros.
  const meetings = [];
  let cancelled = 0, unrecorded = 0;
  for (const date of [...dates].sort()) {
    const m = meetingFor(db, cfg, date);
    const here = byDate.get(date) || [];
    if (m.startUtc + HELD_AFTER > nowMs) continue;
    if (m.cancelled) { cancelled++; continue; }
    if (!here.length) { unrecorded++; continue; }
    const wards = [...new Set(here.map((a) => a.ward))];
    meetings.push({
      date, label: monthDay(m.effectiveDate), longLabel: mdy(m.effectiveDate), count: here.length,
      wardsRepresented: cfg.wards.filter((w) => wards.includes(w)).length, wardsTotal: cfg.wards.length,
      note: m.note || "",
    });
  }

  const counts = meetings.map((m) => m.count);
  const wardStats = [...cfg.wards, "Stake"].map((ward) => {
    const attended = meetings.filter((m) => (byDate.get(m.date) || []).some((a) => a.ward === ward)).length;
    const people = new Set(rows.filter((r) => r.ward === ward && meetings.some((m) => m.date === r.d)).map((r) => r.pid)).size;
    const total = rows.filter((r) => r.ward === ward && meetings.some((m) => m.date === r.d)).length;
    return { ward, meetingsAttended: attended, meetingsHeld: meetings.length, rate: meetings.length ? Math.round((attended / meetings.length) * 100) : 0, people, headcount: total };
  }).filter((w) => w.ward !== "Stake" || w.headcount > 0);

  const held = new Set(meetings.map((m) => m.date));
  const personMap = new Map();
  for (const r of rows) {
    if (!held.has(r.d)) continue;
    const p = personMap.get(r.pid) || { name: r.name, calling: r.calling, ward: r.ward, attended: 0, last: "" };
    p.attended++; p.name = r.d >= p.last ? r.name : p.name; p.calling = r.d >= p.last ? r.calling : p.calling; p.ward = r.d >= p.last ? r.ward : p.ward;
    if (r.d > p.last) p.last = r.d;
    personMap.set(r.pid, p);
  }
  const people = [...personMap.values()]
    .map((p) => ({ ...p, rate: meetings.length ? Math.round((p.attended / meetings.length) * 100) : 0, lastLabel: mdy(p.last) }))
    .sort((a, b) => b.attended - a.attended || a.name.localeCompare(b.name));

  // Trend: the last three held meetings against the three before them. Needs at least four to say anything.
  let trend = { direction: "none", text: "Not enough meetings yet to show a trend (needs at least 4)." };
  if (counts.length >= 4) {
    const recent = counts.slice(-3), before = counts.slice(-6, -3);
    const diff = avg(recent) - avg(before);
    const dir = diff >= 1 ? "up" : diff <= -1 ? "down" : "steady";
    trend = {
      direction: dir, recentAvg: round1(avg(recent)), beforeAvg: round1(avg(before)), change: round1(diff),
      text: dir === "steady" ? `Steady: the last ${recent.length} meetings averaged ${round1(avg(recent))}, about the same as the ${before.length} before (${round1(avg(before))}).`
        : `${dir === "up" ? "Up" : "Down"} ${Math.abs(round1(diff))}: the last ${recent.length} meetings averaged ${round1(avg(recent))} against ${round1(avg(before))} for the ${before.length} before.`,
    };
  }
  const best = meetings.reduce((b, m) => (!b || m.count > b.count ? m : b), null);
  const low = meetings.reduce((b, m) => (!b || m.count < b.count ? m : b), null);
  return {
    months, from, to: today, fromLabel: mdy(from), toLabel: mdy(today),
    summary: { held: meetings.length, cancelled, unrecorded, average: round1(avg(counts)), best: best && { label: best.longLabel, count: best.count }, lowest: low && { label: low.longLabel, count: low.count }, total: counts.reduce((s, x) => s + x, 0) },
    trend, meetings, wards: wardStats, people,
  };
}

// ---- the PDF -------------------------------------------------------------------------------------

const NAVY = "#1f3a5f", GOLD = "#b8892b", GREY = "#666666", LINE = "#d8d2c4";

export function attendancePdf(h, title = "Missionary Coordination Meeting") {
  const doc = new PDFDocument({ size: "LETTER", margins: { top: 54, bottom: 54, left: 54, right: 54 }, info: { Title: `${title}: attendance history` } });
  const W = doc.page.width - 108;
  const ensure = (need) => { if (doc.y + need > doc.page.height - 60) doc.addPage(); };
  const h2 = (t) => { ensure(60); doc.moveDown(0.8).font("Helvetica-Bold").fontSize(13).fillColor(NAVY).text(t).moveDown(0.3); doc.font("Helvetica").fontSize(10).fillColor("#000"); };

  doc.font("Helvetica-Bold").fontSize(20).fillColor(NAVY).text(title);
  doc.font("Helvetica").fontSize(12).fillColor(GREY).text(`Attendance history, ${h.fromLabel} to ${h.toLabel}`);
  doc.moveTo(54, doc.y + 6).lineTo(54 + W, doc.y + 6).strokeColor(GOLD).lineWidth(1.5).stroke();
  doc.moveDown(1);

  const s = h.summary;
  doc.font("Helvetica").fontSize(11).fillColor("#000");
  doc.text(`Meetings held: ${s.held}${s.cancelled ? `  (${s.cancelled} cancelled)` : ""}`);
  if (s.unrecorded) doc.text(`Meetings with no attendance recorded (not counted): ${s.unrecorded}`);
  doc.text(`Average attendance: ${s.average}`);
  if (s.best) doc.text(`Highest: ${s.best.count} on ${s.best.label}   Lowest: ${s.lowest.count} on ${s.lowest.label}`);
  doc.moveDown(0.3).font("Helvetica-Oblique").text(`Trend: ${h.trend.text}`).font("Helvetica");

  h2("Attendance by meeting");
  if (!h.meetings.length) doc.text("No meetings have been held in this period.");
  else {
    const chartH = 150, top = doc.y + 6, left = 54 + 26, cw = W - 30, max = Math.max(5, ...h.meetings.map((m) => m.count));
    const step = max <= 10 ? 2 : Math.ceil(max / 5);
    const topVal = Math.ceil(max / step) * step;
    for (let v = 0; v <= topVal; v += step) {
      const y = top + chartH - (v / topVal) * chartH;
      doc.moveTo(left, y).lineTo(left + cw, y).strokeColor(LINE).lineWidth(0.5).stroke();
      doc.font("Helvetica").fontSize(8).fillColor(GREY).text(String(v), 54, y - 4, { width: 20, align: "right" });
    }
    const slot = cw / h.meetings.length, bw = Math.min(28, slot * 0.6);
    h.meetings.forEach((m, i) => {
      const bh = (m.count / topVal) * chartH, x = left + slot * i + (slot - bw) / 2;
      doc.rect(x, top + chartH - bh, bw, bh).fillColor(NAVY).fill();
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#000").text(String(m.count), x - 6, top + chartH - bh - 10, { width: bw + 12, align: "center" });
      if (h.meetings.length <= 14 || i % 2 === 0) doc.font("Helvetica").fontSize(7).fillColor(GREY).text(m.label, x - 10, top + chartH + 4, { width: bw + 20, align: "center" });
    });
    // A dashed average line.
    const ay = top + chartH - (s.average / topVal) * chartH;
    doc.save().dash(4, { space: 3 }).moveTo(left, ay).lineTo(left + cw, ay).strokeColor(GOLD).lineWidth(1).stroke().restore();
    doc.font("Helvetica").fontSize(8).fillColor(GOLD).text(`average ${s.average}`, left + cw - 70, ay - 11, { width: 70, align: "right" });
    doc.y = top + chartH + 22;
    doc.x = 54;
  }

  const table = (heads, widths, data, align = []) => {
    const draw = (cells, bold, shade) => {
      ensure(18);
      const y = doc.y;
      if (shade) doc.rect(54, y - 2, W, 16).fillColor("#f3efe4").fill();
      let x = 54;
      cells.forEach((c, i) => {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor("#000").text(String(c), x + 2, y + 1, { width: widths[i] - 6, align: align[i] || "left", lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      doc.y = y + 16; doc.x = 54;
    };
    draw(heads, true, true);
    data.forEach((r) => draw(r, false, false));
  };

  h2("By ward");
  table(["Ward", "Meetings attended", "Rate", "Different people"], [150, 130, 80, 120],
    h.wards.map((w) => [w.ward, `${w.meetingsAttended} of ${w.meetingsHeld}`, `${w.rate}%`, w.people]), ["left", "left", "left", "left"]);

  h2("Meeting by meeting");
  table(["Date", "Attended", "Wards present", "Note"], [110, 80, 110, 190],
    [...h.meetings].reverse().map((m) => [m.longLabel, m.count, `${m.wardsRepresented} of ${m.wardsTotal}`, m.note]));

  h2("Individuals");
  const shown = h.people.slice(0, 60);
  table(["Name", "Calling", "Ward", "Attended", "Last"], [120, 130, 90, 70, 90],
    shown.map((p) => [p.name, p.calling, p.ward, `${p.attended} of ${h.summary.held}`, p.lastLabel]));
  if (h.people.length > shown.length) doc.moveDown(0.3).fillColor(GREY).text(`${h.people.length - shown.length} more not shown.`);

  doc.end();
  return doc;
}
