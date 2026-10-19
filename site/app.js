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
const SEGMENTS = {
  beacon: [["BEACON", "Beacon"], ["REGION", "Region"]],
  gov: [["GOV", "Government"], ["LAW", "Law & courts"]],
  world: [["WORLD", "World"], ["SPORTS", "Sports"]],
};
const DESK_NAME = { BEACON: "Beacon", REGION: "Region", GOV: "Gov", LAW: "Law", WORLD: "World", SPORTS: "Sports", SYSTEM: "System" };
// Region items are Beacon-desk items from regional outlets (sources.yaml `regional: true`).
const deskOf = (it) => (it.desk === "BEACON" && it.regional ? "REGION" : it.desk);
const KEY = {
  visit: "wire.lastVisit", tab: "wire.tab", seg: "wire.seg", channel: "wire.channel",
  prefs: "wire.prefs", saved: "wire.saved",
};
const REFRESH_MS = 5 * 60 * 1000;
const STALE_MIN = 45;
const FRESH_MIN = 30;
const PAGE = 30;
const LANG_NAME = { fr: "French", he: "Hebrew" };
const PERSPECTIVE = { left: "Left", "center-left": "Center-left", center: "Center", heterodox: "Independent", cross: "Left and right",
  "center-right": "Center-right", right: "Right", libertarian: "Libertarian", international: "International" };
const BUCKET = { left: "left", "center-left": "left", center: "center", heterodox: "center", cross: "center", "center-right": "right", right: "right", libertarian: "libertarian", international: "international" };
function personName(id) { const p = (data.people || []).find((x) => x.id === id); return p ? p.name : id; }
function byline(it) {
  // "Jeff Simms · Highlands Current"; a person's own feed already shows their name as the source.
  const names = (it.people || []).map(personName).filter((n) => n !== it.source);
  return names.length ? names.join(", ") + " · " + it.source : it.source;
}
const KIND_MARK = { VIDEO: "Video", DOC: "Document", QUOTE: "Quote", BLOTTER: "Police blotter", PODCAST: "Podcast", POST: "Post" };
const SIZES = [["system", "iPhone"], ["15", "S"], ["17", "M"], ["19", "L"], ["21", "XL"]];
const THEMES = [["auto", "Match iPhone"], ["dark", "Dark"], ["light", "Light"]];

// --------------------------------------------------------------- storage (never throws)
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, String(v)); } catch (e) { /* private mode */ } },
  json(k, d) { try { return JSON.parse(store.get(k)) ?? d; } catch (e) { return d; } },
};
const prefs = Object.assign({ size: "system", theme: "auto", speak: true, rate: 1, clocks: true, newOnly: false, mutedSources: [], mutedWords: "", pins: [], liveRegion: null, mutedPeople: [] }, store.json(KEY.prefs, {}));
const savePrefs = () => store.set(KEY.prefs, JSON.stringify(prefs));
let saved = store.json(KEY.saved, []);           // [{id, title, link, source, ms}]
const saveSaved = () => store.set(KEY.saved, JSON.stringify(saved.slice(0, 100)));

let data = null;
let pending = null;                                // fresh data held while you're scrolled down
let tab = TABS.some((t) => t.id === store.get(KEY.tab)) ? store.get(KEY.tab) : "today";
const seg = Object.assign({ beacon: "BEACON", gov: "GOV", world: "WORLD" }, store.json(KEY.seg, {}));
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
  if (isToday(ms)) return "Today";
  if (isYesterday(ms)) return "Yesterday";
  return fmtDate.format(new Date(ms));
}

// --------------------------------------------------------------- text size (follows the iPhone setting by default)
// Appearance follows the iPhone's Light/Dark setting unless locked in Settings.
function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === "auto") delete root.dataset.theme; else root.dataset.theme = prefs.theme;
  const dark = prefs.theme === "dark" || (prefs.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute("content", dark ? "#141619" : "#f5f3ee");
}
try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme); } catch (e) { /* old Safari */ }

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
  if (it.people && it.people.length && it.people.every((p) => (prefs.mutedPeople || []).includes(p)) && it.person_feed) return true;
  const words = mutedWordList();
  if (!words.length) return false;
  const t = (it.title + " " + (it.summary || "")).toLowerCase();
  return words.some((w) => t.includes(w));
}

// --------------------------------------------------------------- data
const DATA_CACHE = "wire-data";
let dataTag = null;   // build stamp of the data on screen (ETag)

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
    if (r && !data) { dataTag = r.headers.get("etag"); accept(await r.json()); }
  } catch (e) { /* no Cache API: the network load follows */ }
}

// A background refresh never moves the list under your thumb: if you're scrolled
// down, the new data waits behind a "N new" pill until you tap it.
async function load(force) {
  const btn = $("refresh-btn");
  btn.classList.add("spin");
  try {
    // Ask "anything new?" first: between builds the answer is an empty 304, so most opens
    // load nothing and the page is ready at once.
    const headers = data && dataTag ? { "If-None-Match": dataTag } : {};
    const r = await fetch("data.json", { cache: "no-store", credentials: "same-origin", redirect: "manual", headers });
    if (r.type === "opaqueredirect" || r.status === 401 || r.status === 403) throw new Error("signed out");
    if (r.status === 304) { renderTop(); return; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    dataTag = r.headers.get("etag");
    const json = await r.clone().json();
    try { (await caches.open(DATA_CACHE)).put("data.json", r); } catch (e) { /* ignore */ }
    if (!data || force || window.scrollY < 200) {
      pending = null;
      if (!updateReady) $("newpill").hidden = true;
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
      if (!data) showSignIn(e.message === "signed out");
    } else if (!data) {
      a.textContent = "couldn't load (" + e.message + ")";
    }
  } finally {
    btn.classList.remove("spin");
  }
}

$("newpill").addEventListener("click", () => {
  if (updateReady) { applyUpdate(true); return; }
  $("newpill").hidden = true;
  if (pending) accept(pending);
  pending = null;
  window.scrollTo({ top: 0, behavior: "smooth" });
});
$("refresh-btn").addEventListener("click", () => { checkVersion(); load(true); });

// The home-screen app keeps its own sign-in, separate from Safari's, so it can be signed
// out while Safari is signed in. Say so plainly instead of showing an empty page.
function showSignIn(signedOut) {
  $("view-today").hidden = false;
  $("view-today").replaceChildren(el("div", { class: "signin" },
    el("h2", { class: "stitle", text: signedOut ? "Sign in to The Wire" : "Can't reach The Wire" }),
    el("p", { class: "sdesc", text: signedOut
      ? "The home-screen app keeps its own sign-in, separate from Safari. Sign in once here with your email code and it stays signed in for a month."
      : "No connection right now. The Wire will load as soon as you're back online." }),
    el("a", { class: "sbtn primary", href: "./?reauth=" + Date.now(), text: signedOut ? "Sign in" : "Try again" }),
    el("p", { class: "fine", text: "Tip: when the code arrives, copy it from Mail and come straight back; the sign-in page stays open in the app." })));
}

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
  if (tab === "beacon") return deskOf(it) === seg.beacon;
  if (tab === "gov") return it.desk === seg.gov;
  if (tab === "world") return it.desk === seg.world;
  return false;
}

function newCount(desks) {
  if (!prevVisit || !data) return 0;
  return data.items.filter((it) => desks.includes(deskOf(it)) && !isSeen(it) && !folded.has(it.id) && !isMuted(it)).length;
}

