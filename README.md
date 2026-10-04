# Eagle Mountain West Stake Missionary Member Visits

A plain sign-up sheet for hosting the missionaries. No ads, no accounts, no theming.

- A week calendar of open times. Tap one, enter family name + mobile number, done.
- Booked times show the family name (never the phone number).
- Optional text reminders **1 day before** and **1 hour before** (Twilio).
- "Add to my calendar" (.ics for iPhone/Outlook/Apple) and "Add to Google Calendar".
- Each family gets a private link (`/b/<token>`) to re-download the calendar file or cancel.
- Optional address on the form (never shown publicly). It becomes the location of the missionaries' calendar events, with Google/Apple Maps links for one-tap directions.
- `/admin` (password): visits grouped by week and ward, add a visit by hand, cancel, block times, CSV export,
  the **missionary calendar link** (subscribe once; new sign-ups and cancellations flow to their phones), and
  **visitor stats** (anonymous: one cookie per browser, device/browser type, where visitors came from; no IPs or names).
- Tag links to see where visitors come from: `/?src=harmony`. Open `/?notrack` on your own devices so you don't count.

## Run it

```
npm install
npm start          # http://localhost:3000
npm test
```

## Settings (environment variables, all optional)

| Variable | Default | What it does |
|---|---|---|
| `SLOT_SCHEDULE` | the stake schedule (Sun/Mon/Tue/Thu 7:30 & 8:15 PM, Wed 6:45 & 7:30 PM, Fri 10:00 & 10:45 AM, Sat 3:00 & 3:45 PM) | JSON of day-of-week (0 = Sunday) to start times, e.g. `{"0":["19:30"],"6":["15:00"]}` |
| `SLOT_MINUTES` | `45` | Length of a visit (calendar event length) |
| `ROTATION_CYCLES` | `4` | How many times the ward list repeats. Four cycles of six wards = 24 weeks (Sep 20, 2026 – Mar 6, 2027); nothing after that can be booked. |
| `WARDS` | Harmony, Overland Trails, Springwater, White Hills, Cedar Fort, Fairfield | Ward rotation, comma separated; each Sunday–Saturday week belongs to the next ward |
| `ROTATION_START` | `2026-09-20` | The Sunday that begins the first ward's week |
| `MISSIONARY_PHONE`, `HELP_NAME`, `HELP_PHONE` | from the old sign-up doc | Shown at the bottom of the page |
| `SITE_TZ` | `America/Denver` | Time zone for the times above |
| `ADMIN_PASSWORD` | _(unset = admin off)_ | Password for `/admin` (any username) |
| `SELF_URL` | | Public address, e.g. `https://visits.example.org` — put in texts and calendar files |
| `DATA_DIR` | `./data` | Where the SQLite file lives. **On a host with a temporary disk, mount a volume here or sign-ups vanish on redeploy.** |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (or `TWILIO_MESSAGING_SERVICE_SID`) | | Turns on text reminders. Until set, the reminder checkboxes are hidden. |

## Pictures

Put these in `public/images/` — either one is optional and simply doesn't show if missing:

- `christ.jpg` — a portrait (roughly 3:4)
- `missionaries.jpg` — a wide photo (roughly 3:2)

The Church's Media Library (churchofjesuschrist.org/media) has images that are free for non-commercial Church use.

## Notes on texting

US carriers require registration (Twilio "A2P 10DLC" or a toll-free verification) before they deliver
app-sent texts; it takes a few days. The form's wording (opt-in checkbox, "Reply STOP") is written to
fit that. Checkboxes are deliberately unchecked by default — consent should be a choice.
A reminder is claimed in the database before it is sent, so a crash can lose a text but never send two.
