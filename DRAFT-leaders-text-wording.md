# DRAFT wording: leaders' and huddle texts (NOT applied to the live pages)

Status: draft for Shawn's review. Nothing here is in `public/terms.html`,
`public/privacy.html` or `public/sms-opt-in.html`. Apply it only after the
Twilio toll-free verification is resolved, and after the Twilio registration
(use case + opt-in description) is updated to include this program.
Not legal advice; have the LLC's counsel glance at it if you can.

---

## 1. terms.html  (add after the existing "Text messaging program" list)

```html
<h3>Text messaging program: stake missionary coordination meeting</h3>
<p><strong>Program name:</strong> Missionary Coordination Meeting text messages. <strong>Sender:</strong> FIDUS Technology Solutions LLC, on behalf of the Eagle Mountain West Stake.</p>
<ul>
<li><strong>Who this is for:</strong> stake and ward leaders who attend the missionary coordination meeting. It is separate from the visit reminders above.</li>
<li><strong>What you will receive:</strong> automated text messages about the meeting only &mdash; reminders before a meeting (typically 2 days before and 2 hours before), and updates such as a change of date, time or place.</li>
<li><strong>How you agree:</strong> by checking the text-message consent box on the meeting sign-in form (reached by scanning the QR code at the meeting). Consent is not a condition of signing in or attending. You may sign in without giving a mobile number.</li>
<li><strong>How often:</strong> message frequency varies, about 2 to 4 messages a month.</li>
<li><strong>Cost:</strong> message and data rates may apply, set by your mobile carrier.</li>
<li><strong>Stop:</strong> reply <strong>STOP</strong> at any time to cancel. You will get one confirmation and no more messages. You can also ask an administrator to remove your number.</li>
<li><strong>Help:</strong> reply <strong>HELP</strong>, or contact us at 801-404-4111.</li>
<li><strong>Carriers:</strong> supported on major U.S. carriers. Carriers are not liable for delayed or undelivered messages.</li>
<li>We do not share your mobile number or text-message consent with third parties or affiliates for marketing or promotional purposes. See our <a href="/privacy">Privacy Policy</a>.</li>
</ul>
<p>Ward huddle lists (who is expected at each ward's missionary huddle) are a reference list for leaders. Being on a huddle list does not enroll you in text messages, and no text is sent because of it.</p>
```

Also add one sentence to "The service":

> Stake and ward leaders can also sign in to the missionary coordination meeting and keep a list of who is expected at each ward's missionary huddle.

---

## 2. privacy.html

**Information we collect** (add a bullet):

```html
<li><strong>Meeting sign-in details (leaders only):</strong> your name, calling, ward and, if you choose to give one, your mobile number, entered when you sign in to the missionary coordination meeting, plus whether you agreed to texts and the date and wording you agreed to. Leaders and ward missionary teams may also be entered on a ward huddle list (name, calling, ward and phone number; youth are listed by name only, and their numbers are not shown on the list that is sent out unless an administrator chooses to).</li>
```

**How we use it** (add a bullet):

```html
<li>To record who attended the missionary coordination meeting, to keep each ward's huddle list, and, if you checked the consent box, to send the meeting texts described below.</li>
```

**Who we share it with** (add a sentence):

> Meeting attendance and huddle lists are visible to the stake administrators. A ward huddle list may be sent to ward leaders through a private link; it shows names, callings and phone numbers (not youth numbers by default) and is not public.

**Text messages** (add after the visit/wait-list bullets):

```html
<p><strong>Meeting texts (leaders only).</strong> If you check the consent box on the meeting sign-in form, we send reminders for future missionary coordination meetings and updates about them, about 2 to 4 messages a month. Consent is not a condition of signing in. Your number is not used for visit reminders or wait-list notices, and we never text anyone because they appear on a huddle list.</p>
```

**How long we keep it** (add a sentence):

> Meeting attendance and huddle lists are kept while the program runs. Ask an administrator, or contact us, and we will remove your name or number; replying STOP ends texts immediately.

---

## 3. sms-opt-in.html  (new section, mirrors the existing ones)

```html
<h4>3. Meeting reminders (on the leaders' sign-in form)</h4>
<p>Leaders who attend the missionary coordination meeting scan a QR code at the meeting and enter their name, mobile number, calling and ward. An unchecked box reads:</p>
<blockquote>By checking this box you agree to receive text messages from Missionary Visits (operated by FIDUS Technology Solutions LLC) with reminders for future missionary coordination meetings and updates about them. Message frequency varies, about 2 to 4 a month. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of signing in.</blockquote>
<p>Sample messages:</p>
<ul>
<li>Missionary Visits: Reminder: the missionary coordination meeting is Thu Dec 10 at 8:00 PM, Stake council room. Reply STOP to opt out.</li>
<li>Missionary Visits: Update: this month's missionary coordination meeting moved to 7:30 PM. Reply STOP to opt out.</li>
</ul>
```

(Check the sample text against what `src/leaders.js` actually sends before
publishing; the live message wording must match what is shown here.)

---

## Things to settle before publishing

1. **Twilio registration.** The current toll-free registration covers visit
   reminders and wait-list notices. This is a new audience and message type;
   register it (amend the use case/opt-in description, or use a separate
   number) before switching `leaders.textsEnabled` on.
2. **Reminder timing.** Wording says 2 days and 2 hours; that matches the
   defaults (`reminderDays 2 at 09:00`, `reminderHours 2`). Update the text if
   you change them in Settings.
3. **Consent text on the form** already matches section 3 above verbatim. If
   either changes, change both (the exact wording is stored per person).
4. **Huddle youth numbers.** The wording says youth numbers are hidden by
   default; keep that true or edit the sentence.