function renderTabbar() {
  const counts = { beacon: newCount(["BEACON", "REGION"]), gov: newCount(["GOV", "LAW"]), world: newCount(["WORLD", "SPORTS"]) };
  const liveOn = playing;
  $("tabbar").replaceChildren(...TABS.map((t) => el("button", {
    class: "tabbtn", "aria-current": t.id === tab ? "page" : null, "data-tab": t.id,
    "aria-label": t.label + (counts[t.id] ? ", " + counts[t.id] + " new" : ""),
    onclick: () => go(t.id),
  },
    el("span", { class: "ico" + (t.id === "live" && liveOn ? " on" : ""), "aria-hidden": "true", text: t.icon }),
    el("span", { class: "tl", text: t.label }),
    counts[t.id] ? el("span", { class: "badge", "aria-hidden": "true" }) : null)));
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
  if (id === "beacon") v.replaceChildren(segBar("beacon"), ...deskView("beacon", seg.beacon));
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
      el("span", { class: "dot bad" }), bad.length + (bad.length > 1 ? " sources aren't updating" : " source isn't updating"), el("span", { class: "chev", text: "›" })));
  }
  const since = prevVisit && Date.now() - prevVisit < 30 * 3600e3 ? prevVisit : null;

  // 1. The day so far, and the briefing
  out.push(el("h1", { class: "yw", text: "Your Wire" }));
  out.push(el("div", { class: "ywsub" }, new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date()),
    since ? el("span", { class: "since", text: " · since you last looked at " + (isToday(since) ? fmtTime.format(new Date(since)) : exact(since)) }) : null));
  if (data.day_so_far && data.day_so_far.text) {
    out.push(el("div", { class: "daysofar" }, el("span", { class: "mlabel", text: "The day so far · machine-written · " + fmtTime.format(new Date(Date.parse(data.day_so_far.at))) }), el("p", { text: data.day_so_far.text })));
  }
  out.push(el("button", { class: "briefcard", onclick: openBrief },
    el("span", { class: "bc-ico", "aria-hidden": "true", text: "▶" }),
    el("span", { class: "bc-txt" },
      el("span", { class: "bc-t", text: "Brief me" }),
      el("span", { class: "bc-s", text: (since ? "What's new since " + (isToday(since) ? fmtTime.format(new Date(since)) : exact(since)) : "What matters today") + " · newscast or narrative" }))));

  // 2. Threads you follow
  out.push(...threadsSection());

  // 3. Top stories as units: Beacon first, then the ranked front page
  const cutoff = Date.now() - 48 * 3600000;
  const featured = new Set();
  const units = [];
  const beaconStories = (data.stories || []).filter((s) => storyOf.get(s.lead) === s && byId.get(s.lead) && deskOf(byId.get(s.lead)) === "BEACON" && Date.parse(s.last) >= cutoff && !isMuted(byId.get(s.lead)));
  const beaconItems = data.items.filter((it) => deskOf(it) === "BEACON" && !it.alert && it.kind !== "BLOTTER" && it.ms >= cutoff && !isMuted(it) && !storyOf.has(it.id) && !folded.has(it.id)
    && (it.machine_summary || it.agenda || (it.event_at && Date.parse(it.event_at) > Date.now() - 3600e3)));
  for (const s of beaconStories.slice(0, 1)) { units.push(unit(s)); featured.add(s.lead); }
  for (const it of beaconItems.slice(0, 2 - units.length)) { units.push(itemCard(it)); featured.add(it.id); }
  const front = (data.stories || []).filter((s) => storyOf.get(s.lead) === s && !featured.has(s.lead) && !isMuted(byId.get(s.lead)) && byId.get(s.lead).desk !== "SPORTS");
  for (const s of front.slice(0, 5)) { units.push(unit(s)); featured.add(s.lead); }
  if (units.length) {
    out.push(sectionHead("Top stories"));
    out.push(...units.filter(Boolean));
  }

  // 4. People, ahead, scores, edition
  const following = followingItems(5);
  if (following.length) {
    out.push(sectionHead("From people you follow", null, () => openPeople(), "People"));
    out.push(el("ol", { class: "list" }, ...following.map((it) => row(it, { desk: true }))));
  }
  const ahead = aheadBlock();
  if (ahead) out.push(ahead);
  const teams = (data.teams || []).filter((t) => t.live || (t.last && Date.now() - Date.parse(t.last.at) < 3 * 86400000));
  if (teams.length) {
    out.push(sectionHead("Scores", null, () => { seg.world = "SPORTS"; store.set(KEY.seg, JSON.stringify(seg)); go("world"); }, "Sports"));
    out.push(el("div", { class: "scores" }, ...teams.map(teamLine)));
  }
  if (data.front_page_url) {
    out.push(el("a", { class: "edition", href: data.front_page_url, target: "_blank", rel: "noopener" },
      el("span", { class: "ed-k", text: new Date().getHours() < 15 ? "Morning Edition" : new Date().getHours() >= 18 ? "Evening Edition" : "The Edition" }),
      el("span", { class: "ed-t", text: "Your written front page for " + new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(new Date()) }),
      el("span", { class: "ed-a", text: "›" })));
  }

  // 5. Everything else, folded: the rest of Beacon, the last hour, the rest of the front page
  const rest = [];
  const seenIds = new Set(featured);
  for (const it of data.items.filter((it) => deskOf(it) === "BEACON" && !it.alert && it.kind !== "BLOTTER" && it.ms >= cutoff && !isMuted(it) && !featured.has(it.id) && !folded.has(it.id)).slice(0, 6)) { rest.push(it); seenIds.add(it.id); }
  for (const s of front.slice(5, 14)) { const it = byId.get(s.lead); if (it && !seenIds.has(it.id)) { rest.push(it); seenIds.add(it.id); } }
  for (const it of data.items.filter((it) => it.fast && it.ms >= Date.now() - 3600000 && !it.alert && !folded.has(it.id) && !isMuted(it) && (!it.quiet || storyOf.has(it.id)) && !seenIds.has(it.id)).slice(0, 6)) { rest.push(it); seenIds.add(it.id); }
  if (rest.length) {
    const det = el("details", { class: "rest" }, el("summary", {}, el("span", { text: "Everything else · " + rest.length + " headlines" }), el("span", { class: "chev", text: "▾" })),
      el("ol", { class: "list" }, ...rest.map((it) => row(it, { desk: true }))));
    out.push(det);
  }

  out.push(el("div", { class: "caughtup" },
    el("div", { class: "cu-k", text: "That's The Wire" }),
    el("div", { class: "cu-t", text: "You're current as of " + exact(Date.parse(data.generated_at)) + ". More on each desk:" }),
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
    action ? el("button", { class: "sa", onclick: action, text: actionLabel }) : null);
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
    el("div", { class: "lbl", text: "Ahead" }),
    ...rows.map((m) => el("div", { class: "arow" + (m.live ? " live" : "") },
      el("span", { class: "aw", text: m.live ? "Live" : (isToday(m.ms) ? "" : "Tmrw ") + fmtTime.format(new Date(m.ms)) }),
      m.item
        ? el("button", { class: "at", onclick: () => openItem(m.item) }, m.label, m.n ? el("span", { class: "an", text: " · " + m.n + " items" }) : null)
        : el("span", { class: "at", text: m.label }),
      watchable(m) ? el("button", { class: "watch", text: "▶ Watch", onclick: () => play(meetingFeed.id) }) : null)));
}

function clocks() {
  const CLOCKS = [["Beacon", "America/New_York", true], ["Paris", "Europe/Paris", false], ["Tel Aviv", "Asia/Jerusalem", false]];
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
  // Quiet (corroborating) sources show only as part of a story, never as lone rows.
  // Story-first: the tab opens with its own written stories (multi-outlet stories, then
  // single local items with a machine summary), and the headline list follows.
  const cutoff = Date.now() - 48 * 3600e3;
  const leadStories = desk === "SPORTS" ? [] : (data.stories || [])
    .filter((s) => storyOf.get(s.lead) === s && byId.get(s.lead) && deskOf(byId.get(s.lead)) === desk && Date.parse(s.last) >= cutoff && !isMuted(byId.get(s.lead)))
    .filter((s) => s.what || s.card || s.summary).slice(0, 3);
  const leadItems = ["BEACON", "GOV", "LAW"].includes(desk) ? data.items
    .filter((it) => deskOf(it) === desk && it.machine_summary && !storyOf.has(it.id) && !folded.has(it.id) && it.ms >= cutoff && !isMuted(it))
    .slice(0, Math.max(0, 3 - leadStories.length)) : [];
  const featured = new Set([...leadStories.map((s) => s.lead), ...leadItems.map((it) => it.id)]);
  const all = data.items.filter((it) => deskOf(it) === desk && !folded.has(it.id) && !it.alert && !isMuted(it) && (!it.quiet || storyOf.has(it.id)) && !featured.has(it.id));
  const fresh = prevVisit ? all.filter((it) => !isSeen(it)).length : 0;
  const list = prefs.newOnly && fresh ? all.filter((it) => !isSeen(it)) : all;
  const out = [];
  if (featured.size) {
    out.push(sectionHead("Top stories"));
    out.push(...leadStories.map((st) => unit(st)).filter(Boolean), ...leadItems.map(itemCard));
    out.push(sectionHead("Everything else"));
  }
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
      ol.append(el("li", { class: "divider", text: "Since you last opened" }));
      dividerPlaced = true;
    }
    ol.append(row(it, { desk: false }));
  }
  if (!list.length) ol.append(el("li", { class: "empty", text: "Nothing on this desk yet." }));
  out.push(ol);
  if (list.length > shown[key]) {
    out.push(el("button", { class: "more-btn", text: "Show " + Math.min(PAGE, list.length - shown[key]) + " more",
      onclick: () => { const y = window.scrollY; shown[key] += PAGE; renderView(tab); window.scrollTo(0, y); } }));
  } else if (list.length) {
    out.push(el("div", { class: "endline", text: "That's everything from the last 7 days." }));
  }
  return out;
}

// --------------------------------------------------------------- rows (tap opens the detail sheet)
function row(it, opt = {}) {
  const st = storyOf.get(it.id);
  const watch = it.watch && it.watch.length;
  const headline = el("span", { class: "headline", text: it.title });
  const tags = (it.watch_terms && it.watch_terms.length ? it.watch_terms : it.watch || []).slice(0, 2);
  const meta = el("span", { class: "meta" },
    el("span", { class: "t" + (isFresh(it.ms) && !isSeen(it) ? " fresh" : ""), text: ago(it.ms) }),
    el("span", { class: "src", text: byline(it) }),
    it.translated ? el("span", { class: "kind", text: "Translated from " + (LANG_NAME[it.lang] || it.lang) }) : null,
    opt.desk ? el("span", { class: "dk", style: "--c: var(--" + deskOf(it).toLowerCase() + ")", text: DESK_NAME[deskOf(it)] }) : null,
    it.kind ? el("span", { class: "kind", text: KIND_MARK[it.kind] || it.kind }) : null,
    st && st.developing ? el("span", { class: "dev", text: "Developing" }) : null,
    st ? el("span", { class: "plus", text: st.sources + " sources" }) : null,
    ...tags.map((tg) => el("span", { class: "tag", text: String(tg) })));
  return el("li", { class: "row" + (watch ? " watch" : "") + (isSeen(it) ? " seen" : "") },
    el("button", { class: "head", onclick: () => openItem(it) }, headline, meta));
}

