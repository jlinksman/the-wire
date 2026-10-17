"use strict";

// The Wire — page. Five tabs (Today, Beacon, Gov, World, Live) with a bottom tab bar,
// a detail sheet for any item, one live player that docks as a mini-player, and a
// settings sheet. Preferences, saved items and the last-visit time live in this
// browser only (per device).

const TABS = [
  { id: "today", label: "Today", icon: "◉" },
  { id: "beacon", label: "Beacon", icon: "⌂" },
  { id: "gov", label: "Gov", icon: "§" },
  { id: "world", label: "World", icon: "◍" },
  { id: "live", label: "Live", icon: "▶" },
];
const SEGMENTS = { gov: [["GOV", "Government"], ["LAW", "Law & courts"]], world: [["WORLD", "World"], ["SPORTS", "Sports"]] };
const KEY = {
  visit: "wire.lastVisit", tab: "wire.tab", seg: "wire.seg", channel: "wire.channel",
  prefs: "wire.prefs", saved: "wire.saved",
};
const REFRESH_MS = 5 * 60 * 1000;
const STALE_MIN = 45;
const FRESH_MIN = 30;
const PAGE = 30;
const KIND_MARK = { VIDEO: "▶ VIDEO", DOC: "DOC", QUOTE: "“ QUOTE", BLOTTER: "BLOTTER" };
const SIZES = [["system", "iPhone"], ["15", "S"], ["17", "M"], ["19", "L"], ["21", "XL"]];

// --------------------------------------------------------------- storage (never throws)
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, String(v)); } catch (e) { /* private mode */ } },
  json(k, d) { try { return JSON.parse(store.get(k)) ?? d; } catch (e) { return d; } },
};
const prefs = Object.assign({ size: "system", clocks: true, newOnly: false, mutedSources: [], mutedWords: "" }, store.json(KEY.prefs, {}));
const savePrefs = () => store.set(KEY.prefs, JSON.stringify(prefs));
let saved = store.json(KEY.saved, []);           // [{id, title, link, source, ms}]
const saveSaved = () => store.set(KEY.saved, JSON.stringify(saved.slice(0, 100)));

let data = null;
let pending = null;                                // fresh data held while you're scrolled down
let tab = TABS.some((t) => t.id === store.get(KEY.tab)) ? store.get(KEY.tab) : "today";
const seg = Object.assign({ gov: "GOV", world: "WORLD" }, store.json(KEY.seg, {}));
let prevVisit = Number(store.get(KEY.visit)) || null;
let channel = store.get(KEY.channel);
let playing = false;
const shown = {};                                  // how many rows each feed shows
const scrollPos = {};

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
const link = (href, text, cls) => el("a", { href, target: "_blank", rel: "noopener", class: cls, text });
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
const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const exact = (ms) => fmtFull.format(new Date(ms));
const dayKey = (ms) => new Date(ms).toDateString();
const isToday = (ms) => dayKey(ms) === dayKey(Date.now());
const isTomorrow = (ms) => dayKey(ms) === dayKey(Date.now() + 86400000);
const isYesterday = (ms) => dayKey(ms) === dayKey(Date.now() - 86400000);
const isSeen = (it) => prevVisit != null && it.ms <= prevVisit;
const isFresh = (ms) => Date.now() - ms < FRESH_MIN * 60000;
function when(ms) {
  if (isToday(ms)) return fmtTime.format(new Date(ms));
  if (isTomorrow(ms)) return "Tmrw " + fmtTime.format(new Date(ms));
  return fmtDate.format(new Date(ms)) + " " + fmtTime.format(new Date(ms));
}
function dayLabel(ms) {
  if (isToday(ms)) return "TODAY";
  if (isYesterday(ms)) return "YESTERDAY";
  return fmtDate.format(new Date(ms)).toUpperCase();
}

// --------------------------------------------------------------- text size (follows the iPhone setting by default)
function applySize() {
  const root = document.documentElement;
  root.classList.toggle("dyn", prefs.size === "system");
  root.style.fontSize = prefs.size === "system" ? "" : prefs.size + "px";
}

// --------------------------------------------------------------- muting
function mutedWordList() {
  return prefs.mutedWords.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
}
function isMuted(it) {
  if (prefs.mutedSources.includes(it.source_id)) return true;
  const words = mutedWordList();
  if (!words.length) return false;
  const t = (it.title + " " + (it.summary || "")).toLowerCase();
  return words.some((w) => t.includes(w));
}

// --------------------------------------------------------------- data
const DATA_CACHE = "wire-data";

function accept(json) {
  data = json;
  for (const it of data.items) it.ms = Date.parse(it.t);
  indexStories();
  render();
}

async function loadCached() {
  try {
    const c = await caches.open(DATA_CACHE);
    const r = await c.match("data.json");
    if (r && !data) accept(await r.json());
  } catch (e) { /* no Cache API: the network load follows */ }
}

