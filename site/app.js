"use strict";

// The Wire — page. Reads data.json and renders: notices, today line, live player,
// last hour, desk filters, Beacon pin, scoreboard, feed, source health.
// Last-visit time and preferences live in this browser only (per device).

const DESKS = ["ALL", "BEACON", "GOV", "LAW", "WORLD", "SPORTS"];
const KEY = { visit: "wire.lastVisit", desk: "wire.desk", channel: "wire.channel" };
const REFRESH_MS = 5 * 60 * 1000;
const STALE_MIN = 45;
const FRESH_MIN = 30;
const PIN_HOURS = 48;
const PIN_MAX = 5;
const LAST_HOUR_MAX = 5;
const KIND_MARK = { VIDEO: "▶ VIDEO", DOC: "DOC", QUOTE: "“ QUOTE", BLOTTER: "BLOTTER" };

// --------------------------------------------------------------- storage (never throws)
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, String(v)); } catch (e) { /* private mode */ } },
};

let data = null;
let desk = DESKS.includes(store.get(KEY.desk)) ? store.get(KEY.desk) : "ALL";
let prevVisit = Number(store.get(KEY.visit)) || null; // the visit before this one (ms)
let channel = store.get(KEY.channel);
let livePanelOpen = false;
let playing = false;
let newOnly = false;
const openRows = new Set();

// --------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids) if (kid != null && kid !== false) n.append(kid);
  return n;
}
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
const fmtFull = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "numeric", day: "numeric" });
const exact = (ms) => fmtFull.format(new Date(ms));
const dayKey = (ms) => new Date(ms).toDateString();
const isToday = (ms) => dayKey(ms) === dayKey(Date.now());
const isTomorrow = (ms) => dayKey(ms) === dayKey(Date.now() + 86400000);
const isSeen = (it) => prevVisit != null && it.ms <= prevVisit;
const isFresh = (ms) => Date.now() - ms < FRESH_MIN * 60000;
function when(ms) {
  if (isToday(ms)) return fmtTime.format(new Date(ms));
  if (isTomorrow(ms)) return "Tmrw " + fmtTime.format(new Date(ms));
  return fmtDate.format(new Date(ms)) + " " + fmtTime.format(new Date(ms));
}

// --------------------------------------------------------------- data
// The last good data.json is kept in the browser cache so the page paints instantly,
// then a fresh copy replaces it.
const DATA_CACHE = "wire-data";

function accept(json) {
  data = json;
  for (const it of data.items) it.ms = Date.parse(it.t);
  render();
}

async function loadCached() {
  try {
    const c = await caches.open(DATA_CACHE);
    const r = await c.match("data.json");
    if (r && !data) accept(await r.json());
  } catch (e) { /* no Cache API: fine, the network load follows */ }
}

async function load() {
  try {
    const r = await fetch("data.json?ts=" + Date.now(), { cache: "no-store", credentials: "same-origin", redirect: "manual" });
    if (r.type === "opaqueredirect" || r.status === 401 || r.status === 403) throw new Error("signed out");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const json = await r.clone().json();
    try { (await caches.open(DATA_CACHE)).put("data.json", r); } catch (e) { /* ignore */ }
    accept(json);
  } catch (e) {
    const a = $("asof");
    a.classList.add("stale");
    if (e.message === "signed out" || e instanceof TypeError) {
      a.replaceChildren(el("a", { href: "./?reauth=" + Date.now(), text: data ? "offline or signed out · sign in" : "sign in" }));
    } else if (!data) {
      a.textContent = "couldn't load data (" + e.message + ")";
    }
  }
}

function render() {
  if (!data) return;
  renderAsOf();
  renderNotices();
  renderToday();
  renderLive();
  renderLastHour();
  renderDesks();
  renderNewLine();
  renderScoreboard();
  renderPinned();
  renderFeed();
  renderHealth();
}

// --------------------------------------------------------------- header + notices
function renderAsOf() {
  const g = Date.parse(data.generated_at);
  const a = $("asof");
  a.textContent = "as of " + (isToday(g) ? fmtTime.format(new Date(g)) : exact(g)) + " · " + ago(g);
  a.title = exact(g);
  a.classList.toggle("stale", (Date.now() - g) / 60000 > STALE_MIN);
}

function failingSources() {
  return data.sources.filter((s) => {
    const ok = s.last_success ? Date.parse(s.last_success) : null;
    return Boolean(s.last_error) || !ok || Date.now() - ok > Math.max(3 * s.poll, 60) * 60000;
  });
}

