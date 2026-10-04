import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { zonedToUtc } from "../src/time.js";
import { parseUa, isBot } from "../src/analytics.js";

const NOW = zonedToUtc("2026-10-06", "10:00", "America/Denver");
const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections?.(); s.close(); }));

function start(over = {}) {
  const db = openDb(":memory:");
  const cfg = { ...loadConfig({ ADMIN_PASSWORD: "pw", SELF_URL: "https://x.test", MISSIONARY_KEY: "secretkey123" }), ...over };
  const clock = { t: NOW };
  const server = createApp({ db, cfg, now: () => clock.t }).listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = { Authorization: "Basic " + Buffer.from("a:pw").toString("base64") };
  const j = (p, body, headers = {}) => fetch(base + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return { db, base, j, admin, clock };
}
const book = (t, extra = {}, headers = {}) => t.j("/api/book", { date: "2026-10-07", time: "18:45", family: "Smith", phone: "8015550123", address: "123 Main St, Eagle Mountain", ...extra }, headers);

test("address is stored but never public; the missionaries' feed carries phone + address + directions", async () => {
  const t = start();
  assert.equal((await book(t)).status, 201);
  assert.equal((await book(t, { time: "19:30", family: "Jones", address: "" })).status, 201); // address optional

  const week = JSON.stringify(await (await t.j("/api/week?start=2026-10-04")).json());
  assert.ok(!week.includes("Main St") && !week.includes("555"));

  const st = await (await t.j("/api/admin/state", null, t.admin)).json();
  assert.equal(st.pageUrl, "https://x.test/m/secretkey123");
  assert.equal(st.webcalUrl, "webcal://x.test/m/secretkey123/feed.ics");
  const api = await (await fetch(`${t.base}/api/m/secretkey123/visits`)).json();
  assert.equal(api.visits.find((v) => v.family === "Smith Family").address, "123 Main St, Eagle Mountain");

  const feed = await fetch(`${t.base}/m/secretkey123/feed.ics`);
  assert.match(feed.headers.get("content-type"), /text\/calendar/);
  const body = await feed.text();
  assert.equal((body.match(/BEGIN:VEVENT/g) || []).length, 2);
  const flat = body.replace(/\r\n /g, ""); // unfold long lines
  assert.match(flat, /LOCATION:123 Main St\\, Eagle Mountain/);
  assert.match(flat, /Phone: \(801\) 555-0123/);
  assert.match(flat, /URL:https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=123%20Main%20St%2C%20Eagle%20Mountain/);
  assert.match(flat, /Directions \(Apple Maps\): https:\/\/maps\.apple\.com\/\?q=123%20Main%20St/);
  assert.match(flat, /Ward: Springwater/);
  for (const line of body.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
});

test("missionary feed: wrong key, key unset, and cancelled visits", async () => {
  const t = start();
  const { token } = await (await book(t)).json();
  assert.equal((await fetch(`${t.base}/m/wrong/feed.ics`)).status, 404);
  assert.ok((await (await fetch(`${t.base}/m/secretkey123/feed.ics`)).text()).includes("Smith"));
  await t.j(`/api/booking/${token}/cancel`, {});
  assert.ok(!(await (await fetch(`${t.base}/m/secretkey123/feed.ics`)).text()).includes("Smith")); // cancellation reaches their calendar

  const off = start({ missionaryKey: "" });
  assert.equal((await fetch(`${off.base}/m/secretkey123/feed.ics`)).status, 404);
  assert.equal((await (await off.j("/api/admin/state", null, off.admin)).json()).pageUrl, null);
});

test("admin can add a visit (no texts), and cannot double-book; CSV neutralises formulas", async () => {
  const t = start({ twilio: { sid: "a", token: "b", from: "+1", service: "" } });
  const body = { date: "2026-10-08", time: "19:30", family: "=HYPERLINK(\"x\")", phone: "801-555-0100", remindDay: true, remindHour: true };
  assert.equal((await t.j("/api/admin/book", body, t.admin)).status, 201);
  assert.equal((await t.j("/api/admin/book", body, t.admin)).status, 409);
  assert.equal((await t.j("/api/admin/book", body)).status, 401);
  assert.equal(t.db.prepare("SELECT remind_day, remind_hour FROM bookings").get().remind_day, 0);
  const csv = await (await t.j("/api/admin/export.csv", null, t.admin)).text();
  assert.match(csv, /^"Date","Time","Ward"/);
  assert.ok(!csv.includes('"=HYPERLINK') && csv.includes("\"'=HYPERLINK"));
});

test("analytics: counts a browser once per half hour, ignores bots/notrack, records signup without identity", async () => {
  const t = start();
  const phone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const hit = (body, headers = {}) => t.j("/api/hit", body, { "User-Agent": phone, ...headers });

  let r = await hit({ src: "harmony", ref: "https://www.facebook.com/x" });
  assert.equal(r.status, 204);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /^mv=/);
  await hit({ src: "harmony" }, { Cookie: cookie });          // refresh: not counted again
  t.clock.t += 3600_000;
  await hit({ src: "harmony" }, { Cookie: cookie });          // an hour later: counted, same visitor
  await hit({ src: "springwater" }, { "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120" }); // second browser
  await hit({}, { "User-Agent": "WhatsApp/2.23" });             // preview robot
  await hit({}, { "User-Agent": "Googlebot/2.1" });
  await hit({ off: true });                                     // ?notrack: sets an off cookie
  await hit({ src: "x" }, { Cookie: "mv=off" });                // ...and that browser is then invisible

  await book(t, {}, { Cookie: cookie, "User-Agent": phone });   // signup from the first browser

  const s = await (await t.j("/api/admin/stats", null, t.admin)).json();
  assert.equal(s.totals.views, 3);
  assert.equal(s.totals.visitors, 2);
  assert.equal(s.totals.signups, 1);
  assert.equal(s.totals.conversionPct, 50);
  assert.deepEqual(s.devices.map((d) => d.name).sort(), ["Computer", "Phone"]);
  assert.equal(s.referrers[0].name, "facebook.com");
  assert.equal(s.sources.find((x) => x.name === "harmony").count, 1);
  // nothing identifying is stored
  const cols = t.db.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
  assert.ok(!cols.some((c) => /ip|name|phone|booking/i.test(c)), cols.join());
  assert.equal((await t.j("/api/admin/stats")).status, 401);
});

test("user-agent parsing", () => {
  assert.deepEqual(parseUa("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36"), { device: "Phone", os: "Android", browser: "Chrome" });
  assert.equal(parseUa("Mozilla/5.0 (iPad; CPU OS 17_0) Safari/604.1").device, "Tablet");
  assert.equal(parseUa("Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/400]").browser, "Facebook app");
  assert.ok(isBot("") && isBot("curl/8") && !isBot("Mozilla/5.0 (iPhone) Safari"));
});