// A background refresh never moves the list under your thumb: if you're scrolled
// down, the new data waits behind a "N new" pill until you tap it.
async function load(force) {
  const btn = $("refresh-btn");
  btn.classList.add("spin");
  try {
    const r = await fetch("data.json?ts=" + Date.now(), { cache: "no-store", credentials: "same-origin", redirect: "manual" });
    if (r.type === "opaqueredirect" || r.status === 401 || r.status === 403) throw new Error("signed out");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const json = await r.clone().json();
    try { (await caches.open(DATA_CACHE)).put("data.json", r); } catch (e) { /* ignore */ }
    if (!data || force || window.scrollY < 200) {
      pending = null;
      $("newpill").hidden = true;
      accept(json);
    } else {
      const known = new Set(data.items.map((it) => it.id));
      const fresh = json.items.filter((it) => !known.has(it.id) && inView(it)).length;
      pending = json;
      if (fresh) {
        $("newpill").textContent = "↑ " + fresh + " new";
        $("newpill").hidden = false;
      } else {
        accept(json);
      }
    }
  } catch (e) {
    const a = $("asof");
    a.classList.add("stale");
    if (e.message === "signed out" || e instanceof TypeError) {
      a.replaceChildren(el("a", { href: "./?reauth=" + Date.now(), text: data ? "offline · sign in" : "sign in" }));
    } else if (!data) {
      a.textContent = "couldn't load (" + e.message + ")";
    }
  } finally {
    btn.classList.remove("spin");
  }
}

$("newpill").addEventListener("click", () => {
  $("newpill").hidden = true;
  if (pending) accept(pending);
  pending = null;
  window.scrollTo({ top: 0, behavior: "smooth" });
});
$("refresh-btn").addEventListener("click", () => load(true));

// --------------------------------------------------------------- render
function render() {
  if (!data) return;
  renderTop();
  renderTabbar();
  renderView(tab);
  renderPlayer();
}

function renderTop() {
  const g = Date.parse(data.generated_at);
  const a = $("asof");
  a.textContent = "as of " + (isToday(g) ? fmtTime.format(new Date(g)) : exact(g));
  a.title = exact(g) + " · " + ago(g) + " ago";
  a.classList.toggle("stale", (Date.now() - g) / 60000 > STALE_MIN);
  const bad = failingSources().length;
  $("status-dot").className = "dot " + (bad ? "bad" : "ok");
  $("status-n").textContent = bad ? String(bad) : "";
  $("status-btn").setAttribute("aria-label", bad ? bad + " sources down" : "All sources ok");
}

function inView(it) {
  if (tab === "beacon") return it.desk === "BEACON";
  if (tab === "gov") return it.desk === seg.gov;
  if (tab === "world") return it.desk === seg.world;
  return false;
}

function newCount(desks) {
  if (!prevVisit || !data) return 0;
  return data.items.filter((it) => desks.includes(it.desk) && !isSeen(it) && !folded.has(it.id) && !isMuted(it)).length;
}

function renderTabbar() {
  const counts = { beacon: newCount(["BEACON"]), gov: newCount(["GOV", "LAW"]), world: newCount(["WORLD", "SPORTS"]) };
  const liveOn = playing;
  $("tabbar").replaceChildren(...TABS.map((t) => el("button", {
    class: "tabbtn", "aria-current": t.id === tab ? "page" : null, "data-tab": t.id,
    onclick: () => go(t.id),
  },
    el("span", { class: "ico" + (t.id === "live" && liveOn ? " on" : ""), "aria-hidden": "true", text: t.icon }),
    el("span", { class: "tl", text: t.label }),
    counts[t.id] ? el("span", { class: "badge", text: counts[t.id] > 99 ? "99+" : String(counts[t.id]) }) : null)));
}

// Tapping the tab you're on goes to the top, as in iPhone apps.
function go(id) {
  if (id === tab) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  scrollPos[tab] = window.scrollY;
  $("view-" + tab).hidden = true;
  tab = id;
  store.set(KEY.tab, id);
  $("view-" + id).hidden = false;
  document.body.dataset.tab = id;
  render();
  window.scrollTo(0, scrollPos[id] || 0);
}
$("brand").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

function renderView(id) {
  const v = $("view-" + id);
  for (const t of TABS) $("view-" + t.id).hidden = t.id !== id;
  document.body.dataset.tab = id;
  if (id === "today") v.replaceChildren(...todayView());
  if (id === "beacon") v.replaceChildren(...deskView("beacon", "BEACON"));
  if (id === "gov") v.replaceChildren(segBar("gov"), ...(seg.gov === "GOV" ? govPanel() : []), ...deskView("gov", seg.gov));
  if (id === "world") v.replaceChildren(segBar("world"), ...(seg.world === "SPORTS" ? scoreboard() : []), ...deskView("world", seg.world));
  if (id === "live") v.replaceChildren(...liveView());
}