function renderNotices() {
  const box = $("notices");
  const kids = [];
  for (const it of data.alerts || []) {
    const exp = it.alert && it.alert.expires ? " · until " + exact(Date.parse(it.alert.expires)) : "";
    kids.push(el("a", { class: "alert", href: it.link, target: "_blank", rel: "noopener" },
      "⚠ " + (it.alert.event || "Weather alert") + " — Beacon" + exp, el("small", { text: it.title })));
  }
  const bad = failingSources();
  if (bad.length) {
    kids.push(el("a", {
      class: "down", href: "#footer",
      onclick: () => { $("health").hidden = false; $("health-line").setAttribute("aria-expanded", "true"); },
      text: "⚠ " + bad.length + " source" + (bad.length > 1 ? "s" : "") + " down: " + bad.map((s) => s.name).join(", "),
    }));
  }
  box.replaceChildren(...kids);
}

// --------------------------------------------------------------- today line
function renderToday() {
  const rows = { today: [], tomorrow: [] };
  const meetings = data.items
    .filter((it) => it.event_at && Date.parse(it.event_at) > Date.now() - 3 * 3600000)
    .map((it) => ({ ms: Date.parse(it.event_at), label: it.title.split(" - ")[0] + (it.agenda ? " (" + it.agenda.length + " items)" : ""), link: it.link, meeting: true }))
    .sort((a, b) => a.ms - b.ms);
  const seen = new Set();
  for (const m of meetings) {
    const k = m.label + m.ms;
    if (seen.has(k)) continue;
    seen.add(k);
    if (isToday(m.ms)) rows.today.push(m);
    else if (isTomorrow(m.ms)) rows.tomorrow.push(m);
  }
  for (const t of data.teams || []) {
    if (t.live) rows.today.unshift({ ms: Date.now(), label: "LIVE " + t.short + " " + score(t.live) + " " + vs(t.live), live: true });
    else if (t.next) {
      const ms = Date.parse(t.next.at);
      const g = { ms, label: t.short + " " + vs(t.next) };
      if (isToday(ms)) rows.today.push(g);
      else if (isTomorrow(ms)) rows.tomorrow.push(g);
    }
  }
  const meetingFeed = (data.video || []).find((v) => v.meetings);
  const watchable = (m) => m.meeting && meetingFeed && Date.now() > m.ms - 30 * 60000 && Date.now() < m.ms + 4 * 3600000;
  const line = (name, items) => el("div", { class: "row" },
    el("span", { class: "when", text: name }),
    el("span", { class: "what" }, ...items.sort((a, b) => a.ms - b.ms).flatMap((m, i) => [
      i ? el("span", { class: "sep", text: " · " }) : null,
      m.live ? "" : fmtTime.format(new Date(m.ms)) + " ",
      m.link ? el("a", { href: m.link, target: "_blank", rel: "noopener", text: m.label }) : m.label,
      watchable(m) ? el("button", {
        class: "watch", text: "▶ WATCH",
        onclick: () => { channel = meetingFeed.id; playing = true; livePanelOpen = true; store.set(KEY.channel, channel); renderLive(); $("live-toggle").scrollIntoView({ block: "start" }); },
      }) : null,
    ])));
  const kids = [];
  if (rows.today.length) kids.push(line("TODAY", rows.today));
  if (rows.tomorrow.length) kids.push(line("TOMORROW", rows.tomorrow));
  if (!kids.length) {
    const next = meetings.find((m) => m.ms > Date.now());
    if (next) kids.push(el("div", { class: "row" }, el("span", { class: "when", text: "NEXT" }),
      el("span", { class: "what", text: when(next.ms) + " " + next.label })));
  }
  $("today").replaceChildren(...kids);
}

// --------------------------------------------------------------- live player
function renderLive() {
  const vids = data.video || [];
  const playable = vids.filter((v) => v.channel_id);
  if (!playable.some((v) => v.id === channel)) channel = playable.length ? playable[0].id : null;
  const current = playable.find((v) => v.id === channel);
  $("live-now").textContent = playing && current ? current.name : "Watch a live channel";
  $("live-toggle").setAttribute("aria-expanded", String(livePanelOpen));
  $("live-panel").hidden = !livePanelOpen;

  const groups = [];
  for (const v of vids) {
    let g = groups.find((x) => x.name === v.group);
    if (!g) groups.push((g = { name: v.group, items: [] }));
    g.items.push(v);
  }
  $("channels").replaceChildren(...groups.map((g) => el("div", { class: "cg" },
    el("span", { class: "cg-name", text: g.name.toUpperCase() }),
    ...g.items.map((v) => v.link
      ? el("a", { class: "chip out", href: v.link, target: "_blank", rel: "noopener", text: v.name })
      : el("button", {
          class: "chip", "aria-pressed": String(playing && v.id === channel),
          onclick: () => { channel = v.id; playing = true; store.set(KEY.channel, v.id); renderLive(); },
        }, v.name, v.note ? el("span", { class: "note", text: v.note }) : null)))));
  renderPlayer(current);
}