// The unit (BRIEF.md): one story told in place. Label, headline, a paragraph, a quote with
// its source, the latest development, why it's here, and Follow. Readable without a tap;
// the tap opens the thread.
function whyHere(s, lead) {
  if (s.lead_note) return s.lead_note;
  const bits = [];
  if (s.followed) bits.push("you follow this thread");
  if (deskOf(lead) === "BEACON") bits.push("Beacon");
  if (lead.watch_terms && lead.watch_terms.length) bits.push("matches your watchlist: " + lead.watch_terms.join(", "));
  if (s.developing) bits.push(s.sources + " outlets, " + (s.reports || s.sources) + " reports in a day");
  else if (s.sources > 1) bits.push(s.sources + " outlets");
  return bits.join(" · ");
}

function unit(s, opt = {}) {
  const lead = byId.get(s.lead);
  if (!lead) return null;
  const th = threadOf(s);
  const q = storyQuotes(s)[0];
  const body = s.what || s.card || s.summary;
  const outlets = [...new Set(s.members.map((m) => byId.get(m)).filter(Boolean).map((m) => m.source))];
  const open = () => openItem(lead);
  return el("article", { class: "unit" + (isSeen(lead) ? " seen" : "") },
    el("div", { class: "lbl" },
      s.developing ? el("span", { class: "dev", text: "Developing" }) : null,
      el("span", { class: "dk", style: "--c: var(--" + deskOf(lead).toLowerCase() + ")", text: DESK_NAME[deskOf(lead)] }),
      th ? el("span", { text: th.kind }) : null,
      s.sources > 1 ? el("span", { text: s.sources + " outlets" + (s.reports > s.sources ? " · " + s.reports + " reports" : "") }) : el("span", { text: lead.source }),
      el("span", { class: "t" + (isFresh(Date.parse(s.last)) && !isSeen(lead) ? " fresh" : ""), text: ago(Date.parse(s.last)) + (ago(Date.parse(s.last)) === "now" ? "" : " ago") })),
    el("h3", {}, el("button", { class: "uhead", onclick: open, text: lead.title })),
    body ? el("p", { class: "ubody", text: body }) : (lead.summary ? el("p", { class: "ubody desc", text: lead.summary }) : null),
    q ? el("blockquote", { class: "uq" }, el("p", { text: "“" + q.text + "”" }), el("cite", {}, q.by + " · ", link(q.item.link, q.item.source))) : null,
    s.latest && body !== s.latest ? el("div", { class: "latest" }, el("span", { class: "mlabel", text: "Latest" + (s.latest_at ? " · " + (isToday(Date.parse(s.latest_at)) ? fmtTime.format(new Date(Date.parse(s.latest_at))) : exact(Date.parse(s.latest_at))) : "") }), el("p", { text: s.latest })) : null,
    whyHere(s, lead) ? el("div", { class: "why" }, el("b", { text: "Why it's here: " }), whyHere(s, lead)) : null,
    el("div", { class: "uacts" },
      s.thread ? followButton(s, true) : null,
      el("button", { class: "sbtn", text: th ? "Open thread" : "Open story", onclick: open }),
      el("span", { class: "srcs", text: outlets.slice(0, 5).join(" · ") + (outlets.length > 5 ? " · +" + (outlets.length - 5) : "") })));
}

// A single report written up (a council agenda, county minutes, a DEC rule) in the same shape.
function itemCard(it) {
  const body = it.machine_summary || it.summary;
  const q = (it.quotes || [])[0];
  const docN = it.agenda ? it.agenda.length + " agenda items" : null;
  return el("article", { class: "unit" + (isSeen(it) ? " seen" : "") },
    el("div", { class: "lbl" },
      el("span", { class: "dk", style: "--c: var(--" + deskOf(it).toLowerCase() + ")", text: DESK_NAME[deskOf(it)] }),
      el("span", { text: byline(it) }),
      it.event_at ? el("span", { text: exact(Date.parse(it.event_at)) }) : el("span", { class: "t" + (isFresh(it.ms) && !isSeen(it) ? " fresh" : ""), text: ago(it.ms) + (ago(it.ms) === "now" ? "" : " ago") })),
    el("h3", {}, el("button", { class: "uhead", onclick: () => openItem(it), text: it.title })),
    body ? el("p", { class: "ubody" + (it.machine_summary ? "" : " desc"), text: body }) : null,
    q ? el("blockquote", { class: "uq" }, el("p", { text: "“" + q.text + "”" }), el("cite", {}, q.by + " · ", link(it.link, it.source))) : null,
    it.agenda && it.agenda.length ? el("div", { class: "udoc" }, el("span", { class: "mlabel", text: "The document · " + docN }),
      el("ol", {}, ...it.agenda.filter((a) => a.flags && a.flags.length).slice(0, 4).map((a) => el("li", {}, a.text.slice(0, 120), ...a.flags.map((f) => el("span", { class: "aflag", text: f })))))) : null,
    el("div", { class: "why" }, el("b", { text: "Why it's here: " }), deskOf(it) === "BEACON" ? "Beacon" + (it.kind === "DOC" || it.agenda ? " · the document" : "") : DESK_NAME[deskOf(it)] + (it.watch_terms && it.watch_terms.length ? " · matches your watchlist: " + it.watch_terms.join(", ") : "")),
    el("div", { class: "uacts" }, el("button", { class: "sbtn", text: it.agenda ? "Open the agenda" : "Open", onclick: () => openItem(it) })));
}

// --------------------------------------------------------------- Brief me (written on demand, read aloud)
let speechQueue = [];
function stopSpeech() { try { speechSynthesis.cancel(); } catch (e) { /* no speech */ } speechQueue = []; }
function bestVoice() {
  try {
    const vs = speechSynthesis.getVoices().filter((v) => /^en(-|_)US/i.test(v.lang));
    const rank = (v) => (/premium/i.test(v.name) ? 3 : /enhanced/i.test(v.name) ? 2 : /^(Ava|Evan|Zoe|Nathan|Samantha|Allison|Tom)/.test(v.name) ? 1 : 0);
    return vs.sort((a, b) => rank(b) - rank(a))[0] || null;
  } catch (e) { return null; }
}
function speak(paragraphs, btn) {
  if (!("speechSynthesis" in window)) return;
  stopSpeech();
  const voice = bestVoice();
  speechQueue = paragraphs.map((text, i) => {
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = prefs.rate || 1;
    u.onend = () => { if (i === paragraphs.length - 1 && btn) btn.textContent = "▶ Listen"; };
    return u;
  });
  for (const u of speechQueue) speechSynthesis.speak(u);
  if (btn) btn.textContent = "■ Stop";
}

// Categories: All, Local, State, National, World, then city beats (from brief.json).
let briefBeats = [["all", "All"], ["local", "Local"], ["state", "State"], ["national", "National"], ["world", "World"], ["paris", "Paris"], ["israel", "Israel"], ["following", "Following"]];
let briefSeq = 0;
function beatPills(current, onPick) {
  return el("div", { class: "pills bpills", role: "tablist", "aria-label": "Briefing category" }, ...briefBeats.map(([id, label]) => el("button", {
    role: "tab", "aria-selected": String(id === current), text: label,
    onclick: (e) => { [...e.currentTarget.parentNode.children].forEach((x) => x.setAttribute("aria-selected", String(x === e.currentTarget))); onPick(id); },
  })));
}
const BRIEF_STYLES = [["newscast", "Newscast", "About 90 seconds, story by story, for listening"], ["narrative", "Narrative", "The story of the day in connected paragraphs, about 3 minutes"]];

// Brief me opens a chooser first: nothing is written (and no free AI allowance is spent)
// until you pick a category and a style and tap Write.
function openBrief() {
  let beat = briefBeats.some(([id]) => id === prefs.briefBeat) ? prefs.briefBeat : "all";
  let style = prefs.briefStyle === "narrative" ? "narrative" : "newscast";
  const desc = el("p", { class: "fine", text: BRIEF_STYLES.find((x) => x[0] === style)[2] });
  const styleRow = el("div", { class: "segmini two" }, ...BRIEF_STYLES.map(([id, label, d]) => el("button", {
    "aria-pressed": String(id === style), text: label,
    onclick: (e) => { style = id; desc.textContent = d; [...e.currentTarget.parentNode.children].forEach((x) => x.setAttribute("aria-pressed", String(x === e.currentTarget))); },
  })));
  openSheet([
    el("div", { class: "smeta" }, el("span", { text: "Brief me" })),
    el("h2", { id: "sheet-title", class: "stitle", text: "What do you want to hear?" }),
    el("h3", { class: "sh3", text: "Category" }),
    beatPills(beat, (id) => { beat = id; }),
    el("h3", { class: "sh3", text: "Style" }),
    styleRow, desc,
    el("div", { class: "sactions" }, el("button", { class: "sbtn primary wide", text: "Write my briefing", onclick: () => {
      prefs.briefBeat = beat; prefs.briefStyle = style; savePrefs(); writeBrief(beat, style);
    } })),
    el("p", { class: "fine", text: "Nothing is written until you tap. The same briefing asked for again within 15 minutes comes back instantly at no cost." }),
  ], "Brief me");
}

