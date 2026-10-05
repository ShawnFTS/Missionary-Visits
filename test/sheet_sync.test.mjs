import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { zonedToUtc } from "../src/time.js";

const TZ = "America/Denver";
const NOW = zonedToUtc("2026-10-06", "10:00", TZ); // Tue; week of Oct 4 (Springwater)
const SECRET = "sheet-secret-0123456789";
const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections?.(); s.close(); }));
const tick = () => new Promise((r) => setTimeout(r, 80));

function start({ secret = SECRET } = {}) {
  const db = openDb(":memory:");
  const cfg = loadConfig({ ADMIN_PASSWORD: "pw", SELF_URL: "https://x.test", SHEET_SECRET: secret, MISSIONARY_KEY: "mk" });
  const sent = [];
  const server = createApp({ db, cfg, now: () => NOW, sendSms: async (to, body) => { sent.push({ to, body }); } }).listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) => fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    db, cfg, sent,
    state: async () => (await (await call("GET", `/api/sheet/${SECRET}/state`)).json()).state,
    sync: async (body) => (await (await call("POST", `/api/sheet/${SECRET}/sync`, body)).json()),
    raw: call,
    pub: (method, p, body) => call(method, p, body),
  };
}

async function book(t, family = "Test", phone = "801-555-0101", address = "1 Main St") {
  const week = await (await t.pub("GET", "/api/week?start=2026-10-04")).json();
  const day = week.days.find((d) => d.slots.some((s) => s.status === "open"));
  const slot = day.slots.find((s) => s.status === "open");
  const r = await t.pub("POST", "/api/book", { date: day.date, time: slot.time, family, phone, address });
  assert.equal(r.status, 201);
  const { token } = await r.json();
  return { ...t.db.prepare(`SELECT id FROM bookings WHERE token = ?`).get(token), token, date: day.date, time: slot.time };
}
function pastVisit(t, family = "Past", date = "2026-09-30", time = "19:00") {
  const r = t.db.prepare(`INSERT INTO bookings (token, slot_date, slot_time, start_utc, family, phone, remind_day, remind_hour, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`).run(`past-${family}`, date, time, zonedToUtc(date, time, TZ), family, "+18015550199", NOW - 9e9);
  return Number(r.lastInsertRowid);
}
// A sheet row for a visit, as the Sheet script would send it.
const row = (v, over = {}) => ({ id: v.id, version: v.version, action: "", planned: v.planned, taught: v.taught, commitments: v.commitments, followupDate: v.followupDate, followupTime: v.followupTime, ...over });

test("the sync address is private: wrong secret, or no secret configured, is a plain 404", async () => {
  const t = start();
  assert.equal((await t.raw("GET", "/api/sheet/nope/state")).status, 404);
  assert.equal((await t.raw("POST", "/api/sheet/nope/sync", { visits: [] })).status, 404);
  const off = start({ secret: "" });
  assert.equal((await off.raw("GET", `/api/sheet/${SECRET}/state`)).status, 404);
  assert.equal((await off.raw("GET", "/api/sheet//state")).status, 404);
});

test("state lists upcoming and recent visits with everything the missionaries need, plus schedule, closed times and time choices", async () => {
  const t = start();
  const b = await book(t, "Reyes", "801-555-0101", "12 Oak St, Eagle Mountain UT");
  pastVisit(t, "Olsen");
  const s = await t.state();
  const v = s.upcoming.find((x) => x.id === b.id);
  assert.equal(v.family, "Reyes Family");
  assert.equal(v.phone, "(801) 555-0101");
  assert.equal(v.address, "12 Oak St, Eagle Mountain UT");
  assert.match(v.mapUrl, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=12%20Oak/);
  assert.equal(v.ward, "Springwater");
  assert.equal(v.version, 0);
  assert.deepEqual(s.recent.map((x) => x.family), ["Olsen Family"]);
  assert.equal(Object.keys(s.schedule.days).length, 7);
  assert.equal(typeof s.schedule.minutes, "number");
  assert.ok(s.times.includes("7:30 PM"));
  assert.deepEqual(s.closed, []);
  assert.match(s.stateHash, /^[0-9a-f]{12}$/);
  assert.equal((await t.state()).stateHash, s.stateHash); // stable when nothing changed
});

