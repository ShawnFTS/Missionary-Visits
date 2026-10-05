// Two-way sync with the missionaries' Google Sheet. The missionaries cannot visit this site, so a script inside
// the Sheet (running as its owner) posts what they typed here and writes back the current visits.
//
// The Sheet is the missionaries' whole interface: visit list with notes, cancel/delete, the weekly schedule and
// closed times. Everything goes through the same functions the web page uses, so the rules are identical.
import crypto from "node:crypto";
import { fmtDay, fmtTime, sundayOf } from "./time.js";
import { displayFamily, formatPhone } from "./people.js";
import { googleMapsUrl } from "./ics.js";
import * as notes from "./notes.js";
import * as settings from "./settings.js";
import { slotTimesOn, allTimes } from "./config.js";

const hash = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 12);
const DAYS = 7;

export function visitRow(deps, b, n) {
  return {
    id: b.id,
    version: n?.updatedAt || 0,
    ward: deps.wardOf(b) || "",
    date: b.slot_date,
    dayLabel: fmtDay(b.slot_date, { weekday: "short", month: "short", day: "numeric" }),
    time: fmtTime(b.slot_time),
    family: displayFamily(b.family),
    phone: formatPhone(b.phone),
    address: b.address || "",
    mapUrl: b.address ? googleMapsUrl(b.address) : "",
    planned: n?.planned || "", taught: n?.taught || "", commitments: n?.commitments || "",
    followupDate: n?.followupDate || "", followupTime: n?.followupTime || "",
  };
}

function scheduleState(deps) {
  const v = settings.editableView(deps.cfg);
  const days = {};
  for (let d = 0; d < DAYS; d++) days[d] = v.schedule[d] || "";
  return { days, minutes: v.minutes, version: hash({ days, minutes: v.minutes }) };
}

function closedState(deps) {
  const rows = deps.blockList().map((k) => ({ date: k.date, time: fmtTime(k.time), label: k.label }));
  return { rows, version: hash(rows.map((r) => [r.date, r.time])) };
}

export function buildState(deps) {
  const up = deps.upcoming(), past = deps.recent();
  const n = notes.forBookings(deps.db, [...up, ...past].map((b) => b.id));
  const closed = closedState(deps);
  const state = {
    upcoming: up.map((b) => visitRow(deps, b, n.get(b.id))),
    recent: past.map((b) => visitRow(deps, b, n.get(b.id))),
    schedule: scheduleState(deps),
    closed: closed.rows,
    closedVersion: closed.version,
    times: allTimes(deps.cfg).map(fmtTime),
  };
  state.stateHash = hash(state);
  return state;
}

const same = (a, b) => notes.clean(a) === notes.clean(b);

function applyVisits(deps, rows, results) {
  for (const v of rows.slice(0, 600)) {
    const id = Number(v?.id);
    const b = Number.isInteger(id) ? deps.byId(id) : null;
    if (!b) { results.push({ section: "visit", id: v?.id ?? null, status: "gone", message: "This visit isn't there any more." }); continue; }
    const action = String(v.action ?? "").trim().toLowerCase();
    if (action.startsWith("cancel")) {
      if (b.cancelled_at == null) deps.cancelBooking(b, "missionary");
      results.push({ section: "visit", id, status: "cancelled", message: "Cancelled. The time is open again. The family is not told automatically, so please call or text them." });
      continue;
    }
    if (action.startsWith("delete")) {
      deps.deleteBooking(b, "missionary");
      results.push({ section: "visit", id, status: "deleted", message: "Deleted." });
      continue;
    }
    const cur = notes.get(deps.db, id);
    const changed = !same(v.planned, cur.planned) || !same(v.taught, cur.taught) || !same(v.commitments, cur.commitments)
      || String(v.followupDate ?? "").trim() !== cur.followupDate || String(v.followupTime ?? "").trim() !== cur.followupTime;
    if (!changed) continue;
    if (b.cancelled_at != null) { results.push({ section: "visit", id, status: "error", message: "That visit was cancelled, so notes can't be saved." }); continue; }
    if (Number(v.version || 0) !== (cur.updatedAt || 0)) {
      results.push({ section: "visit", id, status: "conflict", message: "Someone else changed this at the same time. Check it and try again." });
      continue;
    }
    const r = notes.save(deps.db, deps.cfg, id, {
      planned: v.planned, taught: v.taught, commitments: v.commitments, followupDate: v.followupDate, followupTime: v.followupTime,
    }, deps.now(), "missionary");
    results.push(r.error ? { section: "visit", id, status: "error", message: r.error } : { section: "visit", id, status: "saved", message: "Saved" });
  }
}