async function writeBrief(beat, style) {
  beat = beat || "all";
  style = style || "newscast";
  const seq = ++briefSeq;
  // Safari only lets a page talk after a tap: start (silent) speech inside this tap.
  try { if (prefs.speak && "speechSynthesis" in window) { stopSpeech(); speechSynthesis.speak(new SpeechSynthesisUtterance(" ")); } } catch (e) { /* ignore */ }
  const status = el("p", { class: "sdesc", text: "Writing your briefing…" });
  const label = (briefBeats.find(([id]) => id === beat) || [beat, beat])[1] + " · " + (style === "narrative" ? "Narrative" : "Newscast");
  const head = [el("div", { class: "smeta" }, el("span", { text: "Brief me · " + label })), el("h2", { id: "sheet-title", class: "stitle", text: "Your briefing" }), status];
  if ($("sheet").hidden) openSheet(head, "Your briefing"); else $("sheet-body").replaceChildren(...head);
  const since = prevVisit && Date.now() - prevVisit < 30 * 3600e3 ? prevVisit : Date.now() - 12 * 3600e3;
  let b;
  try {
    const r = await fetch("brief?since=" + Math.round(since) + (beat === "all" ? "" : "&beat=" + encodeURIComponent(beat)) + (style === "narrative" ? "&style=narrative" : ""), { credentials: "same-origin", redirect: "manual" });
    if (r.type === "opaqueredirect" || r.status === 401 || r.status === 403) throw new Error("You're signed out. Reload the page to sign in.");
    b = await r.json();
    if (!r.ok) throw new Error(b.error || "HTTP " + r.status);
  } catch (e) {
    if (seq === briefSeq) status.textContent = "Couldn't write the briefing: " + e.message;
    return;
  }
  if (seq !== briefSeq || $("sheet").hidden) return;   // another category was chosen, or the sheet closed
  if (b.beats && b.beats.length) briefBeats = b.beats.map((x) => [x.id, x.label]);
  const texts = b.paragraphs.map((p) => p.text);
  const listen = el("button", { class: "sbtn primary", text: "▶ Listen" });
  listen.onclick = () => {
    if (speechQueue.length && speechSynthesis.speaking) { stopSpeech(); listen.textContent = "▶ Listen"; } else speak(texts, listen);
  };
  const rate = el("div", { class: "segmini three rate" }, ...[[0.9, "Slower"], [1, "Normal"], [1.15, "Faster"]].map(([v, label]) => el("button", {
    "aria-pressed": String((prefs.rate || 1) === v),
    onclick: (e) => { prefs.rate = v; savePrefs(); [...e.currentTarget.parentNode.children].forEach((x) => x.setAttribute("aria-pressed", String(x === e.currentTarget))); if (speechSynthesis.speaking) speak(texts, listen); },
  }, label)));
  const byIdLocal = Object.fromEntries((b.sources || []).map((s) => [s.id, s]));
  $("sheet-body").replaceChildren(...[
    el("div", { class: "smeta" }, el("span", { text: "Machine-written from The Wire's sources" }), el("span", { text: "feed as of " + fmtTime.format(new Date(Date.parse(b.as_of))) })),
    el("h2", { id: "sheet-title", class: "stitle", text: style === "narrative" ? "The story of the day" : b.mode === "new" ? "What's new" : "Where things stand" }),
    el("p", { class: "fine" }, label + " · ", el("button", { class: "linkbtn", text: "Change", onclick: openBrief })),
    el("div", { class: "sactions" }, listen),
    rate,
    el("div", { class: "brief" + (style === "narrative" ? " narrative" : "") }, ...b.paragraphs.map((p) => el("p", {}, p.text,
      ...(p.refs || []).map((id) => byIdLocal[id]).filter(Boolean).map((s) => el("a", { class: "bref", href: s.link, target: "_blank", rel: "noopener", text: s.outlets > 1 ? s.source + " +" + (s.outlets - 1) : s.source }))))),
    b.notice ? el("p", { class: "fine", text: b.notice }) : null,
    b.dropped ? el("p", { class: "fine", text: (b.dropped === 1 ? "One line was left out because it couldn't" : b.dropped + " lines were left out because they couldn't") + " be traced to a source." }) : null,
    el("p", { class: "fine", text: "Reading stops if the screen locks. Voice: download an Enhanced or Premium English voice in Settings › Accessibility › Spoken Content › Voices for the best sound." }),
  ].filter(Boolean));
  const sel = document.querySelector(".bpills [aria-selected='true']");
  if (sel) sel.scrollIntoView({ inline: "center", block: "nearest" });
  if (prefs.speak) speak(texts, listen);
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
  stopSpeech();
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

// A story page: the synthesis first, then what changed, the figures as each outlet reported
// them, a timeline, quotes and every source. Reporting is machine-written from the
// outlets; anything labeled analysis is separate.
function openStory(st, it) {
  const th = threadOf(st);
  if (th) return openThread(th, it);
  const lead = byId.get(st.lead) || it;
  const isSaved = saved.some((x) => x.id === lead.id);
  const saveBtn = el("button", { class: "sbtn", text: isSaved ? "★ Saved" : "☆ Save" });
  saveBtn.onclick = () => {
    if (saved.some((x) => x.id === lead.id)) saved = saved.filter((x) => x.id !== lead.id);
    else saved.unshift({ id: lead.id, title: lead.title, link: lead.link, source: lead.source, ms: lead.ms });
    saveSaved();
    saveBtn.textContent = saved.some((x) => x.id === lead.id) ? "★ Saved" : "☆ Save";
  };
  const members = st.members.map((m) => byId.get(m)).filter(Boolean);
  const fresh = prevVisit ? members.filter((m) => m.ms > prevVisit && m.id !== lead.id) : [];
  const sec = (title, ...kids) => el("section", { class: "ssec" }, el("h3", { class: "sh3", text: title }), ...kids);
  const when = (iso) => { const ms = Date.parse(iso); return isToday(ms) ? fmtTime.format(new Date(ms)) : exact(ms); };
  const nodes = [
    el("div", { class: "smeta" },
      st.developing ? el("span", { class: "dev", text: "Developing" }) : null,
      el("span", { class: "dk", style: "--c: var(--" + st.desk.toLowerCase() + ")", text: DESK_NAME[st.desk] || st.desk }),
      el("span", { text: st.sources + " outlets" + (st.reports > st.sources ? " · " + st.reports + " reports" : "") }),
      el("span", { text: "Updated " + ago(Date.parse(st.last)) + (ago(Date.parse(st.last)) === "now" ? "" : " ago") })),
    el("h2", { id: "sheet-title", class: "stitle", text: lead.title }),
    st.what || st.card || st.summary ? el("div", { class: "machine" },
      el("span", { class: "mlabel", text: "What happened · machine-written from " + st.sources + " outlets" + (st.written_at ? " · " + when(st.written_at) : "") }),
      el("p", { text: st.what || st.card || st.summary })) : null,
    st.lead_note ? el("p", { class: "leadnote" }, el("span", { class: "mlabel", text: "Why it's on the front page · analysis" }), el("span", { text: " " + st.lead_note })) : null,
    st.latest ? el("div", { class: "latest" }, el("span", { class: "mlabel", text: "Latest" + (st.latest_at ? " · " + when(st.latest_at) : "") }), el("p", { text: st.latest })) : null,
    fresh.length ? sec(fresh.length + (fresh.length === 1 ? " new report" : " new reports") + " since you last looked",
      el("ul", { class: "also" }, ...fresh.slice(0, 6).map((m) => el("li", {}, el("span", { class: "asrc", text: ago(m.ms) + " · " + m.source }), link(m.link, m.title))))) : null,
    st.figures && st.figures.length ? sec("Figures as reported",
      ...st.figures.map((f) => el("div", { class: "fig" }, el("span", { class: "figw", text: f.what }),
        el("ul", { class: "figl" }, ...f.reports.map((r) => el("li", {}, el("span", { class: "fign", text: r.text }), " ",
          el("span", { class: "asrc", text: r.source + " · " + when(r.t) }), " ", link(r.link, "↗")))))),
      el("p", { class: "fine", text: "Outlets' numbers, word for word. They may cover different periods or update through the day." })) : null,
    st.timeline && st.timeline.length ? sec("Timeline",
      el("ol", { class: "tl" }, ...st.timeline.map((t) => el("li", {}, el("span", { class: "tlt", text: when(t.t) }), el("span", { class: "tlb" }, link(t.link, t.title), el("span", { class: "asrc", text: " · " + t.source })))))) : null,
    st.views && st.views.length ? sec("Range of views",
      el("ul", { class: "views" }, ...st.views.map((v) => byId.get(v.id)).filter(Boolean).filter((it) => !isMuted(it)).map((it) => el("li", {},
        el("span", { class: "vlab", text: (PERSPECTIVE[it.perspective] || "") + " · " + byline(it) + (it.kind === "PODCAST" ? " · podcast" : "") }),
        link(it.link, it.title),
        it.summary ? el("span", { class: "vsum", text: it.summary.slice(0, 220) + (it.summary.length > 220 ? "…" : "") }) : null))),
      el("p", { class: "fine", text: "Opinion and analysis from people you follow, spread across perspectives. Their words, linked; not The Wire's." })) : null,
    quoteList(storyQuotes(st)),
    st.why ? el("div", { class: "why" }, el("span", { class: "mlabel", text: "Why it matters to you · analysis" }), el("p", { text: st.why })) : null,
    el("div", { class: "sactions" },
      link(lead.link, "Open " + lead.source + " ↗", "sbtn primary"),
      navigator.share ? el("button", { class: "sbtn", text: "Share", onclick: () => navigator.share({ title: lead.title, url: lead.link }).catch(() => {}) }) : null,
      saveBtn),
    sec("All coverage · " + st.sources + " outlets", alsoList(st, lead.id)),
  ];
  openSheet(nodes.filter(Boolean), lead.title);
}

function openItem(it) {
  const st = storyOf.get(it.id) || (data.stories || []).find((s) => s.members.includes(it.id) && storyOf.get(s.lead) === s);
  if (st) return openStory(st, it);
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
      el("span", { class: "dk", style: "--c: var(--" + deskOf(it).toLowerCase() + ")", text: DESK_NAME[deskOf(it)] }),
      el("span", { text: it.source }),
      el("span", { text: exact(it.ms) }),
      it.kind ? el("span", { class: "kind", text: KIND_MARK[it.kind] || it.kind }) : null),
    el("h2", { id: "sheet-title", class: "stitle", text: it.title }),
    it.translated ? el("p", { class: "orig" }, el("span", { class: "mlabel", text: "Machine-translated from " + (LANG_NAME[it.lang] || it.lang) + " · original" }),
      el("span", { dir: "auto", lang: it.lang, text: it.orig_title })) : null,
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
    st ? el("div", { class: "salso" }, el("h3", { class: "sh3", text: "Also covering this · " + (st.sources - 1) + (st.sources === 2 ? " outlet" : " outlets") }), alsoList(st, it.id)) : null,
  ];
  openSheet(nodes.filter(Boolean), it.title);
}