// --------------------------------------------------------------- today
function todayView() {
  const out = [];
  if (prefs.clocks) out.push(clocks());
  for (const it of data.alerts || []) {
    const exp = it.alert && it.alert.expires ? " · until " + exact(Date.parse(it.alert.expires)) : "";
    out.push(el("a", { class: "alert", href: it.link, target: "_blank", rel: "noopener" },
      "⚠ " + (it.alert.event || "Weather alert") + " — Beacon" + exp, el("small", { text: it.title })));
  }
  const bad = failingSources();
  if (bad.length) {
    out.push(el("button", { class: "down", onclick: openHealth },
      "⚠ " + bad.length + (bad.length > 1 ? " sources" : " source") + " down", el("span", { class: "chev", text: " ›" })));
  }
  const ahead = aheadBlock();
  if (ahead) out.push(ahead);
  if (data.front_page_url) {
    out.push(el("a", { class: "edition", href: data.front_page_url, target: "_blank", rel: "noopener" },
      el("span", { class: "ed-k", text: "THE EDITION" }),
      el("span", { class: "ed-t", text: "Read today's written front page" }),
      el("span", { class: "ed-a", text: "↗" })));
  }

  const cutoff = Date.now() - 48 * 3600000;
  const beacon = data.items.filter((it) => it.desk === "BEACON" && !it.alert && it.kind !== "BLOTTER" && it.ms >= cutoff && !isMuted(it)).slice(0, 3);
  if (beacon.length) {
    out.push(sectionHead("BEACON", "Last 48 hours", () => go("beacon"), "All Beacon"));
    out.push(el("ol", { class: "list" }, ...beacon.map((it) => row(it, { desk: false }))));
  }

  const stories = (data.stories || []).filter((s) => storyOf.get(s.lead) === s && !isMuted(byId.get(s.lead))).slice(0, 6);
  if (stories.length) {
    out.push(sectionHead("FRONT PAGE", "Stories covered by several outlets"));
    out.push(...stories.map(storyCard));
  }

  const hour = data.items.filter((it) => it.fast && it.ms >= Date.now() - 3600000 && !it.alert && !folded.has(it.id) && !isMuted(it)).slice(0, 5);
  if (hour.length) {
    out.push(sectionHead("LAST HOUR"));
    out.push(el("ol", { class: "list" }, ...hour.map((it) => row(it, { desk: true }))));
  }

  const teams = (data.teams || []).filter((t) => t.live || (t.last && Date.now() - Date.parse(t.last.at) < 3 * 86400000));
  if (teams.length) {
    out.push(sectionHead("SCORES", null, () => { seg.world = "SPORTS"; store.set(KEY.seg, JSON.stringify(seg)); go("world"); }, "Sports"));
    out.push(el("div", { class: "scores" }, ...teams.map(teamLine)));
  }

  out.push(el("div", { class: "caughtup" },
    el("div", { class: "cu-k", text: "YOU'RE CAUGHT UP" }),
    el("div", { class: "cu-t", text: "Feed as of " + exact(Date.parse(data.generated_at)) + ". More on each desk:" }),
    el("div", { class: "cu-links" }, ...[["beacon", "Beacon"], ["gov", "Gov"], ["gov:LAW", "Law"], ["world", "World"], ["world:SPORTS", "Sports"]].map(([k, label]) =>
      el("button", { class: "pill", text: label, onclick: () => {
        const [t, s] = k.split(":");
        if (s) { seg[t] = s; store.set(KEY.seg, JSON.stringify(seg)); }
        else if (SEGMENTS[t]) { seg[t] = SEGMENTS[t][0][0]; store.set(KEY.seg, JSON.stringify(seg)); }
        go(t);
      } })))));
  return out;
}

function sectionHead(label, sub, action, actionLabel) {
  return el("div", { class: "shead" },
    el("span", { class: "sk", text: label }),
    sub ? el("span", { class: "ss", text: sub }) : null,
    action ? el("button", { class: "sa", onclick: action, text: actionLabel + " ›" }) : null);
}

function aheadBlock() {
  const rows = [];
  const meetings = data.items
    .filter((it) => it.event_at && Date.parse(it.event_at) > Date.now() - 3 * 3600000)
    .map((it) => ({ ms: Date.parse(it.event_at), label: it.title.split(" - ")[0], n: it.agenda ? it.agenda.length : 0, item: it, meeting: true }));
  const seen = new Set();
  for (const m of meetings.sort((a, b) => a.ms - b.ms)) {
    const k = m.label + m.ms;
    if (seen.has(k) || !(isToday(m.ms) || isTomorrow(m.ms))) continue;
    seen.add(k);
    rows.push(m);
  }
  for (const t of data.teams || []) {
    if (t.live) rows.push({ ms: Date.now(), label: t.short + " " + score(t.live) + " " + vs(t.live), live: true });
    else if (t.next) {
      const ms = Date.parse(t.next.at);
      if (isToday(ms) || isTomorrow(ms)) rows.push({ ms, label: t.short + " " + vs(t.next) });
    }
  }
  if (!rows.length) return null;
  const meetingFeed = (data.video || []).find((v) => v.meetings);
  const watchable = (m) => m.meeting && meetingFeed && Date.now() > m.ms - 30 * 60000 && Date.now() < m.ms + 4 * 3600000;
  rows.sort((a, b) => a.ms - b.ms);
  return el("div", { class: "ahead" },
    el("div", { class: "shead" }, el("span", { class: "sk", text: "AHEAD" })),
    ...rows.map((m) => el("div", { class: "arow" + (m.live ? " live" : "") },
      el("span", { class: "aw", text: m.live ? "LIVE" : (isToday(m.ms) ? "" : "Tmrw ") + fmtTime.format(new Date(m.ms)) }),
      m.item
        ? el("button", { class: "at", onclick: () => openItem(m.item) }, m.label, m.n ? el("span", { class: "an", text: " · " + m.n + " items" }) : null)
        : el("span", { class: "at", text: m.label }),
      watchable(m) ? el("button", { class: "watch", text: "▶ WATCH", onclick: () => play(meetingFeed.id) }) : null)));
}

