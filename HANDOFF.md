# Handoff — where we left off (2026-10-03)

## What exists
A working sign-up sheet, **Eagle Mountain West Stake Missionary Member Visits**, built from the stake's Google Doc
"Missionary Visit Schedule V2". Node + Express + SQLite, no build step. 9 tests pass (`npm test`).

- Week calendar (Sun–Sat); day-specific 45-minute slots (Sun/Mon/Tue/Thu 7:30 & 8:15 PM, Wed 6:45 & 7:30 PM,
  Fri 10:00 & 10:45 AM, Sat 3:00 & 3:45 PM).
- Each week belongs to a ward, rotating Harmony → Overland Trails → Springwater → White Hills → Cedar Fort → Fairfield,
  starting Sun Sep 20, 2026, **four cycles (24 weeks, through Sat Mar 6, 2027)**, then nothing is bookable.
- The page always opens on the current week; moving to another week changes the ward banner with it.
- Tap an open time → family name + mobile → booked slot shows the family name (phone never shown publicly).
- Optional text reminders (1 day / 1 hour before) via Twilio; .ics download + Google Calendar link; private
  `/b/<token>` link to re-download or cancel; `/admin` (password) to cancel visits or block times.
- Reminder checkboxes are hidden until all three Twilio variables are set.

## Not done yet (in order)
1. **Railway deploy** — create the project from this repo, add a volume at `/data`, set variables
   (`DATA_DIR=/data`, `ADMIN_PASSWORD`, `SELF_URL`). Steps in `DEPLOY.md`. Not deployed as of this handoff.
2. **Twilio** — account exists. Still to do: buy a toll-free number, submit toll-free verification (wording in
   `DEPLOY.md`; approval takes days and texts to US numbers won't deliver until then), then add
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` in **Railway Variables** (never in chat or in git).
3. **Pictures** — add `public/images/christ.jpg` and `public/images/missionaries.jpg` (optional; hidden if missing).
   The Church Media Library has images free for Church use.
4. **Test end to end** once live: book a slot, download the .ics, cancel, check `/admin`, and (after Twilio approval)
   book one ~1 hour out with the 1-hour text ticked.

## Open questions
- Should the sign-up form ask which ward the family is in? (Ward is currently derived from the week only.)
- Custom domain? If added, update `SELF_URL`.

## Where things are
`src/` server, slots/rotation (`slots.js`), reminders (`reminders.js`), Twilio (`sms.js`); `public/` the pages;
`private/admin.html`; `test/app.test.mjs`; `README.md` (all settings); `DEPLOY.md` (GitHub → Railway → Twilio).
