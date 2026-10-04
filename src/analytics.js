// Anonymous visit counting for the sign-up page.
//
// What a "visitor" is: a random id in a first-party cookie, so one per BROWSER.
// It is not a person. The same family on a phone and a laptop counts twice; a
// private window or cleared cookies counts as new; an in-app browser (Messages,
// Facebook) keeps its own cookies, so opening the link there and again in
// Safari counts twice. No IP address, no fingerprinting, nothing that names anyone.
import crypto from "node:crypto";
import { todayInZone, addDays } from "./time.js";

const BOT = /bot|crawl|spider|slurp|preview|curl|wget|python|node-fetch|axios|go-http|headless|lighthouse|pingdom|uptime|monitor|embedly|facebookexternalhit|^WhatsApp/i;
export const isBot = (ua) => !ua || BOT.test(ua);

export function parseUa(ua = "") {
  const device = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? "Tablet"
    : /Mobi|iPhone|iPod|Android/i.test(ua) ? "Phone" : "Computer";
  const os = /iPhone|iPad|iPod/i.test(ua) ? "iOS" : /Android/i.test(ua) ? "Android" : /Windows/i.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/i.test(ua) ? "Mac" : /CrOS/i.test(ua) ? "ChromeOS" : /Linux/i.test(ua) ? "Linux" : "Other";
  const browser = /FBAN|FBAV/i.test(ua) ? "Facebook app" : /Instagram/i.test(ua) ? "Instagram app"
    : /EdgA?\/|Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /FxiOS|Firefox/i.test(ua) ? "Firefox"
    : /CriOS|Chrome/i.test(ua) ? "Chrome" : /Safari/i.test(ua) ? "Safari" : "Other";
  return { device, os, browser };
}

export function readCookie(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.get("cookie") || "");
  return m ? m[1] : "";
}

export const newVisitorId = () => crypto.randomBytes(12).toString("base64url");
export const cleanSrc = (s) => (/^[\w-]{1,30}$/.test(String(s ?? "")) ? String(s) : null);

// Referrer host only (never the full URL), and not ourselves.
export function refHost(ref, selfHost) {
  try {
    const h = new URL(String(ref)).host.replace(/^www\./, "").slice(0, 60);
    return h && h !== selfHost ? h : null;
  } catch { return null; }
}

const HALF_HOUR = 30 * 60_000;

export function record(db, { kind, visitor, ua, src = null, ref = null, now }) {
  // One view per visitor per half hour, so a refresh-happy parent doesn't inflate the count.
  if (kind === "view" && db.prepare(`SELECT 1 FROM events WHERE kind='view' AND visitor=? AND ts>?`).get(visitor, now - HALF_HOUR)) return false;
  const d = parseUa(ua);
  db.prepare(`INSERT INTO events (ts, kind, visitor, device, os, browser, src, ref) VALUES (?,?,?,?,?,?,?,?)`)
    .run(now, kind, visitor, d.device, d.os, d.browser, src, ref);
  return true;
}

const tally = (items) => {
  const m = new Map();
  for (const x of items) if (x) m.set(x, (m.get(x) || 0) + 1);
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8);
};

export function stats(db, cfg, now) {
  const rows = db.prepare(`SELECT * FROM events WHERE ts > ? ORDER BY ts`).all(now - 120 * 86400_000);
  const views = rows.filter((r) => r.kind === "view");
  const signups = rows.filter((r) => r.kind === "signup");
  const within = (list, days) => list.filter((r) => r.ts > now - days * 86400_000);
  const uniq = (list) => new Set(list.map((r) => r.visitor)).size;

  const byVisitor = new Map(); // newest view per visitor, for the device breakdowns
  const firstTouch = new Map(); // first src / referrer each visitor arrived with: credit where they came FROM, not where a later revisit came from
  const days = new Map();
  for (const v of views) {
    byVisitor.set(v.visitor, v);
    const ft = firstTouch.get(v.visitor) || {};
    firstTouch.set(v.visitor, { src: ft.src || v.src, ref: ft.ref || v.ref });
    const s = days.get(v.visitor) || new Set();
    s.add(todayInZone(v.ts, cfg.tz)); days.set(v.visitor, s);
  }
  const people = [...byVisitor.values()];
  const visitors = people.length;
  const signedUp = new Set(signups.map((r) => r.visitor));
  const today = todayInZone(now, cfg.tz);
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const date = addDays(today, -i);
    const day = views.filter((v) => todayInZone(v.ts, cfg.tz) === date);
    daily.push({ date, views: day.length, unique: uniq(day) });
  }
  return {
    since: rows.length ? rows[0].ts : null,
    totals: {
      views: views.length, visitors,
      returning: [...days.values()].filter((s) => s.size > 1).length,
      signups: signups.length,
      conversionPct: visitors ? Math.round((100 * [...signedUp].filter((v) => byVisitor.has(v)).length) / visitors) : 0,
    },
    last7: { views: within(views, 7).length, visitors: uniq(within(views, 7)) },
    last30: { views: within(views, 30).length, visitors: uniq(within(views, 30)) },
    devices: tally(people.map((p) => p.device)),
    os: tally(people.map((p) => p.os)),
    browsers: tally(people.map((p) => p.browser)),
    sources: tally([...firstTouch.values()].map((p) => p.src)),
    referrers: tally([...firstTouch.values()].map((p) => p.ref)),
    daily,
  };
}