function agendaList(it) {
  const box = el("div", { class: "agenda" }, el("h3", { class: "sh3", text: it.agenda.length + " agenda items" }));
  let section = null;
  for (const a of it.agenda) {
    if (a.section && a.section !== section) {
      section = a.section;
      box.append(el("div", { class: "asec", text: section }));
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
    el("span", { class: "mlabel", text: "Machine summary · from " + n + (n === 1 ? " report" : " reports") }),
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
    el("span", { class: "qby" }, q.by + " · ", link(q.item.link, q.item.source)))));
}

function alsoList(s, except) {
  return el("ul", { class: "also" }, ...s.members.filter((m) => m !== except).map((m) => byId.get(m)).map((it) =>
    el("li", {}, el("span", { class: "asrc", text: ago(it.ms) + " · " + it.source + (it.translated ? " · translated from " + (LANG_NAME[it.lang] || it.lang) : "") }), link(it.link, it.title))));
}

// --------------------------------------------------------------- government panel
function govPanel() {
  const rows = data.gov_panel || [];
  if (!rows.length) return [];
  return [el("section", { class: "govpanel" },
    el("div", { class: "lbl", text: "Today in government" }),
    ...rows.map((g) => {
      const it = g.item && byId.get(g.item.id);
      return el("div", { class: "gline" },
        el("span", { class: "gl", text: g.label }),
        it ? el("button", { class: "gi", onclick: () => openItem(it) }, it.title, el("span", { class: "ga", text: ago(it.ms) }))
          : el("span", { class: "none", text: g.item ? g.item.title : "nothing recent" }),
        g.watch ? link(g.watch, "Watch ↗", "gw") : el("span"));
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
    lines.push(el("span", { class: "live", text: "Live " + score(t.live) + " " + vs(t.live) + " · " + t.live.detail }));
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
// Live: region pills, then a short list of channels as rows. Each region fits on one
// screen, so nothing long scrolls under the video. Starred channels form "Pinned".
function liveView() {
  const vids = data.video || [];
  const regions = [];
  if (prefs.pins.some((id) => vids.some((v) => v.id === id))) regions.push("Pinned");
  for (const v of vids) if (!regions.includes(v.group)) regions.push(v.group);
  let region = regions.includes(prefs.liveRegion) ? prefs.liveRegion : regions[0];
  const current = vids.find((v) => v.id === channel);
  if (!prefs.liveRegion && playing && current) region = current.group;
  const list = region === "Pinned" ? prefs.pins.map((id) => vids.find((v) => v.id === id)).filter(Boolean) : vids.filter((v) => v.group === region);
  const pills = el("div", { class: "pills", role: "tablist" }, ...regions.map((r) => el("button", {
    role: "tab", "aria-selected": String(r === region),
    onclick: () => { prefs.liveRegion = r; savePrefs(); renderView("live"); },
  }, r === "Pinned" ? "★ Pinned" : r)));
  const rows = list.map((v) => {
    const on = playing && v.id === channel;
    const pinned = prefs.pins.includes(v.id);
    const star = el("button", { class: "star" + (pinned ? " on" : ""), "aria-label": (pinned ? "Unpin " : "Pin ") + v.name, text: pinned ? "★" : "☆",
      onclick: (e) => { e.stopPropagation(); prefs.pins = pinned ? prefs.pins.filter((x) => x !== v.id) : [...prefs.pins, v.id]; savePrefs(); renderView("live"); } });
    const info = el("span", { class: "chi" },
      el("span", { class: "chn", text: v.name }),
      el("span", { class: "cht", text: on ? "Playing" : v.link ? "Opens their site" : (v.note || (v.audio ? "Live radio" : "Live stream")) }));
    return v.link
      ? el("div", { class: "chrow" }, el("a", { class: "chmain", href: v.link, target: "_blank", rel: "noopener" }, info, el("span", { class: "chgo out", "aria-hidden": "true", text: "↗" })), star)
      : el("div", { class: "chrow" + (on ? " on" : "") }, el("button", { class: "chmain", onclick: () => play(v.id) }, info, el("span", { class: "chgo", "aria-hidden": "true", text: on ? "■" : "▶" })), star);
  });
  return [
    el("div", { class: "stage", id: "stage" }, playing ? null : el("div", { class: "stage-empty", text: "Choose a channel below. It keeps playing in a small player while you read other tabs." })),
    pills,
    el("div", { class: "chlist" }, ...rows),
    el("p", { class: "fine", text: "Official streams only: the publishers' own YouTube channels, players and radio streams. Channels marked \"when live\" only carry events; between events YouTube says the video is unavailable." }),
  ];
}

function play(id) {
  channel = id;
  playing = true;
  store.set(KEY.channel, id);
  const v = (data.video || []).find((x) => x.id === id);
  if (v && prefs.liveRegion !== "Pinned") { prefs.liveRegion = v.group; savePrefs(); }
  if (tab !== "live") go("live"); else render();
}

function renderPlayer() {
  const p = $("player");
  const v = (data && data.video || []).find((x) => x.id === channel && (x.channel_id || x.audio || x.embed));
  if (!playing || !v) {
    p.hidden = true;
    $("frame").replaceChildren();
    document.body.classList.remove("has-mini", "has-stage");
    document.documentElement.classList.remove("stage-lock");
    return;
  }
  p.hidden = false;
  const docked = tab !== "live";
  p.classList.toggle("mini", docked);
  document.body.classList.toggle("has-mini", docked);
  document.body.classList.toggle("has-stage", !docked);
  // On the Live tab the video stays put and only the channel list scrolls beneath it.
  document.documentElement.classList.toggle("stage-lock", !docked);
  $("pname").textContent = v.name;
  p.classList.toggle("audio", Boolean(v.audio));
  $("pyt").href = v.site || (v.channel_id ? "https://www.youtube.com/channel/" + v.channel_id + "/live" : v.embed || v.audio);
  $("pyt").textContent = v.channel_id ? "YouTube ↗" : "Site ↗";
  $("psound").hidden = Boolean(v.embed || v.audio);   // radio has its own controls
  const key = v.channel_id || v.audio || v.embed;
  const existing = $("frame").firstElementChild;
  if (existing && existing.dataset.channel === key) return;
  if (v.audio) {
    // Official live radio stream, played by the browser's own audio player.
    const a = el("audio", { src: v.audio, controls: true, autoplay: true, preload: "none", "data-channel": key, "aria-label": v.name + " live" });
    $("frame").replaceChildren(a);
    a.play().catch(() => { /* Safari may need the Sound tap */ });
    return;
  }
  if (v.embed) {
    // The publisher's own player page (e.g. the State Assembly's Granicus player).
    $("frame").replaceChildren(el("iframe", { src: v.embed, title: v.name + " live", "data-channel": key,
      allow: "autoplay; encrypted-media; fullscreen", allowfullscreen: true, referrerpolicy: "strict-origin-when-cross-origin" }));
    return;
  }
  {
    $("frame").replaceChildren(el("iframe", {
      src: "https://www.youtube.com/embed/live_stream?channel=" + encodeURIComponent(v.channel_id) + "&autoplay=1&mute=0&playsinline=1&enablejsapi=1&origin=" + encodeURIComponent(location.origin),
      title: v.name + " live", "data-channel": v.channel_id,
      allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: true,
      referrerpolicy: "strict-origin-when-cross-origin",
    }));
  }
}
$("pclose").addEventListener("click", () => { playing = false; render(); });
// Safari only allows sound after a tap. If the stream started silent, this tap turns
// sound on through YouTube's embed API.
function ytCommand(func, args = []) {
  const f = $("frame").querySelector("iframe");
  if (f && f.contentWindow) f.contentWindow.postMessage(JSON.stringify({ event: "command", func, args }), "*");
}
$("psound").addEventListener("click", () => {
  const a = $("frame").querySelector("audio");
  if (a) { a.muted = false; a.play().catch(() => {}); return; }
  ytCommand("unMute"); ytCommand("setVolume", [100]); ytCommand("playVideo");
});
$("pname").addEventListener("click", () => go("live"));

// --------------------------------------------------------------- source health (sheet)
function failingSources() {
  return data.sources.filter((s) => {
    const ok = s.last_success ? Date.parse(s.last_success) : null;
    return Boolean(s.last_error) || !ok || Date.now() - ok > Math.max(3 * s.poll, 60) * 60000;
  });
}

// Errors in plain words; the raw message stays in the tooltip-free detail for debugging.
function plainError(e) {
  if (!e) return "";
  const m = String(e);
  if (/HTTP 403/.test(m)) return "Blocked by the site (403). Retrying later.";
  if (/HTTP 429/.test(m)) return "Asked to slow down (429). Waiting, then retrying.";
  if (/HTTP 404/.test(m)) return "Page moved or gone (404).";
  if (/HTTP 5\d\d/.test(m)) return "The site is having trouble (" + (m.match(/HTTP (5\d\d)/) || [])[1] + "). Retrying.";
  if (/robots/i.test(m)) return "The site's robots.txt doesn't allow it; skipped.";
  if (/web page instead of a feed/.test(m)) return "Got a web page instead of the feed (blocked or moved).";
  if (/timed? ?out|Timeout/i.test(m)) return "Timed out. Retrying.";
  if (/token not set|Authentication/i.test(m)) return "Cloudflare credentials missing or lacking permission.";
  return m.replace(/^\w+Error:\s*/, "");
}

function healthTable(list, withTeams) {
  const bad = new Set(failingSources().map((s) => s.id));
  const rows = (list || data.sources).slice().sort((a, b) => bad.has(b.id) - bad.has(a.id)).map((s) => {
    const ok = s.last_success ? Date.parse(s.last_success) : null;
    const failing = bad.has(s.id);
    return el("tr", {},
      el("td", {}, s.short || s.name, s.robots === "subscription" ? el("span", { class: "sub", text: " · sub" }) : null),
      el("td", {}, el("span", { class: "dk", style: "--c: var(--" + s.desk.toLowerCase() + ")", text: DESK_NAME[s.desk] || s.desk })),
      el("td", { class: "num", text: String(s.items) }),
      el("td", { text: ok ? ago(ok) : "never", title: ok ? exact(ok) : "" }),
      el("td", { class: failing ? "err" : "ok", text: plainError(s.last_error) || (failing ? "Late: no update in " + (ok ? ago(ok) : "a while") : "ok") }));
  });
  for (const t of withTeams || !list ? (data.teams || []).filter((t) => t.error) : []) {
    rows.unshift(el("tr", {}, el("td", { text: t.name + " schedule" }), el("td", { text: "Sports" }), el("td", { text: "–" }), el("td", { text: "–" }), el("td", { class: "err", text: t.error })));
  }
  return el("div", { class: "tablewrap" }, el("table", { class: "health" },
    el("thead", {}, el("tr", {}, ...["Source", "Desk", "Items", "Last ok", "Status"].map((h) => el("th", { text: h })))),
    el("tbody", {}, ...rows)));
}

// Problems first, in plain words; the full list, grouped by desk, sits behind a tap.
function openHealth() {
  const badList = failingSources();
  const bad = badList.length;
  const teamErr = (data.teams || []).filter((t) => t.error);
  const okCount = data.sources.length - bad;
  const byDesk = {};
  for (const s of data.sources) (byDesk[s.desk] = byDesk[s.desk] || []).push(s);
  const order = ["BEACON", "GOV", "LAW", "WORLD", "SPORTS", "SYSTEM"];
  const full = el("div", { class: "hgroups", hidden: true }, ...Object.keys(byDesk).sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((d) => {
    const list = byDesk[d];
    const down = list.filter((s) => badList.includes(s)).length;
    return el("details", { class: "hgroup" },
      el("summary", {}, el("span", { class: "dk", style: "--c: var(--" + d.toLowerCase() + ")", text: DESK_NAME[d] || (d === "SYSTEM" ? "System" : d) }),
        el("span", { class: "hcount", text: list.length + " sources" + (down ? " · " + down + " down" : " · all ok") })),
      healthTable(list));
  }));
  const toggle = el("button", { class: "sbtn", text: "Show all " + data.sources.length + " sources" });
  toggle.onclick = () => { full.hidden = !full.hidden; toggle.textContent = full.hidden ? "Show all " + data.sources.length + " sources" : "Hide the full list"; };
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "Sources" }),
    el("p", { class: "sdesc", text: (bad ? bad + " down · " : "All working · ") + okCount + " ok · feed as of " + exact(Date.parse(data.generated_at)) }),
    bad || teamErr.length ? healthTable(badList, true) : el("p", { class: "fine", text: "Every source updated on schedule." }),
    el("div", { class: "sactions" }, toggle),
    full,
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
  const srcs = (data ? data.sources : []).filter((s) => !["SYSTEM"].includes(s.desk) && !s.id.startsWith("p_"));
  const srcList = el("div", { class: "srclist" }, ...srcs.map((s) => el("label", { class: "trow" },
    el("span", {}, s.name, el("span", { class: "dk", style: "--c: var(--" + s.desk.toLowerCase() + ")", text: DESK_NAME[s.desk] || s.desk })),
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
    el("h3", { class: "sh3", text: "Appearance" }),
    el("div", { class: "segmini three" }, ...THEMES.map(([v, label]) => el("button", {
      "aria-pressed": String(prefs.theme === v),
      onclick: (e) => { prefs.theme = v; savePrefs(); applyTheme(); [...e.currentTarget.parentNode.children].forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); },
    }, label))),
    el("h3", { class: "sh3", text: "Text size" }),
    sizeRow,
    el("p", { class: "fine", text: "“iPhone” follows Settings › Display & Brightness › Text Size." }),
    el("h3", { class: "sh3", text: "Display" }),
    toggle("World clocks on Today", "clocks"),
    toggle("Read briefings aloud right away", "speak"),
    toggle("Desks open on new items only", "newOnly"),
    el("h3", { class: "sh3", text: "Saved" }),
    savedList,
    el("h3", { class: "sh3", text: "Mute words" }),
    words,
    el("p", { class: "fine", text: "Comma-separated. Items whose headline or description contains one are hidden everywhere." }),
    el("h3", { class: "sh3", text: "People" }),
    el("button", { class: "sbtn wide", text: "People you follow (" + ((data && data.people) || []).length + ") ›", onclick: openPeople }),
    el("h3", { class: "sh3", text: "Sources shown" }),
    srcList,
    el("button", { class: "sbtn wide", text: "Source health ›", onclick: openHealth }),
    el("p", { class: "fine", text: "Settings and saved items stay on this device." }),
    el("p", { class: "fine", text: "Version " + (APP_VERSION.startsWith("__") ? "local" : APP_VERSION) + (deployedAt ? " · deployed " + exact(Date.parse(deployedAt)) : "") + ". The Wire checks for a new version every time you open it." }),
    el("button", { class: "sbtn wide", text: "Check for updates now", onclick: async (e) => { e.currentTarget.textContent = "Checking…"; const b = e.currentTarget; await checkVersion(); if (!updateReady) b.textContent = "You're on the newest version"; } }),
  ], "Settings");
}
$("settings-btn").addEventListener("click", openSettings);

// --------------------------------------------------------------- always the newest version
// Each deploy stamps a version (the commit) into this page and into version.json. The page
// checks version.json whenever it's opened or brought back, and every 5 minutes. A newer
// version reloads right away if nothing is in progress (no open sheet, video or
// briefing); otherwise a pill offers the reload. Home-screen apps on iPhone resume
// without reloading, so this check is what keeps them current.
const APP_VERSION = (document.querySelector('meta[name="wire-version"]') || {}).content || "";
if (location.search.includes("v=")) { try { history.replaceState(null, "", location.pathname); } catch (e) { /* ignore */ } }
let updateReady = null;
let deployedAt = null;
const busy = () => !$("sheet").hidden || playing || (window.speechSynthesis && speechSynthesis.speaking);

// Reload into the new version. At most two automatic tries per version in 10 minutes (the
// second bypasses every cache with a versioned URL); after that only the pill reloads,
// so a page that is briefly out of step with version.json can never loop.
function updateAttempts() {
  try { const a = JSON.parse(sessionStorage.getItem("wire.reloadTried")); if (a && a.v === updateReady && Date.now() - a.at < 600000) return a; } catch (e) { /* ignore */ }
  return { v: updateReady, n: 0, at: Date.now() };
}
function applyUpdate(byHand) {
  const a = updateAttempts();
  if (!byHand && a.n >= 2) return false;
  try { sessionStorage.setItem("wire.reloadTried", JSON.stringify({ v: updateReady, n: a.n + 1, at: a.n ? a.at : Date.now() })); } catch (e) { /* ignore */ }
  if (navigator.serviceWorker) navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
  if (a.n >= 1) location.replace(location.pathname + "?v=" + encodeURIComponent(updateReady));
  else location.reload();
  return true;
}

async function checkVersion() {
  if (!APP_VERSION || APP_VERSION.startsWith("__")) return;   // local copy, not a deploy
  try {
    const r = await fetch("version.json?ts=" + Date.now(), { cache: "no-store", credentials: "same-origin", redirect: "manual" });
    if (!r.ok) return;
    const v = await r.json();
    deployedAt = v.deployed_at || null;
    if (!v.version || v.version === APP_VERSION) return;
    updateReady = v.version;
    if (!busy() && applyUpdate(false)) return;
    $("newpill").textContent = "New version ready · Reload";
    $("newpill").hidden = false;
  } catch (e) { /* offline: try again next time */ }
}

// --------------------------------------------------------------- visit tracking
function markVisit() { store.set(KEY.visit, Date.now()); }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    markVisit();
  } else {
    prevVisit = Number(store.get(KEY.visit)) || prevVisit;
    for (const k in shown) delete shown[k];
    checkVersion();
    load(true);
  }
});
window.addEventListener("pagehide", markVisit);

