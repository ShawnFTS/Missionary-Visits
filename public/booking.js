(() => {
  const token = location.pathname.split("/").pop();
  const box = document.getElementById("box");
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

  async function show() {
    const r = await fetch(`/api/booking/${encodeURIComponent(token)}`);
    box.replaceChildren();
    if (!r.ok) { box.append(el("h2", "serif", "Sign-up not found"), el("p", "", "That link doesn't match a sign-up."), link("/", "Back to the sheet", "btn")); return; }
    const b = await r.json();

    if (b.cancelled) {
      box.append(el("h2", "serif", "This visit was cancelled"), el("p", "", "Thank you for letting us know."), link("/", "Pick another time", "btn"));
      return;
    }
    box.append(
      el("h2", "serif", b.past ? "Thank you for hosting!" : "You're signed up — thank you!"),
      el("p", "big", b.family),
      el("p", "big", `${b.dayLabel} at ${b.timeLabel}`),
    );
    const reminders = [b.remindDay && "1 day before", b.remindHour && "1 hour before"].filter(Boolean);
    box.append(el("p", "", reminders.length ? `Text reminders to ${b.phone}: ${reminders.join(" and ")}.` : "No text reminders requested."));

    if (!b.past) {
      const stack = el("div", "stack");
      const ics = link(`/api/booking/${encodeURIComponent(token)}/ics`, "Add to my calendar (iPhone, Outlook…)", "btn");
      ics.setAttribute("download", "missionary-visit.ics");
      stack.append(ics, link(b.googleUrl, "Add to Google Calendar", "btn ghost"));
      const cancel = el("button", "btn danger", "Cancel this visit");
      cancel.onclick = async () => {
        if (!confirm("Cancel this visit? The time will open up for another family.")) return;
        await fetch(`/api/booking/${encodeURIComponent(token)}/cancel`, { method: "POST" });
        show();
      };
      stack.append(cancel);
      box.append(stack, el("p", "note", "Bookmark this page — it's your link to add the visit to your calendar or cancel it."));
    }
  }
  function link(href, text, cls) { const a = el("a", cls, text); a.href = href; if (href.startsWith("http")) { a.target = "_blank"; a.rel = "noreferrer"; } return a; }
  show();
})();
