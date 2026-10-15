"use strict";

// The Wire — V1 page. Reads data.json, renders the feed, breaking strip and
// source health. Last-visit time lives in this browser only (per device).

const DESKS = ["ALL", "BEACON", "GOV", "LAW", "WORLD"];
const LAST_VISIT_KEY = "wire.lastVisit";
const DESK_KEY = "wire.desk";
const CHANNEL_KEY = "wire.channel";
const REFRESH_MS = 5 * 60 * 1000;
const STALE_MIN = 45;

// --------------------------------------------------------------- storage (never throws)
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, String(v)); } catch (e) { /* private mode */ } },
};

let data = null;
let desk = store.get(DESK_KEY) || "ALL";
if (!DESKS.includes(desk)) desk = "ALL";
let prevVisit = Number(store.get(LAST_VISIT_KEY)) || null; // ms; the visit before this one
let channel = store.get(CHANNEL_KEY);
let playerOpen = false;
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
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
}
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
function exact(ms) { return fmt.format(new Date(ms)); }
function sameDay(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }

// --------------------------------------------------------------- data
async function load() {
  try {
    const r = await fetch("data.json?ts=" + Date.now(), { cache: "no-store", credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    data = await r.json();
    for (const it of data.items) it.ms = Date.parse(it.t);
    render();
  } catch (e) {
    $("asof").textContent = "couldn't load data (" + e.message + ")";
    $("asof").classList.add("stale");
  }
}

// --------------------------------------------------------------- render
function render() {
  if (!data) return;
  renderAsOf();
  renderAlerts();
  renderChannels();
  renderPlayer();
  renderLastHour();
  renderDesks();
  renderFeed();
  renderHealth();
}

function renderAsOf() {
  const g = Date.parse(data.generated_at);
  const minutes = (Date.now() - g) / 60000;
  const a = $("asof");
  a.textContent = "as of " + (sameDay(g, Date.now()) ? fmtTime.format(new Date(g)) : exact(g)) + " · " + ago(g);
  a.title = exact(g);
  a.classList.toggle("stale", minutes > STALE_MIN);
}

function renderAlerts() {
  const box = $("alerts");
  box.replaceChildren();
  for (const it of data.alerts || []) {
    const exp = it.alert && it.alert.expires ? " · until " + exact(Date.parse(it.alert.expires)) : "";
    box.append(el("a", { class: "alert", href: it.link, target: "_blank", rel: "noopener" },
      "⚠ " + (it.alert.event || "Weather alert") + " — Beacon" + exp,
      el("small", { text: it.title })));
  }
}

function renderChannels() {
  const vids = data.video || [];
  if (!vids.some((v) => v.id === channel)) channel = vids.length ? vids[0].id : null;
  const box = $("channels");
  box.replaceChildren(...vids.map((v) => el("button", {
    role: "tab", "aria-selected": String(playerOpen && v.id === channel), text: v.name,
    onclick: () => {
      if (playerOpen && v.id === channel) { playerOpen = false; } else { channel = v.id; playerOpen = true; store.set(CHANNEL_KEY, v.id); }
      renderChannels(); renderPlayer();
    },
  })));
}

function renderPlayer() {
  const p = $("player");
  const v = (data.video || []).find((x) => x.id === channel);
  if (!playerOpen || !v) {
    p.hidden = false;
    p.replaceChildren(el("div", { class: "player-hint", text: "▶ Tap a channel to watch live" }));
    return;
  }
  const src = "https://www.youtube.com/embed/live_stream?channel=" + encodeURIComponent(v.channel_id) + "&autoplay=1&mute=1&playsinline=1";
  const current = p.querySelector("iframe");
  if (current && current.dataset.channel === v.channel_id) { p.hidden = false; return; }
  const frame = el("div", { class: "frame" }, el("iframe", {
    src, title: v.name + " live", "data-channel": v.channel_id,
    allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: true, referrerpolicy: "strict-origin-when-cross-origin",
  }));
  const links = el("div", { class: "player-links" },
    el("a", { href: "https://www.youtube.com/channel/" + v.channel_id + "/live", target: "_blank", rel: "noopener", text: "Not playing? Watch on YouTube" }),
    el("button", { text: "close", onclick: () => { playerOpen = false; renderChannels(); renderPlayer(); } }));
  p.replaceChildren(frame, links);
  p.hidden = false;
}

let lastHourExpanded = false;
function renderLastHour() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const items = data.items.filter((it) => it.fast && it.ms >= cutoff && !it.alert).slice(0, 12);
  $("lasthour-count").textContent = items.length ? "· " + items.length : "";
  const list = $("lasthour");
  if (!items.length) { list.replaceChildren(el("li", { class: "empty", text: "Nothing from the fast sources in the last 60 minutes." })); return; }
  const narrow = window.matchMedia("(max-width: 759px)").matches;
  const shown = narrow && !lastHourExpanded ? items.slice(0, 5) : items;
  const rows = shown.map((it) => el("li", {},
    el("span", { class: "t", text: ago(it.ms), title: exact(it.ms) }),
    el("a", { href: it.link, target: "_blank", rel: "noopener", title: it.source + " — " + it.title, text: it.title })));
  if (shown.length < items.length) {
    rows.push(el("li", {}, el("button", { class: "linklike", text: "+" + (items.length - shown.length) + " more",
      onclick: () => { lastHourExpanded = true; renderLastHour(); } })));
  }
  list.replaceChildren(...rows);
}

function renderDesks() {
  const counts = { ALL: data.items.length };
  for (const it of data.items) counts[it.desk] = (counts[it.desk] || 0) + 1;
  $("desks").replaceChildren(...DESKS.map((d) => el("button", {
    "aria-pressed": String(d === desk),
    onclick: () => { desk = d; store.set(DESK_KEY, d); renderDesks(); renderFeed(); },
  }, d, el("span", { class: "n", text: String(counts[d] || 0) }))));
}

function renderFeed() {
  const items = data.items.filter((it) => desk === "ALL" || it.desk === desk);
  const nc = $("newcount");
  if (prevVisit) {
    const fresh = items.filter((it) => it.ms > prevVisit).length;
    nc.textContent = fresh ? fresh + " new since " + (sameDay(prevVisit, Date.now()) ? fmtTime.format(new Date(prevVisit)) : exact(prevVisit)) : "Nothing new since your last visit.";
  } else {
    nc.textContent = "";
  }
  const feed = $("feed");
  const rows = [];
  let dividerPlaced = !prevVisit;
  for (const it of items) {
    if (!dividerPlaced && it.ms <= prevVisit) {
      if (rows.length) rows.push(el("li", { class: "divider", text: "SINCE YOU LAST OPENED" }));
      dividerPlaced = true;
    }
    rows.push(row(it));
  }
  if (!rows.length) rows.push(el("li", { class: "empty", text: "No items on this desk yet." }));
  feed.replaceChildren(...rows);
}

function row(it) {
  const li = el("li", { class: "row" + (it.watch && it.watch.length ? " watch" : "") + (openRows.has(it.id) ? " open" : "") });
  const title = el("span", { class: "title" }, it.title);
  for (const g of it.watch || []) title.append(el("span", { class: "tag", text: g.replace(/_/g, " ") }));
  title.append(el("span", { class: "src", text: it.source }));
  const head = el("button", {
    class: "head", "aria-expanded": String(openRows.has(it.id)),
    onclick: () => {
      openRows.has(it.id) ? openRows.delete(it.id) : openRows.add(it.id);
      li.classList.toggle("open"); head.setAttribute("aria-expanded", String(li.classList.contains("open")));
    },
  },
    el("span", { class: "t", text: ago(it.ms), title: exact(it.ms) }),
    el("span", { class: "desk " + it.desk, text: it.desk }),
    title);
  const more = el("div", { class: "more" },
    it.summary ? el("p", { text: it.summary }) : null,
    el("p", {}, el("a", { href: it.link, target: "_blank", rel: "noopener", text: "Open ↗" }), "  ",
      el("span", { class: "exact", text: exact(it.ms) })));
  li.append(head, more);
  return li;
}

function renderHealth() {
  const rows = [];
  let bad = 0;
  for (const s of data.sources) {
    const ok = s.last_success ? Date.parse(s.last_success) : null;
    const staleAfter = Math.max(3 * s.poll, 60) * 60000;
    const stale = !ok || Date.now() - ok > staleAfter;
    const failing = Boolean(s.last_error) || stale;
    if (failing) bad++;
    const status = s.last_error ? s.last_error : stale ? "stale" : "ok";
    rows.push(el("tr", {},
      el("td", {}, s.name, s.robots === "subscription" ? el("span", { class: "sub", text: " · subscription" }) : null),
      el("td", { class: "desk " + s.desk, text: s.desk }),
      el("td", { text: String(s.items) }),
      el("td", { text: ok ? ago(ok) : "never", title: ok ? exact(ok) : "" }),
      el("td", { class: failing ? "err" : "ok", text: status })));
  }
  $("health-rows").replaceChildren(...rows);
  const sum = $("health-summary");
  sum.replaceChildren(bad ? el("span", { class: "bad", text: "· " + bad + " need attention" }) : "· all " + data.sources.length + " ok");
  if (bad) $("health").open = false;
}

// --------------------------------------------------------------- visit tracking
function markVisit() { store.set(LAST_VISIT_KEY, Date.now()); }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    markVisit();
  } else {
    // Coming back: everything seen up to the moment you left becomes "read".
    prevVisit = Number(store.get(LAST_VISIT_KEY)) || prevVisit;
    load();
  }
});
window.addEventListener("pagehide", markVisit);

// --------------------------------------------------------------- boot
load();
setInterval(() => { if (document.visibilityState === "visible") load(); }, REFRESH_MS);
setInterval(() => { if (data) { renderAsOf(); } }, 30000);