function clocks() {
  const CLOCKS = [["BEACON", "America/New_York", true], ["PARIS", "Europe/Paris", false], ["TEL AVIV", "Asia/Jerusalem", false]];
  const now = new Date();
  const here = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
  return el("div", { class: "clocks", id: "clocks" }, ...CLOCKS.flatMap(([name, tz, h12], i) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: h12, weekday: "short" }).formatToParts(now);
    const day = parts.find((p) => p.type === "weekday").value;
    const time = parts.filter((p) => ["hour", "minute", "dayPeriod"].includes(p.type) || (p.type === "literal" && p.value === ":")).map((p) => p.value).join("").replace(/(\d)(AM|PM)/, "$1 $2");
    return [i ? el("span", { class: "sep", text: " · " }) : null,
      el("span", {}, el("span", { class: "cn", text: name + " " }), time + (day !== here ? " " + day : ""))];
  }).filter(Boolean));
}

// --------------------------------------------------------------- desks
function segBar(t) {
  return el("div", { class: "seg", role: "tablist" }, ...SEGMENTS[t].map(([d, label]) => {
    const n = newCount([d]);
    return el("button", {
      role: "tab", "aria-selected": String(seg[t] === d),
      onclick: () => { if (seg[t] === d) return; seg[t] = d; store.set(KEY.seg, JSON.stringify(seg)); renderView(t); window.scrollTo(0, 0); },
    }, label, n ? el("span", { class: "n", text: " " + (n > 99 ? "99+" : n) }) : null);
  }));
}

function deskView(t, desk) {
  const key = t + ":" + desk;
  shown[key] = shown[key] || PAGE;
  const all = data.items.filter((it) => it.desk === desk && !folded.has(it.id) && !it.alert && !isMuted(it));
  const fresh = prevVisit ? all.filter((it) => !isSeen(it)).length : 0;
  const list = prefs.newOnly && fresh ? all.filter((it) => !isSeen(it)) : all;
  const out = [];
  if (prevVisit) {
    const since = isToday(prevVisit) ? fmtTime.format(new Date(prevVisit)) : exact(prevVisit);
    out.push(el("div", { class: "newline" },
      el("span", { text: fresh ? fresh + " new since " + since : "Nothing new since " + since }),
      fresh ? el("button", { class: "act", text: prefs.newOnly ? "Show all" : "New only",
        onclick: () => { prefs.newOnly = !prefs.newOnly; savePrefs(); renderView(tab); } }) : null));
  }
  const ol = el("ol", { class: "list" });
  let lastDay = null;
  let dividerPlaced = !prevVisit || (prefs.newOnly && fresh);
  for (const it of list.slice(0, shown[key])) {
    const d = dayKey(it.ms);
    if (d !== lastDay) { ol.append(el("li", { class: "day", text: dayLabel(it.ms) })); lastDay = d; }
    if (!dividerPlaced && isSeen(it)) {
      ol.append(el("li", { class: "divider", text: "SINCE YOU LAST OPENED" }));
      dividerPlaced = true;
    }
    ol.append(row(it, { desk: false }));
  }
  if (!list.length) ol.append(el("li", { class: "empty", text: "Nothing on this desk yet." }));
  out.push(ol);
  if (list.length > shown[key]) {
    out.push(el("button", { class: "more-btn", text: "Show " + Math.min(PAGE, list.length - shown[key]) + " more · " + (list.length - shown[key]) + " left",
      onclick: () => { const y = window.scrollY; shown[key] += PAGE; renderView(tab); window.scrollTo(0, y); } }));
  } else if (list.length) {
    out.push(el("div", { class: "endline", text: "End of desk · " + list.length + " items in the last 7 days" }));
  }
  return out;
}

// --------------------------------------------------------------- rows (tap opens the detail sheet)
function row(it, opt = {}) {
  const st = storyOf.get(it.id);
  const watch = it.watch && it.watch.length;
  const meta = el("span", { class: "meta" },
    el("span", { class: "t" + (isFresh(it.ms) ? " fresh" : ""), text: ago(it.ms) }),
    opt.desk ? el("span", { class: "desk " + it.desk, text: it.desk }) : null,
    el("span", { class: "src", text: it.source }),
    it.kind ? el("span", { class: "kind", text: KIND_MARK[it.kind] || it.kind }) : null,
    st ? el("span", { class: "plus", text: "+" + (st.sources - 1) }) : null);
  const headline = el("span", { class: "headline" }, it.title);
  const tags = (it.watch_terms && it.watch_terms.length ? it.watch_terms : it.watch || []).slice(0, 2);
  for (const tg of tags) headline.append(el("span", { class: "tag", text: String(tg).toUpperCase() }));
  return el("li", { class: "row" + (watch ? " watch" : "") + (isSeen(it) ? " seen" : "") },
    el("button", { class: "head", onclick: () => openItem(it) }, meta, headline));
}

