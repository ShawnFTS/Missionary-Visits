import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createApp } from "./server.js";
import { smsConfigured, makeTwilioSender } from "./sms.js";
import { startReminders } from "./reminders.js";
import { startLeaderReminders } from "./leaders.js";

const cfg = loadConfig();
const db = openDb(cfg.dataDir);
const app = createApp({ db, cfg });
app.set("trust proxy", 1); // behind Railway/Render/etc., so rate limiting sees the visitor, not the proxy

app.listen(cfg.port, () => {
  console.log(`Missionary visits sign-up on :${cfg.port}`);
  console.log(smsConfigured(cfg) ? "Text reminders: ON" : "Text reminders: off (set TWILIO_* to enable)");
  console.log(cfg.adminPassword ? "Admin: /admin" : "Admin: off (set ADMIN_PASSWORD to enable)");
  console.log(cfg.adminPassword ? "Leaders: /leaders (admin login)" : "Leaders: off (set ADMIN_PASSWORD to enable)");
});
if (smsConfigured(cfg)) {
  const send = makeTwilioSender(cfg);
  startReminders({ db, cfg, send });
  startLeaderReminders({ db, cfg, send }); // texts only if an admin has turned on texting leaders
}
