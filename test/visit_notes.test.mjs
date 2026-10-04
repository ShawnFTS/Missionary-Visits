import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { zonedToUtc } from "../src/time.js";

const TZ = "America/Denver";
const NOW = zonedToUtc("2026-10-06", "10:00", TZ); // Tue; week of Oct 4 (Springwater)
const KEY = "mkey-0123456789";
const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections?.(); s.close(); }));
const tick = () => new Promise((r) => setTimeout(r, 80));

function start() {
  const db = openDb(":memory:");
  const cfg = loadConfig({ ADMIN_PASSWORD: "pw", SELF_URL: "https://x.test", MISSIONARY_KEY: KEY });
  const sent = [];
  const server = createApp({ db, cfg, now: () => NOW, sendSms: async (to, body) => { sent.push({ to, body }); } }).listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const adminH = { Authorization: "Basic " + Buffer.from("a:pw").toString("base64") };
  const req = (method, p, body, headers = {}) => fetch(base + p, {
    method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    db, cfg, sent, base,
    m: (method, p, body) => req(method, `/api/m/${KEY}${p}`, body),
    a: (method, p, body) => req(method, `/api/admin${p}`, body, adminH),
    pub: (method, p, body) => req(method, p, body),
  };
}

// First open slot in the week of Oct 4 after NOW, for a family; returns { id, token, date, time }.
async function book(t, family = "Test", phone = "801-555-0101", address = "1 Main St") {
  const week = await (await t.pub("GET", "/api/week?start=2026-10-04")).json();
  const day = week.days.find((d) => d.slots.some((s) => s.status === "open"));
  const slot = day.slots.find((s) => s.status === "open");
  const r = await t.pub("POST", "/api/book", { date: day.date, time: slot.time, family, phone, address });
  assert.equal(r.status, 201);
  const { token } = await r.json();
  const row = t.db.prepare(`SELECT id FROM bookings WHERE token = ?`).get(token);
  return { id: row.id, token, date: day.date, time: slot.time };
}

// A visit that already happened (the public form refuses past times, so insert directly).
function pastVisit(t, family = "Past", date = "2026-09-30", time = "19:00") {
  const r = t.db.prepare(`INSERT INTO bookings (token, slot_date, slot_time, start_utc, family, phone, remind_day, remind_hour, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`).run(`past-${family}`, date, time, zonedToUtc(date, time, TZ), family, "+18015550199", NOW - 9e9);
  return Number(r.lastInsertRowid);
}

const FULL = { planned: "The Plan of Salvation", taught: "Lesson 1 and a prayer", commitments: "Read 3 Nephi 11\nPray daily", followupDate: "2026-10-12", followupTime: "18:30" };

test("missionaries save notes on a visit; they come back with the visit list; wrong key is refused", async () => {
  const t = start();
  const b = await book(t);
  assert.equal((await t.pub("PUT", `/api/m/wrong-key/visits/${b.id}/notes`, FULL)).status, 404);

  const r = await t.m("PUT", `/visits/${b.id}/notes`, FULL);
  assert.equal(r.status, 200);
  const back = (await r.json()).notes;
  assert.equal(back.planned, FULL.planned);
  assert.equal(back.commitments, "Read 3 Nephi 11\nPray daily"); // line breaks survive

  const list = await (await t.m("GET", "/visits")).json();
  const v = list.visits.find((x) => x.id === b.id);
  assert.equal(v.notes.taught, FULL.taught);
  assert.equal(v.notes.followupDate, "2026-10-12");
  assert.equal(v.notes.followupTime, "18:30");
});

test("notes are validated; an empty form clears them; cancelled visits take no notes", async () => {
  const t = start();
  const b = await book(t);
  assert.equal((await t.m("PUT", `/visits/${b.id}/notes`, { ...FULL, followupDate: "2026-13-45" })).status, 400);
  assert.equal((await t.m("PUT", `/visits/${b.id}/notes`, { ...FULL, followupTime: "25:99" })).status, 400);
  assert.equal((await t.m("PUT", `/visits/${b.id}/notes`, { planned: "x", followupDate: "", followupTime: "18:00" })).status, 400); // time but no date
  assert.equal(t.db.prepare(`SELECT COUNT(*) c FROM visit_notes`).get().c, 0);          // nothing half-saved

  await t.m("PUT", `/visits/${b.id}/notes`, FULL);
  assert.equal(t.db.prepare(`SELECT COUNT(*) c FROM visit_notes`).get().c, 1);
  await t.m("PUT", `/visits/${b.id}/notes`, { planned: "", taught: "", commitments: "", followupDate: "", followupTime: "" });
  assert.equal(t.db.prepare(`SELECT COUNT(*) c FROM visit_notes`).get().c, 0);

  await t.m("POST", `/visits/${b.id}/cancel`);
  assert.equal((await t.m("PUT", `/visits/${b.id}/notes`, FULL)).status, 409);
  assert.equal((await t.m("PUT", `/visits/99999/notes`, FULL)).status, 404);

  const long = "x".repeat(5000);
  const c = await book(t, "Long", "801-555-0102");
  await t.m("PUT", `/visits/${c.id}/notes`, { planned: long });
  assert.equal(t.db.prepare(`SELECT length(planned) n FROM visit_notes WHERE booking_id = ?`).get(c.id).n, 2000);
});

test("notes stay private: not on the family's page, the public sheet, texts, or the CSV", async () => {
  const t = start();
  const b = await book(t);
  await t.m("PUT", `/visits/${b.id}/notes`, { ...FULL, planned: "SECRETPLAN-xyz", taught: "SECRETTAUGHT-xyz", commitments: "SECRETCOMMIT-xyz" });
  const seen = [
    JSON.stringify(await (await t.pub("GET", `/api/booking/${b.token}`)).json()),
    await (await t.pub("GET", `/api/booking/${b.token}/ics`)).text(),
    JSON.stringify(await (await t.pub("GET", "/api/week?start=2026-10-04")).json()),
    await (await t.a("GET", "/export.csv")).text(),
    JSON.stringify(t.sent),
  ].join("\n");
  assert.ok(!seen.includes("SECRET"), "notes leaked somewhere they should not be");
  // ...but the missionaries' own page and the admin both have them.
  assert.ok(JSON.stringify(await (await t.m("GET", "/visits")).json()).includes("SECRETPLAN-xyz"));
  assert.ok(JSON.stringify(await (await t.a("GET", "/state")).json()).includes("SECRETPLAN-xyz"));
  assert.equal((await t.pub("GET", "/api/admin/state")).status, 401);
});

test("a follow-up becomes a calendar reminder on the missionaries' feed", async () => {
  const t = start();
  const b = await book(t, "Reyes", "801-555-0103");
  await t.m("PUT", `/visits/${b.id}/notes`, FULL);
  const ics = await (await t.pub("GET", `/m/${KEY}/feed.ics`)).text();
  assert.ok(ics.includes("SUMMARY:Follow up — Reyes Family"));
  const followAt = zonedToUtc("2026-10-12", "18:30", TZ);
  const stamp = new Date(followAt).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  assert.ok(ics.includes(`DTSTART:${stamp}`), "timed follow-up at 6:30 PM Mountain");
  assert.ok(ics.includes("TRIGGER:-PT1H"));
  const flat = ics.replace(/\r\n /g, "");
  assert.ok(flat.includes("Commitments they left: Read 3 Nephi 11\\nPray daily"));
  assert.ok(!flat.includes("The Plan of Salvation"), "only the commitments go in the calendar, not the lesson notes");

  // date only -> all-day event with a morning reminder
  await t.m("PUT", `/visits/${b.id}/notes`, { ...FULL, followupTime: "" });
  const day = await (await t.pub("GET", `/m/${KEY}/feed.ics`)).text();
  assert.ok(day.includes("DTSTART;VALUE=DATE:20261012") && day.includes("DTEND;VALUE=DATE:20261013"));
  assert.ok(day.includes("TRIGGER:PT9H"));

  // a hand-picked download is just those visits; the full download carries follow-ups
  assert.ok(!(await (await t.pub("GET", `/api/m/${KEY}/visits.ics?ids=${b.id}`)).text()).includes("Follow up"));
  assert.ok((await (await t.pub("GET", `/api/m/${KEY}/visits.ics`)).text()).includes("Follow up"));

  // cancelling the visit removes its follow-up from the feed; a follow-up long past is dropped too
  await t.m("POST", `/visits/${b.id}/cancel`);
  assert.ok(!(await (await t.pub("GET", `/m/${KEY}/feed.ics`)).text()).includes("Follow up"));
  const p = pastVisit(t);
  await t.m("PUT", `/visits/${p}/notes`, { taught: "x", followupDate: "2026-10-01" });
  assert.ok(!(await (await t.pub("GET", `/m/${KEY}/feed.ics`)).text()).includes("Follow up"));
});

test("recent visits can be written up after the fact", async () => {
  const t = start();
  const p = pastVisit(t, "Olsen");
  const list = await (await t.m("GET", "/visits")).json();
  assert.deepEqual(list.recent.map((v) => v.family), ["Olsen Family"]);
  assert.equal((await t.m("PUT", `/visits/${p}/notes`, { taught: "The Restoration", commitments: "Come to church", followupDate: "2026-10-20" })).status, 200);
  const after = await (await t.m("GET", "/visits")).json();
  assert.equal(after.recent[0].notes.taught, "The Restoration");
  // very old visits are not listed
  pastVisit(t, "Ancient", "2026-06-01");
  assert.deepEqual((await (await t.m("GET", "/visits")).json()).recent.map((v) => v.family), ["Olsen Family"]);
});

test("missionaries can cancel a visit: the time reopens, they are not texted about their own action", async () => {
  const t = start();
  const b = await book(t);
  const r = await t.m("POST", `/visits/${b.id}/cancel`);
  assert.equal(r.status, 200);
  await tick();
  const row = t.db.prepare(`SELECT cancelled_at, cancelled_by FROM bookings WHERE id = ?`).get(b.id);
  assert.ok(row.cancelled_at); assert.equal(row.cancelled_by, "missionary");
  assert.equal(t.sent.length, 0);
  const week = await (await t.pub("GET", "/api/week?start=2026-10-04")).json();
  const slot = week.days.find((d) => d.date === b.date).slots.find((s) => s.time === b.time);
  assert.equal(slot.status, "open");
  assert.equal((await t.m("POST", `/visits/${b.id}/cancel`)).status, 200); // pressing twice is harmless
  assert.equal((await t.pub("POST", `/api/m/nope/visits/${b.id}/cancel`)).status, 404);

  // the same cancel from admin still texts the missionaries, as before
  const c = await book(t, "Other", "801-555-0104");
  await t.a("POST", `/cancel/${c.id}`);
  await tick();
  assert.equal(t.sent.length, 1);
});

test("delete removes the visit and its notes for good, from either side", async () => {
  const t = start();
  const b = await book(t);
  await t.m("PUT", `/visits/${b.id}/notes`, FULL);
  assert.equal((await t.m("POST", `/visits/${b.id}/delete`)).status, 200);
  assert.equal(t.db.prepare(`SELECT COUNT(*) c FROM bookings WHERE id = ?`).get(b.id).c, 0);
  assert.equal(t.db.prepare(`SELECT COUNT(*) c FROM visit_notes WHERE booking_id = ?`).get(b.id).c, 0);
  assert.equal((await t.pub("GET", `/api/booking/${b.token}`)).status, 404);               // the family's old link is dead
  const week = await (await t.pub("GET", "/api/week?start=2026-10-04")).json();
  assert.equal(week.days.find((d) => d.date === b.date).slots.find((s) => s.time === b.time).status, "open");
  assert.equal((await t.m("POST", `/visits/${b.id}/delete`)).status, 404);

  const c = await book(t, "Second", "801-555-0105");
  await t.a("PUT", `/visits/${c.id}/notes`, FULL);
  assert.equal((await t.pub("POST", `/api/admin/delete/${c.id}`)).status, 401);           // admin only
  assert.equal((await t.a("POST", `/delete/${c.id}`)).status, 200);
  assert.equal(t.db.prepare(`SELECT COUNT(*) c FROM visit_notes`).get().c, 0);

  const p = pastVisit(t); // a past visit can be deleted too
  assert.equal((await t.m("POST", `/visits/${p}/delete`)).status, 200);
});

test("admin sees notes on upcoming and recent visits and can edit them", async () => {
  const t = start();
  const b = await book(t, "Adminfam", "801-555-0106");
  const p = pastVisit(t, "Pastfam");
  assert.equal((await t.a("PUT", `/visits/${b.id}/notes`, FULL)).status, 200);
  assert.equal((await t.a("PUT", `/visits/${p}/notes`, { taught: "Prayer" })).status, 200);
  assert.equal((await t.a("PUT", `/visits/${b.id}/notes`, { ...FULL, followupDate: "nope" })).status, 400);
  assert.equal((await t.pub("PUT", `/api/admin/visits/${b.id}/notes`, FULL)).status, 401);
  const s = await (await t.a("GET", "/state")).json();
  assert.equal(s.bookings.find((x) => x.id === b.id).notes.followupDate, "2026-10-12");
  assert.equal(s.recent.find((x) => x.id === p).notes.taught, "Prayer");
  assert.ok(!s.bookings.some((x) => x.id === p)); // past visits are listed separately
});

test("missionaries can close and reopen times, same rules as the admin screen", async () => {
  const t = start();
  const week = await (await t.pub("GET", "/api/week?start=2026-10-04")).json();
  const day = week.days.find((d) => d.slots.filter((s) => s.status === "open").length >= 2);
  const [a, b] = day.slots.filter((s) => s.status === "open");
  const status = async (time) => (await (await t.pub("GET", "/api/week?start=2026-10-04")).json()).days.find((d) => d.date === day.date).slots.find((s) => s.time === time).status;

  const info = await (await t.m("GET", "/times")).json();
  assert.ok(info.times.length > 0 && Array.isArray(info.blocks));
  assert.equal((await t.pub("GET", "/api/m/wrong/times")).status, 404);

  const r = await t.m("POST", "/block", { date: day.date, time: a.time });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).blocks.length, 1);
  assert.equal(await status(a.time), "blocked");
  assert.equal(await status(b.time), "open");                                  // only that time

  // a family can't book a closed time
  const tryBook = await t.pub("POST", "/api/book", { date: day.date, time: a.time, family: "X", phone: "801-555-0111" });
  assert.equal(tryBook.status, 409);

  // a time a family already holds can't be closed until their visit is cancelled
  const held = await t.pub("POST", "/api/book", { date: day.date, time: b.time, family: "Held", phone: "801-555-0112" });
  assert.equal(held.status, 201);
  const refused = await t.m("POST", "/block", { date: day.date, time: b.time });
  assert.equal(refused.status, 409);

  assert.equal((await t.m("POST", "/block", { date: "2026-13-45", time: a.time })).status, 400);
  assert.equal((await t.m("POST", "/block", { date: day.date, time: "03:07" })).status, 400);
  assert.equal((await t.pub("POST", `/api/m/wrong/block`, { date: day.date, time: a.time })).status, 404);

  const open = await t.m("POST", "/unblock", { date: day.date, time: a.time });
  assert.equal(open.status, 200);
  assert.equal((await open.json()).blocks.length, 0);
  assert.equal(await status(a.time), "open");

  // the admin screen sees the same closed times
  await t.m("POST", "/block", { date: day.date, time: a.time });
  assert.equal((await (await t.a("GET", "/state")).json()).blocks.length, 1);
});

test("the times form lists only the times offered on each weekday", async () => {
  const t = start();
  const info = await (await t.m("GET", "/times")).json();
  assert.equal(Object.keys(info.byDay).length, 7);
  for (const d of Object.keys(info.byDay)) for (const o of info.byDay[d]) assert.ok(info.times.some((x) => x.value === o.value));
  const monday = info.byDay[1].map((o) => o.value);
  const weekday = await (await t.pub("GET", "/api/week?start=2026-10-04")).json();
  const mon = weekday.days.find((d) => d.date === "2026-10-05");
  assert.deepEqual(mon.slots.map((s) => s.time), monday);                       // matches what the sign-up sheet offers
});
