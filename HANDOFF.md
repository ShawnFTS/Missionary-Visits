# Handoff — where we left off (2026-10-03)

*These are working notes for whoever continues this project next (Shawn, or a fresh Claude session). Not for any one person.*

## What exists
A working sign-up sheet, **Eagle Mountain West Stake Missionary Member Visits**, built from the stake's Google Doc
"Missionary Visit Schedule V2". Node + Express + SQLite, no build step. 11 tests pass (`npm test`).
**Live:** https://www.missionaryvisits.com (Railway project `missionary-visits`, service `web`, volume at `/data`;
the old https://web-production-d291da.up.railway.app address still works). Domain is registered at GoDaddy:
`CNAME www → qcgft9bd.up.railway.app` plus the `_railway-verify.www` TXT record. GoDaddy can't CNAME the bare domain,
so `missionaryvisits.com` should *forward* (301) to `https://www.missionaryvisits.com` — as of 2026-10-03 that forward had
not taken effect yet (bare domain still showed GoDaddy's placeholder). `SELF_URL` is set to the www address.

- Week calendar (Sun–Sat); day-specific 45-minute slots (Sun/Mon/Tue/Thu 7:30 & 8:15 PM, Wed 6:45 & 7:30 PM,
  Fri 10:00 & 10:45 AM, Sat 3:00 & 3:45 PM).
- Each week belongs to a ward, rotating Harmony → Overland Trails → Springwater → White Hills → Cedar Fort → Fairfield,
  starting Sun Sep 20, 2026, **four cycles (24 weeks, through Sat Mar 6, 2027)**, then nothing is bookable.
- Tap an open time → family name + mobile. Booked slots show the family name (phone never shown publicly).
- "Text me reminders" checkbox reveals 1-day / 1-hour boxes and the opt-in wording (links to `/privacy`, `/terms`).
- .ics download + Google Calendar link; private `/b/<token>` link to re-download or cancel; `/admin` (password).
- **Missionary view** `/m/<MISSIONARY_KEY>`: all upcoming visits with phone numbers, pick-and-download .ics
  (family + phone + ward in event details), and a live subscribe feed at `/m/<key>/feed.ics`. Off if the key is unset.
- **Ward permalinks:** `/HA` Harmony, `/OT` Overland Trails, `/SP` Springwater, `/WH` White Hills, `/CF` Cedar Fort,
  `/FF` Fairfield (case-insensitive). Each 302-redirects to `/?start=<Sunday>` for that ward's next week that still has an
  open time (skips full/past weeks). Codes come from the ward names; override with `WARD_CODES="HA=Harmony,..."`.
- Header: missionaries photo as a tinted banner. `public/images/christ.jpg` is in the repo but unused.

## Added in the admin/missionary-calendar session
- Optional **address** on the form (never public). It is the **location** of the missionaries' calendar events, with
  a Google Maps link in the details (the missionaries are all on Android, so there are no iPhone/Apple buttons or links for them), and shows (tap for directions) on their `/m/<key>` page and in `/admin`.
- **Admin upgrades** (`/admin`, three tabs): visits grouped by week/ward, add a visit by hand (no text consent),
  cancel, block times, CSV export; "Missionary calendar" tab shows the `/m/<MISSIONARY_KEY>` page + feed links, subscribe
  steps and a message to paste (it says to set `MISSIONARY_KEY` if unset); "Visitors" tab (below).
- **Anonymous visitor stats**: a beacon from the sign-up page records a random per-browser cookie, device/OS/browser,
  referrer host and `?src=` tag. No IPs, names or booking ids; bots/previews filtered; one view per browser per 30 min.
  Tag links like `/?src=harmony`; open `/?notrack` on your own devices. Honest limits are printed on the Visitors tab.
  Privacy policy updated to say so. DB gained an `events` table and a `bookings.address` column (both additive).
- 16 tests pass.

## Settings backend + cancellation notices (latest session)
- `/admin` → **Settings**: schedule per day, visit length, ward list/start Sunday/cycles, contact info. Stored in the
  `settings` table (JSON overrides on top of env defaults), applied live, validated (start must be a Sunday, times need
  AM/PM, etc.). A booked visit always stays visible even if its time leaves the schedule; warnings say so after saving.
- `/admin` → **Missionaries**: the missionaries' shared phone (the number shown at the bottom of the page) is texted by default; it is edited right on the Missionaries tab
  (also in Settings), must be a valid 10-digit mobile, and one change updates both the page footer and who gets texted —
  that is the step for when a new set of missionaries arrives (toggles: cancellations on, new sign-ups off; no need to re-enter it). Optional
  extra people live in `missionary_contacts` (name, **mobile required**, optional email kept only as a record; flags per
  person; one text per number, flags combined). **Notifications are texts only** (Twilio, same number as the family
  reminders; no email anywhere). On a cancel (family link or admin) every active contact with that flag is texted; once per
  cancellation, skipped for visits already in the past; every attempt is logged in `notification_log` and shown on that
  tab; failures never affect the cancel. The slot reopens for others immediately. "Send test" texts one contact.
  Texting waits on Twilio's toll-free approval. (Resend/email was built and then removed at Shawn's request.)