function storyCard(s) {
  const lead = byId.get(s.lead);
  const q = storyQuotes(s)[0];
  return el("article", { class: "story" + (isSeen(lead) ? " seen" : "") },
    el("button", { class: "head", onclick: () => openItem(lead) },
      el("span", { class: "meta" },
        el("span", { class: "t" + (isFresh(Date.parse(s.last)) ? " fresh" : ""), text: ago(Date.parse(s.last)) }),
        el("span", { class: "desk " + s.desk, text: s.desk }),
        el("span", { class: "plus", text: s.sources + " sources" })),
      el("span", { class: "headline", text: lead.title }),
      s.summary ? el("span", { class: "msum" }, el("span", { class: "mlabel", text: "MACHINE SUMMARY " }), s.summary) : null,
      q ? el("span", { class: "qline" }, "“" + q.text + "” ", el("span", { class: "qby", text: "— " + q.by })) : null));
}

// --------------------------------------------------------------- detail sheet
let sheetReturn = null;
function openSheet(nodes, title) {
  sheetReturn = document.activeElement;
  $("sheet-body").replaceChildren(...nodes);
  $("sheet").setAttribute("aria-label", title || "Details");
  $("scrim").hidden = false;
  $("sheet").hidden = false;
  $("sheet-body").scrollTop = 0;
  document.documentElement.classList.add("locked");
  requestAnimationFrame(() => $("sheet").classList.add("up"));
  $("sheet-close").focus({ preventScroll: true });
}
function closeSheet() {
  $("sheet").classList.remove("up");
  $("scrim").hidden = true;
  document.documentElement.classList.remove("locked");
  setTimeout(() => { $("sheet").hidden = true; }, 180);
  if (sheetReturn) sheetReturn.focus({ preventScroll: true });
}
$("sheet-close").addEventListener("click", closeSheet);
$("scrim").addEventListener("click", closeSheet);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });
// Swipe down on the handle (or the top of the sheet) to close.
(() => {
  let y0 = null;
  const s = $("sheet");
  s.addEventListener("touchstart", (e) => { if ($("sheet-body").scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
  s.addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy > 0) s.style.transform = "translateY(" + dy + "px)";
  }, { passive: true });
  s.addEventListener("touchend", (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    s.style.transform = "";
    y0 = null;
    if (dy > 90) closeSheet();
  });
})();

function openItem(it) {
  const st = storyOf.get(it.id) || (data.stories || []).find((s) => s.members.includes(it.id) && storyOf.get(s.lead) === s);
  const isSaved = saved.some((x) => x.id === it.id);
  const qs = st ? storyQuotes(st) : (it.quotes || []).map((q) => ({ ...q, item: it }));
  const saveBtn = el("button", { class: "sbtn", text: isSaved ? "★ Saved" : "☆ Save" });
  saveBtn.onclick = () => {
    if (saved.some((x) => x.id === it.id)) saved = saved.filter((x) => x.id !== it.id);
    else saved.unshift({ id: it.id, title: it.title, link: it.link, source: it.source, ms: it.ms });
    saveSaved();
    saveBtn.textContent = saved.some((x) => x.id === it.id) ? "★ Saved" : "☆ Save";
  };
  const nodes = [
    el("div", { class: "smeta" },
      el("span", { class: "desk " + it.desk, text: it.desk }),
      el("span", { text: it.source }),
      el("span", { text: exact(it.ms) }),
      it.kind ? el("span", { class: "kind", text: KIND_MARK[it.kind] || it.kind }) : null),
    el("h2", { id: "sheet-title", class: "stitle", text: it.title }),
    st && st.summary ? machine(st.summary, st.sources) : null,
    it.machine_summary && !st ? machine(it.machine_summary, 1) : null,
    it.summary && !it.agenda ? el("p", { class: "sdesc", text: it.summary }) : null,
    it.watch_terms && it.watch_terms.length ? el("p", { class: "swatch", text: "Matched your watchlist: " + it.watch_terms.join(", ") }) : null,
    quoteList(qs),
    it.agenda ? agendaList(it) : null,
    it.blotter ? blotterTable(it.blotter) : null,
    el("div", { class: "sactions" },
      link(it.link, "Open " + it.source + " ↗", "sbtn primary"),
      navigator.share ? el("button", { class: "sbtn", text: "Share", onclick: () => navigator.share({ title: it.title, url: it.link }).catch(() => {}) }) : null,
      saveBtn),
    st ? el("div", { class: "salso" }, el("div", { class: "shead" }, el("span", { class: "sk", text: "ALSO COVERING · " + (st.sources - 1) + (st.sources === 2 ? " OUTLET" : " OUTLETS") })), alsoList(st, it.id)) : null,
  ];
  openSheet(nodes.filter(Boolean), it.title);
}

