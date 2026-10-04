import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { zonedToUtc } from "../src/time.js";
import { normalizePhone, cleanFamily } from "../src/people.js";
import { buildIcs } from "../src/ics.js";
import { runReminders } from "../src/reminders.js";

// Tue 2026-10-06 10:00 Denver (MDT, UTC-6)
const NOW = zonedToUtc("2026-10-06", "10:00", "America/Denver");
const cfg = loadConfig({ ADMIN_PASSWORD: "pw", SELF_URL: "https://x.test" });

const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections?.(); s.close(); })); // a failed assertion must not leave a server holding the process open

async function start(over = {}) {
  const db = openDb(":memory:");
  const c = { ...cfg, ...over };
  const clock = { t: NOW };
  const server = createApp({ db, cfg: c, now: () => clock.t }).listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = (p, body, headers = {}) => fetch(base + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return { db, base, j, clock, c, close: () => server.close() };
}

test("time zone conversion across the November clock change", () => {
  assert.equal(new Date(zonedToUtc("2026-10-07", "17:00", "America/Denver")).toISOString(), "2026-10-07T23:00:00.000Z");
  assert.equal(new Date(zonedToUtc("2026-11-10", "17:00", "America/Denver")).toISOString(), "2026-11-11T00:00:00.000Z");
});

test("input cleaning", () => {
  assert.equal(normalizePhone("(801) 555-0123"), "+18015550123");
  assert.equal(normalizePhone("1-801-555-0123"), "+18015550123");
  assert.equal(normalizePhone("555-0123"), null);
  assert.equal(cleanFamily("  Smith Family "), "Smith");
  assert.equal(cleanFamily("<b>Lee</b>"), "bLee/b");
  assert.equal(cleanFamily("   "), null);
});

test("booking: shows family, hides phone, blocks double booking", async () => {
  const t = await start();
  let r = await t.j("/api/book", { date: "2026-10-07", time: "18:45", family: "Smith Family", phone: "801-555-0123" });
  assert.equal(r.status, 201);
  const { token } = await r.json();

  const week = await (await t.j("/api/week?start=2026-10-04")).json();
  const wed = week.days.find((d) => d.date === "2026-10-07");
  assert.equal(wed.slots[0].status, "booked");
  assert.equal(wed.slots[0].family, "Smith");
  assert.equal(wed.slots[1].status, "open");
  assert.ok(!JSON.stringify(week).includes("555"), "phone leaked into the public week");
  assert.equal(week.ward, "Springwater"); // week 3 of the rotation
  assert.equal(week.isCurrent, true);  // NOW is Tue Oct 6, inside the week of Oct 4
  assert.equal((await (await t.j("/api/week?start=2026-10-11")).json()).isCurrent, false);
  const cur = await (await t.j("/api/week")).json(); // default view = the week we are in (Sun Oct 4 .. NOW is Tue Oct 6)
  assert.equal(cur.weekStart, "2026-10-04");
  assert.equal(cur.isCurrent, true);
  assert.equal(cur.ward, "Springwater");
  const later = await (await t.j("/api/week?start=2026-10-11")).json(); // skipping ahead changes the ward with it
  assert.equal(later.ward, "White Hills");
  assert.equal((await (await t.j("/api/week?start=2026-11-01")).json()).ward, "Harmony"); // rotation wraps after six weeks
  assert.equal(week.days.length, 7);       // Sunday through Saturday
  assert.deepEqual(week.days[5].slots.map((x) => x.label), ["10:00 AM", "10:45 AM"]); // Friday mornings

  r = await t.j("/api/book", { date: "2026-10-07", time: "18:45", family: "Jones", phone: "801-555-0199" });
  assert.equal(r.status, 409);

  // cancelling frees the slot
  assert.equal((await t.j(`/api/booking/${token}/cancel`, {})).status, 200);
  r = await t.j("/api/book", { date: "2026-10-07", time: "18:45", family: "Jones", phone: "801-555-0199" });
  assert.equal(r.status, 201);
  t.close();
});

test("booking: rejects past, bad slots, bad phone", async () => {
  const t = await start();
  const book = (o) => t.j("/api/book", { date: "2026-10-07", time: "18:45", family: "A", phone: "8015550123", ...o });
  assert.equal((await book({ date: "2026-10-05", time: "19:30" })).status, 400); // past
  assert.equal((await book({ date: "2026-10-09", time: "19:30" })).status, 400); // Friday has no evening slot
  assert.equal((await book({ time: "03:00" })).status, 400);
  assert.equal((await book({ phone: "12" })).status, 400);
  assert.equal((await book({ family: "" })).status, 400);
  assert.equal((await book({ date: "2027-10-07" })).status, 400); // too far
  // four cycles x six wards = 24 weeks; Fri Mar 5 2027 is inside the last one, Fri Mar 12 is past the end
  assert.equal((await book({ date: "2027-03-05", time: "10:00" })).status, 201);
  assert.equal((await book({ date: "2027-03-12", time: "10:00" })).status, 400);
  const last = await (await t.j("/api/week?start=2027-03-14")).json(); // clamped back to the final week
  assert.equal(last.weekStart, "2027-02-28");
  assert.equal(last.next, null);
  assert.equal(last.ward, "Fairfield");
  t.close();
});

test("ics download is a valid event with the right instant", async () => {
  const t = await start();
  const { token } = await (await t.j("/api/book", { date: "2026-10-07", time: "18:45", family: "Smith", phone: "8015550123" })).json();
  const res = await fetch(`${t.base}/api/booking/${token}/ics`);
  assert.match(res.headers.get("content-type"), /text\/calendar/);
  const body = await res.text();
  assert.match(body, /DTSTART:20261008T004500Z\r\n/);
  assert.match(body, /DTEND:20261008T013000Z\r\n/);
  assert.match(body, /SUMMARY:Missionary visit — Smith Family/);
  assert.match(body, /TRIGGER:-P1D/);
  for (const line of body.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
  t.close();
});

test("reminders only offered when texting is configured", async () => {
  const off = await start();
  await off.j("/api/book", { date: "2026-10-08", time: "19:30", family: "A", phone: "8015550123", remindDay: true });
  assert.equal(off.db.prepare("SELECT remind_day FROM bookings").get().remind_day, 0);
  off.close();
});

test("reminders send once, at the right time, and not for cancelled visits", async () => {
  const t = await start({ twilio: { sid: "a", token: "b", from: "+1", service: "" } });
  const book = (date, extra) => t.j("/api/book", { date, time: "19:30", family: "Smith", phone: "8015550123", remindDay: true, remindHour: true, ...extra });
  const { token } = await (await book("2026-10-08")).json();   // Thu 7:30pm
  const cancelled = await (await book("2026-10-08", { time: "20:15" })).json();
  await t.j(`/api/booking/${cancelled.token}/cancel`, {});

  const sent = [];
  const send = async (to, body) => sent.push({ to, body });
  const run = (ms) => runReminders({ db: t.db, cfg: t.c, send, nowMs: ms });

  assert.equal(await run(NOW), 0); // too early
  const start1 = zonedToUtc("2026-10-08", "19:30", "America/Denver");
  assert.equal(await run(start1 - 24 * 3600_000 + 60_000), 1);
  assert.equal(await run(start1 - 24 * 3600_000 + 120_000), 0); // not twice
  assert.equal(await run(start1 - 3600_000 + 60_000), 1);
  assert.equal(await run(start1 + 1), 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, "+18015550123");
  assert.match(sent[0].body, /Thursday, Oct 8 at 7:30 PM/);
  assert.match(sent[0].body, new RegExp(token));
  t.close();
});

test("a failed text is recorded and never retried into a duplicate", async () => {
  const t = await start({ twilio: { sid: "a", token: "b", from: "+1", service: "" } });
  await t.j("/api/book", { date: "2026-10-08", time: "19:30", family: "S", phone: "8015550123", remindHour: true });
  const at = zonedToUtc("2026-10-08", "19:30", "America/Denver") - 1800_000;
  let calls = 0;
  const send = async () => { calls++; throw new Error("boom"); };
  await runReminders({ db: t.db, cfg: t.c, send, nowMs: at });
  await runReminders({ db: t.db, cfg: t.c, send, nowMs: at + 60_000 });
  assert.equal(calls, 1);
  assert.equal(t.db.prepare("SELECT sms_error FROM bookings").get().sms_error, "boom");
  t.close();
});

test("admin: closed without a password, gated with one, can block and cancel", async () => {
  const none = await start({ adminPassword: "" });
  assert.equal((await none.j("/admin")).status, 404);
  none.close();

  const t = await start();
  assert.equal((await t.j("/api/admin/state")).status, 401);
  const auth = { Authorization: "Basic " + Buffer.from("admin:pw").toString("base64") };
  assert.equal((await t.j("/api/admin/state", null, { Authorization: "Basic " + Buffer.from("admin:no").toString("base64") })).status, 401);
  assert.equal((await t.j("/api/admin/block", { date: "2026-10-08", time: "20:15" }, auth)).status, 200);
  const r = await t.j("/api/book", { date: "2026-10-08", time: "20:15", family: "S", phone: "8015550123" });
  assert.equal(r.status, 409);
  const week = await (await t.j("/api/week?start=2026-10-04")).json();
  assert.equal(week.days.find((d) => d.date === "2026-10-08").slots[1].status, "blocked");
  assert.equal((await t.j("/admin", null, auth)).status, 200);
  t.close();
});

test("missionary link: off without a key, secret-gated, shows phones, feeds a calendar", async () => {
  const off = await start();
  assert.equal((await off.j("/api/m/anything/visits")).status, 404);
  off.close();

  const s = await start({ missionaryKey: "sekret-key-123" });
  await s.j("/api/book", { date: "2026-10-08", time: "19:30", family: "Smith", phone: "(801) 555-0123" });
  const b2 = await (await s.j("/api/book", { date: "2026-10-09", time: "10:00", family: "Lee; Jr", phone: "801-555-0199" })).json();
  assert.ok(b2.token);

  assert.equal((await s.j("/api/m/wrong/visits")).status, 404);
  assert.equal((await fetch(s.base + "/m/wrong")).status, 404);
  assert.equal((await fetch(s.base + "/m/sekret-key-123")).status, 200);

  const { visits } = await (await s.j("/api/m/sekret-key-123/visits")).json();
  assert.equal(visits.length, 2);
  assert.equal(visits[0].phone, "(801) 555-0123");
  assert.equal(visits[0].ward, "Springwater");

  // The public week never carries a phone number.
  assert.ok(!JSON.stringify(await (await s.j("/api/week?start=2026-10-04")).json()).includes("555"));

  const all = await (await s.j("/api/m/sekret-key-123/visits.ics")).text();
  assert.equal((all.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(all, /Phone: \(801\) 555-0123/);
  assert.match(all, /Ward: Springwater/);

  const one = await (await s.j(`/api/m/sekret-key-123/visits.ics?ids=${visits[1].id}`)).text();
  assert.equal((one.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.ok(one.includes("Lee\\; Jr Family"));

  const feed = await s.j("/m/sekret-key-123/feed.ics");
  assert.match(feed.headers.get("content-type"), /text\/calendar/);
  assert.match(await feed.text(), /X-WR-CALNAME:Missionary visits/);

  await s.j(`/api/booking/${b2.token}/cancel`, {});
  assert.equal(((await (await s.j("/api/m/sekret-key-123/visits")).json()).visits).length, 1);
  s.close();
});

test("ward permalinks jump to that ward's next week with an open time", async () => {
  const s = await start();
  const go = async (p) => { const r = await fetch(s.base + p, { redirect: "manual" }); return [r.status, r.headers.get("location")]; };
  assert.deepEqual(await go("/SP"), [302, "/?start=2026-10-04"]);   // this week is Springwater's
  assert.deepEqual(await go("/sp"), [302, "/?start=2026-10-04"]);   // case doesn't matter
  assert.deepEqual(await go("/FF"), [302, "/?start=2026-10-25"]);
  assert.deepEqual(await go("/OT"), [302, "/?start=2026-11-08"]);   // this week was OT's but is past; next is 6 weeks out
  assert.deepEqual(await go("/HA"), [302, "/?start=2026-11-01"]);
  assert.equal((await go("/ZZ"))[0], 404);

  // Block every remaining time this week: Springwater's next open week is the next cycle.
  const times = ["18:45", "19:30", "20:15", "10:00", "10:45", "15:00", "15:45"];
  for (const d of ["04", "05", "06", "07", "08", "09", "10"]) for (const t of times) s.db.prepare("INSERT OR IGNORE INTO blocks (slot_date, slot_time) VALUES (?, ?)").run(`2026-10-${d}`, t);
  assert.deepEqual(await go("/SP"), [302, "/?start=2026-11-15"]);
  s.close();
});