function renderPlayer(v) {
  const p = $("player");
  if (!playing || !v) { p.replaceChildren(); return; }
  const existing = p.querySelector("iframe");
  if (existing && existing.dataset.channel === v.channel_id) return;
  const src = "https://www.youtube.com/embed/live_stream?channel=" + encodeURIComponent(v.channel_id) + "&autoplay=1&mute=1&playsinline=1";
  p.replaceChildren(
    el("div", { class: "frame" }, el("iframe", {
      src, title: v.name + " live", "data-channel": v.channel_id,
      allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: true,
      referrerpolicy: "strict-origin-when-cross-origin",
    })),
    el("div", { class: "player-links" },
      el("a", { href: "https://www.youtube.com/channel/" + v.channel_id + "/live", target: "_blank", rel: "noopener", text: "Not playing? Open on YouTube" }),
      el("button", { text: "stop", onclick: () => { playing = false; renderLive(); } })));
}

$("live-toggle").addEventListener("click", () => {
  livePanelOpen = !livePanelOpen;
  if (!livePanelOpen) playing = false;
  renderLive();
});

// --------------------------------------------------------------- last hour
function renderLastHour() {
  const cutoff = Date.now() - 3600000;
  const items = data.items.filter((it) => it.fast && it.ms >= cutoff && !it.alert).slice(0, LAST_HOUR_MAX);
  $("lasthour").hidden = !items.length;
  $("lasthour-list").replaceChildren(...items.map((it) => el("li", {},
    el("span", { class: "t", text: ago(it.ms), title: exact(it.ms) }),
    el("a", { href: it.link, target: "_blank", rel: "noopener", title: it.source + " — " + it.title, text: it.title }))));
}

// --------------------------------------------------------------- desks + new line
function newCount(d) {
  return data.items.filter((it) => (d === "ALL" || it.desk === d) && !isSeen(it)).length;
}

function renderDesks() {
  $("desks").replaceChildren(...DESKS.map((d) => {
    const n = prevVisit ? newCount(d) : 0;
    return el("button", {
      "aria-pressed": String(d === desk),
      onclick: () => { desk = d; store.set(KEY.desk, d); render(); },
    }, d, n ? el("span", { class: "n", text: String(n) }) : null);
  }));
}

function renderNewLine() {
  const b = $("newline");
  if (!prevVisit) { b.hidden = true; return; }
  const n = newCount(desk);
  const since = isToday(prevVisit) ? fmtTime.format(new Date(prevVisit)) : exact(prevVisit);
  b.hidden = false;
  b.replaceChildren(...[
    n ? n + " new since " + since : "Nothing new since " + since,
    n ? el("span", { class: "act", text: newOnly ? "show all" : "new only" }) : null,
  ].filter(Boolean));
  b.onclick = () => { if (n) { newOnly = !newOnly; renderNewLine(); renderPinned(); renderFeed(); } };
}

// --------------------------------------------------------------- rows
function row(it) {
  const li = el("li", { class: "row" + (it.watch && it.watch.length ? " watch" : "") + (isSeen(it) ? " seen" : "") + (openRows.has(it.id) ? " open" : "") });
  const meta = el("span", { class: "meta" },
    el("span", { class: "t" + (isFresh(it.ms) ? " fresh" : ""), text: ago(it.ms), title: exact(it.ms) }),
    el("span", { class: "sep", text: "·" }),
    el("span", { class: "desk " + it.desk, text: it.desk }),
    el("span", { class: "sep", text: "·" }),
    el("span", { class: "src", text: it.source }),
    it.kind ? el("span", { class: "sep", text: "·" }) : null,
    it.kind ? el("span", { class: "kind", text: KIND_MARK[it.kind] || it.kind }) : null);
  const headline = el("span", { class: "headline" }, it.title);
  const tags = (it.watch_terms && it.watch_terms.length ? it.watch_terms : it.watch || []).slice(0, 2);
  for (const tg of tags) headline.append(el("span", { class: "tag", text: String(tg).toUpperCase() }));
  const head = el("button", {
    class: "head", "aria-expanded": String(openRows.has(it.id)),
    onclick: () => {
      openRows.has(it.id) ? openRows.delete(it.id) : openRows.add(it.id);
      li.classList.toggle("open");
      head.setAttribute("aria-expanded", String(li.classList.contains("open")));
    },
  }, meta, headline);
  const more = el("div", { class: "more" },
    it.summary && !it.agenda ? el("p", { text: it.summary }) : null,
    it.blotter ? blotterTable(it.blotter) : null,
    it.agenda ? agendaList(it) : null,
    el("p", {}, el("a", { href: it.link, target: "_blank", rel: "noopener", text: "Open ↗" }),
      el("span", { class: "exact", text: exact(it.ms) })));
  li.append(head, more);
  return li;
}