function agendaList(it) {
  const box = el("div", { class: "agenda" }, el("div", { class: "shead" }, el("span", { class: "sk", text: it.agenda.length + " AGENDA ITEMS" })));
  let section = null;
  for (const a of it.agenda) {
    if (a.section && a.section !== section) {
      section = a.section;
      box.append(el("div", { class: "asec", text: section.toUpperCase() }));
    }
    const hist = a.addr ? ((data.tracker || {})[a.addr] || []).filter((h) => h.link !== it.link) : [];
    const histBox = el("div", { class: "ahist", hidden: true },
      ...hist.map((h) => el("div", {},
        link(h.link, fmtDate.format(new Date(h.date + "T12:00:00")) + " · " + h.body),
        h.flags.length ? " · " + h.flags.join(", ") : "")));
    box.append(el("div", { class: "aitem" },
      el("span", { class: "anum", text: a.n != null ? a.n + "." : "·" }),
      el("span", { class: "atext" }, a.text,
        ...a.flags.map((f) => el("span", { class: "aflag" + (f === "ADJOURNED" ? " adj" : ""), text: f })),
        hist.length ? el("button", { class: "aseen", text: "↺ " + hist.length + " earlier",
          onclick: () => { histBox.hidden = !histBox.hidden; } }) : null,
        histBox)));
  }
  return box;
}

function blotterTable(days) {
  const box = el("div", { class: "blotter" });
  for (const d of days.slice().reverse()) {
    const dt = new Date(d.day + "T12:00:00");
    box.append(el("div", { class: "bday" }, link(d.url, isNaN(dt) ? d.day : fmtDate.format(dt)), " · " + d.rows.length + " calls"));
    for (const r of d.rows) {
      box.append(el("div", { class: "brow" },
        el("span", { class: "bt", text: r.time }), el("span", { class: "bc", text: r.call }), el("span", { class: "bd", text: r.disposition })));
    }
  }
  return box;
}

// --------------------------------------------------------------- stories (V5)
const storyOf = new Map();   // lead item id -> story
const folded = new Set();    // item ids shown only inside their story
const byId = new Map();

function indexStories() {
  storyOf.clear(); folded.clear(); byId.clear();
  for (const it of data.items) byId.set(it.id, it);
  for (const s of data.stories || []) {
    const members = s.members.filter((m) => byId.has(m));
    if (members.length < 2) continue;
    s.members = members;
    storyOf.set(s.lead, s);
    for (const m of members) if (m !== s.lead) folded.add(m);
  }
}

function machine(text, n) {
  return el("div", { class: "machine" },
    el("span", { class: "mlabel", text: "MACHINE SUMMARY · " + n + (n === 1 ? " report" : " reports") }),
    el("p", { text }));
}

function storyQuotes(s) {
  const out = [];
  for (const m of s.members) for (const q of byId.get(m).quotes || []) {
    if (out.length < 2 && !out.some((o) => o.by === q.by)) out.push({ ...q, item: byId.get(m) });
  }
  return out;
}

function quoteList(qs) {
  if (!qs.length) return null;
  return el("div", { class: "quotes" }, ...qs.map((q) => el("blockquote", {},
    el("span", { class: "qt", text: "“" + q.text + "”" }),
    el("span", { class: "qby" }, "— " + q.by + " · ", link(q.item.link, q.item.source + " ↗")))));
}

function alsoList(s, except) {
  return el("ul", { class: "also" }, ...s.members.filter((m) => m !== except).map((m) => byId.get(m)).map((it) =>
    el("li", {}, el("span", { class: "asrc", text: ago(it.ms) + " · " + it.source }), link(it.link, it.title))));
}

// --------------------------------------------------------------- government panel
function govPanel() {
  const rows = data.gov_panel || [];
  if (!rows.length) return [];
  return [el("section", { class: "govpanel" },
    el("div", { class: "shead" }, el("span", { class: "sk", text: "TODAY IN GOVERNMENT" })),
    ...rows.map((g) => {
      const it = g.item && byId.get(g.item.id);
      return el("div", { class: "gline" },
        el("span", { class: "gl", text: g.label }),
        it ? el("button", { class: "gi", onclick: () => openItem(it) }, it.title, el("span", { class: "ga", text: ago(it.ms) }))
          : el("span", { class: "none", text: g.item ? g.item.title : "nothing recent" }),
        g.watch ? link(g.watch, "WATCH ↗", "gw") : el("span"));
    }))];
}

