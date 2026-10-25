# SMS go-live test

Run after Twilio approves the toll-free verification (+1 855 713 4387).

## 1. Confirm texting is on
- Railway → web service → Variables: set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM=+18557134387`.
  The service restarts on save.
- Railway logs show `Text reminders: ON` at startup.
- `https://www.missionaryvisits.com/api/config` returns `smsAvailable: true`. If false, a var is missing or wrong
  and the "Text me reminders" box will not appear on the booking page.

## 2. Direct test to a missionary contact
- `/admin` → Missionaries tab → add your own mobile as a contact → **Send test**.
- The text arrives from the 855 number, and the result is listed in that tab's notification log
  (failures include Twilio's error code).

## 3. Family reminder flow
- Book a slot about 1 hour out on the public page with your own name and number.
- Tick "Text me reminders" and choose "1 hour before". The reminder arrives about an hour before the visit.
- For a faster check of the day-before path, book a slot about 1 day out with "1 day before".
- Cancel the booking afterwards.

## 4. Cancel and wait-list texts (optional)
- Cancel a booking while a contact has the cancel flag on: that contact is texted once.
- Fill a week, join its wait-list with a second number, then cancel a visit in that week: the waiter is texted first.

## 5. Opt-out
- Reply STOP to a text; Twilio sends its own confirmation. Reply START to re-enable that number.

## If a text does not arrive
- Twilio Console → Monitor → Logs → Messaging: `delivered` means a phone/carrier issue; `failed`/`undelivered`
  carries an error code.
- Confirm `TWILIO_FROM` matches the console number exactly, including `+1`.
