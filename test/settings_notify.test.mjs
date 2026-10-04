import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { zonedToUtc } from "../src/time.js";
import { parseTime, validate } from "../src/settings.js";

const NOW = zonedToUtc("2026-10-06", "10:00", "America/Denver"); // Tue
const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections?.(); s.close(); }));

function start({ db = openDb(":memory:"), sent = { sms: [] }, failSms = false, none = false, clock = { t: NOW } } = {}) {
  const cfg = loadConfig({ ADMIN_PASSWORD: "pw", SELF_URL: "https://x.test" });
  const sendSms = none ? null : async (to, body) => { if (failSms) throw new Error("carrier rejected"); sent.sms.push({ to, body }); };
  const server = createApp({ db, cfg, now: () => clock.t, sendSms }).listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = { Authorization: "Basic " + Buffer.from("a:pw").toString("base64") };
  const j = (p, body, headers = {}) => fetch(base + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  const a = (p, body) => j(p, body ?? (p.startsWith("/api/admin") && p.includes("remove") ? {} : undefined), admin);
  return { db, cfg, base, j, a, sent, clock };
}
const book = (t, o = {}) => t.j("/api/book", { date: "2026-10-08", time: "19:30", family: "Smith", phone: "8015550123", address: "1 Main St", ...o });
const tick = () => new Promise((r) => setTimeout(r, 50)); // notifications are fire-and-forget

test("time parsing is strict about AM/PM", () => {
  assert.equal(parseTime("7:30 PM"), "19:30");
  assert.equal(parseTime("7pm"), "19:00");
  assert.equal(parseTime("12:15 am"), "00:15");
  assert.equal(parseTime("12 PM"), "12:00");
  assert.equal(parseTime("19:30"), "19:30");
  assert.equal(parseTime("7:30"), null);   // ambiguous: refused, not guessed
  assert.equal(parseTime("10:00"), null);
  assert.equal(parseTime("25:00"), null);
  assert.equal(parseTime("soon"), null);
});

test("settings validation", () => {
  assert.equal(validate({ rotationStart: "2026-09-21" }).errors.length, 1);      // a Monday
  assert.equal(validate({ rotationStart: "2026-09-20" }).errors.length, 0);
  assert.equal(validate({ wards: "A\nB\na" }).errors.length, 1);                 // duplicate
  assert.deepEqual(validate({ wards: " A \n\nB, C\n" }).values.wards, ["A", "B C"]);
  assert.equal(validate({ minutes: 5 }).errors.length, 1);
  assert.equal(validate({ rotationCycles: 0 }).errors.length, 1);
  assert.equal(validate({ schedule: { 0: "7:30 PM", 1: "later" } }).errors.length, 1);
  assert.equal(validate({ schedule: {} }).errors.length, 1);                      // nothing at all
  assert.deepEqual(validate({ schedule: { 3: "7:30 PM, 6:45 PM" } }).values.schedule[3], ["18:45", "19:30"]);
});

test("changing schedule + rotation takes effect on the live page and never hides a booked family", async () => {
  const t = start();
  assert.equal((await book(t)).status, 201); // Thu Oct 8 7:30 PM

  const before = await (await t.j("/api/week?start=2026-10-04")).json();
  assert.equal(before.ward, "Springwater");

  // new schedule: Thursdays only 5:00 PM (7:30 PM is no longer offered); wards reordered, start moved a week
  let r = await t.a("/api/admin/settings", { schedule: { 0: "", 1: "", 2: "", 3: "", 4: "5:00 PM", 5: "", 6: "" }, minutes: 60 });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.warnings.join(" "), /no longer on the schedule/);
  assert.equal(body.settings.schedule[4], "5:00 PM");

  const week = await (await t.j("/api/week?start=2026-10-04")).json();
  const thu = week.days.find((d) => d.date === "2026-10-08");
  assert.deepEqual(thu.slots.map((s) => [s.label, s.status]), [["5:00 PM", "open"], ["7:30 PM", "booked"]]); // still there
  assert.equal(week.days.find((d) => d.date === "2026-10-07").slots.length, 0);
  assert.equal((await book(t, { date: "2026-10-08", time: "20:15", family: "Lee" })).status, 400); // removed time can't be booked

  r = await t.a("/api/admin/settings", { wards: "Alpha\nBeta", rotationStart: "2026-10-04", rotationCycles: 2 });
  assert.equal(r.status, 200);
  const w2 = await (await t.j("/api/week?start=2026-10-11")).json();
  assert.equal(w2.ward, "Beta");
  assert.equal((await (await t.j("/api/week?start=2026-10-04")).json()).ward, "Alpha");
  assert.equal(w2.next, "2026-10-18"); // four weeks only: Oct 4 .. Oct 31
  assert.equal((await (await t.j("/api/week?start=2026-11-08")).json()).weekStart, "2026-10-25");

  // ward shortcut links follow the new names
  const link = await fetch(`${t.base}/AL`, { redirect: "manual" });
  assert.equal(link.status, 302);

  // contact info shown on the page
  await t.a("/api/admin/settings", { missionaryPhone: "801-000-1111", helpName: "Pat", helpPhone: "801-000-2222" });
  const conf = await (await t.j("/api/config")).json();
  assert.equal(conf.missionaryPhone, "801-000-1111");
  assert.equal(conf.helpName, "Pat");
});