function agendaList(it) {
  const box = el("div", { class: "agenda" }, el("div", { class: "agenda-head", text: it.agenda.length + " agenda items" }));
  let section = null;
  for (const a of it.agenda) {
    if (a.section && a.section !== section) {
      section = a.section;
      box.append(el("div", { class: "asec", text: section.toUpperCase() }));
    }
    const hist = a.addr ? ((data.tracker || {})[a.addr] || []).filter((h) => h.link !== it.link) : [];
    const histBox = el("div", { class: "ahist", hidden: true },
      ...hist.map((h) => el("div", {},
        el("a", { href: h.link, target: "_blank", rel: "noopener", text: fmtDate.format(new Date(h.date + "T12:00:00")) + " · " + h.body }),
        h.flags.length ? " · " + h.flags.join(", ") : "")));
    box.append(el("div", { class: "aitem" },
      el("span", { class: "an", text: a.n != null ? a.n + "." : "·" }),
      el("span", { class: "at" }, a.text,
        ...a.flags.map((f) => el("span", { class: "aflag" + (f === "ADJOURNED" ? " adj" : ""), text: f })),
        hist.length ? el("button", {
          class: "aseen", text: "↺ " + hist.length + " earlier",
          onclick: (ev) => { ev.stopPropagation(); histBox.hidden = !histBox.hidden; },
        }) : null,
        histBox)));
  }
  return box;
}

function blotterTable(days) {
  const box = el("div", { class: "blotter" });
  for (const d of days.slice().reverse()) {
    const dt = new Date(d.day + "T12:00:00");
    const label = isNaN(dt) ? d.day : fmtDate.format(dt);
    box.append(el("div", { class: "bday" },
      el("a", { href: d.url, target: "_blank", rel: "noopener", text: label }),
      " · " + d.rows.length + " calls"));
    for (const r of d.rows) {
      box.append(el("div", { class: "brow" },
        el("span", { class: "bt", text: r.time }),
        el("span", { class: "bc", text: r.call }),
        el("span", { class: "bd", text: r.disposition })));
    }
  }
  return box;
}

// --------------------------------------------------------------- pinned Beacon block
function pinnedItems() {
  if (desk !== "ALL") return [];
  const cutoff = Date.now() - PIN_HOURS * 3600000;
  return data.items.filter((it) => it.desk === "BEACON" && !it.alert && it.kind !== "BLOTTER" && it.ms >= cutoff && (!newOnly || !isSeen(it))).slice(0, PIN_MAX);
}

function renderPinned() {
  const items = pinnedItems();
  $("pinned").hidden = !items.length;
  $("pinned-list").replaceChildren(...items.map(row));
}

// --------------------------------------------------------------- scoreboard
function vs(g) { return (g.home ? "v " : "@ ") + g.opp + (g.comp ? " (" + g.comp + ")" : ""); }
function score(g) { return (g.us || "0") + "–" + (g.them || "0"); }
function result(g) {
  if (g.winner === true) return "W";
  if (g.us !== "" && g.us === g.them) return "D";
  return g.winner === false ? "L" : "";
}

function renderScoreboard() {
  const box = $("scoreboard");
  const teams = data.teams || [];
  box.hidden = desk !== "SPORTS" || !teams.length;
  if (box.hidden) return;
  box.replaceChildren(...teams.map((t) => {
    const lines = [el("span", { class: "name", text: t.short })];
    if (t.live) {
      lines.push(el("span", { class: "live", text: "LIVE " + score(t.live) + " " + vs(t.live) + " · " + t.live.detail }));
    } else if (t.last) {
      const r = result(t.last);
      lines.push(el("span", { class: "last" },
        r ? el("span", { class: "res " + r, text: r + " " }) : null,
        score(t.last) + " " + vs(t.last) + " · " + fmtDay.format(new Date(Date.parse(t.last.at)))));
    } else {
      lines.push(el("span", { class: "last", text: t.error ? "schedule unavailable" : "no recent result" }));
    }
    lines.push(el("span", { class: "next", text: t.next ? "Next " + when(Date.parse(t.next.at)) + " " + vs(t.next) : "No game scheduled" }));
    return el("div", { class: "team" }, ...lines);
  }));
}

