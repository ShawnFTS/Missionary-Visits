(() => {
  const token = location.pathname.split("/").pop();
  const box = document.getElementById("box");
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const api = (suffix, opts) => fetch(`/api/waitlist/${encodeURIComponent(token)}${suffix}`, opts);

  async function show() {
    const r = await api("");
    box.replaceChildren();
    if (!r.ok) { box.append(el("h2", "serif", "Wait-list spot not found"), el("p", "", "That link doesn't match a wait-list entry."), link("/", "Back to the sheet", "btn")); return; }
    const w = await r.json();

    if (w.status === "booked") {
      box.append(el("h2", "serif", "You're booked — thank you!"), el("p", "", "You got a visit, so you're off the wait-list."));
      if (w.bookingToken) box.append(link("/b/" + w.bookingToken, "See your visit", "btn"));
      return;
    }
    if (w.status !== "waiting") { box.append(el("h2", "serif", "You're not on the wait-list"), el("p", "", "You can still look for an open time."), link("/", "Back to the sheet", "btn")); return; }

    box.append(el("h2", "serif", `You're on the wait-list, ${w.family}`),
      el("p", "big", `${w.ward ? w.ward + " Ward · " : ""}week of ${w.range}`),
      el("p", "", `You're number ${w.position} in line. We'll text you the moment a visit cancels.`));

    if (w.times.length) {
      box.append(el("h3", "serif", "Times you can take right now"));
      const stack = el("div", "stack");
      for (const t of w.times) {
        const b = el("button", "btn", `${t.dayLabel} at ${t.timeLabel}` + (t.status === "held" ? " (held for you)" : ""));
        b.onclick = async () => {
          b.disabled = true;
          const res = await api("/book", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: t.date, time: t.time }) });
          const d = await res.json();
          if (res.ok) { location.href = "/b/" + d.token; return; }
          alert(d.error || "Something went wrong."); show();
        };
        stack.append(b);
      }
      box.append(stack, el("p", "note", "A time that just opened up is held for the wait-list for a short while, then opens to everyone. First to tap gets it."));
    }

    const leave = el("button", "btn danger", "Leave the wait-list");
    leave.style.marginTop = "18px";
    leave.onclick = async () => { if (!confirm("Leave the wait-list?")) return; await api("/leave", { method: "POST" }); show(); };
    box.append(leave);
  }
  function link(href, text, cls) { const a = el("a", cls, text); a.href = href; return a; }
  show();
})();