// --------------------------------------------------------------- boot
// Sticky elements sit under the top bar, whose height depends on the text size.
const setTopH = () => document.documentElement.style.setProperty("--toph", document.querySelector(".top").offsetHeight + "px");
if (window.ResizeObserver) new ResizeObserver(setTopH).observe(document.querySelector(".top"));
applyTheme();
applySize();
setTopH();
document.body.dataset.tab = tab;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
loadCached().then(() => load(true));
checkVersion();
setInterval(() => { if (document.visibilityState === "visible") { load(false); checkVersion(); } }, REFRESH_MS);
if (navigator.serviceWorker) {
  // A freshly deployed worker took over: reload once so page and worker match.
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded && updateReady && !busy()) { reloaded = true; location.reload(); } });
}
setInterval(() => {
  if (!data) return;
  renderTop();
  const c = $("clocks");
  if (c) c.replaceWith(clocks());
}, 30000);

// --------------------------------------------------------------- threads and follows (BRIEF.md stage 1)
// Follows live on Cloudflare (functions/follow.js) so they work on every device and reach
// the build. data.follows is the build's copy; this page keeps a live one after any change.
let follows = null;
function followsNow() { return follows || (data && data.follows) || { threads: [], topics: [] }; }
function isFollowed(tid) { return followsNow().threads.some((x) => x.id === tid) || followsNow().topics.some((x) => x.id === tid); }
async function setFollow(body) {
  try {
    const r = await fetch("follow", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    follows = await r.json();
    render();
    return true;
  } catch (e) {
    return false;
  }
}
function threadOf(st) { return st && st.thread ? (data.threads || []).find((t) => t.id === st.thread) : null; }
function followButton(st, compact) {
  const tid = st && st.thread;
  if (!tid) return null;
  const on = isFollowed(tid);
  const b = el("button", { class: "sbtn follow" + (on ? " on" : ""), text: on ? "✓ Following" : "+ Follow" });
  b.onclick = async (e) => {
    e.stopPropagation();
    b.textContent = "…";
    const th = threadOf(st);
    const ok = await setFollow(on ? { action: "unfollow", type: "thread", id: tid } : { action: "follow", type: "thread", id: tid, title: (th && th.title) || (byId.get(st.lead) || {}).title || "" });
    if (!ok) b.textContent = "Couldn't save";
  };
  return b;
}
function devLabel(reason) {
  return { document: "Document", confirmed: "Confirmed by a second outlet", spread: "Spread", figures: "Figures changed", update: "Update" }[reason] || "Update";
}

// A thread card for Today: title, what's new since the last visit, counts.
function threadCard(t) {
  const since = prevVisit && Date.now() - prevVisit < 48 * 3600e3 ? prevVisit : Date.now() - 24 * 3600e3;
  const newDevs = (t.developments || []).filter((d) => Date.parse(d.t) > since);
  const lastDev = newDevs.length ? newDevs[newDevs.length - 1] : null;
  const latest = t.latest || (lastDev ? (lastDev.text === t.title
    ? (newDevs.length === 1 ? devLabel(lastDev.reason) : newDevs.length + " developments") + (t.outlets > 1 ? "; now " + t.outlets + " outlets" : "") + " (" + lastDev.source + (lastDev.also && lastDev.also.length ? ", " + lastDev.also.slice(0, 3).join(", ") : "") + ")"
    : devLabel(lastDev.reason) + " · " + lastDev.source + ": " + lastDev.text) : null);
  const nextDoc = (t.docs || []).map((d) => byId.get(d.id)).filter((it) => it && it.event_at && Date.parse(it.event_at) > Date.now()).sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at))[0];
  const st = (data.stories || []).find((s) => s.thread === t.id);
  return el("button", { class: "thread" + (t.developing ? " live" : ""), onclick: () => openThread(t) },
    el("span", { class: "lbl" }, t.developing ? el("span", { class: "dev", text: "Developing" }) : null,
      el("span", { text: (t.developing ? " · " : "") + (t.kind || "thread") + " · " }), el("span", { class: "dk", style: "--c: var(--" + t.desk.toLowerCase() + ")", text: DESK_NAME[t.desk] || t.desk })),
    el("span", { class: "headline", text: t.title }),
    newDevs.length ? el("span", { class: "tnew" }, el("b", { text: "New since " + (isToday(since) ? fmtTime.format(new Date(since)) : exact(since)) + ": " }), latest) :
      nextDoc ? el("span", { class: "tnew" }, el("b", { text: "Next: " }), nextDoc.title + " · " + exact(Date.parse(nextDoc.event_at))) :
      el("span", { class: "tnew quiet", text: "Nothing new since you last looked. Last development " + ago(Date.parse(t.last)) + " ago." }),
    el("span", { class: "meta" }, el("span", { text: (t.developments || []).length + (t.developments && t.developments.length === 1 ? " development" : " developments") }),
      t.outlets > 1 ? el("span", { text: t.outlets + " outlets" }) : null, el("span", { text: t.n_reports + " reports" })));
}

