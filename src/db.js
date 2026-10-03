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
    CREATE TABLE IF NOT EXISTS blocks (
      slot_date TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      PRIMARY KEY (slot_date, slot_time)
    );
  `);
  return db;
}