test("bad settings are refused with reasons and change nothing", async () => {
  const t = start();
  const r = await t.a("/api/admin/settings", { rotationStart: "2026-09-21", minutes: 1 });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).errors.length, 2);
  assert.equal(t.cfg.rotationStart, "2026-09-20");
  assert.equal((await t.j("/api/admin/settings", { minutes: 50 })).status, 401); // admin only
});

test("saved settings survive a restart", async () => {
  const db = openDb(":memory:");
  const t = start({ db });
  await t.a("/api/admin/settings", { wards: "Only One", rotationCycles: 3 });
  const t2 = start({ db }); // new app, same database, fresh config from env
  assert.deepEqual(t2.cfg.wards, ["Only One"]);
  assert.equal(t2.cfg.rotationCycles, 3);
});

test("contacts: a mobile is required, email is optional record-keeping, edit, remove", async () => {
  const t = start();
  assert.equal((await t.a("/api/admin/contacts", { name: "", phone: "385-233-7693" })).status, 400);
  assert.equal((await t.a("/api/admin/contacts", { name: "E" })).status, 400);                  // texts need a number
  assert.equal((await t.a("/api/admin/contacts", { name: "E", phone: "12" })).status, 400);
  assert.equal((await t.a("/api/admin/contacts", { name: "E", phone: "385-233-7693", email: "nope" })).status, 400);
  assert.equal((await t.a("/api/admin/contacts", { name: "Elder Jones", phone: "385-233-7693", email: "Jones@Example.org" })).status, 200);
  assert.equal((await t.a("/api/admin/contacts", { name: "Dup", phone: "(385) 233-7693" })).status, 409);
  assert.equal((await t.a("/api/admin/contacts", { name: "No email", phone: "801-555-0100" })).status, 200);
  assert.equal((await t.j("/api/admin/contacts", { name: "x", phone: "801-555-0101" })).status, 401);
  let d = await (await t.a("/api/admin/contacts")).json();
  assert.equal(d.contacts.length, 2);
  assert.equal(d.textReady, true);
  const jones = d.contacts.find((c) => c.name === "Elder Jones");
  assert.equal(jones.email, "jones@example.org");
  await t.a("/api/admin/contacts", { id: jones.id, name: "Elder J", phone: "385-233-7693", notifySignup: true });
  d = await (await t.a("/api/admin/contacts")).json();
  assert.deepEqual([d.contacts.find((c) => c.id === jones.id).name, d.contacts.find((c) => c.id === jones.id).notifySignup], ["Elder J", true]);
  await t.a(`/api/admin/contacts/${jones.id}/remove`);
  assert.equal((await (await t.a("/api/admin/contacts")).json()).contacts.length, 1);
});

test("a cancellation texts the missionaries once, and the time opens up again", async () => {
  const t = start();
  await t.a("/api/admin/contacts", { name: "Elder Jones", phone: "385-233-7693" });
  await t.a("/api/admin/contacts", { name: "Sister Lee", phone: "801-555-0100", notifyCancel: false }); // opted out
  const { token } = await (await book(t)).json();
  await tick();
  assert.equal(t.sent.sms.length, 0); // sign-up texts are off by default

  assert.equal((await t.j(`/api/booking/${token}/cancel`, {})).status, 200);
  assert.equal((await t.j(`/api/booking/${token}/cancel`, {})).status, 200); // double tap
  await tick();
  assert.equal(t.sent.sms.length, 1);
  assert.equal(t.sent.sms[0].to, "+13852337693");
  assert.match(t.sent.sms[0].body, /Visit cancelled: Smith Family, Thu, Oct 8 7:30 PM \(\(801\) 555-0123\)/);
  assert.match(t.sent.sms[0].body, /open again/);
  assert.match(t.sent.sms[0].body, /https:\/\/x\.test\/\?start=2026-10-04/);

  // the slot is open on the public sheet and another family can take it
  const wk = await (await t.j("/api/week?start=2026-10-04")).json();
  assert.equal(wk.days.find((d) => d.date === "2026-10-08").slots[0].status, "open");
  assert.equal((await book(t, { family: "Jones" })).status, 201);
});

