// Ward huddles. The backend is behind the admin login (same as /leaders); the only public piece is the read-only
// list that gets sent out, which needs the random key in its link and does not exist until an admin creates it.
import path from "node:path";
import * as H from "./huddles.js";
import { WEEKDAYS, YOUTH } from "./leaders.js";

export function mountHuddles({ app, db, cfg, now, root, requireAdmin }) {
  const reply = (res, r, okStatus = 200) => (r.error ? res.status(r.status || 400).json({ error: r.error }) : res.status(okStatus).json(r));
  // Only real wards (not "Stake"); the name comes decoded from the path.
  const wardOf = (req, res) => {
    const w = String(req.params.ward);
    if (cfg.wards.includes(w)) return w;
    res.status(404).json({ error: "That isn't one of the wards." });
    return null;
  };
  const base = (req) => cfg.selfUrl || `${req.protocol}://${req.get("host")}`;
  const shareInfo = (req) => {
    const s = H.shareState(db);
    return { on: !!s.key, url: s.key ? `${base(req)}/huddles/${s.key}` : "", showYouthPhones: s.showYouthPhones };
  };

  app.get("/api/leaders/huddles", requireAdmin, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      wards: H.allWards(db, cfg, now()), share: shareInfo(req), weekdays: WEEKDAYS,
      callings: [...new Set([...cfg.leaders.callings, YOUTH])],
    });
  });
  app.get("/api/leaders/huddles.csv", requireAdmin, (req, res) => {
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="ward-huddles.csv"' });
    res.send(H.csv(db, cfg, now()));
  });

  app.post("/api/leaders/huddles/share", requireAdmin, (req, res) => {
    const b = req.body || {};
    H.saveShare(db, { action: ["create", "rotate", "off"].includes(b.action) ? b.action : undefined, showYouthPhones: typeof b.showYouthPhones === "boolean" ? b.showYouthPhones : undefined }, now());
    res.json({ ok: true, share: shareInfo(req) });
  });

  app.post("/api/leaders/huddles/:ward/schedule", requireAdmin, (req, res) => {
    const w = wardOf(req, res); if (!w) return;
    reply(res, H.saveSchedule(db, w, req.body || {}, now()));
  });
  app.post("/api/leaders/huddles/:ward/confirm", requireAdmin, (req, res) => {
    const w = wardOf(req, res); if (!w) return;
    H.confirmWard(db, w, now());
    res.json({ ok: true });
  });
  app.post("/api/leaders/huddles/:ward/people", requireAdmin, (req, res) => {
    const w = wardOf(req, res); if (!w) return;
    reply(res, H.addPerson(db, cfg, w, req.body || {}, now()), 201);
  });
  app.put("/api/leaders/huddles/:ward/people/:id", requireAdmin, (req, res) => {
    const w = wardOf(req, res); if (!w) return;
    reply(res, H.updatePerson(db, cfg, w, req.params.id, req.body || {}));
  });
  app.delete("/api/leaders/huddles/:ward/people/:id", requireAdmin, (req, res) => {
    const w = wardOf(req, res); if (!w) return;
    H.removePerson(db, w, req.params.id);
    res.json({ ok: true });
  });
  const huddleDate = (req, res, w) => {
    const d = String(req.params.date);
    if (H.isHuddleDate(db, w, d, now(), cfg.tz)) return d;
    res.status(404).json({ error: "That isn't one of this ward's huddle dates." });
    return null;
  };
  app.get("/api/leaders/huddles/:ward/:date", requireAdmin, (req, res) => {
    const w = wardOf(req, res); if (!w) return;
    const d = huddleDate(req, res, w); if (!d) return;
    res.set("Cache-Control", "no-store");
    res.json(H.sheet(db, w, d));
  });
  app.put("/api/leaders/huddles/:ward/:date", requireAdmin, (req, res) => {
    const w = wardOf(req, res); if (!w) return;
    const d = huddleDate(req, res, w); if (!d) return;
    reply(res, H.saveSheet(db, w, d, req.body || {}, now()));
  });

  // ---- the list that gets sent out: read-only, behind a random key, nothing until an admin makes the link ----
  app.get("/huddles/:key", (req, res) => {
    if (!H.keyMatches(db, req.params.key)) return res.status(404).send("Not found");
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    res.sendFile(path.join(root, "private", "huddles-share.html"));
  });
  app.get("/api/huddles/:key", (req, res) => {
    if (!H.keyMatches(db, req.params.key)) return res.status(404).json({ error: "Not found" });
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    res.json(H.shareable(db, cfg, now()));
  });
}