// --------------------------------------------------------------- scores
function vs(g) { return (g.home ? "v " : "@ ") + g.opp + (g.comp ? " (" + g.comp + ")" : ""); }
function score(g) { return (g.us || "0") + "–" + (g.them || "0"); }
function result(g) {
  if (g.winner === true) return "W";
  if (g.us !== "" && g.us === g.them) return "D";
  return g.winner === false ? "L" : "";
}
function teamLine(t) {
  const lines = [el("span", { class: "name", text: t.short })];
  if (t.live) {
    lines.push(el("span", { class: "live", text: "LIVE " + score(t.live) + " " + vs(t.live) + " · " + t.live.detail }));
  } else if (t.last) {
    const r = result(t.last);
    lines.push(el("span", { class: "last" }, r ? el("span", { class: "res " + r, text: r + " " }) : null,
      score(t.last) + " " + vs(t.last) + " · " + fmtDay.format(new Date(Date.parse(t.last.at)))));
  } else {
    lines.push(el("span", { class: "last", text: t.error ? "schedule unavailable" : "no recent result" }));
  }
  lines.push(el("span", { class: "next", text: t.next ? "Next " + when(Date.parse(t.next.at)) + " " + vs(t.next) : "No game scheduled" }));
  return el("div", { class: "team" }, ...lines);
}
function scoreboard() {
  const teams = data.teams || [];
  return teams.length ? [el("section", { class: "scores board" }, ...teams.map(teamLine))] : [];
}

// --------------------------------------------------------------- live (one player, docked as a mini-player elsewhere)
function liveView() {
  const vids = data.video || [];
  const groups = [];
  for (const v of vids) {
    let g = groups.find((x) => x.name === v.group);
    if (!g) groups.push((g = { name: v.group, items: [] }));
    g.items.push(v);
  }
  return [
    el("div", { class: "stage", id: "stage" }, playing ? null : el("div", { class: "stage-empty", text: "Pick a channel. It keeps playing in a mini-player while you read the other tabs." })),
    ...groups.map((g) => el("section", { class: "cgroup" },
      el("div", { class: "shead" }, el("span", { class: "sk", text: g.name.toUpperCase() })),
      el("div", { class: "chips" }, ...g.items.map((v) => v.link
        ? el("a", { class: "chip out", href: v.link, target: "_blank", rel: "noopener" }, v.name, el("span", { class: "note", text: "opens site ↗" }))
        : el("button", { class: "chip", "aria-pressed": String(playing && v.id === channel), onclick: () => play(v.id) },
            v.name, v.note ? el("span", { class: "note", text: v.note }) : null))))),
    el("p", { class: "fine", text: "Official YouTube live streams, embedded. If a channel isn't live, YouTube shows its latest video or an offline card." }),
  ];
}

function play(id) {
  channel = id;
  playing = true;
  store.set(KEY.channel, id);
  if (tab !== "live") go("live"); else render();
}

function renderPlayer() {
  const p = $("player");
  const v = (data && data.video || []).find((x) => x.id === channel && x.channel_id);
  if (!playing || !v) {
    p.hidden = true;
    $("frame").replaceChildren();
    document.body.classList.remove("has-mini", "has-stage");
    return;
  }
  p.hidden = false;
  const docked = tab !== "live";
  p.classList.toggle("mini", docked);
  document.body.classList.toggle("has-mini", docked);
  document.body.classList.toggle("has-stage", !docked);
  $("pname").textContent = v.name;
  $("pyt").href = "https://www.youtube.com/channel/" + v.channel_id + "/live";
  const existing = $("frame").querySelector("iframe");
  if (!existing || existing.dataset.channel !== v.channel_id) {
    $("frame").replaceChildren(el("iframe", {
      src: "https://www.youtube.com/embed/live_stream?channel=" + encodeURIComponent(v.channel_id) + "&autoplay=1&mute=1&playsinline=1",
      title: v.name + " live", "data-channel": v.channel_id,
      allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: true,
      referrerpolicy: "strict-origin-when-cross-origin",
    }));
  }
}
$("pclose").addEventListener("click", () => { playing = false; render(); });
$("pname").addEventListener("click", () => go("live"));

// --------------------------------------------------------------- source health (sheet)
function failingSources() {
  return data.sources.filter((s) => {
    const ok = s.last_success ? Date.parse(s.last_success) : null;
    return Boolean(s.last_error) || !ok || Date.now() - ok > Math.max(3 * s.poll, 60) * 60000;
  });
}

function healthTable() {
  const bad = new Set(failingSources().map((s) => s.id));
  const rows = data.sources.slice().sort((a, b) => bad.has(b.id) - bad.has(a.id)).map((s) => {
    const ok = s.last_success ? Date.parse(s.last_success) : null;
    const failing = bad.has(s.id);
    return el("tr", {},
      el("td", {}, s.short || s.name, s.robots === "subscription" ? el("span", { class: "sub", text: " · sub" }) : null),
      el("td", { class: "desk " + s.desk, text: s.desk }),
      el("td", { class: "num", text: String(s.items) }),
      el("td", { text: ok ? ago(ok) : "never", title: ok ? exact(ok) : "" }),
      el("td", { class: failing ? "err" : "ok", text: s.last_error || (failing ? "stale" : "ok") }));
  });
  for (const t of (data.teams || []).filter((t) => t.error)) {
    rows.unshift(el("tr", {}, el("td", { text: t.name + " schedule" }), el("td", { class: "desk SPORTS", text: "SPORTS" }), el("td", { text: "–" }), el("td", { text: "–" }), el("td", { class: "err", text: t.error })));
  }
  return el("div", { class: "tablewrap" }, el("table", { class: "health" },
    el("thead", {}, el("tr", {}, ...["Source", "Desk", "Items", "Last ok", "Status"].map((h) => el("th", { text: h })))),
    el("tbody", {}, ...rows)));
}

