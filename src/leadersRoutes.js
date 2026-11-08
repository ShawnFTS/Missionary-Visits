// /leaders — the missionary coordination meeting. Mounted from server.js.
//
// Auth is HTTP Basic like /admin (any username): LEADERS_PASSWORD, or the admin password. With neither set the
// whole section answers 404, so it is invisible until someone decides to turn it on. JSON bodies only, so a
// form on another site cannot post through a leader's cached sign-in.
import path from "node:path";
import { isDate } from "./time.js";
import { smsConfigured } from "./sms.js";
import * as L from "./leaders.js";

export function mountLeaders({ app, db, cfg, now, sendSms, same, root, requireAdmin }) {
  function requireLeaders(req, res, next) {
    const passwords = [cfg.leadersPassword, cfg.adminPassword].filter(Boolean);
    if (!passwords.length) return res.status(404).send("Not found");
    const m = /^Basic (.+)$/.exec(req.get("authorization") || "");
    const pass = m ? Buffer.from(m[1], "base64").toString().split(":").slice(1).join(":") : "";
    if (m && passwords.some((p) => same(pass, p))) return next();
    res.set("WWW-Authenticate", 'Basic realm="Missionary leaders"').status(401).send("Sign in required");
  }
  const ctx = () => ({ db, cfg, sendSms, now });
  const reply = (res, r, okStatus = 200) => (r.error ? res.status(r.status || 400).json({ error: r.error, saved: r.saved }) : res.status(okStatus).json(r));
  // Only real meetings: one the rule schedules, or one the books already hold. Stops junk dates making rows.
  const meetingDate = (req, res) => {
    const d = String(req.params.date);
    if (isDate(d) && L.isKnownMeeting(db, cfg, d)) return d;
    res.status(404).json({ error: "That isn't a meeting date." });
    return null;
  };

  app.get("/leaders", requireLeaders, (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    res.sendFile(path.join(root, "private", "leaders.html"));
  });

  app.get("/api/leaders/state", requireLeaders, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      settings: L.leadersView(cfg),
      people: L.listPeople(db),
      meetings: L.meetingLists(db, cfg, now()),
      messages: L.listMessages(db, cfg),
      texts: { enabled: cfg.leaders.textsEnabled, ready: L.textsReady(cfg, sendSms), recipients: L.textable(db).length, smsConfigured: smsConfigured(cfg) },
    });
  });

  app.get("/api/leaders/meetings/:date", requireLeaders, (req, res) => {
    const d = meetingDate(req, res); if (!d) return;
    res.set("Cache-Control", "no-store");
    res.json(L.meetingDetail(db, cfg, d));
  });

  app.post("/api/leaders/meetings/:date/attendance", requireLeaders, (req, res) => {
    const d = meetingDate(req, res); if (!d) return;
    reply(res, L.addAttendance(db, cfg, d, req.body || {}, now()), 201);
  });
  app.put("/api/leaders/meetings/:date/attendance/:id", requireLeaders, (req, res) => {
    const d = meetingDate(req, res); if (!d) return;
    reply(res, L.updateAttendance(db, cfg, d, req.params.id, req.body || {}));
  });
  app.delete("/api/leaders/meetings/:date/attendance/:id", requireLeaders, (req, res) => {
    const d = meetingDate(req, res); if (!d) return;
    L.removeAttendance(db, d, req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/leaders/meetings/:date/update", requireLeaders, async (req, res) => {
    const d = meetingDate(req, res); if (!d) return;
    reply(res, await L.updateMeeting(ctx(), d, req.body || {}));
  });
  app.post("/api/leaders/meetings/:date/remind", requireLeaders, async (req, res) => {
    const d = meetingDate(req, res); if (!d) return;
    reply(res, await L.remindNow(ctx(), d));
  });

  app.post("/api/leaders/people", requireLeaders, (req, res) => {
    const r = L.savePerson(db, cfg, req.body || {}, now());
    reply(res, r, req.body?.id ? 200 : 201);
  });
  app.post("/api/leaders/people/:id/remove", requireLeaders, (req, res) => {
    L.removePerson(db, req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/leaders/messages", requireLeaders, async (req, res) => {
    const b = req.body || {};
    reply(res, await L.postMessage(ctx(), { fromId: b.fromId, body: b.body, meetingDate: b.meetingDate, alsoText: b.alsoText === true, recipientIds: b.recipientIds }), 201);
  });

  // The meeting rule, callings and reminder timing. The texting switch is deliberately not settable here.
  app.post("/api/leaders/settings", requireLeaders, (req, res) => {
    const r = L.saveLeaders(db, cfg, req.body || {}, now(), { allowTexts: false });
    if (r.errors) return res.status(400).json({ error: r.errors.join(" ") });
    res.json({ ok: true, settings: L.leadersView(cfg) });
  });

  // ---- admin: where the page lives, and the texting switch ----
  app.get("/api/admin/leaders", requireAdmin, (req, res) => {
    const base = cfg.selfUrl || `${req.protocol}://${req.get("host")}`;
    res.json({
      url: `${base}/leaders`, passwordSet: !!cfg.leadersPassword, adminPasswordWorks: !!cfg.adminPassword,
      textsEnabled: cfg.leaders.textsEnabled, smsConfigured: smsConfigured(cfg), recipients: L.textable(db).length, people: L.listPeople(db).length,
    });
  });
  app.post("/api/admin/leaders", requireAdmin, (req, res) => {
    const r = L.saveLeaders(db, cfg, { textsEnabled: req.body?.textsEnabled === true }, now(), { allowTexts: true });
    if (r.errors) return res.status(400).json({ error: r.errors.join(" ") });
    res.json({ ok: true, textsEnabled: cfg.leaders.textsEnabled });
  });
}