// --------------------------------------------------------------- feed
function renderFeed() {
  const pinned = new Set(pinnedItems().map((it) => it.id));
  const items = data.items.filter((it) => (desk === "ALL" || it.desk === desk) && !pinned.has(it.id) && (!newOnly || !isSeen(it)));
  const rows = [];
  let dividerPlaced = !prevVisit || newOnly;
  for (const it of items) {
    if (!dividerPlaced && isSeen(it)) {
      if (rows.length) rows.push(el("li", { class: "divider", text: "SINCE YOU LAST OPENED" }));
      dividerPlaced = true;
    }
    rows.push(row(it));
  }
  if (!rows.length) rows.push(el("li", { class: "empty", text: newOnly ? "Nothing new on this desk." : "No items on this desk yet." }));
  $("feed").replaceChildren(...rows);
}

// --------------------------------------------------------------- source health
function renderHealth() {
  const bad = new Set(failingSources().map((s) => s.id));
  const rows = data.sources.map((s) => {
    const ok = s.last_success ? Date.parse(s.last_success) : null;
    const failing = bad.has(s.id);
    return el("tr", {},
      el("td", {}, s.name, s.robots === "subscription" ? el("span", { class: "sub", text: " · subscription" }) : null),
      el("td", { class: "desk " + s.desk, text: s.desk }),
      el("td", { text: String(s.items) }),
      el("td", { text: ok ? ago(ok) : "never", title: ok ? exact(ok) : "" }),
      el("td", { class: failing ? "err" : "ok", text: s.last_error || (failing ? "stale" : "ok") }));
  });
  const teamErr = (data.teams || []).filter((t) => t.error);
  for (const t of teamErr) rows.push(el("tr", {}, el("td", { text: t.name + " schedule" }), el("td", { class: "desk SPORTS", text: "SPORTS" }), el("td", { text: "–" }), el("td", { text: "–" }), el("td", { class: "err", text: t.error })));
  $("health-rows").replaceChildren(...rows);
  const n = data.sources.length;
  const line = $("health-line");
  line.replaceChildren("SOURCES " + n + " · ", bad.size ? el("span", { class: "bad", text: bad.size + " down" }) : "all ok", "  ▾");
  line.onclick = () => {
    const h = $("health");
    h.hidden = !h.hidden;
    line.setAttribute("aria-expanded", String(!h.hidden));
  };
}

// --------------------------------------------------------------- visit tracking
function markVisit() { store.set(KEY.visit, Date.now()); }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    markVisit();
  } else {
    prevVisit = Number(store.get(KEY.visit)) || prevVisit;
    newOnly = false;
    load();
  }
});
window.addEventListener("pagehide", markVisit);

// --------------------------------------------------------------- world clocks
const CLOCKS = [["BEACON", "America/New_York", true], ["PARIS", "Europe/Paris", false], ["TEL AVIV", "Asia/Jerusalem", false]];
const clockFmt = CLOCKS.map(([, tz, h12]) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: h12, weekday: "short" }));
function renderClocks() {
  const now = new Date();
  const here = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
  $("clocks").replaceChildren(...CLOCKS.flatMap(([name], i) => {
    const parts = clockFmt[i].formatToParts(now);
    const day = parts.find((p) => p.type === "weekday").value;
    const time = parts.filter((p) => p.type !== "weekday" && p.type !== "literal" || (p.type === "literal" && p.value !== ", ")).map((p) => p.value).join("").trim();
    return [i ? el("span", { class: "sep", text: " · " }) : null,
      el("span", {}, el("span", { class: "cn", text: name + " " }), time + (day !== here ? " " + day : ""))];
  }).filter(Boolean));
}

// --------------------------------------------------------------- boot
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* page works without it */ });
}
renderClocks();
loadCached().then(load);
setInterval(() => { if (document.visibilityState === "visible") load(); }, REFRESH_MS);
setInterval(() => { renderClocks(); if (data) { renderAsOf(); } }, 30000);