function openHealth() {
  const bad = failingSources().length;
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "Sources" }),
    el("p", { class: "sdesc", text: data.sources.length + " sources · " + (bad ? bad + " down" : "all ok") + " · feed as of " + exact(Date.parse(data.generated_at)) }),
    healthTable(),
  ], "Sources");
}
$("status-btn").addEventListener("click", () => { if (data) openHealth(); });

// --------------------------------------------------------------- settings (sheet)
function openSettings() {
  const sizeRow = el("div", { class: "segmini" }, ...SIZES.map(([v, label]) => el("button", {
    "aria-pressed": String(prefs.size === v),
    onclick: (e) => { prefs.size = v; savePrefs(); applySize(); [...e.currentTarget.parentNode.children].forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); },
  }, label)));
  const toggle = (label, keyName) => el("label", { class: "trow" },
    el("span", { text: label }),
    el("input", { type: "checkbox", id: "pref-" + keyName, checked: prefs[keyName] ? true : null,
      onchange: (e) => { prefs[keyName] = e.target.checked; savePrefs(); render(); } }));
  const words = el("input", { type: "text", id: "pref-words", class: "tin", value: prefs.mutedWords, placeholder: "e.g. NCIS, Grand Theft Auto, Kardashian",
    onchange: (e) => { prefs.mutedWords = e.target.value; savePrefs(); render(); } });
  const srcs = (data ? data.sources : []).filter((s) => !["SYSTEM"].includes(s.desk));
  const srcList = el("div", { class: "srclist" }, ...srcs.map((s) => el("label", { class: "trow" },
    el("span", {}, s.name, el("span", { class: "dk desk " + s.desk, text: " " + s.desk })),
    el("input", { type: "checkbox", id: "src-" + s.id, checked: prefs.mutedSources.includes(s.id) ? null : true,
      onchange: (e) => {
        prefs.mutedSources = prefs.mutedSources.filter((x) => x !== s.id);
        if (!e.target.checked) prefs.mutedSources.push(s.id);
        savePrefs(); render();
      } }))));
  const savedList = saved.length
    ? el("ol", { class: "savedlist" }, ...saved.map((x) => el("li", {},
        link(x.link, x.title),
        el("span", { class: "asrc", text: x.source + " · " + fmtDate.format(new Date(x.ms)) }),
        el("button", { class: "unsave", text: "Remove", onclick: (e) => { saved = saved.filter((y) => y.id !== x.id); saveSaved(); e.currentTarget.parentNode.remove(); } }))))
    : el("p", { class: "sdesc", text: "Nothing saved yet. Use ☆ Save on any item." });
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "Settings" }),
    el("div", { class: "shead" }, el("span", { class: "sk", text: "TEXT SIZE" })),
    sizeRow,
    el("p", { class: "fine", text: "“iPhone” follows Settings › Display & Brightness › Text Size." }),
    el("div", { class: "shead" }, el("span", { class: "sk", text: "DISPLAY" })),
    toggle("World clocks on Today", "clocks"),
    toggle("Desks open on new items only", "newOnly"),
    el("div", { class: "shead" }, el("span", { class: "sk", text: "SAVED" })),
    savedList,
    el("div", { class: "shead" }, el("span", { class: "sk", text: "MUTE WORDS" })),
    words,
    el("p", { class: "fine", text: "Comma-separated. Items whose headline or description contains one are hidden everywhere." }),
    el("div", { class: "shead" }, el("span", { class: "sk", text: "SOURCES SHOWN" })),
    srcList,
    el("button", { class: "sbtn wide", text: "Source health ›", onclick: openHealth }),
    el("p", { class: "fine", text: "Settings and saved items stay on this device." }),
  ], "Settings");
}
$("settings-btn").addEventListener("click", openSettings);

// --------------------------------------------------------------- visit tracking
function markVisit() { store.set(KEY.visit, Date.now()); }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    markVisit();
  } else {
    prevVisit = Number(store.get(KEY.visit)) || prevVisit;
    for (const k in shown) delete shown[k];
    load(true);
  }
});
window.addEventListener("pagehide", markVisit);

// --------------------------------------------------------------- boot
// Sticky elements sit under the top bar, whose height depends on the text size.
const setTopH = () => document.documentElement.style.setProperty("--toph", document.querySelector(".top").offsetHeight + "px");
if (window.ResizeObserver) new ResizeObserver(setTopH).observe(document.querySelector(".top"));
applySize();
setTopH();
document.body.dataset.tab = tab;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
loadCached().then(() => load(true));
setInterval(() => { if (document.visibilityState === "visible") load(false); }, REFRESH_MS);
setInterval(() => {
  if (!data) return;
  renderTop();
  const c = $("clocks");
  if (c) c.replaceWith(clocks());
}, 30000);
