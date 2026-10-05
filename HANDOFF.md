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

## Secrets (Railway → web → Variables; never in git or chat)
`ADMIN_PASSWORD`, `MISSIONARY_KEY` (the secret in the missionaries' link; change it to revoke the link),
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