- 28 tests pass.

## Wait-list (latest session)
- A week with nothing bookable but real upcoming visits is `full` (`buildWeek`). The public page then shows "Join the
  wait-list" (name, mobile, optional address, **required text-consent checkbox**); offered only when texting is set up.
- Joining creates a `waitlist` row (one waiting spot per phone per week, max 20 per week) and a private page `/w/<token>`
  (position, times they can take, leave button).
- On a cancellation of a future visit: every waiting family for that week is texted first (private link), the time is
  put in `slot_holds` for `waitlistHoldMinutes` (default 30; 0 = notify only), the public sheet shows it as "held for
  wait-list" and refuses public bookings with a reason; waitlisters (and the admin) can book it. After the hold it opens
  to everyone. No hold if nobody is waiting or texting isn't set up. A waiter who gets a visit any way is removed.
  Then the missionaries are texted as before. Admin: Visits tab lists/removes waiters; Settings sets the hold.
- Privacy policy mentions the wait-list texts. **Twilio's toll-free verification text should mention wait-list texts too.**
- 35 tests pass.

## Visit notes, cancel/delete, open/close times (branch `visit-notes`)
- **Notes per visit** (table `visit_notes`): planned to teach, what was taught, commitments left, and a follow-up date (+ optional time).
  Written on the missionaries' page (Notes on each visit, plus a "Recent visits" list of the last 60 days for after-the-fact write-ups) or by
  the admin (Notes on the Visits tab). Private: never in the family's link, the public sheet, texts or the CSV.
- **Follow-up reminders** appear on the missionaries' calendar feed (and the "everything" .ics download) as "Follow up — family": timed (30 min,
  reminder 1 hour before) or all-day (reminder 9 AM). The event description carries phone/address and the commitments only, not the lesson notes.
  Cancelling or deleting the visit drops its follow-up.
- **Cancel / Delete** on both sides. Cancel keeps the record and reopens the time (wait-list is texted as usual; the missionaries are not texted
  about their own cancel). Delete = cancel plus erasing the record and its notes. The family is not told automatically either way: they only
  consented to reminders, so whoever acts should call them.
- **Open/close times** on the missionaries' page, same rules as the admin's "Make a time unavailable"; the form lists only that weekday's times.
- **Weekly schedule editable by the missionaries** (a panel on their page): the times each weekday offers plus the visit length, with the admin's
  validation and warnings. Only those two settings; the ward rotation, phone numbers, text settings and wait-list hold stay admin-only
  (the endpoint ignores any other field). A change never moves or cancels a booked family.
- Fixed: `isDate("2026-13-45")` threw instead of returning false, so any endpoint given a malformed date could answer 500.
- Removed "include your city" from the sign-up form's address hint (missionaries know their area).
- 46 tests pass.

## Google Sheet sync (branch `sheet-sync`, not yet deployed)
- The missionaries are not allowed to visit custom domains, so their page and calendar feed are unusable for them. They are allowed Google Sheets. A
  Google Sheet is now their whole interface: upcoming and recent visits (family, phone, address, directions link), notes, cancel/delete, the weekly
  schedule and visit length, and closed times. No calendar or iCal is involved.
