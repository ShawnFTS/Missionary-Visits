import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export function openDb(dir) {
  let db;
  if (dir === ":memory:") db = new Database(":memory:");
  else {
    fs.mkdirSync(dir, { recursive: true });
    db = new Database(path.join(dir, "signups.db"));
    db.pragma("journal_mode = WAL");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id            INTEGER PRIMARY KEY,
      token         TEXT NOT NULL UNIQUE,   -- the family's private link; the only credential they have
      slot_date     TEXT NOT NULL,          -- local calendar date in the stake's zone
      slot_time     TEXT NOT NULL,          -- local wall-clock "HH:MM"
      start_utc     INTEGER NOT NULL,
      family        TEXT NOT NULL,
      phone         TEXT NOT NULL,          -- E.164, never sent to the browser except masked
      remind_day    INTEGER NOT NULL DEFAULT 0,
      remind_hour   INTEGER NOT NULL DEFAULT 0,
      day_sent_at   INTEGER,                -- claimed BEFORE the request: better to miss one text than send two
      hour_sent_at  INTEGER,
      sms_error     TEXT,
      created_at    INTEGER NOT NULL,
      cancelled_at  INTEGER,
      cancelled_by  TEXT
    );
    -- Two families cannot hold one evening. Enforced here, not just in the
    -- handler, so two phones tapping the same slot at once cannot both win.
    CREATE UNIQUE INDEX IF NOT EXISTS ux_active_slot
      ON bookings(slot_date, slot_time) WHERE cancelled_at IS NULL;
    -- Anonymous visit counting. Deliberately holds no IP address, no name and no booking id:
    -- a signup event says "a visitor signed up", never which family.
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL,   -- 'view' | 'signup'
      visitor TEXT NOT NULL,                                              -- random cookie id, one per browser
      device TEXT, os TEXT, browser TEXT, src TEXT, ref TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);
    -- Admin-editable settings (schedule, rotation, contact info). Env vars are the defaults;
    -- whatever is saved here wins and is applied live, no redeploy.
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    -- Who is told when a visit is cancelled (or booked). Deactivated, never deleted: the log refers to them.
    CREATE TABLE IF NOT EXISTS missionary_contacts (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT,
      sms INTEGER NOT NULL DEFAULT 0, notify_cancel INTEGER NOT NULL DEFAULT 1, notify_signup INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, booking_id INTEGER,
      contact_id INTEGER, contact_name TEXT, channel TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT
    );
    -- Families waiting for a week that is full. First to hear when a visit cancels.
    CREATE TABLE IF NOT EXISTS waitlist (
      id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE, week_start TEXT NOT NULL,
      family TEXT NOT NULL, phone TEXT NOT NULL, address TEXT, created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',   -- waiting | booked | left | removed
      done_at INTEGER, booking_token TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_waiting ON waitlist(week_start, phone) WHERE status = 'waiting';
    -- A just-cancelled time held for the wait-list for a short while before the public can take it.
    CREATE TABLE IF NOT EXISTS slot_holds (slot_date TEXT NOT NULL, slot_time TEXT NOT NULL, until_ts INTEGER NOT NULL, PRIMARY KEY (slot_date, slot_time));
    -- What the missionaries plan to teach, what they taught, what the family committed to, and when
    -- they will follow up. Private: only the missionary page and admin ever read this, never the
    -- family's own link, the public sheet, or any text message. One row per visit.
    CREATE TABLE IF NOT EXISTS visit_notes (
      booking_id INTEGER PRIMARY KEY,
      planned TEXT, taught TEXT, commitments TEXT,
      followup_date TEXT,        -- local calendar date in the stake's zone, or NULL
      followup_time TEXT,        -- local "HH:MM", or NULL for an all-day reminder
      followup_utc INTEGER,      -- instant for a timed follow-up
      updated_at INTEGER NOT NULL, updated_by TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_notes_followup ON visit_notes(followup_date);
    CREATE TABLE IF NOT EXISTS blocks (
      slot_date TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      PRIMARY KEY (slot_date, slot_time)
    );
  `);
  // Added after first deploy: where the missionaries should go. Guarded so existing data survives.
  if (!db.prepare("PRAGMA table_info(bookings)").all().some((c) => c.name === "address")) {
    db.exec("ALTER TABLE bookings ADD COLUMN address TEXT");
  }
  return db;
}
