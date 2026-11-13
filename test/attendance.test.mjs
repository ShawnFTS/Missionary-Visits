import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { zonedToUtc } from "../src/time.js";
import { attendanceHistory } from "../src/attendanceReport.js";

// Sun Nov 8 2026. The 2nd Thursdays before it: Oct 8, Sep 10, Aug 13, Jul 9, Jun 11. Nov 12 is still ahead.
const NOW = zonedToUtc("2026-11-08", "12:00", "America/Denver");
const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections?.(); s.close(); }));

function start() {
  const db = openDb(":memory:");
  const cfg = loadConfig({ ADMIN_PASSWORD: "pw", SELF_URL: "https://x.test" });
  const server = createApp({ db, cfg, now: () => NOW, sendSms: null }).listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: "Basic " + Buffer.from("x:pw").toString("base64") };
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(body) });
  return { db, cfg, base, auth, post };
}

// who[i] = how many people (named P0, P1, ...) came on the i-th date; P0 always comes first.
async function seed(t, dates, counts, ward = "Harmony") {
  const people = [];
  for (let i = 0; i < Math.max(...counts); i++) {
    const r = await t.post("/api/leaders/people", { name: `Person ${i}`, calling: "High Councilor", ward: i % 2 ? t.cfg.wards[1] : ward });
    people.push((await r.json()).id);
  }
  for (let d = 0; d < dates.length; d++) {
    for (let i = 0; i < counts[d]; i++) assert.equal((await t.post(`/api/leaders/meetings/${dates[d]}/attendance`, { personId: people[i] })).status, 201);
  }
}

test("history counts held meetings, averages them, and ignores future ones", async () => {
  const t = start();
  await seed(t, ["2026-06-11", "2026-07-09", "2026-08-13", "2026-09-10", "2026-10-08", "2026-11-12"], [4, 4, 4, 6, 8, 3]);
  const h = attendanceHistory(t.db, t.cfg, NOW, 6);
  assert.deepEqual(h.meetings.map((m) => m.count), [4, 4, 4, 6, 8]);                  // Nov 12 hasn't happened
  assert.equal(h.summary.held, 5);
  assert.equal(h.summary.average, 5.2);
  assert.deepEqual([h.summary.best.count, h.summary.lowest.count], [8, 4]);
  assert.equal(h.meetings[4].longLabel, "Oct 8, 2026");
});

test("trend compares the last three meetings with the three before, and needs four meetings", async () => {
  const t = start();
  await seed(t, ["2026-08-13", "2026-09-10"], [4, 4]);
  assert.equal(attendanceHistory(t.db, t.cfg, NOW, 6).trend.direction, "none");

  const up = start();
  await seed(up, ["2026-06-11", "2026-07-09", "2026-08-13", "2026-09-10", "2026-10-08"], [3, 3, 3, 6, 6]);
  const h = attendanceHistory(up.db, up.cfg, NOW, 6);
  assert.equal(h.trend.direction, "up");
  assert.ok(h.trend.text.startsWith("Up "));

  const flat = start();
  await seed(flat, ["2026-06-11", "2026-07-09", "2026-08-13", "2026-09-10", "2026-10-08"], [5, 5, 5, 5, 5]);
  assert.equal(attendanceHistory(flat.db, flat.cfg, NOW, 6).trend.direction, "steady");
});

test("a cancelled meeting is not counted as held, and the per-ward and per-person numbers add up", async () => {
  const t = start();
  await seed(t, ["2026-08-13", "2026-09-10", "2026-10-08"], [2, 2, 1]);
  await t.post("/api/leaders/meetings/2026-09-10/update", { cancelled: true });
  const h = attendanceHistory(t.db, t.cfg, NOW, 6);
  assert.equal(h.summary.held, 2);
  assert.equal(h.summary.cancelled, 1);
  const harmony = h.wards.find((w) => w.ward === "Harmony");
  assert.deepEqual([harmony.meetingsAttended, harmony.meetingsHeld, harmony.rate], [2, 2, 100]);
  const p0 = h.people.find((p) => p.name === "Person 0");
  assert.deepEqual([p0.attended, p0.rate], [2, 100]);
  assert.equal(h.people.find((p) => p.name === "Person 1").attended, 1);
});

test("the range is limited to what the page offers", async () => {
  const t = start();
  assert.equal(attendanceHistory(t.db, t.cfg, NOW, 7).months, 12);
  assert.equal(attendanceHistory(t.db, t.cfg, NOW, 3).months, 3);
  assert.equal(attendanceHistory(t.db, t.cfg, NOW, 6).summary.held, 0);   // an empty history is fine
});

test("the history API and the PDF are admin-only, and the PDF is a real PDF", async () => {
  const t = start();
  await seed(t, ["2026-09-10", "2026-10-08"], [3, 5]);
  for (const p of ["/api/leaders/history", "/api/leaders/history.pdf"]) assert.equal((await fetch(t.base + p)).status, 401, p);

  const j = await (await fetch(t.base + "/api/leaders/history?months=6", { headers: t.auth })).json();
  assert.equal(j.summary.held, 2);
  assert.equal(j.meetings[1].count, 5);

  const pdf = await fetch(t.base + "/api/leaders/history.pdf?months=6", { headers: t.auth });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-disposition"), /attachment; filename="meeting-attendance-2026-11-08\.pdf"/);
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(buf.length > 1500);

  const e = start(); // no meetings at all: still a valid PDF
  const empty = await fetch(e.base + "/api/leaders/history.pdf", { headers: e.auth });
  assert.equal(empty.status, 200);
  assert.equal(Buffer.from(await empty.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
});
