import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { zonedToUtc } from "../src/time.js";
import { nthWeekday, scheduledDates, runLeaderReminders, validateLeaders } from "../src/leaders.js";

// Sun Nov 8 2026, noon in Denver. The 2nd Thursday of November is Nov 12.
const NOW = zonedToUtc("2026-11-08", "12:00", "America/Denver");
const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections?.(); s.close(); }));

function start({ db = openDb(":memory:"), env = {}, none = false, failFor = [], clock = { t: NOW } } = {}) {
  const cfg = loadConfig({ ADMIN_PASSWORD: "pw", LEADERS_PASSWORD: "lead", SELF_URL: "https://x.test", ...env });
  const sent = [];
  const sendSms = none ? null : async (to, body) => { if (failFor.includes(to)) throw new Error("carrier rejected"); sent.push({ to, body }); };
  const server = createApp({ db, cfg, now: () => clock.t, sendSms }).listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = (p) => ({ Authorization: "Basic " + Buffer.from(`x:${p}`).toString("base64") });
  const j = (p, body, headers = {}, method) => fetch(base + p, { method: method || (body ? "POST" : "GET"), headers: { "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  const l = (p, body, method) => j(p, body, auth("lead"), method);
  const a = (p, body) => j(p, body, auth("pw"));
  return { db, cfg, base, j, l, a, auth, sent, clock, sendSms };
}
const person = (t, o = {}) => t.l("/api/leaders/people", { name: "Brother Jones", calling: "High Councilor", ward: "Harmony", ...o });
const enableTexts = (t) => t.a("/api/admin/leaders", { textsEnabled: true });
const tick = () => new Promise((r) => setTimeout(r, 40));

test("2nd Thursday math, including months that start on a Thursday", () => {
  assert.equal(nthWeekday(2026, 11, 4, 2), "2026-11-12");
  assert.equal(nthWeekday(2026, 12, 4, 2), "2026-12-10");
  assert.equal(nthWeekday(2027, 1, 4, 2), "2027-01-14");
  assert.equal(nthWeekday(2026, 10, 4, 2), "2026-10-08"); // Oct 1 2026 is a Thursday: the 2nd is the 8th
  const cfg = loadConfig({});
  assert.deepEqual(scheduledDates(cfg, "2026-11-01", "2027-01-31"), ["2026-11-12", "2026-12-10", "2027-01-14"]);
});

test("off until a password exists; the leaders or the admin password opens it; wrong ones do not", async () => {
  const off = start({ env: { ADMIN_PASSWORD: "", LEADERS_PASSWORD: "" } });
  assert.equal((await off.j("/leaders")).status, 404);
  assert.equal((await off.j("/api/leaders/state")).status, 404);

  const t = start();
  assert.equal((await t.j("/leaders")).status, 401);
  assert.equal((await t.j("/api/leaders/state", null, t.auth("nope"))).status, 401);
  assert.equal((await t.l("/api/leaders/state")).status, 200);
  assert.equal((await t.a("/api/leaders/state")).status, 200); // the admin password also works
  assert.equal((await t.j("/api/admin/leaders", null, t.auth("lead"))).status, 401); // but the leaders password is not admin
});

test("the next meeting is the 2nd Thursday at 8 PM in the stake council room", async () => {
  const t = start();
  const s = await (await t.l("/api/leaders/state")).json();
  const next = s.meetings.upcoming[0];
  assert.equal(next.date, "2026-11-12");
  assert.equal(next.timeLabel, "8:00 PM");
  assert.equal(next.place, "Stake council room");
  assert.match(next.dayLabel, /Thursday, November 12, 2026/);
  assert.deepEqual(s.meetings.upcoming.map((m) => m.date), ["2026-11-12", "2026-12-10", "2027-01-14", "2027-02-11"]);
  assert.match(s.settings.rule, /2nd Thursday of the month at 8:00 PM, Stake council room/);
  // once the meeting is well over, the next one takes its place
  t.clock.t = zonedToUtc("2026-11-13", "09:00", "America/Denver");
  const after = await (await t.l("/api/leaders/state")).json();
  assert.equal(after.meetings.upcoming[0].date, "2026-12-10");
  assert.equal(after.meetings.past[0].date, "2026-11-12");
});

test("people: dropdown values are enforced, names are unique, consent needs a number", async () => {
  const t = start();
  assert.equal((await person(t)).status, 201);
  assert.equal((await person(t, { name: "brother jones" })).status, 409);
  assert.equal((await person(t, { name: "A", calling: "Emperor" })).status, 400);
  assert.equal((await person(t, { name: "A", ward: "Narnia" })).status, 400);
  assert.equal((await person(t, { name: "" })).status, 400);
  assert.equal((await person(t, { name: "A", smsOk: true })).status, 400);               // agreed to texts but no number
  assert.equal((await person(t, { name: "A", phone: "12" })).status, 400);
  assert.equal((await person(t, { name: "Sister Lee", calling: "Relief Society President", ward: "Stake", phone: "801-555-0101", smsOk: true })).status, 201);
  const s = await (await t.l("/api/leaders/state")).json();
  const lee = s.people.find((p) => p.name === "Sister Lee");
  assert.deepEqual([lee.ward, lee.phone, lee.smsOk], ["Stake", "(801) 555-0101", true]);
  // edit and remove
  assert.equal((await person(t, { id: lee.id, name: "Sister Lee", calling: "Bishop", ward: "Harmony" })).status, 200);
  assert.equal((await (await t.l("/api/leaders/state")).json()).people.find((p) => p.id === lee.id).smsOk, false); // dropping the number drops consent
  await t.l(`/api/leaders/people/${lee.id}/remove`, {});
  assert.equal((await (await t.l("/api/leaders/state")).json()).people.some((p) => p.id === lee.id), false);
});

test("attendance: pick from the roster, add someone new, no duplicates, change calling/ward, wards missing", async () => {
  const t = start();
  const jones = (await (await person(t)).json()).id;
  const d = "2026-11-12";
  let r = await t.l(`/api/leaders/meetings/${d}/attendance`, { personId: jones });
  assert.equal(r.status, 201);
  const row = (await r.json()).id;
  assert.equal((await t.l(`/api/leaders/meetings/${d}/attendance`, { personId: jones })).status, 409);

  // "Someone new": a typed name joins the roster too, with the chosen calling and ward
  r = await t.l(`/api/leaders/meetings/${d}/attendance`, { name: "Sister Smith", calling: "Ward Mission Leader", ward: "Springwater" });
  assert.equal(r.status, 201);
  assert.ok((await (await t.l("/api/leaders/state")).json()).people.some((p) => p.name === "Sister Smith"));
  assert.equal((await t.l(`/api/leaders/meetings/${d}/attendance`, { name: "New Person", calling: "Emperor", ward: "Harmony" })).status, 400);
  assert.equal((await (await t.l("/api/leaders/state")).json()).people.some((p) => p.name === "New Person"), false); // a bad row leaves nothing behind

  assert.equal((await t.l(`/api/leaders/meetings/${d}/attendance/${row}`, { calling: "Bishop", ward: "Fairfield" }, "PUT")).status, 200);
  const detail = await (await t.l(`/api/leaders/meetings/${d}`)).json();
  assert.deepEqual(detail.attendees.map((a) => [a.name, a.calling, a.ward]).sort(), [["Brother Jones", "Bishop", "Fairfield"], ["Sister Smith", "Ward Mission Leader", "Springwater"]]);
  assert.deepEqual(detail.represented.sort(), ["Fairfield", "Springwater"]);
  assert.deepEqual(detail.missing.sort(), ["Cedar Fort", "Harmony", "Overland Trails", "White Hills"]);

  assert.equal((await t.l(`/api/leaders/meetings/${d}/attendance/${row}`, null, "DELETE")).status, 200);
  assert.equal((await (await t.l(`/api/leaders/meetings/${d}`)).json()).attendees.length, 1);
  assert.equal((await t.l("/api/leaders/meetings/2026-11-13")).status, 404);    // not a meeting day
  assert.equal((await t.l("/api/leaders/meetings/2026-13-45")).status, 404);
  assert.equal((await t.l("/api/leaders/meetings/2026-11-13/attendance", { personId: jones }, "POST")).status, 404);
});

test("attendance keeps what was true at the time, even if the roster changes", async () => {
  const t = start();
  const id = (await (await person(t)).json()).id;
  await t.l("/api/leaders/meetings/2026-11-12/attendance", { personId: id });
  await person(t, { id, name: "Brother Jones", calling: "Bishop", ward: "Fairfield" });
  const a = (await (await t.l("/api/leaders/meetings/2026-11-12")).json()).attendees[0];
  assert.deepEqual([a.calling, a.ward], ["High Councilor", "Harmony"]);
});

test("the board works with texting off; texting needs the admin switch, consent and a number", async () => {
  const t = start();
  const from = (await (await person(t)).json()).id;
  await person(t, { name: "Sister Lee", calling: "Bishop", ward: "Stake", phone: "801-555-0101", smsOk: true });
  await person(t, { name: "No Consent", calling: "Bishop", ward: "Harmony", phone: "801-555-0102" });
  await person(t, { name: "No Phone", calling: "Bishop", ward: "Harmony" });

  let r = await t.l("/api/leaders/messages", { fromId: from, body: "Please bring your ward numbers." });
  assert.equal(r.status, 201);
  assert.equal((await t.l("/api/leaders/messages", { body: "  " })).status, 400);
  assert.equal((await t.l("/api/leaders/messages", { body: "hi", alsoText: true })).status, 400); // switch is off
  assert.equal(t.sent.length, 0);

  assert.equal((await t.l("/api/admin/leaders", { textsEnabled: true })).status, 401); // leaders can't flip it
  assert.equal((await t.a("/api/admin/leaders", { textsEnabled: true })).status, 200);
  r = await t.l("/api/leaders/messages", { fromId: from, body: "Bring your ward numbers.", alsoText: true });
  assert.equal(r.status, 201);
  const out = await r.json();
  assert.deepEqual([out.texted, out.failed], [1, 0]);
  assert.deepEqual(t.sent.map((m) => m.to), ["+18015550101"]); // only the one who agreed
  assert.match(t.sent[0].body, /^Missionary Visits leaders: Brother Jones: Bring your ward numbers\. Reply STOP to opt out\.$/);

  const board = (await (await t.l("/api/leaders/state")).json()).messages;
  assert.deepEqual(board.map((m) => [m.body, m.texted]), [["Bring your ward numbers.", 1], ["Please bring your ward numbers.", 0]]);

  // choose recipients
  const lee = (await (await t.l("/api/leaders/state")).json()).people.find((p) => p.name === "Sister Lee").id;
  assert.equal((await t.l("/api/leaders/messages", { body: "x", alsoText: true, recipientIds: [999] })).status, 400); // nobody left to text
  assert.equal((await t.l("/api/leaders/messages", { body: "y", alsoText: true, recipientIds: [lee] })).status, 201);
});

test("a failed text is counted and logged, never thrown at the sender", async () => {
  const t = start({ failFor: ["+18015550101"] });
  await person(t, { name: "Sister Lee", calling: "Bishop", ward: "Stake", phone: "801-555-0101", smsOk: true });
  await person(t, { name: "Brother Ray", calling: "Bishop", ward: "Harmony", phone: "801-555-0103", smsOk: true });
  await enableTexts(t);
  const out = await (await t.l("/api/leaders/messages", { body: "Hello" })).json();
  assert.equal(out.id > 0, true);
  const r = await (await t.l("/api/leaders/messages", { body: "Hello again", alsoText: true })).json();
  assert.deepEqual([r.texted, r.failed], [1, 1]);
  assert.equal(t.db.prepare("SELECT error FROM leaders_text_log WHERE ok = 0").get().error, "carrier rejected");
});

test("no texting at all when there is no sender configured", async () => {
  const t = start({ none: true });
  await person(t, { name: "Sister Lee", calling: "Bishop", ward: "Stake", phone: "801-555-0101", smsOk: true });
  await enableTexts(t);
  const s = await (await t.l("/api/leaders/state")).json();
  assert.deepEqual([s.texts.enabled, s.texts.ready], [true, false]);
  assert.equal((await t.l("/api/leaders/messages", { body: "x", alsoText: true })).status, 400);
  assert.equal((await t.l("/api/leaders/messages", { body: "x" })).status, 201);
});

test("reminders: 2 days before at 9 AM and 2 hours before, once each, only to people who agreed", async () => {
  const t = start();
  await person(t, { name: "Sister Lee", calling: "Bishop", ward: "Stake", phone: "801-555-0101", smsOk: true });
  await person(t, { name: "No Consent", calling: "Bishop", ward: "Harmony", phone: "801-555-0102" });
  const run = (ms) => runLeaderReminders({ db: t.db, cfg: t.cfg, send: t.sendSms, nowMs: ms });
  const at = (d, h) => zonedToUtc(d, h, "America/Denver");

  assert.equal(await run(at("2026-11-10", "09:30")), 0);          // texting still off
  await enableTexts(t);
  assert.equal(await run(at("2026-11-10", "08:59")), 0);          // too early
  assert.equal(await run(at("2026-11-10", "09:01")), 1);          // Tue 9 AM, two days before
  assert.equal(await run(at("2026-11-10", "09:05")), 0);          // never twice
  assert.equal(await run(at("2026-11-12", "17:59")), 0);
  assert.equal(await run(at("2026-11-12", "18:01")), 1);          // 2 hours before the 8 PM start
  assert.equal(await run(at("2026-11-12", "18:30")), 0);
  assert.equal(await run(at("2026-11-12", "20:30")), 0);          // meeting under way: nothing
  assert.equal(t.sent.length, 2);
  assert.ok(t.sent.every((m) => m.to === "+18015550101"));
  assert.match(t.sent[0].body, /^Missionary Visits: missionary coordination meeting Thursday, November 12 at 8:00 PM, Stake council room\. Reply STOP to opt out\.$/);
  const board = (await (await t.l("/api/leaders/state")).json()).messages;
  assert.equal(board.filter((m) => m.kind === "reminder").length, 2);
});

test("reminders: a late 'days before' is skipped, a cancelled meeting is silent, a moved one starts over", async () => {
  const t = start();
  await person(t, { name: "Sister Lee", calling: "Bishop", ward: "Stake", phone: "801-555-0101", smsOk: true });
  await enableTexts(t);
  const run = (ms) => runLeaderReminders({ db: t.db, cfg: t.cfg, send: t.sendSms, nowMs: ms });
  const at = (d, h) => zonedToUtc(d, h, "America/Denver");

  // the server was down all week: at 6:30 PM on the day, "2 days before" would be nonsense; the "2 hours" one is right
  assert.equal(await run(at("2026-11-12", "18:30")), 1);
  assert.equal(t.sent.length, 1);

  // cancel the December meeting: nothing goes out for it
  assert.equal((await t.l("/api/leaders/meetings/2026-12-10/update", { cancelled: true, note: "Holiday" })).status, 200);
  assert.equal(await run(at("2026-12-08", "09:30")), 0);
  assert.equal(await run(at("2026-12-10", "18:30")), 0);
  // un-cancel and move it: reminders are about the new time
  assert.equal((await t.l("/api/leaders/meetings/2026-12-10/update", { cancelled: false, movedDate: "2026-12-17", movedTime: "19:00" })).status, 200);
  assert.equal(await run(at("2026-12-15", "09:30")), 1);
  assert.match(t.sent.at(-1).body, /Thursday, December 17 at 7:00 PM/);
  // moving it again re-arms what was already sent
  await t.l("/api/leaders/meetings/2026-12-10/update", { movedDate: "2026-12-18", movedTime: "19:00" });
  assert.equal(await run(at("2026-12-16", "09:30")), 1);
});

test("changing a meeting: cancel or move, optionally text everyone", async () => {
  const t = start();
  await person(t, { name: "Sister Lee", calling: "Bishop", ward: "Stake", phone: "801-555-0101", smsOk: true });
  // texting off: the change saves but the text is refused, and says so
  let r = await t.l("/api/leaders/meetings/2026-11-12/update", { cancelled: true, notify: true });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).saved, true);
  assert.equal((await (await t.l("/api/leaders/meetings/2026-11-12")).json()).meeting.cancelled, true);

  await enableTexts(t);
  r = await t.l("/api/leaders/meetings/2026-11-12/update", { cancelled: false, movedDate: "2026-11-19", note: "Council room is booked." });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).notified, null); // not asked to text
  r = await t.l("/api/leaders/meetings/2026-11-12/update", { movedDate: "2026-11-19", note: "Council room is booked.", place: "Relief Society room", notify: true });
  const out = await r.json();
  assert.equal(out.notified.texted, 1);
  assert.match(t.sent.at(-1).body, /^Missionary Visits: the missionary coordination meeting is now Thursday, November 19 at 8:00 PM, Relief Society room\. Council room is booked\. Reply STOP/);
  // saving the same thing again is not a change, so no second text
  const n = t.sent.length;
  await t.l("/api/leaders/meetings/2026-11-12/update", { movedDate: "2026-11-19", note: "Council room is booked.", place: "Relief Society room", notify: true });
  assert.equal(t.sent.length, n);
  assert.equal((await t.l("/api/leaders/meetings/2026-11-12/update", { movedDate: "nope" })).status, 400);
  assert.equal((await t.l("/api/leaders/meetings/2026-11-12/update", { movedTime: "soon" })).status, 400);
});

