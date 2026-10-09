import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { zonedToUtc } from "../src/time.js";

const NOW = zonedToUtc("2026-10-06", "10:00", "America/Denver"); // Tue; week of Oct 4 (Springwater)
const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections?.(); s.close(); }));
const tick = () => new Promise((r) => setTimeout(r, 60));

function start({ none = false, over = {} } = {}) {
  const db = openDb(":memory:");
  const cfg = { ...loadConfig({ ADMIN_PASSWORD: "pw", SELF_URL: "https://x.test" }), ...over };
  const sent = [];
  const clock = { t: NOW };
  const sendSms = none ? null : async (to, body) => { sent.push({ to, body }); };
  const server = createApp({ db, cfg, now: () => clock.t, sendSms }).listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = { Authorization: "Basic " + Buffer.from("a:pw").toString("base64") };
  const j = (p, body, headers = {}) => fetch(base + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return { db, cfg, base, j, sent, clock, admin, a: (p, b) => j(p, b, admin) };
}

// Fill the rest of the week (Tue Oct 6 evening .. Sat Oct 10): every future slot booked.
async function fillWeek(t) {
  const week = await (await t.j("/api/week?start=2026-10-04")).json();
  const tokens = {};
  let n = 0;
  for (const d of week.days) for (const s of d.slots) {
    if (s.status !== "open") continue;
    const r = await t.j("/api/book", { date: d.date, time: s.time, family: `Fam${n}`, phone: `80155501${String(n).padStart(2, "0")}`, address: "1 Main" });
    assert.equal(r.status, 201);
    tokens[`${d.date} ${s.time}`] = (await r.json()).token;
    n++;
  }
  return tokens;
}
const join = (t, o = {}) => t.j("/api/waitlist", { weekStart: "2026-10-04", family: "Waits", phone: "801-555-0999", consent: true, ...o });

test("a full week is flagged; an open week is not; wait-list only offered when texting works", async () => {
  const t = start();
  assert.equal((await (await t.j("/api/week?start=2026-10-04")).json()).full, false);
  assert.equal((await join(t)).status, 400); // still open times: book directly
  await fillWeek(t);
  const wk = await (await t.j("/api/week?start=2026-10-04")).json();
  assert.equal(wk.full, true);
  assert.equal((await (await t.j("/api/week?start=2026-10-11")).json()).full, false); // next week untouched

  const off = start({ none: true });
  await fillWeek(off);
  assert.equal((await join(off)).status, 503);
});

test("joining: consent, validation, one spot per phone, listed for the admin", async () => {
  const t = start();
  await fillWeek(t);
  assert.equal((await join(t, { consent: false })).status, 400);
  assert.equal((await join(t, { family: "" })).status, 400);
  assert.equal((await join(t, { phone: "12" })).status, 400);
  assert.equal((await join(t, { weekStart: "2026-10-05" })).status, 400);       // not a week start
  assert.equal((await join(t)).status, 201);
  assert.equal((await join(t)).status, 409);                                    // same phone twice
  assert.equal((await join(t, { family: "Other", phone: "801-555-0998" })).status, 201);
  const d = await (await t.a("/api/admin/waitlist")).json();
  assert.deepEqual(d.entries.map((e) => [e.family, e.ward]), [["Waits Family", "Springwater"], ["Other Family", "Springwater"]]);
  assert.equal((await t.j("/api/admin/waitlist")).status, 401);
});

test("a cancellation texts the wait-list first and holds the time; public can't take it; waitlister can; first wins", async () => {
  const t = start();
  const tokens = await fillWeek(t);
  const a = await (await join(t)).json();
  const b = await (await join(t, { family: "Second", phone: "801-555-0998" })).json();

  // someone cancels Thursday 7:30 PM
  assert.equal((await t.j(`/api/booking/${tokens["2026-10-08 19:30"]}/cancel`, {})).status, 200);
  await tick();
  const toWaiters = t.sent.filter((m) => /opened up/.test(m.body));
  assert.deepEqual(toWaiters.map((m) => m.to).sort(), ["+18015550998", "+18015550999"]);
  assert.match(toWaiters[0].body, /Thu, Oct 8 7:30 PM/);
  assert.match(toWaiters[0].body, /first pick for the next 30 minutes/);
  assert.match(toWaiters[0].body, /https:\/\/x\.test\/w\//);
  assert.match(toWaiters[0].body, /Springwater Ward/);

  // the public sheet shows it held, not open, and a public booking is refused with a reason
  const wk = await (await t.j("/api/week?start=2026-10-04")).json();
  assert.equal(wk.days.find((d) => d.date === "2026-10-08").slots[0].status, "held");
  assert.equal(wk.full, true); // still nothing a stranger can book
  const pub = await t.j("/api/book", { date: "2026-10-08", time: "19:30", family: "Quick", phone: "801-555-0777" });
  assert.equal(pub.status, 409);
  assert.match((await pub.json()).error, /wait-list first/);

  // the waitlister's own page offers it, and booking works through their link
  const view = await (await t.j(`/api/waitlist/${a.token}`)).json();
  assert.equal(view.position, 1);
  assert.deepEqual(view.times.map((x) => [x.date, x.time, x.status]), [["2026-10-08", "19:30", "held"]]);
  const got = await t.j(`/api/waitlist/${a.token}/book`, { date: "2026-10-08", time: "19:30" });
  assert.equal(got.status, 201);
  const mine = await (await t.j(`/api/booking/${(await got.json()).token}`)).json();
  assert.equal(mine.family, "Waits Family");

  // the second waitlister lost the race, politely; the first is off the list
  const late = await t.j(`/api/waitlist/${b.token}/book`, { date: "2026-10-08", time: "19:30" });
  assert.equal(late.status, 409);
  assert.match((await late.json()).error, /someone else/);
  assert.equal((await (await t.j(`/api/waitlist/${a.token}`)).json()).status, "booked");
  assert.equal((await (await t.j(`/api/waitlist/${b.token}`)).json()).position, 1);
  assert.equal((await t.j(`/api/waitlist/${a.token}/book`, { date: "2026-10-08", time: "20:15" })).status, 409); // no longer waiting
});

test("after the hold the time opens to everyone; a hold of 0 only notifies", async () => {
  const t = start();
  const tokens = await fillWeek(t);
  await join(t);
  await t.j(`/api/booking/${tokens["2026-10-08 19:30"]}/cancel`, {});
  await tick();
  t.clock.t += 31 * 60_000;
  const wk = await (await t.j("/api/week?start=2026-10-04")).json();
  assert.equal(wk.days.find((d) => d.date === "2026-10-08").slots[0].status, "open");
  assert.equal((await t.j("/api/book", { date: "2026-10-08", time: "19:30", family: "Quick", phone: "801-555-0777" })).status, 201);

  const t0 = start({ over: { waitlistHoldMinutes: 0 } });
  const tk = await fillWeek(t0);
  await join(t0);
  await t0.j(`/api/booking/${tk["2026-10-08 19:30"]}/cancel`, {});
  await tick();
  assert.equal(t0.sent.filter((m) => /opened up/.test(m.body)).length, 1);
  assert.doesNotMatch(t0.sent.at(-1).body, /first pick/);
  assert.equal((await t0.j("/api/book", { date: "2026-10-08", time: "19:30", family: "Quick", phone: "801-555-0777" })).status, 201); // no hold
});

test("no wait-list for that week means no hold; other weeks' lists aren't texted; admin can book through a hold", async () => {
  const t = start();
  const tokens = await fillWeek(t);
  await t.j(`/api/booking/${tokens["2026-10-07 18:45"]}/cancel`, {});
  await tick();
  assert.equal((await t.j("/api/week?start=2026-10-04")).status, 200);
  assert.equal((await t.j("/api/book", { date: "2026-10-07", time: "18:45", family: "Quick", phone: "801-555-0777" })).status, 201); // immediately open

  await join(t);
  await t.j(`/api/booking/${tokens["2026-10-09 10:00"]}/cancel`, {}); // Friday
  await tick();
  assert.equal((await t.j("/api/book", { date: "2026-10-09", time: "10:00", family: "Quick2", phone: "801-555-0778" })).status, 409); // held
  assert.equal((await t.a("/api/admin/book", { date: "2026-10-09", time: "10:00", family: "Office", phone: "801-555-0779" })).status, 201);
});

test("leaving, being removed, and a waiter who books through the normal sheet stop waiting; missionaries are still told", async () => {
  const t = start();
  const tokens = await fillWeek(t);
  const a = await (await join(t)).json();
  await join(t, { family: "Gone", phone: "801-555-0998" });
  await join(t, { family: "Normal", phone: "801-555-0997" });
  await t.j(`/api/waitlist/${a.token}/leave`, {});
  const list = (await (await t.a("/api/admin/waitlist")).json()).entries;
  await t.a(`/api/admin/waitlist/${list.find((e) => e.family === "Gone Family").id}/remove`, {});
  assert.equal((await (await t.a("/api/admin/waitlist")).json()).entries.length, 1);

  // "Normal" books a time the ordinary way after the hold passes -> off the list
  await t.j(`/api/booking/${tokens["2026-10-10 15:00"]}/cancel`, {});
  await tick();
  t.clock.t += 31 * 60_000;
  assert.equal((await t.j("/api/book", { date: "2026-10-10", time: "15:00", family: "Normal", phone: "801-555-0997" })).status, 201);
  assert.equal((await (await t.a("/api/admin/waitlist")).json()).entries.length, 0);

  // the missionaries' phone still got its cancellation text alongside the wait-list texts
  assert.ok(t.sent.some((m) => m.to === "+13852337693" && /^Missionary Visits: visit cancelled/.test(m.body)));
});

test("hold setting is validated and saved", async () => {
  const t = start();
  assert.equal((await t.a("/api/admin/settings", { waitlistHoldMinutes: 999 })).status, 400);
  assert.equal((await t.a("/api/admin/settings", { waitlistHoldMinutes: 15 })).status, 200);
  assert.equal(t.cfg.waitlistHoldMinutes, 15);
});
