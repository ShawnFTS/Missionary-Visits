// Text messages through Twilio's REST API (no SDK needed for one endpoint).
// Inert until configured — same pattern as every other optional integration:
// the sheet works fully without it, and /api/config tells the page whether to
// offer reminders at all, so nobody ticks a box that cannot be honoured.

export function smsConfigured(cfg) {
  const t = cfg.twilio;
  return Boolean(t.sid && t.token && (t.from || t.service));
}

export function makeTwilioSender(cfg, fetchImpl = fetch) {
  return async function send(to, body) {
    const t = cfg.twilio;
    const form = new URLSearchParams({ To: to, Body: body });
    if (t.service) form.set("MessagingServiceSid", t.service);
    else form.set("From", t.from);
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${t.sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${t.sid}:${t.token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}