function applySchedule(deps, sch, results) {
  const cur = scheduleState(deps);
  const input = { schedule: {}, minutes: sch.minutes ?? deps.cfg.minutes };
  for (let d = 0; d < DAYS; d++) input.schedule[d] = sch.days?.[d] ?? sch.days?.[String(d)] ?? "";
  const { errors, values } = settings.validate(input);
  if (errors.length) { results.push({ section: "schedule", index: 0, status: "error", message: errors.join(" ") }); return; }
  let same_ = values.minutes === deps.cfg.minutes;
  for (let d = 0; d < DAYS && same_; d++) if (values.schedule[d].join() !== slotTimesOn(deps.cfg, d).join()) same_ = false;
  if (same_) return;
  if (sch.version !== cur.version) {
    results.push({ section: "schedule", index: 0, status: "conflict", message: "The schedule was changed somewhere else at the same time. Check it and try again." });
    return;
  }
  const r = settings.save(deps.db, deps.cfg, input, deps.now());
  if (r.errors) results.push({ section: "schedule", index: 0, status: "error", message: r.errors.join(" ") });
  else results.push({ section: "schedule", index: 0, status: "saved", message: ["Saved. The sign-up page is updated.", ...(r.warnings || [])].join(" ") });
}

function parseClosedRow(r) {
  const date = String(r?.date ?? "").trim();
  const t = String(r?.time ?? "").trim();
  // The Sheet script sends 24-hour "HH:MM" (two-digit hour); anything else is read as "7:30 PM".
  const m = /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : settings.parseTime(t);
  return { date, time: m };
}

function applyClosed(deps, rows, version, results) {
  const cur = closedState(deps);
  const have = new Set(deps.blockList().map((k) => `${k.date} ${k.time}`));
  const want = new Map();
  rows.forEach((r, index) => {
    if (!r || (!String(r.date ?? "").trim() && !String(r.time ?? "").trim())) return; // an empty row
    const p = parseClosedRow(r);
    if (!p.time || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) { results.push({ section: "closed", index, status: "error", message: "Pick a date and a time." }); return; }
    want.set(`${p.date} ${p.time}`, { ...p, index });
  });
  for (const [k, p] of want) {
    if (have.has(k)) continue;
    const r = deps.blockTime({ date: p.date, time: p.time });
    results.push(r.error ? { section: "closed", index: p.index, status: "error", message: r.error } : { section: "closed", index: p.index, status: "ok", message: "Closed." });
  }
  if (version === cur.version) {
    for (const k of have) if (!want.has(k)) { const [date, time] = k.split(" "); deps.unblockTime({ date, time }); }
  } else if ([...have].some((k) => !want.has(k))) {
    results.push({ section: "closed", index: -1, status: "conflict", message: "The list of closed times was changed somewhere else, so no times were reopened. Check the list and try again." });
  }
}

export function applySync(deps, body) {
  const results = [];
  const b = body && typeof body === "object" ? body : {};
  if (Array.isArray(b.visits)) applyVisits(deps, b.visits, results);
  if (b.schedule && typeof b.schedule === "object") applySchedule(deps, b.schedule, results);
  if (Array.isArray(b.closed)) applyClosed(deps, b.closed, String(b.closedVersion ?? ""), results);
  return { ok: true, serverTime: deps.now(), results, state: buildState(deps) };
}
