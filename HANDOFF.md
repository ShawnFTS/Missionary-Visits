# Handoff — where we left off (2026-10-03)

*These are working notes for whoever continues this project next (Shawn, or a fresh Claude session). Not for any one person.*

## What exists
A working sign-up sheet, **Eagle Mountain West Stake Missionary Member Visits**, built from the stake's Google Doc
"Missionary Visit Schedule V2". Node + Express + SQLite, no build step. 10 tests pass (`npm test`).
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
- Header: missionaries photo as a tinted banner. `public/images/christ.jpg` is in the repo but unused.

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
`public/` the pages; `private/` admin and missionary pages; `test/app.test.mjs`; `README.md` (settings); `DEPLOY.md`.