test("notes typed in the Sheet are saved; sending the same thing again changes nothing", async () => {
  const t = start();
  const b = await book(t);
  const v0 = (await t.state()).upcoming[0];
  const r = await t.sync({ visits: [row(v0, { planned: "Plan of Salvation", taught: "Lesson 1", commitments: "Read 3 Nephi 11", followupDate: "2026-10-12", followupTime: "18:30" })] });
  assert.deepEqual(r.results.map((x) => [x.id, x.status]), [[b.id, "saved"]]);
  const v1 = r.state.upcoming[0];
  assert.equal(v1.planned, "Plan of Salvation");
  assert.equal(v1.followupTime, "18:30");
  assert.ok(v1.version > 0);
  const again = await t.sync({ visits: [row(v1)] });
  assert.deepEqual(again.results, []);                       // nothing to do
  assert.notEqual(again.state.stateHash, r.state.stateHash === undefined ? "" : "x");
  // a follow-up reminder reaches the missionaries' calendar feed exactly as before
  assert.ok(t.db.prepare(`SELECT followup_date FROM visit_notes WHERE booking_id = ?`).get(b.id).followup_date === "2026-10-12");
});

test("bad notes come back as an error on that row and change nothing", async () => {
  const t = start();
  await book(t);
  const v = (await t.state()).upcoming[0];
  const r = await t.sync({ visits: [row(v, { planned: "x", followupDate: "2026-13-45" })] });
  assert.equal(r.results[0].status, "error");
  assert.match(r.results[0].message, /follow-up date/i);
  assert.equal(t.db.prepare(`SELECT COUNT(1) c FROM visit_notes`).get().c, 0);
  const gone = await t.sync({ visits: [{ id: 99999, version: 0, action: "", planned: "x" }] });
  assert.equal(gone.results[0].status, "gone");
});

test("a stale version is a conflict: the server keeps its own values", async () => {
  const t = start();
  const b = await book(t);
  const v = (await t.state()).upcoming[0];
  await t.sync({ visits: [row(v, { planned: "first" })] });                      // saved, version moves on
  const stale = await t.sync({ visits: [row(v, { planned: "second" })] });       // still carries the old version
  assert.equal(stale.results[0].status, "conflict");
  assert.equal(stale.state.upcoming[0].planned, "first");
});

test("cancel and delete from the Sheet use the real rules: the time reopens, missionaries are not texted about their own action", async () => {
  const t = start();
  const a = await book(t, "Cancel", "801-555-0111");
  const d = await book(t, "Delete", "801-555-0112");
  const s = await t.state();
  const r = await t.sync({ visits: [row(s.upcoming.find((x) => x.id === a.id), { action: "Cancel this visit" }), row(s.upcoming.find((x) => x.id === d.id), { action: "Delete this visit" })] });
  assert.deepEqual(r.results.map((x) => x.status).sort(), ["cancelled", "deleted"]);
  assert.match(r.results.find((x) => x.status === "cancelled").message, /not told automatically/i);
  assert.deepEqual(r.state.upcoming, []);
  await tick();
  assert.equal(t.sent.length, 0);
  assert.equal(t.db.prepare(`SELECT cancelled_by FROM bookings WHERE id = ?`).get(a.id).cancelled_by, "missionary");
  assert.equal(t.db.prepare(`SELECT COUNT(1) c FROM bookings WHERE id = ?`).get(d.id).c, 0);
  const week = await (await t.pub("GET", "/api/week?start=2026-10-04")).json();
  assert.equal(week.days.find((x) => x.date === a.date).slots.find((x) => x.time === a.time).status, "open");
});