test("'send a reminder now'", async () => {
  const t = start();
  await person(t, { name: "Sister Lee", calling: "Bishop", ward: "Stake", phone: "801-555-0101", smsOk: true });
  assert.equal((await t.l("/api/leaders/meetings/2026-11-12/remind", {})).status, 400); // off
  await enableTexts(t);
  assert.equal((await t.l("/api/leaders/meetings/2026-11-12/remind", {})).status, 200);
  assert.equal(t.sent.length, 1);
  await t.l("/api/leaders/meetings/2026-11-12/update", { cancelled: true });
  assert.equal((await t.l("/api/leaders/meetings/2026-11-12/remind", {})).status, 400); // cancelled
});

test("settings: the meeting rule, callings and reminder timing are editable, validated, and kept across a restart", async () => {
  assert.equal(validateLeaders({ nth: 5 }).errors.length, 1);
  assert.equal(validateLeaders({ weekday: 9 }).errors.length, 1);
  assert.equal(validateLeaders({ time: "late" }).errors.length, 1);
  assert.equal(validateLeaders({ callings: "A\na" }).errors.length, 1);
  assert.equal(validateLeaders({ reminderDays: 30 }).errors.length, 1);
  assert.equal(validateLeaders({ time: "8:30 PM" }).values.time, "20:30");
  assert.equal(validateLeaders({ textsEnabled: true }).values.textsEnabled, undefined); // not without the admin flag

  const db = openDb(":memory:");
  const t = start({ db });
  assert.equal((await t.l("/api/leaders/settings", { nth: 9 })).status, 400);
  const r = await t.l("/api/leaders/settings", { nth: 1, weekday: 2, time: "19:30", place: "Chapel library", callings: "Bishop\nWard Mission Leader\nOther", reminderDays: 0, reminderHours: 3, textsEnabled: true });
  assert.equal(r.status, 200);
  assert.equal(t.cfg.leaders.textsEnabled, false); // the leaders page cannot turn texting on
  const s = await (await t.l("/api/leaders/state")).json();
  assert.equal(s.meetings.upcoming[0].date, "2026-12-01"); // the 1st Tuesday of November (the 3rd) has already passed
  const t2 = start({ db }); // restart: same database, fresh config
  assert.equal(t2.cfg.leaders.nth, 1);
  assert.equal(t2.cfg.leaders.place, "Chapel library");
  assert.deepEqual(t2.cfg.leaders.callings, ["Bishop", "Ward Mission Leader", "Other"]);
  assert.equal((await person(t2, { calling: "High Councilor" })).status, 400); // no longer a choice
  const s2 = await (await t2.l("/api/leaders/state")).json();
  assert.equal(s2.meetings.upcoming[0].time, "19:30");
});

test("admin sees where the page is and can switch leaders' texts on and off", async () => {
  const t = start();
  await person(t, { name: "Sister Lee", calling: "Bishop", ward: "Stake", phone: "801-555-0101", smsOk: true });
  let s = await (await t.a("/api/admin/leaders")).json();
  assert.equal(s.url, "https://x.test/leaders");
  assert.deepEqual([s.passwordSet, s.textsEnabled, s.recipients, s.people], [true, false, 1, 1]);
  await t.a("/api/admin/leaders", { textsEnabled: true });
  assert.equal((await (await t.a("/api/admin/leaders")).json()).textsEnabled, true);
  await t.a("/api/admin/leaders", { textsEnabled: false });
  assert.equal(t.cfg.leaders.textsEnabled, false);
});