function threadsSection() {
  const mine = (data.threads || []).filter((t) => isFollowed(t.id));
  const addBtn = el("button", { class: "sa", text: "Follow a topic", onclick: openTopicForm });
  const out = [sectionHead("Threads you follow", null, openTopicForm, mine.length ? "Follow a topic" : "Follow a topic")];
  if (!mine.length) {
    out.push(el("p", { class: "sdesc", text: "Follow any story with the Follow button, or name a topic to watch over time. Followed threads collect every report, development and document here." }));
    return out;
  }
  out.push(el("div", { class: "threads" }, ...mine.slice(0, 8).map(threadCard)));
  return out;
}

function openTopicForm() {
  const title = el("input", { type: "text", id: "topic-title", class: "tin", placeholder: "e.g. 152-158 Fishkill Avenue" });
  const pattern = el("input", { type: "text", id: "topic-pattern", class: "tin", placeholder: "Words to watch for, comma-separated (default: the title). A trailing * matches endings: rezon*" });
  const desk = el("select", { id: "topic-desk", class: "tin" }, ...["BEACON", "GOV", "LAW", "WORLD", "SPORTS"].map((d) => el("option", { value: d, text: DESK_NAME[d] })));
  const kind = el("select", { id: "topic-kind", class: "tin" }, ...[["subject", "Subject"], ["process", "Process (an application, bill or case)"], ["entity", "Entity (a place, company or team)"], ["law", "Area of law"], ["event", "Event"]].map(([v, l]) => el("option", { value: v, text: l })));
  const status = el("p", { class: "fine" });
  const save = el("button", { class: "sbtn primary wide", text: "Follow this topic" });
  save.onclick = async () => {
    if (!title.value.trim()) { status.textContent = "Give the topic a name."; return; }
    save.textContent = "Saving…";
    const ok = await setFollow({ action: "follow", type: "topic", title: title.value.trim(), pattern: pattern.value.trim() || title.value.trim(), desk: desk.value, kind: kind.value });
    status.textContent = ok ? "Followed. The next build (within 15 minutes) attaches matching reports." : "Couldn't save. Are you signed in?";
    save.textContent = "Follow this topic";
  };
  const mine = followsNow().topics;
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "Follow a topic" }),
    el("p", { class: "sdesc", text: "A topic is a thread you name. Every report whose headline or description matches joins it, from any source, for as long as you follow it." }),
    el("label", { class: "flab", text: "Topic" }), title,
    el("label", { class: "flab", text: "Watch for" }), pattern,
    el("label", { class: "flab", text: "Desk" }), desk,
    el("label", { class: "flab", text: "Kind" }), kind,
    el("div", { class: "sactions" }, save), status,
    mine.length ? el("h3", { class: "sh3", text: "Topics you follow" }) : null,
    mine.length ? el("ul", { class: "also" }, ...mine.map((tp) => el("li", {}, el("span", { class: "asrc", text: tp.kind + " · " + (DESK_NAME[tp.desk] || tp.desk) + " · watching: " + (tp.pattern || tp.title) }),
      el("span", { text: tp.title + " " }), el("button", { class: "unsave", text: "Unfollow", onclick: async (e) => { e.currentTarget.textContent = "…"; await setFollow({ action: "unfollow", type: "topic", id: tp.id }); openTopicForm(); } })))) : null,
  ].filter(Boolean), "Follow a topic");
}

