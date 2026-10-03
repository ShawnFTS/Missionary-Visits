# Deploying: GitHub → Railway, with Twilio texts

## 1. Put the code on GitHub
Create an empty **private** repo (e.g. `missionary-visits`), then from this folder:
```
git remote add origin https://github.com/<you>/missionary-visits.git
git push -u origin main
```
(`.gitignore` already keeps `node_modules`, `data/` and `.env` out.)

## 2. Railway
1. New Project → **Deploy from GitHub repo** → pick the repo. It builds with no settings (`railway.json` is read).
2. Service → **Volumes → Add Volume**, mount path `/data`. **This is what keeps sign-ups across redeploys.**
3. Service → **Variables**: `DATA_DIR=/data`, `ADMIN_PASSWORD=…`.
4. Service → **Settings → Networking → Generate Domain**. Set `SELF_URL` to that address (no trailing slash).
   Texts and calendar files link back to it. Redeploy after changing it.
5. Open the address: the sheet should load. `/admin` asks for the password (any username).
Optional: attach a custom domain in the same Networking panel and update `SELF_URL`.

## 3. Twilio (texts)
Use a **toll-free number**: its verification is free and quicker than registering a local number.
1. Sign up at twilio.com and upgrade the account (add a card; ~$20 credit is plenty for a year).
2. Phone Numbers → Buy a number → filter **Toll-free** → buy one (~$2/mo).
3. Messaging → **Toll-Free Verification** → submit the form. Suggested answers:
   - **Use case:** Appointment reminders.
   - **Description:** "Members of the Eagle Mountain West Stake of The Church of Jesus Christ of Latter-day Saints sign up on a web page to host the full-time missionaries. Families who tick a box receive up to two text reminders (1 day and 1 hour before) about their own visit. No marketing."
   - **Opt-in:** a person ticks an unchecked box on the sign-up form after reading "By checking a box you agree to receive text messages about this visit only. Message and data rates may apply. Reply STOP to opt out." Give your page's address as the opt-in URL (a screenshot of the form is helpful).
   - **Volume:** under 200 a month.
   Approval usually takes a few business days. Texts to US numbers will not be delivered until it is approved.
4. Console home shows **Account SID** and **Auth Token**. In Railway Variables add
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (the number as `+1…`). The service restarts and the
   reminder checkboxes appear on the form (they are hidden until all three are set).
5. Test: sign up for a slot ~1 hour out on your own phone with "1 hour before" ticked, and wait.
   The Railway logs say `Text reminders: ON` on startup; failures show on `/admin` next to the booking.
   STOP/HELP replies are handled by Twilio automatically.

## Costs
Railway ≈ $5/mo (Hobby plan; the volume is included in usage). Twilio ≈ $2/mo number + about 1¢ per text.
