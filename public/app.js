(() => {
  const $ = (id) => document.getElementById(id);
  const weekEl = $("week"), dlg = $("dlg"), form = $("form"), errEl = $("err");
  let state = null, smsAvailable = false, picked = null;

  async function load(start) {
    const r = await fetch("/api/week" + (start ? `?start=${start}` : ""));
    state = await r.json();
    // Always open on the week we are actually in, even if it is full or nearly over:
    // that week's ward is the one being visited, and the banner must say so.
    render();
  }

  function render() {
    $("weekTitle").textContent = state.range;
    const wl = $("wardLine");
    wl.hidden = !state.ward;
    wl.textContent = state.ward ? `${state.ward} Ward${state.isCurrent ? " — this week" : ""}` : "";
    $("thisWeek").hidden = state.isCurrent;
    $("prev").disabled = !state.prev;
    $("next").disabled = !state.next;
    weekEl.replaceChildren();
    for (const day of state.days) {
      const col = document.createElement("div");
      col.className = "day" + (day.isToday ? " today" : "");
      const head = document.createElement("div");
      head.className = "day-head";
      head.innerHTML = "<strong></strong><span></span>";
      head.firstChild.textContent = day.label;
      head.lastChild.textContent = day.sub;
      col.append(head);
      for (const s of day.slots) {
        const el = document.createElement(s.status === "open" ? "button" : "div");
        el.className = "slot " + s.status;
        if (s.status === "open") {
          el.type = "button";
          el.textContent = s.label;
          el.setAttribute("aria-label", `Sign up for ${day.label} ${day.sub} at ${s.label}`);
          el.onclick = () => openForm(day, s);
        } else if (s.status === "booked") {
          el.innerHTML = '<span class="who"></span><small></small>';
          el.firstChild.textContent = s.family + " Family"; // textContent: names are typed by strangers
          el.lastChild.textContent = s.label;
        } else {
          el.textContent = s.label;
        }
        col.append(el);
      }
      weekEl.append(col);
    }
  }

  function openForm(day, slot) {
    picked = { date: day.date, time: slot.time };
    $("when").textContent = `${day.label}, ${day.sub} at ${slot.label}` + (state.ward ? ` · ${state.ward} Ward` : "");
    errEl.textContent = "";
    $("submit").disabled = false;
    dlg.showModal();
    form.elements.family.focus();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.textContent = "";
    $("submit").disabled = true;
    try {
      const r = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...picked,
          family: form.elements.family.value,
          phone: form.elements.phone.value,
          remindDay: form.elements.remindDay.checked,
          remindHour: form.elements.remindHour.checked,
        }),
      });
      const data = await r.json();
      if (r.ok) { location.href = "/b/" + data.token; return; }
      errEl.textContent = data.error || "Something went wrong.";
      if (r.status === 409) { dlg.close(); load(state.weekStart); alert(data.error); }
    } catch {
      errEl.textContent = "Couldn't reach the server. Please check your connection and try again.";
    }
    $("submit").disabled = false;
  });

  $("cancelDlg").onclick = () => dlg.close();
  $("thisWeek").onclick = () => load();
  $("prev").onclick = () => load(state.prev);
  $("next").onclick = () => load(state.next);

  fetch("/api/config").then((r) => r.json()).then((c) => {
    smsAvailable = c.smsAvailable;
    const contact = $("contact");
    const add = (text, phone) => { contact.append(text); const a = document.createElement("a"); a.href = "tel:" + phone.replace(/\D/g, ""); a.textContent = phone; contact.append(a); };
    if (c.missionaryPhone) add("Doesn't one of these times work? Contact the missionaries directly at ", c.missionaryPhone);
    if (c.missionaryPhone && c.helpPhone) contact.append(" · ");
    if (c.helpPhone) add(`Trouble with this page? ${c.helpName || "Call"} `, c.helpPhone);
    $("reminders").hidden = !smsAvailable;
  });
  load();
  // Keep the sheet honest if it's left open: families sign up all day.
  setInterval(() => { if (!dlg.open && state) load(state.weekStart); }, 60_000);
})();