// The thread page: where it stands, developments, documents, figures, quotes, views, coverage.
function openThread(t, viaItem) {
  const st = (data.stories || []).find((s) => s.thread === t.id) || null;
  const members = (t.members || []).map((m) => byId.get(m)).filter(Boolean).sort((a, b) => b.ms - a.ms);
  const lead = (st && byId.get(st.lead)) || members[0] || viaItem;
  const when = (iso) => { const ms = Date.parse(iso); return isToday(ms) ? fmtTime.format(new Date(ms)) : exact(ms); };
  const sec = (title, ...kids) => el("section", { class: "ssec" }, el("h3", { class: "sh3", text: title }), ...kids);
  const since = prevVisit && Date.now() - prevVisit < 48 * 3600e3 ? prevVisit : Date.now() - 24 * 3600e3;
  const devs = (t.developments || []).slice().reverse();
  const newCount = devs.filter((d) => Date.parse(d.t) > since).length;
  const docs = (t.docs || []).slice().reverse();
  const quotes = [];
  for (const m of members) for (const q of m.quotes || []) if (quotes.length < 3 && !quotes.some((o) => o.by === q.by)) quotes.push({ ...q, item: m });
  const follow = followButton(st || { thread: t.id, lead: lead && lead.id }, false);
  const briefBtn = el("button", { class: "sbtn", text: "Brief me on this", onclick: () => { prefs.briefBeat = "all"; openBrief(); } });
  const nodes = [
    el("div", { class: "smeta" },
      t.developing ? el("span", { class: "dev", text: "Developing" }) : null,
      el("span", { text: (t.kind || "thread")[0].toUpperCase() + (t.kind || "thread").slice(1) }),
      el("span", { class: "dk", style: "--c: var(--" + t.desk.toLowerCase() + ")", text: DESK_NAME[t.desk] || t.desk }),
      el("span", { text: "Opened " + exact(Date.parse(t.opened)) })),
    el("h2", { id: "sheet-title", class: "stitle", text: t.title }),
    el("p", { class: "fine" }, (t.outlets > 1 ? t.outlets + " outlets · " : "") + t.n_reports + " reports · " + devs.length + " developments" + (newCount ? " · " : ""),
      newCount ? el("span", { class: "since", text: newCount + " new since you last looked" }) : null),
    el("div", { class: "sactions" }, follow, briefBtn),
    t.what || t.card || t.summary ? el("div", { class: "machine" },
      el("span", { class: "mlabel", text: "Where it stands · machine-written" + (t.outlets > 1 ? " from " + t.outlets + " outlets" : "") + (t.written_at ? " · " + when(t.written_at) : "") }),
      el("p", { text: t.what || t.card || t.summary })) : (lead && lead.machine_summary ? el("div", { class: "machine" }, el("span", { class: "mlabel", text: "Where it stands · machine summary" }), el("p", { text: lead.machine_summary })) : null),
    t.latest ? el("div", { class: "latest" }, el("span", { class: "mlabel", text: "Latest" + (t.latest_at ? " · " + when(t.latest_at) : "") }), el("p", { text: t.latest })) : null,
    devs.length ? sec("Developments",
      el("ol", { class: "tl" }, ...devs.slice(0, 12).map((d) => el("li", { class: Date.parse(d.t) > since ? "new" : "" },
        el("span", { class: "tlt", text: when(d.t) }),
        el("span", { class: "tlb" }, link(d.link, d.text), el("span", { class: "asrc", text: " · " + d.source + (d.also && d.also.length ? ", " + d.also.join(", ") : "") + " · " + devLabel(d.reason) })))))) : null,
    docs.length ? sec("The documents",
      el("ul", { class: "docs" }, ...docs.slice(0, 6).map((d) => { const it = byId.get(d.id); return el("li", {},
        el("span", { class: "asrc", text: when(d.t) + " · " + d.source + (it && it.event_at ? " · " + exact(Date.parse(it.event_at)) : "") }),
        it ? el("button", { class: "doclink", text: d.title, onclick: () => openItem(it) }) : link(d.link, d.title)); }))) : null,
    t.figures && t.figures.length ? sec("Figures as reported",
      ...t.figures.map((f) => el("div", { class: "fig" }, el("span", { class: "figw", text: f.what }),
        el("ul", { class: "figl" }, ...f.reports.map((r) => el("li", {}, el("span", { class: "fign", text: r.text }), " ",
          el("span", { class: "asrc", text: r.source + " · " + when(r.t) }), " ", link(r.link, "↗")))))),
      el("p", { class: "fine", text: "Outlets' numbers, word for word. They may cover different periods or update through the day." })) : null,
    quotes.length ? sec("In their words", quoteList(quotes)) : null,
    t.views && t.views.length ? sec("Range of views",
      el("ul", { class: "views" }, ...t.views.map((v) => byId.get(v.id)).filter(Boolean).filter((it) => !isMuted(it)).map((it) => el("li", {},
        el("span", { class: "vlab", text: (PERSPECTIVE[it.perspective] || "") + " · " + byline(it) + (it.kind === "PODCAST" ? " · podcast" : "") }),
        link(it.link, it.title),
        it.summary ? el("span", { class: "vsum", text: it.summary.slice(0, 220) + (it.summary.length > 220 ? "…" : "") }) : null)))) :
      sec("Range of views", el("p", { class: "fine", text: "None yet from the people you follow. Views appear here, labeled by perspective, when they write about this." })),
    t.why ? el("div", { class: "why" }, el("span", { class: "mlabel", text: "Why it matters to you · analysis" }), el("p", { text: t.why })) : null,
    sec("All coverage · " + members.length + " reports", el("ul", { class: "also" }, ...members.slice(0, 40).map((it) =>
      el("li", {}, el("span", { class: "asrc", text: ago(it.ms) + " · " + byline(it) + (it.translated ? " · translated" : "") }), link(it.link, it.title))))),
    t.named ? el("p", { class: "fine", text: "A topic you named. Watching for: " + (t.pattern || t.title) }) : null,
    el("div", { class: "endline", text: "End of thread" }),
  ];
  openSheet(nodes.filter(Boolean), t.title);
}

// --------------------------------------------------------------- people you follow
// Newest work from followed people since the last visit (or two days), rotated across
// perspectives so one prolific voice or side can't fill the section. Posts are left out.
function followingItems(limit) {
  const since = prevVisit && Date.now() - prevVisit < 48 * 3600e3 ? Math.min(prevVisit, Date.now() - 12 * 3600e3) : Date.now() - 48 * 3600e3;
  const pool = data.items.filter((it) => it.people && it.people.length && it.kind !== "POST" && it.ms >= since && !isMuted(it)
    && !it.people.every((p) => (prefs.mutedPeople || []).includes(p)));
  const groups = {};
  for (const it of pool) {
    const b = it.perspective ? BUCKET[it.perspective] || "center" : "reporting";
    (groups[b] = groups[b] || []).push(it);
  }
  const seenPerson = new Set();
  const out = [];
  const keys = ["reporting", "left", "center", "right", "libertarian", "international"].filter((k) => groups[k]);
  while (out.length < limit && keys.some((k) => groups[k].length)) {
    for (const k of keys) {
      while (groups[k].length) {
        const it = groups[k].shift();
        const who = it.people[0];
        if (seenPerson.has(who)) continue;
        seenPerson.add(who); out.push(it); break;
      }
      if (out.length >= limit) break;
    }
  }
  return out.sort((a, b) => b.ms - a.ms);
}

function openPeople() {
  const people = (data && data.people) || [];
  const latest = {};
  for (const it of data.items) for (const p of it.people || []) if (!latest[p] || it.ms > latest[p].ms) latest[p] = it;
  const order = ["BEACON", "GOV", "LAW", "WORLD", "SPORTS"];
  const groups = order.map((d) => [d, people.filter((p) => p.desk === d)]).filter(([, l]) => l.length);
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "People you follow" }),
    el("p", { class: "sdesc", text: people.length + " people. Edit the list in people.yaml; uncheck someone here to hide them on this device." }),
    ...groups.map(([d, list]) => el("section", { class: "ssec" },
      el("h3", { class: "sh3", text: DESK_NAME[d] }),
      ...list.map((p) => {
        const last = latest[p.id];
        return el("label", { class: "trow person" },
          el("span", { class: "pinfo" },
            el("span", { class: "pn", text: p.name + (p.perspective ? " · " + PERSPECTIVE[p.perspective] : "") }),
            el("span", { class: "pr", text: p.role || "" }),
            el("span", { class: "pl", text: p.unreachable ? "Not reachable from the cloud yet: " + p.unreachable : last ? "Latest " + ago(last.ms) + " ago: " + last.title.slice(0, 70) : "Nothing new this week" })),
          el("input", { type: "checkbox", checked: p.unreachable || (prefs.mutedPeople || []).includes(p.id) ? null : true, disabled: p.unreachable ? true : null,
            onchange: (e) => {
              prefs.mutedPeople = (prefs.mutedPeople || []).filter((x) => x !== p.id);
              if (!e.target.checked) prefs.mutedPeople.push(p.id);
              savePrefs(); render();
            } }));
      }))),
  ], "People you follow");
}

// --------------------------------------------------------------- pull down to refresh
// The home-screen app has no browser pull-to-refresh, so the page provides its own:
// pull down from the top of a list and let go to check for new data (and a new version).
(() => {
  const ind = el("div", { class: "ptr", "aria-hidden": "true" }, el("span", { class: "ptr-i", text: "↓" }), el("span", { class: "ptr-t", text: "Pull to refresh" }));
  document.body.append(ind);
  let y0 = null, dy = 0, armed = false;
  const blocked = () => !$("sheet").hidden || document.documentElement.classList.contains("stage-lock") || tab === "live";
  window.addEventListener("touchstart", (e) => {
    if (blocked() || window.scrollY > 0 || e.touches.length !== 1) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0; armed = false;
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0 || window.scrollY > 0) { ind.classList.remove("show", "ready"); return; }
    const pull = Math.min(dy, 120);
    armed = pull >= 80;
    ind.style.transform = "translate(-50%, " + (pull * 0.6) + "px)";
    ind.classList.add("show");
    ind.classList.toggle("ready", armed);
    ind.lastChild.textContent = armed ? "Release to refresh" : "Pull to refresh";
  }, { passive: true });
  window.addEventListener("touchend", async () => {
    if (y0 == null) return;
    y0 = null;
    if (!armed) { ind.classList.remove("show", "ready"); ind.style.transform = ""; return; }
    ind.classList.add("busy");
    ind.lastChild.textContent = "Refreshing…";
    try { checkVersion(); await load(true); } finally {
      ind.classList.remove("show", "ready", "busy");
      ind.style.transform = "";
    }
  });
})();
