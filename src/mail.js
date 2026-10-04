// Plain-text email through Resend's HTTP API (one endpoint, no SDK). Inert until
// RESEND_API_KEY and MAIL_FROM are both set, like the Twilio texts.
export const mailConfigured = (cfg) => Boolean(cfg.mail?.apiKey && cfg.mail?.from);

export function makeMailer(cfg, fetchImpl = fetch) {
  return async function send({ to, subject, text }) {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.mail.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: cfg.mail.from, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`Email ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}
