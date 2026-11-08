import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { zonedToUtc } from "../src/time.js";
import { huddleDates, whenLabel } from "../src/huddles.js";

const NOW = zonedToUtc("2026-11-08", "12:00", "America/Denver"); // a Sunday
const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections?.(); s.close(); }));

function start({ db = openDb(":memory:"), env = {}, clock = { t: NOW } } = {}) {
  const cfg = loadConfig({ ADMIN_PASSWORD: "pw", SELF_URL: "https://x.test", ...env });
  const sent = [];
  const server = createApp({ db, cfg, now: () => clock.t, sendSms: async (to, body) => { sent.push({ to, body }); } }).listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = { Authorization: "Basic " + Buffer.from("x:pw").toString("base64") };
  const j = (p, body, headers = {}, method) => fetch(base + p, { method: method || (body ? "POST" : "GET"), headers: { "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  const a = (p, body, method) => j(p, body, admin, method);
  return { db, cfg, base, j, a, sent, clock };
}
const W = "Harmony";
const enc = encodeURIComponent;
const sched = (t, o = {}, ward = W) => t.a(`/api/leaders/huddles/${enc(ward)}/schedule`, { freq: "weekly", weekday: 0, time: "9:00 AM", place: "Chapel", ...o });
const addP = (t, o = {}, ward = W) => t.a(`/api/leaders/huddles/${enc(ward)}/people`, { name: "Brother Young", phone: "801-555-0140", calling: "Ward Missionary", ...o });
const state = async (t) => (await (await t.a("/api/leaders/huddles")).json());
const ward = async (t, w = W) => (await state(t)).wards.find((x) => x.ward === w);

test("schedule math and labels: weekly, nth, and never invented", () => {
  assert.equal(whenLabel({ set: false }), "Day and time not set yet");
  assert.equal(whenLabel({ set: true, freq: "weekly", weekday: 0, time: "09:00" }), "Sundays at 9:00 AM");
  assert.equal(whenLabel({ set: true, freq: "nth", nth: 2, weekday: 2, time: "19:30" }), "The 2nd Tuesday of each month at 7:30 PM");
  assert.deepEqual(huddleDates({ set: true, freq: "weekly", weekday: 0 }, "2026-11-01", "2026-11-22"), ["2026-11-01", "2026-11-08", "2026-11-15", "2026-11-22"]);
  assert.deepEqual(huddleDates({ set: true, freq: "nth", nth: 2, weekday: 0 }, "2026-11-01", "2027-01-31"), ["2026-11-08", "2026-12-13", "2027-01-10"]);
  assert.deepEqual(huddleDates({ set: false }, "2026-11-01", "2026-12-01"), []); // an unset ward has no dates, not made-up ones
});

test("the huddle section is admin-only, and 404 with no admin password", async () => {
  const off = start({ env: { ADMIN_PASSWORD: "" } });
  assert.equal((await off.j("/api/leaders/huddles")).status, 404);
  const t = start();
  for (const [p, body, m] of [["/api/leaders/huddles"], ["/api/leaders/huddles.csv"], ["/api/leaders/huddles/Harmony/schedule", {}], ["/api/leaders/huddles/Harmony/confirm", {}],
    ["/api/leaders/huddles/Harmony/people", {}], ["/api/leaders/huddles/Harmony/2026-11-08"], ["/api/leaders/huddles/share", {}]]) {
    assert.equal((await t.j(p, body, {}, m)).status, 401, p);
    assert.equal((await t.j(p, body, { Authorization: "Basic " + Buffer.from("x:nope").toString("base64") }, m)).status, 401, p);
  }
  assert.equal((await t.a("/api/leaders/huddles")).status, 200);
});

test("every ward starts blank and honest; only real wards can be edited", async () => {
  const t = start();
  const s = await state(t);
  assert.deepEqual(s.wards.map((w) => w.ward), ["Harmony", "Overland Trails", "Springwater", "White Hills", "Cedar Fort", "Fairfield"]);
  const h = s.wards[0];
  assert.equal(h.schedule.label, "Day and time not set yet");
  assert.deepEqual([h.people.length, h.recent.length, h.next, h.confirmed.date, h.confirmed.stale], [0, 0, null, null, true]);
  assert.equal((await sched(t, {}, "Narnia")).status, 404);
  assert.equal((await sched(t, {}, "Stake")).status, 404);                       // the stake is not a ward with a huddle
  assert.equal((await t.a("/api/leaders/huddles/Narnia/people", { name: "x" })).status, 404);
});

test("setting when a ward meets", async () => {
  const t = start();
  assert.equal((await sched(t)).status, 200);
  let h = await ward(t);
  assert.equal(h.schedule.label, "Sundays at 9:00 AM");
  assert.equal(h.schedule.place, "Chapel");
  assert.equal(h.next.date, "2026-11-15");
  assert.equal(h.today, "2026-11-08");                                            // today is a huddle day

  assert.equal((await sched(t, { freq: "nth", nth: 2, weekday: 2, time: "19:30", place: "Bishop's office" }, "Springwater")).status, 200);
  h = await ward(t, "Springwater");
  assert.equal(h.schedule.label, "The 2nd Tuesday of each month at 7:30 PM");
  assert.equal(h.next.date, "2026-11-10");

  for (const bad of [{ weekday: 9 }, { weekday: "x" }, { time: "later" }, { freq: "nth", nth: 7 }]) assert.equal((await sched(t, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await ward(t)).schedule.label, "Sundays at 9:00 AM");               // refused edits change nothing
});

test("names and numbers: typed people, youth, validation, edit, remove", async () => {
  const t = start();
  assert.equal((await addP(t)).status, 201);
  assert.equal((await addP(t, { name: "Young Deacon", phone: "801-555-0141", calling: "Youth" })).status, 201);
  assert.equal((await addP(t, { name: "brother young" })).status, 409);           // same name in the same ward
  assert.equal((await addP(t, { name: "Brother Young" }, "Fairfield")).status, 201); // fine in another ward
  assert.equal((await addP(t, { name: "A", calling: "Emperor" })).status, 400);
  assert.equal((await addP(t, { name: "" })).status, 400);
  assert.equal((await addP(t, { name: "B", phone: "12" })).status, 400);
  assert.equal((await addP(t, { name: "No Number", phone: "", calling: "Youth" })).status, 201); // a number is optional

  const h = await ward(t);
  assert.deepEqual(h.people.map((p) => [p.name, p.calling, p.youth, p.phone ? "has" : "none"]),
    [["Brother Young", "Ward Missionary", false, "has"], ["No Number", "Youth", true, "none"], ["Young Deacon", "Youth", true, "has"]]); // adults first, youth after
  const id = h.people.find((p) => p.name === "Brother Young").id;
  assert.equal((await t.a(`/api/leaders/huddles/${W}/people/${id}`, { name: "Brother Yung", phone: "801-555-0199", calling: "Bishop" }, "PUT")).status, 200);
  assert.equal((await ward(t)).people.find((p) => p.id === id).name, "Brother Yung");
  assert.equal((await t.a(`/api/leaders/huddles/${W}/people/${id}`, null, "DELETE")).status, 200);
  assert.equal((await ward(t)).people.some((p) => p.id === id), false);
  assert.equal((await t.a(`/api/leaders/huddles/Fairfield/people/${id}`, { name: "x", calling: "Bishop" }, "PUT")).status, 404); // not another ward's person
});

test("pulling from the leaders list: linked live, never copied", async () => {
  const t = start();
  const lee = (await (await t.a("/api/leaders/people", { name: "Sister Lee", calling: "Ward Mission Leader", ward: W, phone: "801-555-0102" })).json()).id;
  await t.a("/api/leaders/people", { name: "Brother Ray", calling: "Bishop", ward: "Springwater", phone: "801-555-0103" });

  let h = await ward(t);
  assert.deepEqual(h.suggestions.map((s) => s.name), ["Sister Lee"]);              // only this ward's leaders are offered
  assert.equal((await t.a(`/api/leaders/huddles/${W}/people`, { leaderId: lee })).status, 201);
  assert.equal((await t.a(`/api/leaders/huddles/${W}/people`, { leaderId: lee })).status, 409);
  h = await ward(t);
  assert.deepEqual(h.suggestions, []);
  assert.deepEqual([h.people[0].name, h.people[0].phone, h.people[0].linked], ["Sister Lee", "+18015550102", true]);

  // change them on the leaders list: the huddle list follows, because it never held its own copy
  await t.a("/api/leaders/people", { id: lee, name: "Sister Lee-Smith", calling: "Bishopric Counselor", ward: W, phone: "801-555-0188" });
  h = await ward(t);
  assert.deepEqual([h.people[0].name, h.people[0].calling, h.people[0].phone], ["Sister Lee-Smith", "Bishopric Counselor", "+18015550188"]);
  const row = h.people[0].id;
  assert.equal((await t.a(`/api/leaders/huddles/${W}/people/${row}`, { name: "x", calling: "Bishop" }, "PUT")).status, 409); // edit it where it lives

  // removed from the leaders list: gone from the huddle list too
  await t.a(`/api/leaders/people/${lee}/remove`, {});
  assert.equal((await ward(t)).people.length, 0);
  assert.equal((await t.a(`/api/leaders/huddles/${W}/people`, { leaderId: lee })).status, 404);
});

test("who came: record, change, 'we didn't meet', averages, and history survives a schedule change", async () => {
  const t = start();
  await sched(t);
  const ids = [];
  for (const [name, calling] of [["Brother A", "Ward Missionary"], ["Sister B", "Ward Mission Leader"], ["Young C", "Youth"]]) ids.push((await (await addP(t, { name, calling, phone: "" })).json()).id);

  let r = await (await t.a(`/api/leaders/huddles/${W}/2026-11-08`)).json();
  assert.deepEqual([r.recorded, r.held, r.people.length, r.people.some((p) => p.present)], [false, null, 3, false]);
  assert.equal((await t.a(`/api/leaders/huddles/${W}/2026-11-08`, { presentIds: [ids[0], ids[2]], note: "Short one" }, "PUT")).status, 200);
  assert.equal((await t.a(`/api/leaders/huddles/${W}/2026-11-01`, { presentIds: ids }, "PUT")).status, 200);
  r = await (await t.a(`/api/leaders/huddles/${W}/2026-11-08`)).json();
  assert.deepEqual([r.recorded, r.held, r.note, r.people.filter((p) => p.present).map((p) => p.name)], [true, true, "Short one", ["Brother A", "Young C"]]);

  // change it: replaces, does not add
  await t.a(`/api/leaders/huddles/${W}/2026-11-08`, { presentIds: [ids[1]] }, "PUT");
  assert.deepEqual((await (await t.a(`/api/leaders/huddles/${W}/2026-11-08`)).json()).people.filter((p) => p.present).map((p) => p.name), ["Sister B"]);

  // a week nobody met
  await t.a(`/api/leaders/huddles/${W}/2026-10-25`, { held: false, note: "Stake conference" }, "PUT");
  let h = await ward(t);
  const byDate = Object.fromEntries(h.recent.map((x) => [x.date, x]));
  assert.deepEqual([byDate["2026-11-08"].present, byDate["2026-11-01"].present, byDate["2026-10-25"].held], [1, 3, false]);
  assert.equal(h.average, 2);                                                       // (1 + 3) / 2: the week nobody met does not count

  // not someone else's person, not a date that isn't a huddle
  const other = (await (await addP(t, { name: "Elsewhere" }, "Fairfield")).json()).id;
  assert.equal((await t.a(`/api/leaders/huddles/${W}/2026-11-08`, { presentIds: [other] }, "PUT")).status, 400);
  assert.equal((await t.a(`/api/leaders/huddles/${W}/2026-11-09`)).status, 404);
  assert.equal((await t.a(`/api/leaders/huddles/${W}/2026-11-09`, { presentIds: [] }, "PUT")).status, 404);

  // the ward moves to Tuesdays: old Sundays stay in the record
  await sched(t, { weekday: 2 });
  h = await ward(t);
  assert.ok(h.recent.some((x) => x.date === "2026-11-08" && x.recorded), "an old, logged Sunday survives the move");
});

test("'confirmed' says how fresh a ward's list is", async () => {
  const t = start();
  await t.a(`/api/leaders/huddles/${W}/confirm`, {});
  let h = await ward(t);
  assert.equal(h.confirmed.stale, false);
  assert.match(h.confirmed.date, /Nov 8, 2026/);
  t.clock.t += 59 * 86400_000;
  assert.equal((await ward(t)).confirmed.stale, false);
  t.clock.t += 2 * 86400_000;
  h = await ward(t);
  assert.deepEqual([h.confirmed.daysAgo, h.confirmed.stale], [61, true]);
  // changing the list or the time is not the same as confirming it
  await sched(t);
  assert.equal((await ward(t)).confirmed.stale, true);
});

test("the list that gets sent out: nothing public until an admin makes the link; youth numbers hidden by default", async () => {
  const t = start();
  await sched(t);
  await addP(t, { name: "Brother Adult", phone: "801-555-0140", calling: "Ward Mission Leader" });
  await addP(t, { name: "Young Deacon", phone: "801-555-0141", calling: "Youth" });
  await t.a(`/api/leaders/huddles/${W}/confirm`, {});

  // before a link exists, no key reaches anything
  assert.equal((await t.j("/huddles/anything")).status, 404);
  assert.equal((await t.j("/api/huddles/anything")).status, 404);
  assert.equal((await state(t)).share.on, false);

  assert.equal((await t.j("/api/leaders/huddles/share", { action: "create" })).status, 401);
  const made = await (await t.a("/api/leaders/huddles/share", { action: "create" })).json();
  assert.match(made.share.url, /^https:\/\/x\.test\/huddles\/[\w-]{22}$/);
  const key = made.share.url.split("/").pop();
  assert.equal(made.share.showYouthPhones, false);

  const page = await t.j(`/huddles/${key}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-robots-tag"), "noindex");
  const api = await t.j(`/api/huddles/${key}`);
  assert.equal(api.status, 200);
  assert.equal(api.headers.get("cache-control"), "no-store");
  const data = await api.json();
  const h = data.wards.find((x) => x.ward === W);
  assert.deepEqual([h.when, h.place, h.confirmed], ["Sundays at 9:00 AM", "Chapel", "Confirmed Nov 8, 2026"]);
  assert.deepEqual(h.people.map((p) => [p.name, p.youth, p.phone]), [["Brother Adult", false, "(801) 555-0140"], ["Young Deacon", true, ""]]); // youth number not shared
  assert.equal(data.youthPhonesHidden, true);
  assert.ok(!JSON.stringify(data).includes("555-0141"));
  assert.equal(data.wards.find((x) => x.ward === "Fairfield").when, "Day and time not set yet");

  // the admin may choose to include them
  await t.a("/api/leaders/huddles/share", { showYouthPhones: true });
  const open = await (await t.j(`/api/huddles/${key}`)).json();
  assert.equal(open.wards.find((x) => x.ward === W).people.find((p) => p.youth).phone, "(801) 555-0141");
  assert.equal(open.youthPhonesHidden, false);
  await t.a("/api/leaders/huddles/share", { showYouthPhones: false });
  assert.equal((await (await t.j(`/api/huddles/${key}`)).json()).youthPhonesHidden, true);
});

test("the sent-out link can be replaced or switched off", async () => {
  const t = start();
  const key = (await (await t.a("/api/leaders/huddles/share", { action: "create" })).json()).share.url.split("/").pop();
  assert.equal((await t.a("/api/leaders/huddles/share", { action: "create" })).status, 200);       // creating again keeps the same one
  assert.equal((await state(t)).share.url.split("/").pop(), key);

  const fresh = (await (await t.a("/api/leaders/huddles/share", { action: "rotate" })).json()).share.url.split("/").pop();
  assert.notEqual(fresh, key);
  assert.equal((await t.j(`/api/huddles/${key}`)).status, 404);                                     // the old link is dead
  assert.equal((await t.j(`/huddles/${key}`)).status, 404);
  assert.equal((await t.j(`/api/huddles/${fresh}`)).status, 200);

  assert.equal((await (await t.a("/api/leaders/huddles/share", { action: "off" })).json()).share.on, false);
  assert.equal((await t.j(`/api/huddles/${fresh}`)).status, 404);
});

test("the spreadsheet download is admin-only and safe to open", async () => {
  const t = start();
  await sched(t);
  await addP(t, { name: "=HYPERLINK(\"x\")", phone: "801-555-0140", calling: "Youth" });
  assert.equal((await t.j("/api/leaders/huddles.csv")).status, 401);
  const res = await t.a("/api/leaders/huddles.csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /ward-huddles\.csv/);
  const csv = await res.text();
  assert.match(csv, /^"Ward","Meets","Place","Name","Calling","Youth","Phone"/);
  assert.match(csv, /"Harmony","Sundays at 9:00 AM","Chapel","'=HYPERLINK/);                         // a name cannot become a formula
  assert.match(csv, /"yes","\(801\) 555-0140"/);                                                    // the admin's copy has the youth number
  assert.match(csv, /"Fairfield","Day and time not set yet"/);                                       // wards with nothing yet still appear
});

test("nothing on a huddle list can ever be texted", async () => {
  const t = start();
  await t.a("/api/admin/leaders", { textsEnabled: true });
  await addP(t, { name: "Young Deacon", phone: "801-555-0141", calling: "Youth" });
  await addP(t, { name: "Brother Adult", phone: "801-555-0140", calling: "Ward Mission Leader" });
  // huddle people are not on the leaders list at all, so the leaders' texting has nobody to reach
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM leaders_people").get().n, 0);
  const r = await t.a("/api/leaders/messages", { body: "Hello", alsoText: true });
  assert.equal(r.status, 400);
  assert.deepEqual(t.sent, []);
  // and even a leader who is linked in is texted only for what the leaders list says about them (consent), never for being on a huddle list
  const lee = (await (await t.a("/api/leaders/people", { name: "Sister Lee", calling: "Ward Mission Leader", ward: W, phone: "801-555-0102" })).json()).id;
  await t.a(`/api/leaders/huddles/${W}/people`, { leaderId: lee });
  assert.equal((await t.a("/api/leaders/messages", { body: "Hello", alsoText: true })).status, 400); // no consent recorded: still nobody
  assert.deepEqual(t.sent, []);
});