test("the weekly schedule is edited from the Sheet with the admin's rules", async () => {
  const t = start();
  const s0 = (await t.state()).schedule;
  // unchanged text in a different style is not a change
  const same = await t.sync({ schedule: { days: { ...s0.days, 3: s0.days[3].toLowerCase().replace(/ /g, "") }, minutes: s0.minutes, version: s0.version } });
  assert.deepEqual(same.results, []);
  const ok = await t.sync({ schedule: { days: { ...s0.days, 1: "6pm, 6:45pm" }, minutes: 30, version: s0.version } });
  assert.equal(ok.results[0].status, "saved");
  assert.equal(ok.state.schedule.days[1], "6:00 PM, 6:45 PM");
  assert.equal(ok.state.schedule.minutes, 30);
  assert.equal(t.cfg.minutes, 30);
  const bad = await t.sync({ schedule: { days: { ...ok.state.schedule.days, 2: "7:30" }, minutes: 30, version: ok.state.schedule.version } });
  assert.equal(bad.results[0].status, "error");
  assert.match(bad.results[0].message, /AM or PM/);
  const stale = await t.sync({ schedule: { days: { ...ok.state.schedule.days, 4: "5 PM" }, minutes: 30, version: s0.version } });
  assert.equal(stale.results[0].status, "conflict");
  assert.equal(stale.state.schedule.days[4], ok.state.schedule.days[4]);
  // null means "leave it alone"
  assert.deepEqual((await t.sync({ schedule: null, closed: null })).results, []);
});

test("closed times: add a row to close, remove a row to reopen; stale lists never reopen anything", async () => {
  const t = start();
  const s0 = await t.state();
  const closed = await t.sync({ closed: [{ date: "2026-10-14", time: "19:30" }], closedVersion: s0.closedVersion });
  assert.deepEqual(closed.results.map((x) => x.status), ["ok"]);
  assert.deepEqual(closed.state.closed.map((x) => [x.date, x.time]), [["2026-10-14", "7:30 PM"]]);
  const week = await (await t.pub("GET", "/api/week?start=2026-10-11")).json();
  assert.equal(week.days.find((d) => d.date === "2026-10-14").slots.find((x) => x.time === "19:30").status, "blocked");

  // morning times in 24-hour form are fine, and "7:30 PM" text is accepted too
  const more = await t.sync({ closed: [{ date: "2026-10-14", time: "7:30 PM" }, { date: "2026-10-16", time: "10:00" }], closedVersion: closed.state.closedVersion });
  assert.deepEqual(more.state.closed.map((x) => x.time), ["7:30 PM", "10:00 AM"]);

  // someone closed a time on the admin page; the Sheet (with an old version) must not reopen it
  t.db.prepare(`INSERT INTO blocks (slot_date, slot_time) VALUES ('2026-10-15', '19:30')`).run();
  const stale = await t.sync({ closed: [{ date: "2026-10-14", time: "19:30" }, { date: "2026-10-16", time: "10:00" }], closedVersion: more.state.closedVersion });
  assert.ok(stale.results.some((x) => x.section === "closed" && x.status === "conflict"));
  assert.equal(stale.state.closed.length, 3);                                   // nothing was reopened

  // removing rows with an up-to-date version reopens
  const fresh = await t.state();
  const reopen = await t.sync({ closed: [{ date: "2026-10-14", time: "19:30" }], closedVersion: fresh.closedVersion });
  assert.deepEqual(reopen.state.closed.map((x) => x.date), ["2026-10-14"]);
});

test("closed times: invalid rows are reported by position, empty rows ignored, a booked time can't be closed", async () => {
  const t = start();
  const b = await book(t);
  const s0 = await t.state();
  const r = await t.sync({ closed: [{ date: "", time: "" }, { date: "2026-13-45", time: "19:30" }, { date: b.date, time: b.time }], closedVersion: s0.closedVersion });
  const errs = r.results.filter((x) => x.status === "error");
  assert.deepEqual(errs.map((x) => x.index).sort(), [1, 2]);
  assert.match(errs.find((x) => x.index === 2).message, /already signed up/i);
  assert.deepEqual(r.state.closed, []);
});

test("a full sheet is bigger than the normal 10 KB request limit and still goes through", async () => {
  const t = start();
  await book(t);
  const v = (await t.state()).upcoming[0];
  const filler = Array.from({ length: 400 }, (_, i) => ({ id: 100000 + i, version: 0, action: "", planned: "x".repeat(200), taught: "", commitments: "", followupDate: "", followupTime: "" }));
  const body = { visits: [row(v), ...filler] };
  assert.ok(JSON.stringify(body).length > 50_000);
  const r = await t.sync(body);
  assert.equal(r.ok, true);
  assert.equal(r.results.filter((x) => x.status === "gone").length, 400);
  // the ordinary API keeps its small limit
  const huge = await t.pub("POST", "/api/book", { family: "x".repeat(20000) });
  assert.ok(huge.status >= 400, "the ordinary API still refuses a body that big");
});
