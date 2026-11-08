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

// Short permalink codes for each ward (/SP, /FF, ...). Override with WARD_CODES="HA=Harmony,OT=Overland Trails".
const DEFAULT_CODES = { HA: "Harmony", OT: "Overland Trails", SP: "Springwater", WH: "White Hills", CF: "Cedar Fort", FF: "Fairfield" };
export function wardCodes(wards, raw) {
  const out = {};
  if (raw) for (const part of raw.split(",")) { const [k, ...v] = part.split("="); if (k && v.length) out[k.trim().toUpperCase()] = v.join("=").trim(); }
  else {
    for (const [k, v] of Object.entries(DEFAULT_CODES)) if (wards.includes(v)) out[k] = v;
    // Any ward not covered above: initials ("Mill Creek" -> MC) or first two letters.
    for (const w of wards) {
      if (Object.values(out).includes(w)) continue;
      const words = w.split(/\s+/);
      const code = (words.length > 1 ? words.map((x) => x[0]).join("") : w.slice(0, 2)).toUpperCase();
      if (!out[code]) out[code] = w;
    }
  }
  return out;
}

// The missionary coordination meeting (stake leaders). Editable on /leaders (admin login).
export const LEADERS_DEFAULTS = {
  nth: 2,                    // 2nd ...
  weekday: 4,                // ... Thursday (0 = Sunday)
  time: "20:00",             // 8:00 PM
  place: "Stake council room",
  callings: [
    "Stake President", "Stake Presidency Counselor", "High Councilor", "Stake Mission Leader", "Stake Executive Secretary",
    "Bishop", "Bishopric Counselor", "Ward Mission Leader", "Ward Missionary", "Elders Quorum President",
    "Relief Society President", "Full-time Missionary", "Youth", "Other",
  ],
  reminderDays: 2,           // text this many days before, at reminderAt (0 = off)
  reminderAt: "09:00",
  reminderHours: 2,          // and this many hours before (0 = off)
  textsEnabled: false,       // admin-only switch: nobody is texted until an admin turns this on
};

export const slotTimesOn = (cfg, dow) => cfg.schedule[dow] || [];
export const allTimes = (cfg) => [...new Set(Object.values(cfg.schedule).flat())].sort();

export function loadConfig(env = process.env) {
  const cfg = {
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
    wardCodes: null, // filled in below from wards + WARD_CODES
    missionaryPhone: env.MISSIONARY_PHONE ?? "385-233-7693",
    // Who the missionaries' shared phone (above) is texted about; editable on /admin → Settings.
    // Minutes a cancelled time is held for the wait-list before the public can book it (0 = no hold, just notify).
    waitlistHoldMinutes: Number(env.WAITLIST_HOLD_MINUTES ?? 30),
    notifyCancel: true,
    notifySignup: false,
    helpName: env.HELP_NAME ?? "Shawn Sandberg",
    helpPhone: env.HELP_PHONE ?? "801-404-4111",
    adminPassword: env.ADMIN_PASSWORD || "",
    // The leaders' backend (/leaders) is behind the admin login. The QR sign-in link carries a key derived from the admin
    // password (so changing the password retires every printed QR); set this to pin a fixed key instead.
    leadersKey: env.LEADERS_SIGNIN_KEY || "",
    leaders: { ...LEADERS_DEFAULTS, callings: [...LEADERS_DEFAULTS.callings] },
    // Secret in the missionaries' private link (/m/<key>). Unset = that page is off.
    missionaryKey: env.MISSIONARY_KEY || "",
    // Secret in the Google Sheet sync address (/api/sheet/<secret>/sync). Unset = the Sheet sync is off.
    sheetSecret: env.SHEET_SECRET || "",
    dataDir: env.DATA_DIR || "./data",
    selfUrl: (env.SELF_URL || "").replace(/\/$/, ""),
    twilio: {
      sid: env.TWILIO_ACCOUNT_SID || "",
      token: env.TWILIO_AUTH_TOKEN || "",
      from: env.TWILIO_FROM || "",
      service: env.TWILIO_MESSAGING_SERVICE_SID || "",
    },
  };
  cfg.wardCodesRaw = env.WARD_CODES || "";
  cfg.wardCodes = wardCodes(cfg.wards, cfg.wardCodesRaw);
  return cfg;
}