test("admin cancel texts; sign-up text is opt-in; past visits are not texted", async () => {
  const t = start();
  await t.a("/api/admin/contacts", { name: "Elder A", phone: "385-233-7693", notifySignup: true });
  const { token } = await (await book(t)).json();
  await tick();
  assert.equal(t.sent.sms.length, 1);
  assert.match(t.sent.sms[0].body, /^New visit: Smith Family, Thu, Oct 8 7:30 PM, 1 Main St/);

  const id = t.db.prepare("SELECT id FROM bookings WHERE token = ?").get(token).id;
  await t.a(`/api/admin/cancel/${id}`, {});
  await tick();
  assert.equal(t.sent.sms.length, 2);
  assert.match(t.sent.sms[1].body, /^Visit cancelled/);

  const { token: t2 } = await (await book(t, { date: "2026-10-07", time: "19:30" })).json();
  t.clock.t = zonedToUtc("2026-10-08", "09:00", "America/Denver");
  const before = t.sent.sms.length;
  await t.j(`/api/booking/${t2}/cancel`, {});
  await tick();
  assert.equal(t.sent.sms.length, before);
});

test("delivery failures and unconfigured texting are logged, never thrown at the family", async () => {
  const bad = start({ failSms: true });
  await bad.a("/api/admin/contacts", { name: "Elder A", phone: "385-233-7693" });
  const { token } = await (await book(bad)).json();
  assert.equal((await bad.j(`/api/booking/${token}/cancel`, {})).status, 200);
  await tick();
  const log = (await (await bad.a("/api/admin/contacts")).json()).log;
  assert.equal(log[0].ok, false);
  assert.match(log[0].error, /carrier rejected/);

  const off = start({ none: true });
  await off.a("/api/admin/contacts", { name: "Elder B", phone: "385-233-7694" });
  const r = await (await book(off)).json();
  assert.equal((await off.j(`/api/booking/${r.token}/cancel`, {})).status, 200);
  await tick();
  const d = await (await off.a("/api/admin/contacts")).json();
  assert.equal(d.textReady, false);
  assert.match(d.log[0].error, /isn't set up/);
  assert.match((await (await off.a(`/api/admin/contacts/${d.contacts[0].id}/test`, {})).json()).results[0], /not set up/);

  const ok = start();
  await ok.a("/api/admin/contacts", { name: "Elder C", phone: "385-233-7695" });
  const cid = (await (await ok.a("/api/admin/contacts")).json()).contacts[0].id;
  assert.match((await (await ok.a(`/api/admin/contacts/${cid}/test`, {})).json()).results[0], /text: sent/);
  assert.equal(ok.sent.sms.at(-1).to, "+13852337695");
});

test("the missionaries' phone from Settings is texted without anyone being added", async () => {
  const t = start();
  const { token } = await (await book(t)).json();
  await tick();
  assert.equal(t.sent.sms.length, 0); // sign-ups off by default

  await t.j(`/api/booking/${token}/cancel`, {});
  await tick();
  assert.equal(t.sent.sms.length, 1);
  assert.equal(t.sent.sms[0].to, "+13852337693"); // the number already shown on the page

  const d = await (await t.a("/api/admin/contacts")).json();
  assert.deepEqual([d.main.valid, d.main.phone, d.main.notifyCancel, d.main.notifySignup], [true, "(385) 233-7693", true, false]);
  assert.equal(d.contacts.length, 0);

  // changing the number in Settings changes who is texted; toggles are saved
  await t.a("/api/admin/settings", { missionaryPhone: "801-555-0199", notifySignup: true });
  const { token: t2 } = await (await book(t, { time: "20:15" })).json();
  await tick();
  assert.equal(t.sent.sms.at(-1).to, "+18015550199");
  assert.match(t.sent.sms.at(-1).body, /^New visit/);
  await t.a("/api/admin/settings", { notifyCancel: false });
  const before = t.sent.sms.length;
  await t.j(`/api/booking/${t2}/cancel`, {});
  await tick();
  assert.equal(t.sent.sms.length, before);

  // test button
  assert.match((await (await t.a("/api/admin/notify-test", {})).json()).results[0], /text: sent/);
});

test("an unusable missionary phone number is reported, not texted, and never breaks a cancel", async () => {
  const t = start();
  await t.a("/api/admin/settings", { missionaryPhone: "call the office" });
  const { token } = await (await book(t)).json();
  assert.equal((await t.j(`/api/booking/${token}/cancel`, {})).status, 200);
  await tick();
  assert.equal(t.sent.sms.length, 0);
  const d = await (await t.a("/api/admin/contacts")).json();
  assert.equal(d.main.valid, false);
  assert.match((await (await t.a("/api/admin/notify-test", {})).json()).results[0], /valid 10-digit/);
});
