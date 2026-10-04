// The visit-notes form, shared by the missionaries' page and the admin screen.
// No data lives here: each page passes in the notes and a save() that talks to its own (authenticated) API.
(function () {
  const css = `
    .nf { background: #faf7f0; border: 1px solid #d8d2c4; border-radius: 12px; padding: 14px; margin: 8px 0 12px; display: grid; gap: 12px; }
    .nf label { font-weight: 600; font-size: .92rem; display: block; }
    .nf .h { font-weight: 400; color: #666; font-size: .8rem; display: block; margin-top: 2px; }
    .nf textarea { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 10px; font: inherit; font-size: 15px; min-height: 72px; border: 1.5px solid #c9c2b2; border-radius: 10px; background: #fff; color: #222; resize: vertical; }
    .nf input[type=date], .nf input[type=time] { margin-top: 6px; padding: 9px; font: inherit; border: 1.5px solid #c9c2b2; border-radius: 10px; background: #fff; }
    .nf .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: end; }
    .nf .bottom { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .nf .st { font-size: .9rem; font-weight: 600; }
    .nf .st.ok { color: #2e7d32; } .nf .st.bad { color: #b3261e; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 0; }
    .chip { background: #fff4d6; border-radius: 6px; padding: 1px 8px; font-size: .78rem; color: #5a3a00; }
  `;
  if (!document.getElementById("nf-css")) { const s = document.createElement("style"); s.id = "nf-css"; s.textContent = css; document.head.append(s); }

  const mk = (tag, attrs, text) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k === "class") e.className = v; else e.setAttribute(k, v); }
    if (text != null) e.textContent = text;
    return e;
  };
  const fmtDate = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const fmtTime = (t) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };

  // Short badges for a visit's row: whether it has notes, and when the follow-up is.
  function summary(n) {
    const chips = [];
    if (n && (n.planned || n.taught || n.commitments)) chips.push("Notes saved");
    if (n && n.followupDate) chips.push("Follow up: " + fmtDate(n.followupDate) + (n.followupTime ? " · " + fmtTime(n.followupTime) : ""));
    return chips;
  }

  function build(notes, save, onSaved) {
    const n = notes || {};
    const form = mk("form", { class: "nf" });
    const ta = (label, hint, value) => {
      const wrap = mk("label", {}, label);
      if (hint) wrap.append(mk("span", { class: "h" }, hint));
      const t = mk("textarea", { maxlength: "2000" }); t.value = value || "";
      wrap.append(t); form.append(wrap); return t;
    };
    const planned = ta("Planned to teach", "What you plan to share at this visit.", n.planned);
    const taught = ta("What was taught", "What you actually covered.", n.taught);
    const commits = ta("Commitments they left", "What the family said they would do.", n.commitments);

    const when = mk("div");
    when.append(mk("label", {}, "When you will return or follow up"));
    when.lastChild.append(mk("span", { class: "h" }, "Adds a reminder to the missionaries' calendar. Leave the time blank for an all-day reminder. Google Calendar can take a few hours to show it."));
    const row = mk("div", { class: "row" });
    const date = mk("input", { type: "date" }); date.value = n.followupDate || "";
    const time = mk("input", { type: "time" }); time.value = n.followupTime || "";
    const clear = mk("button", { type: "button", class: "btn ghost small" }, "Clear");
    clear.onclick = () => { date.value = ""; time.value = ""; };
    row.append(date, time, clear); when.append(row); form.append(when);

    const bottom = mk("div", { class: "bottom" });
    const btn = mk("button", { type: "submit", class: "btn small" }, "Save notes");
    const st = mk("span", { class: "st", role: "status" });
    bottom.append(btn, st); form.append(bottom);

    form.onsubmit = async (e) => {
      e.preventDefault();
      btn.disabled = true; st.className = "st"; st.textContent = "Saving…";
      try {
        const r = await save({ planned: planned.value, taught: taught.value, commitments: commits.value, followupDate: date.value, followupTime: time.value });
        if (r.ok) { st.className = "st ok"; st.textContent = "Saved ✓"; if (onSaved) onSaved(r.notes || {}); }
        else { st.className = "st bad"; st.textContent = r.error || "Couldn't save. Please try again."; }
      } catch { st.className = "st bad"; st.textContent = "Couldn't save. Check your connection."; }
      btn.disabled = false;
    };
    return form;
  }

  window.NotesForm = { build, summary };
})();