- A script inside the Sheet (Apps Script, run on a timer by the Sheet's owner) calls `POST /api/sheet/<SHEET_SECRET>/sync`. Request: the rows as they
  are in the Sheet. Response: results per row plus the full current state, which the script writes back. `GET /api/sheet/<secret>/state` returns just the
  state. The code is `src/sheetsync.js`; it calls the same functions the web page and admin use, so every rule is identical.
- Conflicts: each visit row carries a `version` (when its notes last changed); the schedule has a version hash; the closed-times list has a
  `closedVersion` hash. A stale version never overwrites; removals of closed times are skipped if the list changed elsewhere (additions still apply).
- `SHEET_SECRET` is a new Railway variable (unset = the endpoints return 404). Treat it like `MISSIONARY_KEY`: it is the only credential.
- The Sheet script and its tests live in `C:\Users\stein\Documents\Claude\missionary-sheet`.

## Missionary coordination meeting — `/leaders` (branch `claude/leaders-meeting`)
- **What:** a page for the stake missionary leaders' monthly meeting (default: 2nd Thursday, 8:00 PM, Stake council room). `src/leaders.js` (logic),
  `src/leadersRoutes.js` (routes, mounted from `server.js`), `private/leaders.html` (one page, four tabs), `test/leaders.test.mjs`.
- **Access:** the whole backend (`/leaders` and `/api/leaders/*`) is behind the **admin login** only (HTTP Basic, same as `/admin`); no admin password = 404. There is no separate leaders password. JSON bodies only.
- **QR sign-in (the one public piece):** `GET /leaders/in/<key>` is the form people reach by scanning the printed card (the card is shown and printed from the page's Sign-in QR tab; `/api/leaders/qr.svg` is admin-only). Fields: name and mobile typed, calling and ward drop-downs, and a checkbox for texts. `POST /api/signin/<key>` puts the person on the roster (matched by phone, then name) and on the meeting's list (`leaders_attendance.source = 'qr'`). The key is **random** (128 bits, stored in `settings` as `leaders_signin_key`) and unrelated to the admin password; `LEADERS_SIGNIN_KEY` pins one instead. "Make a new code" on the Sign-in QR tab (`POST /api/leaders/signin/rotate`) retires every printed card. (The first version derived the key from the admin password with an HMAC, which let anyone who had scanned the card test password guesses offline; that was removed before release.) It only works from 2 hours before the meeting to 6 hours after (`SIGNIN_OPENS_BEFORE/CLOSES_AFTER`), never for a cancelled meeting, 30 tries per IP per hour. Ticking the box records `sms_ok`, the time, the source and the **exact wording shown** (`CONSENT_TEXT`); not ticking on a later visit never removes consent (STOP does).
- **Meeting rule** (week-of-month, weekday, time, place), the **callings list** and the **reminder timing** are edited on the page (Settings tab) and stored
  in the `settings` table under key `leaders`. A meeting is keyed by the date the rule gives it; cancelling or moving one keeps that key, so attendance,
  board posts and sent reminders stay attached. Moving or cancelling clears that meeting's sent-reminder rows so reminders restart for the new time.
- **Attendance:** `leaders_people` (roster: name, calling, ward, optional mobile, consent) and `leaders_attendance` (a snapshot of name/calling/ward per
  meeting, so later roster edits don't rewrite history). Name, calling and ward are drop-downs; "Someone new…" adds the person to the roster.
  Calling and ward are validated against the lists (wards = the rotation's wards + "Stake"). The meeting view shows wards represented and missing.
- **Messages:** a board (`leaders_messages`) that works with no text service at all. A post can also be texted (`leaders_text_log` records each send).
  Rate limit: 20 texted posts per 24 hours.
- **Reminders:** `runLeaderReminders` (started from `index.js` beside the family reminders): days-before at a set time and hours-before; each claimed in
  `leaders_reminders_sent` BEFORE sending; a "days before" text that would arrive within 3 hours of the meeting is skipped; cancelled meetings are silent.
  "Text a reminder now" and "text everyone about this change" are on the meeting tab.
- **Texting leaders is OFF by default** (`leaders.textsEnabled`, admin-only: `/admin` → Missionaries → Leaders page). It only reaches people with a mobile
  AND `sms_ok`. **Open compliance items before turning it on:** (1) the Twilio toll-free verification covers family reminders, wait-list notices and the
  missionaries' phone, **not** leaders' texts, so update the registration/opt-in description first; (2) `sms_ok` is currently recorded by whoever adds the person
  ("they told me yes"), which is weaker than the web-form opt-in the verification describes — a self-serve opt-in page for leaders is the recommended next step;
  (3) the public Terms/Privacy/opt-in pages were intentionally NOT changed, because they are under Twilio review; add a leaders section when (1) and (2) are done.
- Tests: 26 in `test/leaders.test.mjs` (includes the QR sign-in, its window and key, consent wording stored, repeat sign-ins); the whole suite passes. The QR image was decoded in a browser and matches the link.

## Secrets (Railway → web → Variables; never in git or chat)
`ADMIN_PASSWORD` (also opens `/leaders`), `MISSIONARY_KEY` (the secret in the missionaries' link; change it to revoke the link),
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, plus `DATA_DIR=/data`, `SELF_URL`.

## Deploying
Pushing to GitHub does **not** auto-deploy this service. After `git push`, run `railway up -s web -d` from this folder
(use `MSYS_NO_PATHCONV=1` in Git Bash so `/data` isn't rewritten). Railway variable edits wait for "Deploy" in the dashboard.

## Not done yet
1. **Twilio toll-free verification** — submitted/in progress by Shawn; texts to US numbers won't deliver until approved
   (a few business days). Then book a slot ~1 hour out on your own phone with "1 hour before" ticked.
2. Hand the missionaries their private link (`https://www.missionaryvisits.com/m/<MISSIONARY_KEY>`).
   Confirm the GoDaddy forward for the bare domain works.
3. Service is in Railway's Amsterdam region; can move to a US region.

## Open questions
- Should the sign-up form ask which ward the family is in? (Ward is derived from the week only.)

## Where things are
`src/` server, slots/rotation (`slots.js`), calendar files (`ics.js`), reminders (`reminders.js`), Twilio (`sms.js`);
`public/` the pages; `private/` admin and missionary pages; `test/` (two files); `README.md` (settings); `DEPLOY.md`.
