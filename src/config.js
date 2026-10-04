// Everything tunable lives in env vars so changing "which evenings, what times"
// is a restart, not a code change. Read fresh by index.js; tests pass their own.
const DEFAULT_SCHEDULE = {
  0: ["19:30", "20:15"],
  1: ["19:30", "20:15"],
  2: ["19:30", "20:15"],
  3: ["18:45", "19:30"],
  4: ["19:30", "20:15"],
  5: ["10:00", "10:45"],
  6: ["15:00", "15:45"],
};

export const slotTimesOn = (cfg, dow) => cfg.schedule[dow] || [];
export const allTimes = (cfg) => [...new Set(Object.values(cfg.schedule).flat())].sort();

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    tz: env.SITE_TZ || "America/Denver",
    // Start times by day of week (0 = Sunday), 24-hour. Defaults are the stake's
    // Missionary Visit Schedule V2; override with SLOT_SCHEDULE as JSON.
    schedule: env.SLOT_SCHEDULE ? JSON.parse(env.SLOT_SCHEDULE) : DEFAULT_SCHEDULE,
    minutes: Number(env.SLOT_MINUTES) || 45,
    // The rotation runs a fixed number of full cycles through the wards, then stops.
    rotationCycles: Number(env.ROTATION_CYCLES) || 4,
    // Each Sunday–Saturday week belongs to one ward, rotating. The week of
    // `rotationStart` is the first ward's; the list repeats forever.
    rotationStart: env.ROTATION_START || "2026-09-20",
    wards: (env.WARDS || "Harmony,Overland Trails,Springwater,White Hills,Cedar Fort,Fairfield").split(",").map((s) => s.trim()).filter(Boolean),
    missionaryPhone: env.MISSIONARY_PHONE ?? "385-233-7693",
    helpName: env.HELP_NAME ?? "Shawn Sandberg",
    helpPhone: env.HELP_PHONE ?? "801-404-4111",
    adminPassword: env.ADMIN_PASSWORD || "",
    feedToken: env.MISSIONARY_FEED_TOKEN || "", // optional; default is derived from ADMIN_PASSWORD
    dataDir: env.DATA_DIR || "./data",
    selfUrl: (env.SELF_URL || "").replace(/\/$/, ""),
    twilio: {
      sid: env.TWILIO_ACCOUNT_SID || "",
      token: env.TWILIO_AUTH_TOKEN || "",
      from: env.TWILIO_FROM || "",
      service: env.TWILIO_MESSAGING_SERVICE_SID || "",
    },
  };
}
