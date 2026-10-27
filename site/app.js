"use strict";

// The Wire — page. Five tabs (Today, Beacon, Gov, World, Live) with a bottom tab bar,
// a detail sheet for any item, one live player that docks as a mini-player, and a
// settings sheet. Preferences, saved items and the last-visit time live in this
// browser only (per device).

// Five tabs (HIG): Today is the composed page; Threads is the home of topics; News holds the
// desks as segments; Live is the player; Settings has reading preferences and administration.
const TABS = [
  { id: "today", label: "Today", icon: "◉" },
  { id: "threads", label: "Threads", icon: "≡" },
  { id: "news", label: "News", icon: "¶" },
  { id: "live", label: "Live", icon: "▶" },
  { id: "settings", label: "Settings", icon: "⚙" },
];
const SEGMENTS = {
  news: [["BEACON", "Beacon"], ["REGION", "Region"], ["GOV", "Gov"], ["LAW", "Law"], ["WORLD", "World"], ["ISRAEL", "Israel"], ["IDEAS", "Ideas"], ["SPORTS", "Sports"]],
  threads: [["following", "Following"], ["standing", "Standing"], ["suggested", "Suggested"], ["browse", "Browse"]],
};
const DESK_NAME = { BEACON: "Beacon", REGION: "Region", GOV: "Gov", LAW: "Law", WORLD: "World", SPORTS: "Sports", SYSTEM: "System" };
// Region items are Beacon-desk items from regional outlets (sources.yaml `regional: true`).
const deskOf = (it) => (it.desk === "BEACON" && it.regional ? "REGION" : it.desk);
const KEY = {
  picks: "wire.ballotPicks",
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
const KIND_MARK = { VIDEO: "Video", DOC: "Document", QUOTE: "Quote", BLOTTER: "Police blotter", PODCAST: "Podcast", POST: "Post", RECORD: "Record" };
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
const seg = Object.assign({ news: "BEACON", threads: "following" }, store.json(KEY.seg, {}));
if (!SEGMENTS.news.some(([d]) => d === seg.news)) seg.news = "BEACON";
if (!SEGMENTS.threads.some(([d]) => d === seg.threads)) seg.threads = "following";
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
  if (tab === "news") return deskOf(it) === seg.news;
  return false;
}

function newCount(desks) {
  if (!prevVisit || !data) return 0;
  return data.items.filter((it) => (desks.includes(deskOf(it)) || (desks.includes("ISRAEL") && it.itopic && it.itopic !== "jewish"))
    && (!it.quiet || desks.includes("ISRAEL") || storyOf.has(it.id)) && !isSeen(it) && !folded.has(it.id) && !isMuted(it)).length;
}

function renderTabbar() {
  const counts = { news: newCount(["BEACON", "REGION", "GOV", "LAW", "WORLD", "SPORTS"]), threads: newThreadCount() };
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

function goDesk(d) { seg.news = d; store.set(KEY.seg, JSON.stringify(seg)); go("news"); window.scrollTo(0, 0); }
function goThreads(segment) { seg.threads = segment; store.set(KEY.seg, JSON.stringify(seg)); go("threads"); window.scrollTo(0, 0); }
function newThreadCount() {
  if (!prevVisit || !data) return 0;
  return (data.threads || []).filter((t) => t.followed && (t.developments || []).some((d) => Date.parse(d.t) > prevVisit)).length;
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
  if (id === "threads") v.replaceChildren(tellCard(), segBar("threads"), ...threadsView(seg.threads));
  if (id === "news") v.replaceChildren(segBar("news"), ...(seg.news === "ISRAEL" ? israelView() : seg.news === "IDEAS" ? ideasView() : [...(seg.news === "GOV" && data.voter_guide ? [guideCard()] : []), ...(seg.news === "GOV" ? govPanel() : []), ...(seg.news === "SPORTS" ? scoreboard() : []), ...deskView("news", seg.news)]));
  if (id === "live") v.replaceChildren(...liveView());
  if (id === "settings") v.replaceChildren(...settingsView());
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
    const parts = data.day_so_far.parts || [];
    out.push(el("div", { class: "daysofar" }, el("span", { class: "mlabel", text: "The day so far · machine-written · " + fmtTime.format(new Date(Date.parse(data.day_so_far.at))) }),
      parts.length ? el("ol", { class: "dayparts" }, ...parts.map((pt) => {
        const th = pt.thread && (data.threads || []).find((t) => t.id === pt.thread);
        const st = (data.stories || []).find((x) => x.id === pt.story);
        return el("li", {}, el("button", { class: "daypart", onclick: () => th ? openThread(th) : st ? openStory(st) : null },
          el("span", { class: "dlabel", text: pt.label }), el("span", { class: "dtext", text: pt.text })));
      })) : el("p", { text: data.day_so_far.text })));
  }
  if (data.voter_guide) out.push(guideCard());
  const pc = myQuiz ? pulseCard(myQuiz) : (loadQuiz().then(() => { if (myQuiz && pulseCard(myQuiz) && tab === "today") render(); }), null);
  if (pc) out.push(pc);
  const lc = listenCard();
  if (lc) out.push(lc);
  out.push(puzzlesCard());
  out.push(el("button", { class: "briefcard", onclick: openBrief },
    el("span", { class: "bc-ico", "aria-hidden": "true", text: "▶" }),
    el("span", { class: "bc-txt" },
      el("span", { class: "bc-t", text: "Brief me" }),
      el("span", { class: "bc-s", text: (since ? "What's new since " + (isToday(since) ? fmtTime.format(new Date(since)) : exact(since)) : "What matters today") + " · newscast or narrative" }))));
  const wrail = watchRail();
  if (wrail) out.push(wrail);

  // 2. Threads you follow, then a little new territory
  out.push(...threadsStrip());
  const fresh = (data.explore || []).map((id) => (data.threads || []).find((t) => t.id === id)).filter((t) => t && !isFollowed(t.id)).slice(0, 2);
  if (fresh.length) out.push(sectionHead("Outside your usual", "new each day"), suggestList(fresh));

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
  const following = followingItems(followingCount());
  if (following.length) {
    out.push(sectionHead("From people you follow", null, () => openPeople(), "People"));
    out.push(el("ol", { class: "list" }, ...following.map((it) => row(it, { desk: true }))));
  }
  const wr = worthReading();
  if (wr) out.push(...wr);
  const other = otherSide(following);
  if (other) {
    out.push(sectionHead("The other side", other.why));
    out.push(el("ol", { class: "list" }, row(other.it, { desk: true })));
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
    el("div", { class: "cu-links" }, ...SEGMENTS.news.map(([d, label]) => el("button", { class: "pill", text: label, onclick: () => goDesk(d) })))));
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
  if (desk === "LAW" || desk === "GOV") out.push(...areasOfLaw(desk));
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
  return el("li", { class: "row" + (watch ? " watch" : "") + (isSeen(it) ? " seen" : "") + (it.audio ? " hasaudio" : "") },
    el("button", { class: "head", onclick: () => openItem(it) }, headline, meta),
    it.audio ? el("button", { class: "lqadd", "aria-label": "Listen later", text: "＋🎧", onclick: (ev) => { ev.stopPropagation(); addToQueue(it); ev.currentTarget.textContent = "✓🎧"; } }) : null);
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
  engage({ k: "brief", d: tab });
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

// --------------------------------------------------------------- Listen (2026-10-26)
// The audio edition (the build's MP3 of Today's checked text, chapters per story), then podcast
// episodes on threads you follow, then NPR's hourly newscast. One player for all of it, with
// lock-screen and car controls (Media Session), speed, and resume. The queue and positions are a
// per-device convenience (localStorage); what you listen to goes to the private engagement log.
const LQ_KEY = "wire.listen";
const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
let lq = { items: [], i: 0, pos: {}, speed: 1 };
try { lq = Object.assign(lq, JSON.parse(store.get(LQ_KEY) || "{}")); } catch (e) { /* fresh */ }
const aud = new Audio();
aud.preload = "metadata";
let lqHeard = 0, lqTick = 0;
lq.show = lq.show || {};      // per show: "first" (queue first) or "never" (don't queue)
lq.done = lq.done || {};      // episodes heard to the end, so they aren't queued again
function lqSave() {
  const done = Object.fromEntries(Object.entries(lq.done).sort((a, b) => b[1] - a[1]).slice(0, 300));
  try { store.set(LQ_KEY, JSON.stringify({ items: lq.items.slice(0, 40), i: lq.i, pos: lq.pos, speed: lq.speed, intro: lq.intro || {}, noAdSkip: !!lq.noAdSkip, show: lq.show, done })); } catch (e) { /* ignore */ }
}
function editionItem() {
  const L = data.listen;
  if (!L || !L.v) return null;
  return { id: "ed:" + L.v, kind: "edition", title: "The Wire · audio edition", sub: Math.round((L.seconds || 0) / 60) + " min · " + fmtTime.format(new Date(Date.parse(L.at))), src: "listen.mp3?v=" + L.v, chapters: L.chapters || [] };
}
function podItem(it) { return { id: "pod:" + it.id, kind: "podcast", title: it.title, sub: byline(it), src: it.audio, item: it.id, show: it.source_id, chapters: (it.chapters || []).filter((c) => !c.marker), breaks: (it.chapters || []).filter((c) => c.marker).map((c) => c.t), ads: (it.chapters || []).some((c) => c.ad) }; }
// Not an episode (2026-10-26): trailers, "[PREVIEW]" posts for paid or other shows, teasers and
// cross-promos, and very short clips. The build drops these too; this catches what's already stored.
const NOT_EP = /^\W*(preview|trailer|teaser|sneak peek|introducing|presenting|coming soon|announcement)\b|[\[(]\s*(preview|trailer|teaser|bonus preview)\s*[\])]/i;
function isEpisode(it) { return it.audio && it.source_id !== "npr_news_now" && !NOT_EP.test(it.title || "") && !(it.dur && it.dur < 150); }
// Episodes ranked by: shows you've marked "queue first", shows you actually finish (your listening
// log), people you follow on threads you follow, then the newest. One per show per batch where
// possible; shows you've marked "don't queue", finished episodes and anything already queued are left out.
function podcastPicks(n, skip) {
  const cut = Date.now() - 14 * 86400e3;
  const followed = (data.threads || []).filter((t) => t.followed);
  const words = new Set(followed.flatMap((t) => String(t.title || "").toLowerCase().match(/[a-z]{5,}/g) || []));
  const verdicts = showVerdicts();
  const eps = (data.items || []).filter((it) => isEpisode(it) && it.ms >= cut && lq.show[it.source_id] !== "never" && !lq.done[it.id] && !(skip && skip.has("pod:" + it.id)));
  const ms = memberStories();
  const score = (it) => {
    const st = ms.get(it.id); let s = st && st.followed ? 3 : 0;
    for (const w of String(it.title + " " + (it.summary || "")).toLowerCase().match(/[a-z]{5,}/g) || []) if (words.has(w)) s += 1;
    if (lq.show[it.source_id] === "first") s += 6;
    const v = verdicts[it.source_id];
    if (v === "keeper") s += 2; else if (v === "skipper") s -= 3;
    if (Date.now() - it.ms < 3 * 86400e3) s += 1;
    return s;
  };
  const ranked = eps.map((it) => ({ it, s: score(it) })).sort((a, b) => b.s - a.s || b.it.ms - a.it.ms).map((x) => x.it);
  const out = [], seen = new Set();
  for (const it of ranked) if (out.length < n && !seen.has(it.source_id)) { out.push(it); seen.add(it.source_id); }
  for (const it of ranked) if (out.length < n && !out.includes(it)) out.push(it);
  return out;
}
function newscastItem() {
  const it = (data.items || []).filter((x) => x.source_id === "npr_news_now" && x.audio).sort((a, b) => b.ms - a.ms)[0];
  return it ? { id: "nc:" + it.id, kind: "newscast", title: "NPR News Now · " + it.title.split("|")[0].trim(), sub: "hourly newscast", src: it.audio, show: "npr_news_now" } : null;
}
// The newscast goes right after the edition (it's stale within the hour); podcasts follow, and the
// queue tops itself up with more episodes when it runs low, so it doesn't just stop.
function buildQueue() { return [editionItem(), newscastItem(), ...podcastPicks(4).map(podItem)].filter(Boolean); }
function extendQueue() {
  const more = podcastPicks(4, new Set(lq.items.map((x) => x.id))).map(podItem);
  lq.items.push(...more);
  lqSave();
  return more.length;
}

// ---- What you actually listen to (2026-10-26). Each time an item stops (finished, skipped, switched,
// stopped) one event goes to the private engagement log in KV: show, seconds heard, percent heard, why.
// "Your shows" reads it back: shows you finish vs. shows you start and skip.
let listenLog = null;
async function loadListenLog(force) {
  if (listenLog && !force) return listenLog;
  try {
    const r = await fetch("engage", { credentials: "same-origin" });
    const j = r.ok ? await r.json() : { events: [] };
    listenLog = (j.events || []).filter((e) => e.k === "listen" && e.h);
  } catch (e) { listenLog = listenLog || []; }
  listenLog.push(...engageQ.filter((e) => e.k === "listen" && e.h));
  return listenLog;
}
function showStats() {
  const by = {};
  for (const e of listenLog || []) {
    if (e.f !== "podcast") continue;
    const sh = (by[e.h] = by[e.h] || { eps: {}, secs: 0 });
    const ep = (sh.eps[e.t] = sh.eps[e.t] || { p: 0, skip: false, undo: false, end: false, last: "" });
    ep.p = Math.max(ep.p, e.p || 0);
    if (e.d === "skip") ep.skip = true;
    if (e.d === "undo") ep.undo = true;
    if (e.d === "end") ep.end = true;
    if (e.at > ep.last) ep.last = e.at;
    sh.secs += e.s || 0;
  }
  const out = {};
  for (const [id, sh] of Object.entries(by)) {
    const eps = Object.values(sh.eps);
    const touched = eps.length;
    const played = eps.filter((x) => x.p >= 5).length;
    const finished = eps.filter((x) => x.end || x.p >= 85).length;
    const early = eps.filter((x) => x.skip && !x.undo && x.p < 20).length;
    const avg = played ? Math.round(eps.filter((x) => x.p >= 5).reduce((a, x) => a + x.p, 0) / played) : 0;
    let verdict = "new";
    if (touched >= 2 && finished / touched >= 0.5) verdict = "keeper";
    else if (early >= 2 && early >= touched / 2) verdict = "skipper";
    else if (touched >= 2) verdict = "mixed";
    out[id] = { touched, played, finished, early, avg, secs: sh.secs, verdict, last: eps.reduce((a, x) => (x.last > a ? x.last : a), "") };
  }
  return out;
}
function showVerdicts() { const st = listenLog ? showStats() : {}; return Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.verdict])); }
function showName(id) { const s = (data.sources || []).find((x) => x.id === id); return s ? s.name.replace(/ · podcast$/, "") : id; }
async function openShows() {
  await loadListenLog(true);
  const st = showStats();
  const cut = Date.now() - 21 * 86400e3;
  const offered = {};
  for (const it of data.items || []) if (isEpisode(it) && it.ms >= cut) offered[it.source_id] = (offered[it.source_id] || 0) + 1;
  const ids = [...new Set([...Object.keys(offered), ...Object.keys(st)])].filter((id) => id !== "npr_news_now");
  const groups = { keeper: [], mixed: [], skipper: [], never: [], new: [] };
  for (const id of ids) {
    const x = st[id];
    groups[x ? x.verdict : "never"].push(id);
  }
  const hm = (s) => { const m = Math.round(s / 60); return m >= 60 ? Math.floor(m / 60) + "h " + (m % 60) + "m" : m + "m"; };
  const row = (id) => {
    const x = st[id], pref = lq.show[id];
    const facts = x ? [x.touched + " episode" + (x.touched === 1 ? "" : "s"), x.finished + " finished", x.played ? "avg " + x.avg + "% heard" : null, x.early ? x.early + " skipped early" : null, x.secs >= 60 ? hm(x.secs) + " total" : null].filter(Boolean).join(" · ")
      : (offered[id] || 0) + " new episode" + (offered[id] === 1 ? "" : "s") + " in 3 weeks, none played";
    const set = (v) => { if (lq.show[id] === v) delete lq.show[id]; else lq.show[id] = v; lqSave(); openShows(); };
    return el("li", { class: "showrow" },
      el("span", { class: "doclink", text: showName(id) }),
      el("span", { class: "asrc", text: facts }),
      el("div", { class: "wrow" },
        el("button", { class: "chip" + (pref === "first" ? " on" : ""), text: "Queue first", onclick: () => set("first") }),
        el("button", { class: "chip" + (pref === "never" ? " on" : ""), text: "Don't queue", onclick: () => set("never") })));
  };
  const sec = (key, title, note) => groups[key].length ? el("section", { class: "ssec" }, el("h3", { class: "sh3", text: title + " · " + groups[key].length }), note ? el("p", { class: "fine", text: note }) : null,
    el("ul", { class: "admin" }, ...groups[key].sort((a, b) => ((st[b] || {}).secs || 0) - ((st[a] || {}).secs || 0)).map(row))) : null;
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "Your shows" }),
    el("p", { class: "fine", text: "What you actually finish versus what you start and skip, from your listening in The Wire (private: your engagement log in KV, never the repository). Listening in Spotify or Apple isn't visible here. The queue already leans on this: shows you finish move up, shows you skip move down." }),
    sec("keeper", "You finish these", null),
    sec("mixed", "Sometimes", null),
    sec("skipper", "You start and skip", "Two or more episodes skipped in the first fifth. Candidates to drop."),
    sec("never", "Never played here", "Episodes were in your queue pool but you never started one."),
    sec("new", "Not enough yet", "Fewer than two episodes heard."),
    el("button", { class: "sbtn wide", text: "‹ Back to the queue", onclick: () => openQueue() }),
  ].filter(Boolean), "Your shows");
}
// --------------------------------------------------------------- Puzzles (2026-10-27, GAMES.md)
// The Puzzle Page lives in games.js, loaded only when it's opened. The card reads today's count
// from this device (no fetch on every render) and never shows a checklist of what's not done.
let gamesLoading = null;
function loadGames() {
  if (window.WireGames) return Promise.resolve(window.WireGames);
  if (!gamesLoading) gamesLoading = new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = "games.js?v=" + ((document.querySelector("meta[name=wire-version]") || {}).content || "");
    sc.onload = () => res(window.WireGames);
    sc.onerror = () => { gamesLoading = null; rej(new Error("couldn't load the puzzles")); };
    document.head.append(sc);
  });
  return gamesLoading;
}
function openPuzzles() { loadGames().then((W) => W.openPuzzles()).catch((e) => openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Puzzles" }), el("p", { class: "fine", text: e.message })], "Puzzles")); }
function puzzlesCard() {
  let t = null;
  try { t = JSON.parse(store.get("wire.games.today") || "null"); } catch (e) { t = null; }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const cur = t && t.day === today;
  return el("button", { class: "briefcard gamescard", onclick: openPuzzles },
    el("span", { class: "bc-ico", "aria-hidden": "true", text: "⌗" }),
    el("span", { class: "bc-txt" },
      el("span", { class: "bc-t", text: "Puzzles" }),
      el("span", { class: "bc-s", text: (cur ? t.n : 4) + " today" + (cur && t.done ? " · " + t.done + " done" : "") + " · a break from reading" })));
}

function listenCard() {
  const ed = editionItem();
  if (!ed) return null;
  const eps = podcastPicks(3).length, nc = newscastItem();
  return el("button", { class: "briefcard listencard", onclick: () => startListen() },
    el("span", { class: "bc-ico", "aria-hidden": "true", text: "🎧" }),
    el("span", { class: "bc-txt" },
      el("span", { class: "bc-t", text: "Listen" }),
      el("span", { class: "bc-s", text: "Today's stories read aloud · " + ed.sub + (eps || nc ? " · then " + [nc ? "the newscast" : "", eps ? "your shows" : ""].filter(Boolean).join(" and ") : "") })));
}
setTimeout(() => { try { loadListenLog(); } catch (e) { /* later */ } }, 5000);
function startListen(at) {
  lq.items = buildQueue();
  lq.i = 0;
  if (at != null && lq.items[0] && lq.items[0].kind === "edition") lq.pos[lq.items[0].id] = at;
  playAt(0, true);
}
function addToQueue(it) {
  const x = podItem(it);
  if (!lq.items.some((y) => y.id === x.id)) lq.items.push(x);
  lqSave();
  if (aud.paused && !aud.src) playAt(lq.items.length - 1, true); else drawAplayer();
}
function heard(why) {
  const cur = lq.items[lq.i];
  why = why || "switch";
  if (cur && (lqHeard >= 5 || why === "skip")) {
    const p = aud.duration ? Math.round(100 * aud.currentTime / aud.duration) : undefined;
    const ev = { k: "listen", at: new Date().toISOString(), f: cur.kind === "edition" ? "audio" : cur.kind, t: cur.title.slice(0, 140), s: Math.round(lqHeard), d: why, h: cur.show || cur.kind, p };
    engage(ev);
    if (listenLog) listenLog.push(ev);
    if (cur.item && (why === "end" || (p || 0) >= 95)) lq.done[cur.item] = Date.now();
  }
  lqHeard = 0;
}
// Skipping an episode leaves an "Undo" in the player for 15 seconds (an accidental tap shouldn't cost
// you the episode); the skipped one keeps its place, so going back resumes where you were.
function playAt(i, go, why) {
  const prev = lq.items[lq.i];
  if (why === "skip" && prev && prev.kind !== "edition" && i !== lq.i) lq.undo = { id: prev.id, at: Date.now() };
  heard(why);
  if (i >= lq.items.length && lq.items.length) extendQueue();
  const cur = lq.items[i];
  if (!cur) { aud.pause(); drawAplayer(); return; }
  lq.i = i;
  if (playing) { playing = false; render(); }     // one thing at a time: stop the live player
  aud.src = cur.src;
  aud.playbackRate = lq.speed;
  // A show's intro ads: if you've set "start this show at", new episodes begin there (per device).
  const intro = cur.show && (lq.intro || {})[cur.show];
  const resume = lq.pos[cur.id] || intro || 0;
  aud.addEventListener("loadedmetadata", () => { if (resume && (!aud.duration || resume < aud.duration - 10)) aud.currentTime = resume; aud.playbackRate = lq.speed; }, { once: true });
  if (go) aud.play().catch(() => drawAplayer());
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: cur.title, artist: cur.kind === "edition" ? "The Wire" : cur.sub || "", album: "The Wire", artwork: [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }] });
  }
  lqSave(); drawAplayer();
}
function chapterAt(cur, t) { const cs = (cur && cur.chapters) || []; let k = 0; for (let j = 0; j < cs.length; j++) if (cs[j].t <= t + 0.5) k = j; return k; }
function skipChapter(d) {
  const cur = lq.items[lq.i];
  if (cur && cur.chapters && cur.chapters.length) {
    const k = chapterAt(cur, aud.currentTime) + d;
    if (d < 0 && aud.currentTime - cur.chapters[k + 1].t > 3) { aud.currentTime = cur.chapters[k + 1].t; return; }
    if (k >= 0 && k < cur.chapters.length) { aud.currentTime = cur.chapters[k].t; return; }
  }
  if (lq.i + d >= 0 && lq.i + d < lq.items.length) playAt(lq.i + d, true, d > 0 ? "skip" : "switch");
  else if (d > 0) playAt(lq.i + 1, true, "skip");
}
function nextEpisode() { playAt(lq.i + 1, true, "skip"); setTimeout(() => drawAplayer(), 15500); }
function undoSkip() {
  const u = lq.undo; lq.undo = null;
  const j = u ? lq.items.findIndex((x) => x.id === u.id) : -1;
  if (j < 0) return;
  const back = lq.items[j];     // the skip didn't count: mark the restored episode, not the one left
  const ev = { k: "listen", at: new Date().toISOString(), f: back.kind, t: back.title.slice(0, 140), s: 0, d: "undo", h: back.show || back.kind };
  engage(ev);
  if (listenLog) listenLog.push(ev);
  playAt(j, true, "switch");
}
if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession, set = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) { /* unsupported */ } };
  set("play", () => aud.play()); set("pause", () => aud.pause());
  // Car and lock-screen buttons (2026-10-26): in a podcast or the newscast, back and forward jump
  // 15 seconds (quick past an ad read); in the audio edition they move between stories.
  const jump = (d) => { aud.currentTime = Math.max(0, Math.min((aud.duration || 1e9) - 1, aud.currentTime + d)); };
  const inEdition = () => { const cur = lq.items[lq.i]; return cur && cur.kind === "edition"; };
  set("seekbackward", (e) => jump(-((e && e.seekOffset) || 15)));
  set("seekforward", (e) => jump((e && e.seekOffset) || 15));
  set("previoustrack", () => (inEdition() ? skipChapter(-1) : jump(-15)));
  set("nexttrack", () => (inEdition() ? skipChapter(1) : jump(15)));
}
aud.addEventListener("timeupdate", () => {
  const cur = lq.items[lq.i];
  if (!cur) return;
  const now = Date.now();
  if (!aud.paused && lqTick) lqHeard += Math.min(2, (now - lqTick) / 1000) * 1;
  lqTick = now;
  lq.pos[cur.id] = aud.currentTime;
  // Publisher chapters titled as sponsor or ad segments are skipped to the next chapter.
  if (cur.kind === "podcast" && cur.ads && cur.chapters && cur.chapters.length) {
    const k = chapterAt(cur, aud.currentTime), ch = cur.chapters[k], next = cur.chapters[k + 1];
    if (ch && ch.ad && !lq.noAdSkip && aud.currentTime - ch.t < 5) aud.currentTime = next ? next.t : aud.duration || aud.currentTime;
  }
  if (Math.round(aud.currentTime) % 5 === 0) lqSave();
  drawAplayer(true);
});
aud.addEventListener("pause", () => { lqTick = 0; drawAplayer(); lqSave(); });
aud.addEventListener("play", () => { lqTick = Date.now(); drawAplayer(); });
aud.addEventListener("ended", () => { const cur = lq.items[lq.i]; if (cur) delete lq.pos[cur.id]; playAt(lq.i + 1, true, "end"); });
aud.addEventListener("error", () => { const cur = lq.items[lq.i]; if (cur) { cur.failed = true; drawAplayer(); } });
const mmss = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0"); return h ? h + ":" + String(m).padStart(2, "0") + ":" + x : m + ":" + x; };
function drawAplayer(light) {
  const bar = $("aplayer");
  const cur = lq.items[lq.i];
  if (!cur || (!aud.src)) { bar.hidden = true; document.body.classList.remove("listening"); return; }
  bar.hidden = false; document.body.classList.add("listening");
  const k = cur.chapters ? chapterAt(cur, aud.currentTime) : -1;
  const line = cur.failed ? "Couldn't play this one" : k >= 0 && cur.chapters[k] ? cur.chapters[k].label : cur.title;
  const pct = aud.duration ? (100 * aud.currentTime / aud.duration) : 0;
  if (light && bar.firstChild) {
    bar.querySelector(".apline").textContent = line;
    bar.querySelector(".aptime").textContent = mmss(aud.currentTime) + (aud.duration ? " / " + mmss(aud.duration) : "");
    bar.querySelector(".apfill").style.width = pct + "%";
    return;
  }
  bar.replaceChildren(
    el("div", { class: "approg" }, el("div", { class: "apfill", style: "width:" + pct + "%" })),
    el("div", { class: "aprow" },
      el("button", { class: "apbtn apmain", "aria-label": aud.paused ? "Play" : "Pause", text: aud.paused ? "▶" : "❚❚", onclick: () => (aud.paused ? aud.play() : aud.pause()) }),
      el("button", { class: "apinfo", onclick: () => openQueue() },
        el("span", { class: "apline", text: line }),
        el("span", { class: "apsub" }, el("span", { text: (cur.kind === "edition" ? "The Wire" : cur.sub || "") + " · " }), el("span", { class: "aptime", text: mmss(aud.currentTime) + (aud.duration ? " / " + mmss(aud.duration) : "") }))),
      el("button", { class: "apbtn", "aria-label": "Back 15 seconds", text: "↺15", onclick: () => { aud.currentTime = Math.max(0, aud.currentTime - 15); } }),
      cur.kind === "edition" ? el("button", { class: "apbtn", "aria-label": "Next story", text: "⏭", onclick: () => skipChapter(1) })
        : el("button", { class: "apbtn", "aria-label": "Forward 15 seconds", text: "15↻", onclick: () => { aud.currentTime = Math.min((aud.duration || 1e9) - 1, aud.currentTime + 15); } }),
      cur.kind !== "edition" ? el("button", { class: "apbtn", "aria-label": "Next episode", text: "⏭", onclick: () => nextEpisode() }) : null,
      el("button", { class: "apbtn apspeed", "aria-label": "Speed", text: lq.speed + "×", onclick: () => { lq.speed = SPEEDS[(SPEEDS.indexOf(lq.speed) + 1) % SPEEDS.length]; aud.playbackRate = lq.speed; lqSave(); drawAplayer(); } }),
      el("button", { class: "apbtn", "aria-label": "Stop", text: "✕", onclick: () => { heard("stop"); aud.pause(); aud.removeAttribute("src"); aud.load(); drawAplayer(); } })),
    lq.undo && Date.now() - lq.undo.at < 15000 && lq.items.some((x) => x.id === lq.undo.id)
      ? el("button", { class: "apundo", text: "↩ Undo skip · back to " + lq.items.find((x) => x.id === lq.undo.id).title.slice(0, 60), onclick: () => undoSkip() }) : null);
}
function openQueue() {
  const cur = lq.items[lq.i];
  const stories = new Map((data.stories || []).map((s) => [s.id, s]));
  const nodes = [
    el("h2", { id: "sheet-title", class: "stitle", text: "Listening" }),
    el("p", { class: "fine", text: "The edition reads Today's checked story text in Cloudflare's voice; each chapter opens its story. Then NPR's newscast, then episodes ranked by the shows you actually finish and your threads; the queue adds more when it runs low, and ⏭ skips an episode with an undo. In podcasts, the car's back and forward buttons jump 15 seconds; chapters come from the publisher's feed or show notes (times can drift by the length of inserted ads)." }),
  ];
  lq.items.forEach((x, j) => {
    nodes.push(el("section", { class: "ssec" + (j === lq.i ? " apnow" : "") },
      el("div", { class: "aqrow" },
        el("button", { class: "doclink", text: (j === lq.i ? "▶ " : "") + x.title, onclick: () => { playAt(j, true, j > lq.i ? "skip" : "switch"); openQueue(); } }),
        j !== lq.i ? el("button", { class: "unsave", text: "Remove", onclick: () => { lq.items.splice(j, 1); if (j < lq.i) lq.i -= 1; lqSave(); openQueue(); drawAplayer(); } }) : null),
      el("span", { class: "asrc", text: (x.sub || "") + (x.breaks && x.breaks.length ? " · ad breaks near " + x.breaks.map(mmss).join(", ") : "") + (x.ads ? " · sponsor chapters skipped" : "") }),
      j === lq.i && x.kind !== "edition" ? clipControls(() => aud.currentTime, { kind: "audio", src: x.src, title: x.title, source: x.sub || "", link: x.src }) : null,
      x.kind === "podcast" && x.show && j === lq.i ? el("div", { class: "sactions" },
        el("button", { class: "sbtn", text: (lq.intro || {})[x.show] ? "Start this show at " + mmss(lq.intro[x.show]) + " · change to now" : "Skip intro ads: start this show at " + mmss(aud.currentTime), onclick: () => { lq.intro = lq.intro || {}; lq.intro[x.show] = Math.floor(aud.currentTime); lqSave(); openQueue(); } }),
        (lq.intro || {})[x.show] ? el("button", { class: "unsave", text: "Clear", onclick: () => { delete lq.intro[x.show]; lqSave(); openQueue(); } }) : null) : null,
      x.chapters && x.chapters.length ? el("ol", { class: "aqch" }, ...x.chapters.map((c, k) => el("li", {},
        el("button", { class: "linkbtn", text: mmss(c.t) + " · " + c.label, onclick: () => { if (j !== lq.i) { lq.pos[x.id] = c.t; playAt(j, true); } else aud.currentTime = c.t; } }),
        c.story && stories.get(c.story) ? el("button", { class: "linkbtn aqopen", text: "Open ›", onclick: () => openStory(stories.get(c.story)) }) : null))) : null));
  });
  if (!lq.items.length) nodes.push(el("p", { class: "fine", text: "Nothing queued." }));
  nodes.push(el("div", { class: "sactions" },
    el("button", { class: "sbtn", text: "+ More episodes", onclick: () => { const n = extendQueue(); if (!n) alertLine.textContent = "That's every new episode from your shows in the last two weeks."; else openQueue(); } }),
    el("button", { class: "sbtn", text: "Your shows ›", onclick: () => openShows() })));
  const alertLine = el("p", { class: "fine", text: "" });
  nodes.push(alertLine);
  nodes.push(el("button", { class: "sbtn wide", text: "Start over with today's edition", onclick: () => { startListen(); openQueue(); } }));
  openSheet(nodes, "Listening");
}

// --------------------------------------------------------------- Meetings (2026-10-26)
// A Beacon meeting video (YouTube embed only) beside its Granicus agenda. Beacon's uploads carry no
// chapters, so Joe marks moments himself as he watches, optionally tied to an agenda item; they're
// private (/moments, KV) and become jump links on the agenda. Chapters a source does publish in its
// description show too.
const MEET_BODIES = [["zoning", /zoning/i], ["planning", /planning/i], ["council", /council/i], ["historic", /historic|landmark/i], ["conservation", /conservation/i], ["school", /school|education/i]];
function meetingBody(title) { const m = MEET_BODIES.find(([, re]) => re.test(title || "")); return m ? m[0] : null; }
function meetingDay(it) {
  const t = it.title || "";
  let m = t.match(/\b([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4})\b/);
  if (m) { const d = new Date(m[1] + " " + m[2] + ", " + m[3] + " 12:00"); if (!isNaN(d)) return d; }
  m = t.match(/\b(\d{1,2})[ ./-](\d{1,2})[ ./-](\d{2}|\d{4})\b/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(y, +m[1] - 1, +m[2], 12); }
  return it.ms ? new Date(it.ms) : null;
}
function pairMeeting(it, wantVideo) {
  const body = meetingBody(it.title), day = meetingDay(it);
  if (!body || !day) return null;
  const pool = (data.items || []).filter((x) => (wantVideo ? x.meeting_video && x.video : x.agenda && x.agenda.length) && meetingBody(x.title) === body);
  const best = pool.map((x) => ({ x, d: Math.abs((meetingDay(x) || 0) - day) / 86400e3 })).filter((y) => y.d <= 2.5).sort((a, b) => a.d - b.d)[0];
  return best ? best.x : null;
}
let myMoments = null;
async function loadMoments(force) {
  if (myMoments && !force) return myMoments;
  try { const r = await fetch("moments", { credentials: "same-origin" }); myMoments = r.ok ? await r.json() : { moments: [] }; } catch (e) { myMoments = myMoments || { moments: [] }; }
  return myMoments;
}
function descChapters(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/(?:^|\s)((?:\d{1,2}:)?\d{1,2}:\d{2})\s+[-–·]?\s*([^\n]{3,80}?)(?=\s+(?:\d{1,2}:)?\d{1,2}:\d{2}\s|$|\n)/g)) {
    const p = m[1].split(":").map(Number); out.push({ t: p.reduce((s, x) => s * 60 + x, 0), label: m[2].trim() });
  }
  return out.length >= 2 ? out : [];
}
async function openMeeting(video, agendaIt) {
  if (typeof aud !== "undefined" && !aud.paused) aud.pause();
  if (playing) { playing = false; render(); }
  const M = await loadMoments(true);
  const vid = video.video.id;
  engage({ k: "story", f: "video", t: "meeting: " + video.title.slice(0, 100) });
  let now = 0;
  const frame = el("iframe", { class: "meetframe", allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: "",
    src: "https://www.youtube.com/embed/" + encodeURIComponent(vid) + "?enablejsapi=1&playsinline=1&rel=0&origin=" + encodeURIComponent(location.origin), title: video.title });
  const send = (o) => { try { frame.contentWindow.postMessage(JSON.stringify(o), "*"); } catch (e) { /* not ready */ } };
  frame.addEventListener("load", () => send({ event: "listening", id: 1, channel: "widget" }));
  const onMsg = (ev) => {
    if (!/youtube\.com$/.test(new URL(ev.origin).hostname)) return;
    let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d && d.info && typeof d.info.currentTime === "number") { now = d.info.currentTime; clock.textContent = "at " + mmss(now); }
  };
  window.removeEventListener("message", window.__meetMsg || (() => {}));
  window.__meetMsg = onMsg; window.addEventListener("message", onMsg);
  const seek = (t) => { send({ event: "command", func: "seekTo", args: [t, true] }); send({ event: "command", func: "playVideo", args: [] }); };
  const clock = el("span", { class: "asrc", text: "" });
  const mine = () => (myMoments.moments || []).filter((m) => m.v === vid).sort((a, b) => a.t - b.t);
  const agenda = (agendaIt && agendaIt.agenda) || [];
  const chapters = descChapters(video.summary);
  // Mark a moment: the time now, optionally an agenda item and a note.
  let pickN = null;
  const note = el("input", { class: "tin", type: "text", placeholder: "Note (optional)", maxlength: "200" });
  const chips = el("div", { class: "wrow" }, ...[null, ...agenda.filter((a) => a.n != null).map((a) => a.n)].map((n) => {
    const b = el("button", { class: "chip" + (n === pickN ? " on" : ""), text: n == null ? "No item" : "Item " + n });
    b.onclick = () => { pickN = n; [...chips.children].forEach((c) => c.classList.toggle("on", c === b)); }; return b; }));
  const markBox = el("div", { class: "markbox", hidden: true }, el("p", { class: "fine", text: "Tie this moment to an agenda item:" }), chips, note,
    el("button", { class: "sbtn primary wide", text: "Save the moment", onclick: async () => {
      try { const r = await fetch("moments", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add", v: vid, t: Math.floor(now), meeting: agendaIt ? agendaIt.id : null, n: pickN, note: note.value }) }); myMoments = await r.json(); } catch (e) { /* keep going */ }
      markBox.hidden = true; note.value = ""; drawLists(); } }));
  const markBtn = el("button", { class: "sbtn wide", text: "📍 Mark this moment", onclick: () => { markBox.hidden = !markBox.hidden; } });
  const lists = el("div", {});
  function drawLists() {
    const ms = mine();
    const byN = {};
    for (const m of ms) if (m.n) (byN[m.n] = byN[m.n] || []).push(m);
    lists.replaceChildren(...[
      chapters.length ? el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "Chapters" }), el("ul", { class: "admin" }, ...chapters.map((c) => el("li", {}, el("button", { class: "linkbtn", text: mmss(c.t) + " · " + c.label, onclick: () => seek(c.t) }))))) : null,
      el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "Your moments · " + ms.length }),
        ms.length ? el("ul", { class: "admin" }, ...ms.map((m) => el("li", { class: "aqrow" },
          el("button", { class: "linkbtn", text: "▶ " + mmss(m.t) + (m.n ? " · Item " + m.n : "") + (m.note ? " · " + m.note : ""), onclick: () => seek(m.t) }),
          el("button", { class: "unsave", text: "✕", "aria-label": "Delete moment", onclick: async () => { try { const r = await fetch("moments", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", v: vid, t: m.t }) }); myMoments = await r.json(); } catch (e) { /* ignore */ } drawLists(); } }))))
          : el("p", { class: "fine", text: "None yet. Tap Mark this moment while it plays; tie it to an agenda item and it shows on the agenda below." })),
      agenda.length ? el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "The agenda · " + agenda.length + " items" }),
        el("ol", { class: "meetag" }, ...agenda.map((a) => el("li", {},
          el("span", { class: "anum", text: a.n != null ? a.n + "." : "·" }),
          el("span", { class: "atext", text: a.text.length > 220 ? a.text.slice(0, 220) + "…" : a.text }),
          ...(a.flags || []).map((f) => el("span", { class: "aflag", text: f })),
          ...((a.n != null && byN[a.n]) || []).map((m) => el("button", { class: "chip on", text: "▶ " + mmss(m.t), onclick: () => seek(m.t) }))))),
        el("button", { class: "linkbtn", text: "Open the full agenda ›", onclick: () => openItem(agendaIt) })) : el("p", { class: "fine", text: "No matching agenda found for this meeting." }),
    ].filter(Boolean));
  }
  drawLists();
  openSheet([
    el("span", { class: "mlabel", text: "Meeting · City of Beacon" + (video.video.dur ? " · " + video.video.dur : "") }),
    el("h2", { id: "sheet-title", class: "stitle", text: video.title }),
    el("div", { class: "meetwrap" }, frame),
    el("div", { class: "aqrow" }, clock, link(video.link, "YouTube ↗", "srcl")),
    clipControls(() => now, { kind: "yt", v: vid, title: video.title, source: "City of Beacon", link: video.link }),
    markBtn, markBox, lists,
    el("p", { class: "fine", text: "Your moments are private, stored only on Cloudflare. The video plays from YouTube; nothing is downloaded." }),
  ], video.title);
}

// --------------------------------------------------------------- Watch rail (2026-10-26)
// Short official clips (sources marked clip: true) on the stories you follow and the day's top
// stories, swipeable on Today, each played as YouTube's own embed with a link to its story.
// Any report's story, not just the lead's (storyOf is keyed by lead).
function memberStories() { const m = new Map(); for (const st of data.stories || []) for (const id of st.members || []) if (!m.has(id)) m.set(id, st); return m; }
const durSecs = (d) => String(d || "").split(":").reduce((s, x) => s * 60 + Number(x || 0), 0);
function watchPicks(n) {
  const cut = Date.now() - 36 * 3600e3;
  const top = new Map((data.stories || []).slice(0, 12).map((s, i) => [s.id, 12 - i]));
  const words = new Set((data.threads || []).filter((t) => t.followed).flatMap((t) => String(t.title || "").toLowerCase().match(/[a-z]{5,}/g) || []));
  const seen = new Set(), ms = memberStories();
  return (data.items || []).filter((it) => it.clip && it.video && it.ms >= cut && (!it.video.dur || durSecs(it.video.dur) <= 900) && !isMuted(it))
    .map((it) => { const st = ms.get(it.id); let s = 0;
      if (st && st.followed) s += 20; if (st && top.has(st.id)) s += top.get(st.id);
      for (const w of String(it.title).toLowerCase().match(/[a-z]{5,}/g) || []) if (words.has(w)) s += 2;
      return { it, st, s }; })
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.it.ms - a.it.ms)
    .filter((x) => { const k = x.st ? x.st.id : x.it.id; if (seen.has(k)) return false; seen.add(k); return true; })   // one clip per story
    .slice(0, n);
}
function watchRail() {
  const picks = watchPicks(6);
  if (!picks.length) return null;
  return el("section", { class: "watchrail" }, sectionHead("Watch", picks.length + " clips"),
    el("div", { class: "wrail" }, ...picks.map((x, i) => el("button", { class: "wclip", onclick: () => openClip(picks, i) },
      el("span", { class: "wthumb", style: "background-image:url('https://i.ytimg.com/vi/" + encodeURIComponent(x.it.video.id) + "/mqdefault.jpg')" },
        x.it.video.dur ? el("span", { class: "wdur", text: x.it.video.dur }) : null),
      el("span", { class: "wtitle", text: x.it.title }),
      el("span", { class: "wsrc", text: x.it.source + " · " + ago(x.it.ms) })))));
}
let clipNow = () => 0;
function openClip(picks, i) {
  const x = picks[i];
  if (typeof aud !== "undefined" && !aud.paused) aud.pause();
  if (playing) { playing = false; render(); }
  engage({ k: "story", f: "video", t: "clip: " + x.it.title.slice(0, 120), h: "youtube.com" });
  openSheet([
    el("span", { class: "mlabel", text: "Watch · " + x.it.source + (x.it.video.dur ? " · " + x.it.video.dur : "") }),
    el("h2", { id: "sheet-title", class: "stitle", text: x.it.title }),
    (() => { const yp = ytPlayer(x.it.video.id, { autoplay: true, title: x.it.title }); clipNow = yp.now; return el("div", { class: "meetwrap" }, yp.frame); })(),
    clipControls(() => clipNow(), { kind: "yt", v: x.it.video.id, title: x.it.title, source: x.it.source, link: x.it.link }),
    x.st ? el("button", { class: "sbtn wide", text: "The story: " + ((byId.get(x.st.lead) || {}).title || "open") + " ›", onclick: () => openStory(x.st) }) : null,
    el("div", { class: "sactions" },
      i > 0 ? el("button", { class: "sbtn", text: "‹ Previous", onclick: () => openClip(picks, i - 1) }) : null,
      i < picks.length - 1 ? el("button", { class: "sbtn primary", text: "Next clip ›", onclick: () => openClip(picks, i + 1) }) : null,
      link(x.it.link, "YouTube ↗", "sbtn")),
    el("p", { class: "fine", text: "Official clips from news organizations' own YouTube channels, matched to your threads and the day's top stories. Turn a channel off in sources.yaml." }),
  ].filter(Boolean), x.it.title);
}

// --------------------------------------------------------------- On air later (2026-10-26)
// Upcoming broadcasts (pipeline/onair.py) on the Live tab. Star one for a push 10 minutes before it
// starts (the timer Worker sends it, within the 5-a-day cap); stars live in KV (/onair).
let myStars = null;
async function loadStars() {
  try { const r = await fetch("onair", { credentials: "same-origin" }); myStars = r.ok ? await r.json() : { stars: [] }; } catch (e) { myStars = myStars || { stars: [] }; }
  return myStars;
}
const ONAIR_KIND = { meeting: "Beacon", hearing: "House hearing", game: "Game", event: "Event" };
function onAirSection() {
  const list = (data.on_air || []).filter((e) => Date.parse(e.at) > Date.now() - 2 * 3600e3);
  if (!list.length) return null;
  if (!myStars) loadStars().then(() => { if (tab === "live") renderView("live"); });
  const starred = new Set(((myStars || {}).stars || []).map((s) => s.id));
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
  const rows = list.slice(0, 15).map((e) => {
    const ms = Date.parse(e.at), on = starred.has(e.id);
    const vids = data.video || [];
    const playable = e.watch === "beacon" ? vids.find((v) => v.meetings) : e.watch && vids.find((v) => v.id === e.watch);
    const when = (isToday(ms) ? "Today" : isTomorrow(ms) ? "Tomorrow" : day.format(new Date(ms))) + " " + fmtTime.format(new Date(ms));
    const star = el("button", { class: "star" + (on ? " on" : ""), "aria-label": on ? "Don't remind me" : "Remind me 10 minutes before", text: on ? "🔔" : "🔕",
      onclick: async (ev) => { ev.stopPropagation();
        try { const r = await fetch("onair", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: on ? "unstar" : "star", id: e.id, at: e.at, title: e.title, watch: /^https:/.test(e.watch || "") ? e.watch : null }) }); myStars = await r.json(); } catch (x) { /* keep going */ }
        renderView("live"); } });
    const info = el("span", { class: "chi" }, el("span", { class: "chn", text: e.title }),
      el("span", { class: "cht", text: when + " · " + (ONAIR_KIND[e.kind] || "Event") + (e.note ? " · " + e.note : "") }));
    const main = playable ? el("button", { class: "chmain", onclick: () => play(playable.id) }, info, el("span", { class: "chgo", text: "▶" }))
      : e.watch && /^https:/.test(e.watch) ? el("a", { class: "chmain", href: e.watch, target: "_blank", rel: "noopener" }, info, el("span", { class: "chgo out", text: "↗" }))
      : e.item && byId.get(e.item) ? el("button", { class: "chmain", onclick: () => openItem(byId.get(e.item)) }, info, el("span", { class: "chgo", text: "›" }))
      : el("div", { class: "chmain" }, info);
    return el("div", { class: "chrow" }, main, star);
  });
  return el("section", { class: "onair" }, sectionHead("On air later", list.length + " in the next two weeks"),
    el("div", { class: "chlist" }, ...rows),
    el("p", { class: "fine", text: "🔔 = a push 10 minutes before it starts (counts toward your 5 a day). Beacon meetings come from the agendas, House hearings from the House's own schedule, the rest from on_air.yaml." }));
}

// --------------------------------------------------------------- Debate mode (2026-10-26)
// Talk an idea in (the keyboard's microphone works); The Wire spars with it, coaches it, or checks
// it during a debate, from the same sourced material as the questionnaires. Ending a session writes
// a recap and updates a private list of positions rated firm, forming or passing, with the evidence.
// All of it lives only in KV behind Access (functions/debate.js); see CLAUDE.md rule 10.
const DMODES = [["spar", "Spar", "Argues the strongest other side"], ["coach", "Coach", "Sharpens your own case"], ["night", "Debate night", "Checks claims as you watch"]];
let dState = { mode: "spar", topic: null, who: null, video: null };
try { dState = Object.assign(dState, JSON.parse(store.get("wire.debate") || "{}")); } catch (e) { /* fresh */ }
const dSave = () => { try { store.set("wire.debate", JSON.stringify(dState)); } catch (e) { /* ignore */ } };
let dData = null;
async function loadDebate() { try { const r = await fetch("debate", { credentials: "same-origin" }); dData = r.ok ? await r.json() : { now: null, log: [], positions: [] }; } catch (e) { dData = dData || { now: null, log: [], positions: [] }; } return dData; }
const dPost = (body) => fetch("debate", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "HTTP " + r.status); return j; });
// Subjects: the Your solutions issues and the Get up to speed topics.
function debateTopics() {
  const out = {};
  for (const [k, S] of Object.entries(data.solutions || {})) out[k] = S.title;
  for (const [k, T] of Object.entries((data.learn || {}).topics || {})) if (!out[k]) out[k] = T.title;
  return out;
}
function guessTopic(text) {
  const words = new Set(String(text).toLowerCase().match(/[a-z]{4,}/g) || []);
  let best = null, bs = 0;
  for (const [k, title] of Object.entries(debateTopics())) {
    const bag = [title, ...allQuizItems().filter((it) => it.topic === k).map((it) => it.text), ...((data.solutions || {})[k] ? data.solutions[k].mechanisms.map((m) => m.text) : [])].join(" ").toLowerCase().match(/[a-z]{4,}/g) || [];
    const s = new Set(bag); let n = 0; for (const w of words) if (s.has(w)) n += 1;
    if (n > bs) { bs = n; best = k; }
  }
  return bs >= 2 ? best : null;
}
// The numbered material the model may use: statements, explainers, and sourced positions on the subject.
function debateContext(k) {
  const items = [];
  if (!k) return { title: null, items };
  const quizItems = allQuizItems().filter((it) => it.topic === k);
  for (const it of quizItems.slice(0, 4)) {
    const e = (data.explain || {})[it.id];
    if (e && e.now) items.push({ text: "Where things stand on “" + it.text + "”: " + e.now, source: (e.sources || [])[0] || "" });
    if (e && e.case_for) items.push({ text: "Case for: " + e.case_for, source: (e.sources || [])[1] || (e.sources || [])[0] || "" });
    if (e && e.case_against) items.push({ text: "Case against: " + e.case_against, source: (e.sources || [])[2] || (e.sources || [])[0] || "" });
  }
  const S = (data.solutions || {})[k];
  if (S) {
    const names = solveActors(S), mt = Object.fromEntries(S.mechanisms.map((m) => [m.id, m.text]));
    for (const [a, cells] of Object.entries(S.plans || {})) for (const [m, x] of Object.entries(cells)) {
      if (items.length >= 24 || x.unverified) continue;
      items.push({ text: (names[a] || a) + " " + (x.v > 0 ? "supports" : x.v < 0 ? "opposes" : "is mixed on") + ": " + mt[m] + (x.note ? " (" + x.note + ")" : ""), source: x.source || "" });
    }
  }
  return { title: debateTopics()[k] || k, items: items.slice(0, 24) };
}
function debateEntry() {
  return el("div", { class: "rbox quizbox" }, el("span", { class: "mlabel", text: "Debate mode" }),
    el("p", { class: "rjob", text: "Talk an idea through. The Wire argues the other side, sharpens your case, or checks claims while you watch a debate, and keeps track of which views are firm and which are passing." }),
    el("button", { class: "sbtn primary wide", text: "Open", onclick: () => openDebate() }));
}
function dTurn(t) {
  if (t.who === "you") return el("div", { class: "dyou" }, el("span", { class: "mlabel", text: "You" + (t.re ? " · on " + t.re : "") }), el("p", { text: t.text }));
  const src = (t.sources || []).length ? el("p", { class: "fine" }, "Sources: ", ...t.sources.flatMap((x, i) => [i ? " · " : "", x.source && /^https?:/.test(x.source) ? link(x.source, "[" + x.n + "]") : el("span", { text: "[" + x.n + "]" })])) : null;
  if (t.mode === "coach") return el("div", { class: "dwire" }, el("span", { class: "mlabel", text: "Coach" }),
    (t.unsupported || []).length ? el("div", {}, el("b", { text: "Needs evidence:" }), el("ul", { class: "cpos" }, ...t.unsupported.map((u) => el("li", {}, "“" + u.quote + "” " + u.why)))) : null,
    t.rebuttal ? el("p", {}, el("b", { text: "The rebuttal you'll get: " }), t.rebuttal) : null,
    t.tight ? el("p", { class: "dtight" }, el("b", { text: "Your 30 seconds: " }), t.tight) : null, src);
  if (t.mode === "night") return el("div", { class: "dwire" }, el("span", { class: "mlabel", text: "Check · " + (t.verdict || "") }), el("p", { text: t.check || t.text }), src);
  return el("div", { class: "dwire" }, el("span", { class: "mlabel", text: "The other side" }), el("p", { text: t.reply || t.text }), src);
}
async function openDebate(notice) {
  await loadDebate();
  const topics = debateTopics();
  const now = dData.now;
  const box = el("textarea", { class: "tin", rows: "4", placeholder: dState.mode === "night" ? "What did they just say, and what do you make of it? (Tap the keyboard's mic to talk.)" : "Say what you think. Tap the keyboard's mic to talk it in." });
  const status = el("p", { class: notice ? "okmsg" : "fine", text: notice || "" });
  const send = el("button", { class: "sbtn primary wide", text: "Send" });
  send.onclick = async () => {
    const text = box.value.trim();
    if (text.split(/\s+/).length < 4) { status.className = "errmsg"; status.textContent = "Say a little more."; return; }
    send.disabled = true; send.textContent = "Thinking…";
    const k = dState.topic || guessTopic(text);
    try { await dPost({ action: "say", text, mode: dState.mode, who: dState.mode === "night" ? dState.who : null, context: debateContext(k) });
      engage({ k: "quiz", t: "debate:" + dState.mode }); openDebate(); }
    catch (e) { status.className = "errmsg"; status.textContent = e.message; send.disabled = false; send.textContent = "Send"; }
  };
  const modeRow = el("div", { class: "wrow" }, ...DMODES.map(([m, label]) => el("button", { class: "chip" + (dState.mode === m ? " on" : ""), text: label, onclick: () => { dState.mode = m; dSave(); openDebate(); } })));
  const sel = el("select", { class: "tin", onchange: (ev) => { dState.topic = ev.target.value || null; dSave(); } },
    el("option", { value: "", text: "Subject: work it out from what I say" }), ...Object.entries(topics).map(([k, t]) => { const o = el("option", { value: k, text: t }); if (dState.topic === k) o.selected = true; return o; }));
  const g = data.voter_guide;
  const names = g && g.quiz ? Object.keys(g.quiz.stances || {}) : [];
  const whoRow = dState.mode === "night" ? el("div", { class: "wrow" }, ...names.map((n) => el("button", { class: "chip" + (dState.who === n ? " on" : ""), text: n.split(" ").slice(-1)[0], onclick: () => { dState.who = dState.who === n ? null : n; dSave(); openDebate(); } }))) : null;
  const vidIn = dState.mode === "night" ? el("input", { class: "tin", type: "url", placeholder: "Optional: paste the debate's YouTube link to watch it here", value: dState.video || "",
    onchange: (ev) => { const m = String(ev.target.value).match(/(?:v=|youtu\.be\/|embed\/|live\/)([A-Za-z0-9_-]{11})/); dState.video = m ? m[1] : null; dSave(); openDebate(); } }) : null;
  const B = dData.budget;
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "Debate" }),
    modeRow, el("p", { class: "fine", text: DMODES.find(([m]) => m === dState.mode)[2] + ". Facts come only from The Wire's sourced material, cited." }),
    sel, whoRow, vidIn,
    dState.mode === "night" && dState.video ? el("div", { class: "meetwrap" }, el("iframe", { class: "meetframe", allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: "", src: "https://www.youtube.com/embed/" + encodeURIComponent(dState.video) + "?playsinline=1&rel=0", title: "Debate" })) : null,
    now && now.turns.length ? el("div", { class: "dlog" }, ...now.turns.map(dTurn)) : el("p", { class: "fine", text: "Start anywhere: a reaction to the news, a half-formed idea, or what you'd say to someone who disagrees." }),
    box, send, status,
    el("div", { class: "sactions" },
      now && now.turns.length ? el("button", { class: "sbtn", text: "End and recap", onclick: async (ev) => { ev.target.textContent = "Writing the recap…"; try { const R = await dPost({ action: "end" }); openRecap(R); } catch (e) { status.className = "errmsg"; status.textContent = e.message; } } }) : null,
      el("button", { class: "sbtn", text: "Your positions", onclick: () => openPositions() })),
    B ? el("p", { class: "fine", text: "AI today: " + B.used + " of about " + B.allowed + " units free for debate mode (Cloudflare's free daily allowance, after the news build's share). It resets at midnight UTC." }) : null,
    el("p", { class: "fine", text: "Private: what you say is stored only in your Cloudflare storage and read only by Cloudflare's AI, which doesn't keep or train on it." }),
  ].filter(Boolean), "Debate");
  const body = $("sheet-body"); if (body && now && now.turns.length) setTimeout(() => { box.scrollIntoView({ block: "end" }); }, 50);
}
function openRecap(R) {
  const r = R.recap || {};
  openSheet([
    el("button", { class: "linkbtn", text: "‹ Debate", onclick: () => openDebate() }),
    el("h2", { id: "sheet-title", class: "stitle", text: "Recap" }),
    (r.sharpest || []).length ? el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "Your sharpest points" }), el("ul", { class: "cpos" }, ...r.sharpest.map((q) => el("li", { text: "“" + q + "”" })))) : null,
    (r.weakest || []).length ? el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "Where you were weakest" }), el("ul", { class: "cpos" }, ...r.weakest.map((w) => el("li", {}, "“" + w.quote + "” ", el("span", { class: "fine", text: w.why }))))) : null,
    (r.new || []).length ? el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "New for you" }), el("ul", { class: "cpos" }, ...r.new.map((s) => el("li", { text: s })))) : null,
    !R.recap ? el("p", { class: "fine", text: "The session was saved, but the recap couldn't be written (likely today's AI allowance). Your positions update next time." }) : null,
    el("button", { class: "sbtn primary wide", text: "Your positions", onclick: () => openPositions() }),
  ].filter(Boolean), "Recap");
}
// Firm, forming or passing: how often it comes back (days), how certain the wording is, and whether
// it held when challenged (attitude-strength research: Krosnick and Petty).
function rateStrength(p) {
  const days = (p.days || []).length, c = p.certainty || {}, tot = (c.high || 0) + (c.medium || 0) + (c.low || 0);
  const sure = tot ? (c.high || 0) / tot : 0, ch = p.challenge || {}, held = ch.held || 0, gave = (ch.softened || 0) + (ch.changed || 0);
  const why = [days + (days === 1 ? " day" : " days") + " you've raised it", Math.round(sure * 100) + "% said with certainty"];
  if (held || gave) why.push("held " + held + "×, softened or changed " + gave + "× when challenged");
  if (p.confirmed === true) why.push("you confirmed it");
  let r = "Forming";
  if ((days >= 3 && sure >= 0.5 && held >= gave) || (p.confirmed === true && days >= 2 && held >= gave)) r = "Firm";
  else if ((days <= 1 && (sure < 0.5 || gave > held)) || p.confirmed === false) r = "Passing";
  return { r, why };
}
async function openPositions() {
  await loadDebate();
  const P = (dData.positions || []).slice().sort((a, b) => String(b.last || "").localeCompare(String(a.last || "")));
  const groups = { Firm: [], Forming: [], Passing: [] };
  for (const p of P) { const s = rateStrength(p); groups[s.r].push({ p, s }); }
  const card = ({ p, s }) => el("details", { class: "race" },
    el("summary", {}, el("span", { class: "rtitle" }, el("b", { text: p.summary })), el("span", { class: "rsub", text: p.topic + " · " + s.why[0] }), el("span", { class: "chev", text: "▾" })),
    el("p", { class: "fine", text: s.why.join(" · ") }),
    el("ul", { class: "cpos" }, ...(p.quotes || []).slice(0, 4).map((x) => el("li", { text: "“" + x.q + "” · " + fmtDate.format(new Date(x.at)) }))),
    el("div", { class: "sactions" },
      el("button", { class: "sbtn", text: "How it lands", onclick: () => openResonance(p) }),
      el("button", { class: "sbtn", text: p.confirmed === true ? "✓ That's me" : "That's me", onclick: async () => { await dPost({ action: "position", id: p.id, confirm: p.confirmed === true ? null : true }); openPositions(); } }),
      el("button", { class: "sbtn", text: p.confirmed === false ? "✓ Not really" : "Not really", onclick: async () => { await dPost({ action: "position", id: p.id, confirm: p.confirmed === false ? null : false }); openPositions(); } }),
      el("button", { class: "unsave", text: "Forget", onclick: async () => { await dPost({ action: "forget", id: p.id }); openPositions(); } })));
  openSheet([
    el("button", { class: "linkbtn", text: "‹ Debate", onclick: () => openDebate() }),
    el("h2", { id: "sheet-title", class: "stitle", text: "Your positions" }),
    el("p", { class: "sdesc", text: "What you've argued in debate mode, grouped by how firmly you seem to hold it: how often it comes back, how certain your words are, and whether it held when challenged. A reading, not a verdict: confirm or dismiss any of them." }),
    ...["Firm", "Forming", "Passing"].flatMap((k) => groups[k].length ? [el("h3", { class: "sh3", text: k + " · " + groups[k].length }), ...groups[k].map(card)] : []),
    !P.length ? el("p", { class: "fine", text: "Nothing yet. Positions appear after you end a debate session." }) : null,
  ].filter(Boolean), "Your positions");
}
async function openResonance(p) {
  const words = (p.topic + " " + p.summary).toLowerCase();
  const k = guessTopic(words + " " + (p.quotes || []).map((x) => x.q).join(" "));
  const items = k ? allQuizItems().filter((it) => it.topic === k) : [];
  const out = el("div", {});
  const ask = (audience) => async (ev) => {
    ev.target.textContent = "Rewriting…";
    try { const R = await dPost({ action: "reframe", audience, text: p.summary + " " + (p.quotes || []).map((x) => x.q).join(" ") });
      out.replaceChildren(el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "For a " + R.audience + " audience" }), el("p", { text: R.reframed }),
        el("p", { class: "fine", text: "Leans on: " + (R.values || []).join(", ") + ". A technique (Feinberg and Willer, Stanford): arguments land better framed in the listener's values. It isn't a prediction of how anyone will react." }))); }
    catch (e) { out.replaceChildren(el("p", { class: "errmsg", text: e.message })); }
  };
  openSheet([
    el("button", { class: "linkbtn", text: "‹ Your positions", onclick: () => openPositions() }),
    el("h2", { id: "sheet-title", class: "stitle", text: "How it lands" }),
    el("p", { class: "sdesc", text: p.summary }),
    el("h3", { class: "sh3", text: "Where the public is" }),
    items.length ? el("ul", { class: "admin" }, ...items.filter((it) => (data.explain || {})[it.id]).slice(0, 4).map((it) => el("li", {},
      el("b", { text: it.text }), el("p", { class: "fine", text: data.explain[it.id].now }), explainBtn(it.id, () => openResonance(p))))) : el("p", { class: "fine", text: "No polling on file for this subject yet." }),
    el("h3", { class: "sh3", text: "Make the case to the other side" }),
    el("div", { class: "sactions" }, el("button", { class: "sbtn", text: "Right-leaning listener", onclick: ask("right") }), el("button", { class: "sbtn", text: "Left-leaning listener", onclick: ask("left") })),
    out,
    el("p", { class: "fine", text: "Good arguments move policy opinions about 5 points, in the same direction across parties, and backlash is rare (Coppock, Persuasion in Parallel). Evidence and framing matter more than who's talking." }),
  ].filter(Boolean), "How it lands");
}

// --------------------------------------------------------------- Your profile (2026-10-26)
// Everything Joe has answered, argued and proposed in one private place: where he sits, his own and
// outside labels, which party or line fits best in each electorate, where his sources disagree, how
// he has moved, and a platform draft built only from what he confirmed. Party fit is from candidates'
// sourced positions and The Wire's placement of each line until party platforms are coded.
const NOLAN = ["Libertarian", "Left (liberal)", "Right (conservative)", "Statist", "Centrist"];
const MF = [["care", "Care"], ["fairness", "Fairness"], ["loyalty", "Loyalty"], ["authority", "Authority"], ["purity", "Sanctity"], ["liberty", "Liberty"]];
const OUTSIDE = {
  pc: ["The Political Compass", "https://www.politicalcompass.org/test", "Two numbers, economic (left −10 to right +10) and social (libertarian −10 to authoritarian +10)."],
  nolan: ["World's Smallest Political Quiz (the Nolan chart)", "https://www.theadvocates.org/quiz/", "Ten questions; places you as libertarian, left, right, statist or centrist."],
  mf: ["Moral Foundations (YourMorals)", "https://yourmorals.org/", "How much you weigh care, fairness, loyalty, authority, sanctity and liberty (0 to 5 each). The same research behind How it lands."],
  v8: ["8values", "https://8values.github.io/", "An open-source quiz on four axes that ends with an ideology label."],
};
function profileEntry() {
  return el("div", { class: "rbox quizbox" }, el("span", { class: "mlabel", text: "Your profile" }),
    el("p", { class: "rjob", text: "Everything you've answered, argued and proposed in one place: where you sit, your labels, which party fits best in each electorate, and how you've moved." }),
    el("button", { class: "sbtn primary wide", text: "Open", onclick: () => openProfile() }));
}
function recordOutside(k, Q) {
  const me = (Q && Q.self) || {};
  const [name, url, what] = OUTSIDE[k];
  const status = el("p", { class: "fine" });
  const save = async (body) => { try { await saveQuiz({ kind: "self", ...body }); status.className = "okmsg"; status.textContent = "✓ Saved."; await loadQuiz(true); setTimeout(() => openProfile(), 500); } catch (e) { status.className = "errmsg"; status.textContent = e.message; } };
  let form;
  if (k === "pc") {
    const e = el("input", { class: "tin", type: "number", step: "0.01", min: "-10", max: "10", placeholder: "Economic, e.g. -2.5", value: me.pc ? me.pc.econ : "" });
    const s = el("input", { class: "tin", type: "number", step: "0.01", min: "-10", max: "10", placeholder: "Social, e.g. 1.8", value: me.pc ? me.pc.soc : "" });
    form = [e, s, el("button", { class: "sbtn primary wide", text: "Save", onclick: () => save({ pc: { econ: e.value, soc: s.value } }) })];
  } else if (k === "nolan") form = [el("div", { class: "wrow" }, ...NOLAN.map((n) => el("button", { class: "chip" + (me.nolan === n ? " on" : ""), text: n, onclick: () => save({ nolan: n }) })))];
  else if (k === "mf") {
    const ins = MF.map(([id, label]) => [id, el("input", { class: "tin", type: "number", step: "0.1", min: "0", max: "5", placeholder: label + " (0–5)", value: me.mf && me.mf[id] != null ? me.mf[id] : "" })]);
    form = [...ins.map(([, i]) => i), el("button", { class: "sbtn primary wide", text: "Save", onclick: () => save({ mf: Object.fromEntries(ins.map(([id, i]) => [id, i.value])) }) })];
  } else {
    const t = el("input", { class: "tin", type: "text", placeholder: "Your ideology label", value: me.v8 || "" });
    form = [t, el("button", { class: "sbtn primary wide", text: "Save", onclick: () => save({ v8: t.value }) })];
  }
  openSheet([el("button", { class: "linkbtn", text: "‹ Your profile", onclick: () => openProfile() }), el("h2", { id: "sheet-title", class: "stitle", text: name }),
    el("p", { class: "sdesc", text: what }), el("p", {}, link(url, "Take it on their site ↗", "sbtn")), el("p", { class: "fine", text: "Their site keeps your answers there; record just the result here (private, Cloudflare only)." }), ...form, status], name);
}
// Party platforms coded on the statements (party_platforms.yaml): agreement with each party's own
// documents, from the election check and Where you stand answers (proposals fill gaps).
function partyFit(Q, electorate) {
  const P = data.party_platforms || {};
  const g = data.voter_guide;
  const ans = Object.assign({}, (Q.values || {}).answers || {}, withProposals("election", g ? (((Q.elections || {})[g.id] || {}).answers || {}) : {}));
  return Object.entries(P).filter(([, x]) => x.electorate === electorate).map(([id, x]) => {
    let num = 0, den = 0, n = 0; const rows = [];
    for (const [q, c] of Object.entries(x.codes || {})) { const a = ans[q]; if (!a || a.skip || a.v == null) continue; const w = a.w || 2, ag = 1 - Math.abs(a.v - c.v) / 4; num += w * ag; den += w; n += 1; rows.push({ q, ag, c }); }
    return { id, name: x.name, note: x.note, n, pct: n >= 3 ? Math.round(100 * num / den) : null, rows };
  }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
}
function partyList(fits) {
  const text = Object.fromEntries(allQuizItems().map((it) => [it.id, it.text]));
  return el("div", {}, ...fits.map((f) => el("details", { class: "race" },
    el("summary", {}, el("span", { class: "rtitle" }, el("b", { text: f.name }), f.pct != null ? " · " + f.pct + "% agreement" + (fits.some((y) => y !== f && y.pct === f.pct) ? " · tied" : "") : " · too few shared statements"),
      el("span", { class: "rsub", text: f.n + " statements in common" }), el("span", { class: "chev", text: "▾" })),
    f.note ? el("p", { class: "fine", text: f.note }) : null,
    el("ul", { class: "cpos" }, ...f.rows.sort((a, b) => b.ag - a.ag).map((r) => el("li", {}, el("b", { text: r.ag >= 0.75 ? "Agree · " : r.ag <= 0.25 ? "Differ · " : "Partly · " }), "“" + (text[r.q] || r.q) + "” " + (r.c.note || "") + " ", r.c.source ? link(r.c.source, "↗", "srcl") : null))))));
}
function lineFit(Q) {
  const g = data.voter_guide;
  if (!g || !g.quiz) return [];
  const a = withProposals("election", ((Q.elections || {})[g.id] || {}).answers || {});
  const me = myLean();
  const lines = {};
  for (const r of g.races || []) for (const c of r.candidates || []) {
    const m = matchFor(g, c.name, a);
    if (m.n < 2) continue;
    for (const l of c.lines || []) (lines[l] = lines[l] || []).push({ name: c.name, pct: m.pct, n: m.n });
  }
  const pos = g.line_info || {};
  return Object.keys({ ...lines, ...pos }).map((l) => {
    const cs = lines[l] || [];
    const avg = cs.length ? Math.round(cs.reduce((s, x) => s + x.pct, 0) / cs.length) : null;
    const dist = me && pos[l] && pos[l].pos ? Math.hypot(pos[l].pos[0] - me[0], pos[l].pos[1] - me[1]) : null;
    return { l, avg, cs, dist };
  }).filter((x) => x.avg != null || x.dist != null).sort((x, y) => (y.avg ?? -1) - (x.avg ?? -1) || (x.dist ?? 9) - (y.dist ?? 9));
}
function ilFit(Q) {
  const B = data.il_quiz;
  if (!B) return [];
  const a = withProposals("israel", ((Q.elections || {})[IL_ID] || {}).answers || {});
  return B.lists.map((l) => {
    let num = 0, den = 0, n = 0;
    for (const [q, x] of Object.entries(B.stances[l.id] || {})) { const y = a[q]; if (!y || y.skip || y.v == null) continue; num += (y.w || 2) * (1 - Math.abs(y.v - x.v) / 4); den += y.w || 2; n += 1; }
    return { l, n, pct: den ? Math.round(100 * num / den) : null };
  }).filter((x) => x.n >= 3).sort((x, y) => y.pct - x.pct);
}
async function openProfile(notice) {
  const [Q] = await Promise.all([loadQuiz(true), loadProps(), loadDebate(), loadBallot()]);
  const me = Q.self || {};
  const bank = data.values_bank;
  const V = Q.values || {};
  const sc = bank ? standScores(V.answers || {}, electionExtra(Q)) : null;
  const ax = bank ? Object.fromEntries(bank.axes.map((a) => [a.id, a])) : {};
  const nAnswers = Object.keys(V.answers || {}).length + Object.keys((((Q.elections || {})[(data.voter_guide || {}).id] || {}).answers) || {}).length + Object.keys((((Q.elections || {})[IL_ID] || {}).answers) || {}).length;
  const pos = (dData && dData.positions) || [];
  const firm = pos.filter((p) => rateStrength(p).r === "Firm");
  const props = Object.entries((myProps || {}).issues || {});
  const clashes = props.flatMap(([k]) => propClashes(k).map((c) => ({ k, ...c })));
  const sec = (title, ...kids) => el("section", { class: "ssec" }, el("h3", { class: "sh3", text: title }), ...kids.filter(Boolean));
  const row = (label, value, onclick) => el("li", { class: "aqrow" }, el("span", {}, el("b", { text: label + ": " }), value || el("span", { class: "fine", text: "not yet" })), onclick ? el("button", { class: "linkbtn", text: value ? "Change" : "Add", onclick }) : null);
  // 1. Where you sit
  const conf = bank ? axisConfidence(Q) : {};
  const sit = sc ? el("ul", { class: "admin" }, ...bank.axes.map((a) => el("li", {}, el("b", { text: a.label + ": " }), lean(sc[a.id].s, a) + (sc[a.id].n ? " · " + sc[a.id].n + " answers · confidence " + conf[a.id].level.toLowerCase() + (conf[a.id].cons && conf[a.id].level !== "High" && conf[a.id].cons < 0.75 ? " (mixed answers)" : "") : "")))) : el("p", { class: "fine", text: "Take Where you stand to see this." });
  const sharpen = bank && (bank.topup || []).length ? el("button", { class: "sbtn primary wide", text: "Sharpen my profile", onclick: () => sharpenProfile() }) : null;
  // 2. Labels
  const mfTop = me.mf ? Object.entries(me.mf).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => (MF.find(([id]) => id === k) || [k, k])[1]).join(" and ") : null;
  const memeAns = (Q.memes || {}).answers;
  let memeL = null; try { if (memeAns) { const mb = await loadMemeBank(); const r = mb && memeScore(mb, memeAns); if (r) memeL = memeLabel(r); } } catch (e) { memeL = null; }
  let under = null; try { const rd = sc ? lensReadings(sc, V.past || []) : []; const cur = rd.find((r) => /^Nearest current/.test(r.head)); under = cur ? cur.head.replace(/^Nearest current: /, "nearest current: ") : null; } catch (e) { under = null; }
  const labels = el("ul", { class: "admin" },
    row("Self-placement (ANES)", me.anes != null ? (ANES.find(([v]) => v === me.anes) || [0, ""])[1] : null, () => openStand()),
    row("Pew typology", me.pew, () => openStand()),
    row("Political Compass", me.pc ? "economic " + me.pc.econ + ", social " + me.pc.soc + " (" + (me.pc.econ < 0 ? "left" : "right") + ", " + (me.pc.soc < 0 ? "libertarian" : "authoritarian") + ")" : null, () => recordOutside("pc", Q)),
    row("Nolan chart", me.nolan, () => recordOutside("nolan", Q)),
    row("Moral foundations", mfTop ? "leans most on " + mfTop : null, () => recordOutside("mf", Q)),
    row("8values", me.v8, () => recordOutside("v8", Q)),
    row("For fun: the meme map", memeL, () => ((Q.memes || {}).done_at ? openMemeMap() : openMemes())),
    row("For fun: Undercurrents", under, () => openStand()));
  // 3. Party fit by electorate
  const lf = lineFit(Q);
  const ny = lf.length ? el("ul", { class: "cpos" }, ...lf.map((x) => el("li", {}, el("b", { text: x.l + ": " }),
    (x.avg != null ? x.avg + "% average agreement with its " + x.cs.length + " candidate" + (x.cs.length > 1 ? "s" : "") + " you can be scored against" : "no scored candidates") +
    (x.dist != null ? " · " + (x.dist < 0.35 ? "close to" : x.dist < 0.7 ? "some way from" : "far from") + " your economic and cultural answers" : "")))) : el("p", { class: "fine", text: "Answer the election check to see this." });
  const fed = el("ul", { class: "cpos" },
    el("li", { text: "Your Pew group: " + (me.pew || "not recorded") + "; your self-placement: " + (me.anes != null ? (ANES.find(([v]) => v === me.anes) || [0, ""])[1].toLowerCase() : "not recorded") + "." }),
    ...(() => { const g = data.voter_guide; if (!g || !g.quiz) return []; const r = (g.races || []).find((x) => x.id === "ny18"); if (!r) return [];
      const a = withProposals("election", ((Q.elections || {})[g.id] || {}).answers || {});
      return r.candidates.map((c) => { const m = matchFor(g, c.name, a); return el("li", { text: "US House: " + c.name + " (" + (c.lines || [])[0] + ") · " + (m.n >= 2 ? m.pct + "% on " + m.n + " statements" : "too few shared statements") }); }); })());
  const il = ilFit(Q);
  const blocName = { gov: "the governing bloc", opp: "the opposition bloc", arab: "the Arab lists" };
  const blocs = {}; for (const x of il) (blocs[x.l.bloc] = blocs[x.l.bloc] || []).push(x.pct);
  const blocBest = Object.entries(blocs).map(([b, xs]) => [b, Math.round(xs.reduce((s, v) => s + v, 0) / xs.length)]).sort((a, b) => b[1] - a[1]);
  const isr = il.length ? el("ul", { class: "cpos" }, el("li", { text: "Closest lists: " + il.slice(0, 3).map((x) => x.l.name + " " + x.pct + "%").join(", ") + "." }),
    blocBest.length ? el("li", { text: "By bloc: " + blocBest.map(([b, v]) => blocName[b] + " " + v + "%").join(", ") + "." }) : null) : el("p", { class: "fine", text: "Take the Israel match to see this." });
  const local = (() => { const g = data.voter_guide; if (!g || !g.quiz) return null;
    const a = withProposals("election", ((Q.elections || {})[g.id] || {}).answers || {});
    const races = (g.races || []).filter((r) => !["governor", "attorney_general", "comptroller", "ny18"].includes(r.id));
    const rows = races.map((r) => { const ms = r.candidates.map((c) => ({ c, m: matchFor(g, c.name, a) })).filter((x) => x.m.n >= 2).sort((x, y) => y.m.pct - x.m.pct);
      return ms.length ? el("li", { text: r.office + (r.district ? " (" + r.district + ")" : "") + ": " + ms.map((x) => x.c.name + " " + x.m.pct + "%").join(", ") }) : null; }).filter(Boolean);
    return rows.length ? el("ul", { class: "cpos" }, ...rows) : el("p", { class: "fine", text: "Local races are candidate by candidate; too few shared statements to score yet." }); })();
  // 4. Disagreements, drift, platform draft
  const drift = (V.past || []).length && sc ? (() => { const p = standScores(V.past[0].answers || {}); return el("p", { text: "Since your last take (" + fmtDate.format(new Date(V.past[0].done_at)) + "): " + bank.axes.filter((a) => p[a.id].s != null && sc[a.id].s != null && Math.abs(sc[a.id].s - p[a.id].s) >= 0.1).map((a) => a.label.toLowerCase() + " " + (sc[a.id].s > p[a.id].s ? "toward " + a.right : "toward " + a.left).toLowerCase()).join(", ") + "." }); })() : el("p", { class: "fine", text: "Shows after a second take of Where you stand (it offers a retake about once a year), and as your debate positions build up." });
  const platform = () => {
    const lines = ["MY POSITIONS (confirmed)", ...pos.filter((p) => p.confirmed === true).map((p) => "- " + p.summary + " [" + p.topic + "]"),
      "", "MY PROPOSALS", ...props.map(([k, p]) => "- " + ((data.solutions || {})[k] || {}).title + ": " + p.text),
      "", "BEST LINES", ...((dData.log || []).flatMap((s) => (s.recap && s.recap.sharpest) || []).slice(0, 8).map((q) => "- “" + q + "”"))];
    return lines.join("\n");
  };
  const copyBtn = el("button", { class: "sbtn wide", text: "Copy my platform draft", onclick: async (ev) => { try { await navigator.clipboard.writeText(platform()); ev.target.textContent = "✓ Copied"; } catch (e) { ev.target.textContent = "Couldn't copy"; } } });
  openSheet([
    el("span", { class: "mlabel", text: "Private · Cloudflare only" }),
    el("h2", { id: "sheet-title", class: "stitle", text: "Your profile" }),
    el("p", { class: "sdesc", text: nAnswers + " questionnaire answers, " + props.length + " proposals, " + pos.length + " debate positions (" + firm.length + " firm). Everything here comes from those; nothing is guessed from what you read." }),
    notice ? el("p", { class: "okmsg", text: notice }) : null,
    sec("Where you sit", sit, sharpen, el("p", { class: "fine", text: "Sharpen asks 4 to 6 new statements on the two scales where your profile is thinnest or most mixed. Your core 30 stay fixed so yearly retakes still measure how you've moved." }), el("button", { class: "linkbtn", text: "The map and readings ›", onclick: () => openStand() })),
    sec("Your labels", labels, el("p", { class: "fine", text: "Your own placement and outside tools beside The Wire's reading. They measure different things, so they won't always agree; that's useful." })),
    sec("New York · which party fits", partyFit(Q, "ny").length ? partyList(partyFit(Q, "ny")) : null,
      el("p", { class: "fine", text: partyFit(Q, "ny").length ? "Above: each party's own platform and agenda, coded on the statements. Below: the candidates on each line this year." : "Party platforms are being coded; for now, from the candidates on each line and The Wire's rough placement of each line." }), ny),
    sec("Federal", partyFit(Q, "us").length ? partyList(partyFit(Q, "us")) : null, fed),
    sec("Israel", isr),
    sec("Beacon and Dutchess", local, data.local ? el("button", { class: "sbtn wide", text: "Local politics: players, parties, elections, the independent path ›", onclick: () => openLocal() }) : null),
    clashes.length ? sec("Where your answers disagree · " + clashes.length, el("ul", { class: "cpos" }, ...clashes.slice(0, 6).map((c) => el("li", { text: "“" + c.it.text + "”: your proposal reads " + (SCALE.find(([v]) => v === c.c.v) || [0, ""])[1].toLowerCase() + ", your answer " + (SCALE.find(([v]) => v === c.a.v) || [0, ""])[1].toLowerCase() + "." })))) : null,
    sec("How you've moved", drift),
    firm.length ? sec("Firm positions", el("ul", { class: "cpos" }, ...firm.slice(0, 8).map((p) => el("li", { text: p.summary })))) : null,
    sec("People to watch", (data.watch_pool || []).length ? el("p", { class: "fine", text: (followsNow().topics || []).filter((t) => String(t.id).startsWith("person_")).length + " watched. Officials and rising figures across parties, with how their sourced positions compare with yours." }) : el("p", { class: "fine", text: "The list is being researched; it appears here when it's ready." }),
      (data.watch_pool || []).length ? el("button", { class: "sbtn wide", text: "Open people to watch", onclick: () => openWatch() }) : null),
    sec("Platform draft", el("p", { class: "fine", text: "For later: your confirmed positions, proposals and best debate lines as plain text, ready to start a platform from. Nothing leaves this page unless you paste it somewhere." }), copyBtn),
  ].filter(Boolean), "Your profile");
}

// --------------------------------------------------------------- People to watch (2026-10-26)
// A neutral, balanced pool of public figures (watch_pool.yaml: officials and rising figures across
// parties, with sourced positions on the election check's statements). Closeness to Joe is computed
// here on the page only. Watching someone follows their name as a topic, so their news, votes and
// moves collect in a thread over the years.
const WGROUP = [["beacon", "Beacon"], ["dutchess", "Dutchess County"], ["state", "New York"], ["national", "Washington"], ["israel", "Israel"]];
function personFit(p, answers) {
  let num = 0, den = 0, n = 0;
  for (const [q, x] of Object.entries(p.codes || {})) { const a = answers[q]; if (!a || a.skip || a.v == null) continue; const w = a.w || 2; num += w * (1 - Math.abs(a.v - x.v) / 4); den += w; n += 1; }
  return n >= 2 ? { pct: Math.round(100 * num / den), n } : { pct: null, n };
}
async function openWatch(group) {
  const Q = await loadQuiz(true);
  const g = data.voter_guide;
  const answers = withProposals("election", g ? (((Q.elections || {})[g.id] || {}).answers || {}) : {});
  const pool = data.watch_pool || [];
  const watching = new Set((followsNow().topics || []).filter((t) => String(t.id).startsWith("person_")).map((t) => t.id));
  const grp = group || "beacon";
  const list = pool.filter((p) => p.group === grp).map((p) => ({ p, f: personFit(p, answers) }))
    .sort((a, b) => watching.has("person_" + b.p.id) - watching.has("person_" + a.p.id) || (b.f.pct ?? -1) - (a.f.pct ?? -1));
  const card = ({ p, f }) => {
    const on = watching.has("person_" + p.id);
    return el("details", { class: "race" },
      el("summary", {}, el("span", { class: "rtitle" }, el("b", { text: p.name }), " · " + p.party + (on ? " · watching" : "")),
        el("span", { class: "rsub", text: p.role + (f.pct != null ? " · " + f.pct + "% agreement on " + f.n + " statements" : "") }), el("span", { class: "chev", text: "▾" })),
      el("p", { text: p.why_watch }),
      (p.career || []).length ? el("ul", { class: "cpos" }, ...p.career.map((c) => el("li", { text: c }))) : null,
      f.n ? el("p", { class: "fine", text: "Agreement uses only their sourced positions on the election check (" + f.n + " in common); a rough guide, not their whole record." }) : null,
      el("div", { class: "sactions" },
        el("button", { class: "sbtn" + (on ? "" : " primary"), text: on ? "Stop watching" : "Watch their career", onclick: async () => {
          await setFollow({ action: on ? "unfollow" : "follow", type: "topic", id: "person_" + p.id, title: p.name, kind: "entity", desk: p.group === "israel" ? "WORLD" : p.group === "beacon" || p.group === "dutchess" ? "BEACON" : "GOV",
              pattern: p.name });
          openWatch(grp); } }),
        ...(p.links || []).slice(0, 2).map((u) => link(u, (() => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "link"; } })() + " ↗", "sbtn"))));
  };
  openSheet([
    el("button", { class: "linkbtn", text: "‹ Your profile", onclick: () => openProfile() }),
    el("h2", { id: "sheet-title", class: "stitle", text: "People to watch" }),
    el("p", { class: "sdesc", text: "Officials and rising figures across parties, chosen for where their careers are heading, not for agreeing with you. Agreement shows where their sourced positions overlap your answers. Watching someone follows their name, so their news collects in a thread over time." }),
    el("div", { class: "wrow" }, ...WGROUP.map(([k, label]) => el("button", { class: "chip" + (k === grp ? " on" : ""), text: label, onclick: () => openWatch(k) }))),
    list.length ? el("div", {}, ...list.map(card)) : el("p", { class: "fine", text: "No one in this group yet." }),
  ], "People to watch");
}

// --------------------------------------------------------------- Local politics (2026-10-26)
// Beacon and Dutchess: the parties and their officers, officials and key players, every city
// election since 2017, enrollment and results by district, party money, the calendar, and the
// independent path (New York law for voting, running or backing someone without a party). Public
// records only (local_politics.yaml, beacon_elections.yaml, independent_path.yaml).
const LTABS = [["players", "Players"], ["parties", "Parties"], ["elections", "Elections"], ["money", "Money"], ["calendar", "Calendar"], ["independent", "Independent path"]];
const human = (k) => String(k).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const isUrl = (s) => typeof s === "string" && /^https?:\/\//.test(s);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "link"; } };
// A plain renderer for nested public records: keys become labels, URLs become small links.
function renderAny(v, depth) {
  depth = depth || 0;
  if (v == null) return null;
  if (isUrl(v)) return link(v, hostOf(v) + " ↗", "srcl");
  if (typeof v !== "object") return el("span", { text: String(v) });
  if (Array.isArray(v)) {
    if (v.every(isUrl)) return el("span", { class: "fine" }, ...v.flatMap((u, i) => [i ? " · " : "", link(u, hostOf(u) + " ↗", "srcl")]));
    if (v.every((x) => typeof x !== "object")) return el("span", { text: v.join(", ") });
    return el("ul", { class: "cpos" }, ...v.map((x) => el("li", {}, renderAny(x, depth + 1))));
  }
  const keys = Object.keys(v).filter((k) => !["sources", "source"].includes(k));
  const src = v.sources || v.source;
  return el(depth ? "div" : "div", { class: "lrec" }, ...keys.map((k) => typeof v[k] === "object" && v[k] && !Array.isArray(v[k]) && depth < 3
      ? el("details", { class: "rest" }, el("summary", {}, el("span", { text: human(k) }), el("span", { class: "chev", text: "▾" })), renderAny(v[k], depth + 1))
      : el("div", {}, el("b", { text: human(k) + ": " }), renderAny(v[k], depth + 1))),
    src ? el("div", { class: "fine" }, "Source: ", renderAny(Array.isArray(src) ? src : [src], depth + 1)) : null);
}
function localEntry() {
  if (!data.local) return null;
  return el("div", { class: "rbox quizbox" }, el("span", { class: "mlabel", text: "Local politics" }),
    el("p", { class: "rjob", text: "Beacon and Dutchess: who holds power, the parties and their officers, every city election since 2017, the money, the calendar to 2027, and what it takes to run or back someone without a party." }),
    el("button", { class: "sbtn primary wide", text: "Open", onclick: () => openLocal() }));
}
function partyBar(counts) {
  const order = ["DEM", "REP", "BLANK", "CON", "WOR", "IND", "GRE", "LBT", "OTH", "WEP", "REF"];
  const name = { DEM: "Democratic", REP: "Republican", BLANK: "No party", CON: "Conservative", WOR: "Working Families", IND: "Independence", GRE: "Green", LBT: "Libertarian", OTH: "Other", WEP: "Women's Equality", REF: "Reform" };
  const tot = Object.values(counts).reduce((s, x) => s + (Number(x) || 0), 0);
  const parts = order.filter((k) => counts[k]).map((k) => [k, counts[k]]);
  return el("div", {}, el("div", { class: "pbar2" }, ...parts.map(([k, n]) => el("span", { class: "pseg p-" + k, style: "width:" + (100 * n / tot).toFixed(1) + "%", title: name[k] + " " + n }))),
    el("p", { class: "fine", text: parts.filter(([, n]) => n / tot >= 0.01).map(([k, n]) => name[k] + " " + Math.round(100 * n / tot) + "% (" + n.toLocaleString() + ")").join(" · ") + " · " + tot.toLocaleString() + " voters" }));
}
function openLocal(tabId) {
  const L = data.local || {}, E = data.local_elections || {}, I = data.independent || {};
  const t = tabId || "players";
  const tabs = el("div", { class: "wrow" }, ...LTABS.map(([k, label]) => el("button", { class: "chip" + (k === t ? " on" : ""), text: label, onclick: () => openLocal(k) })));
  let body = [];
  if (t === "players") {
    body = [el("p", { class: "sdesc", text: "The people who shape Beacon and Dutchess politics now, from public records and local reporting." }),
      ...(L.players || []).map((p) => el("div", { class: "lplayer" }, el("b", { text: p.name }), el("span", { class: "asrc", text: " · " + (p.party || "") }),
        el("p", { class: "fine", text: p.role }), p.why ? el("p", { text: p.why }) : null, p.source ? renderAny([p.source]) : null)),
      el("h3", { class: "sh3", text: "Officials" }), renderAny(L.officials || {}, 1)];
  } else if (t === "parties") {
    body = [el("p", { class: "sdesc", text: "Party committees and their officers, as published or filed. Officers hold public party roles; committee members appear only as listed in public filings." }),
      ...(L.parties || []).map((p) => el("details", { class: "race" },
        el("summary", {}, el("span", { class: "rtitle" }, el("b", { text: p.name })), el("span", { class: "rsub", text: p.level || "" }), el("span", { class: "chev", text: "▾" })),
        renderAny(Object.fromEntries(Object.entries(p).filter(([k]) => k !== "name")), 1)))];
  } else if (t === "elections") {
    const enr = E.enrollment || [];
    const latest = enr[enr.length - 1];
    const byYear = {};
    for (const r of E.results || []) (byYear[r.year] = byYear[r.year] || []).push(r);
    body = [
      el("h3", { class: "sh3", text: "Who's enrolled in Beacon" }),
      ...enr.map((e) => el("div", {}, el("p", { class: "asrc", text: e.as_of + " · " + (e.publisher || "") }), partyBar((e.totals && (e.totals.active || e.totals.total)) || {}))),
      el("p", { class: "fine", text: "Enrollment from 2022 on sits on the state elections site, which blocks automated downloads; paste its Dutchess enrollment link in a chat and it can be added." }),
      el("h3", { class: "sh3", text: "Every city election since 2017" }),
      ...((L.contests || {}).beacon_history || []).map((h) => el("details", { class: "race" },
        el("summary", {}, el("span", { class: "rtitle" }, el("b", { text: String(h.year) }), " · " + (h.contested || "")), el("span", { class: "chev", text: "▾" })),
        renderAny(Object.fromEntries(Object.entries(h).filter(([k]) => !["year", "contested"].includes(k))), 1))),
      el("h3", { class: "sh3", text: "Results by contest" }),
      ...Object.keys(byYear).sort().reverse().map((y) => el("details", { class: "race" },
        el("summary", {}, el("span", { class: "rtitle" }, el("b", { text: y + " general" })), el("span", { class: "chev", text: "▾" })),
        ...byYear[y].map((r) => el("div", { class: "lres" }, el("b", { text: r.office }),
          el("ul", { class: "cpos" }, ...(r.candidates || []).map((c) => el("li", { text: c.name + " · " + (c.votes || 0).toLocaleString() + (c.lines ? " (" + Object.entries(c.lines).map(([k, n]) => k + " " + n).join(", ") + ")" : "") }))),
          r.source ? renderAny([r.source]) : null)))),
    ];
  } else if (t === "money") {
    const M = L.money || {};
    body = [el("p", { class: "sdesc", text: M.method || "" }),
      ...((M.party_committees) || []).map((c) => { const yrs = Object.entries(c.itemized_raised_by_year || {}); const mx = Math.max(1, ...yrs.map(([, v]) => v));
        return el("div", { class: "lmoney" }, el("b", { text: c.name }), el("div", { class: "mbars" }, ...yrs.map(([y, v]) => el("div", { class: "mbar" }, el("span", { class: "my", text: y }), el("span", { class: "mfill", style: "width:" + Math.round(100 * v / mx) + "%" }), el("span", { class: "mv", text: "$" + Math.round(v / 1000) + "k" })))),
          c.note ? el("p", { class: "fine", text: c.note }) : null, c.source ? renderAny([c.source]) : null); }),
      renderAny(Object.fromEntries(Object.entries(M).filter(([k]) => !["method", "party_committees", "datasets"].includes(k))), 1)];
  } else if (t === "calendar") {
    body = Object.entries(L.calendar || {}).sort(([a], [b]) => (/^\d/.test(a) ? 1 : 0) - (/^\d/.test(b) ? 1 : 0) || a.localeCompare(b)).map(([k, list]) => el("section", { class: "ssec" }, el("h3", { class: "sh3", text: human(k) }),
      Array.isArray(list) ? el("ul", { class: "cpos" }, ...list.map((c) => el("li", {}, el("b", { text: c.date + ": " }), c.event + (c.confidence ? " (" + c.confidence + ")" : "") + " ", c.source ? link(c.source, "↗", "srcl") : null))) : renderAny(list, 1)));
  } else {
    body = [el("p", { class: "sdesc", text: "What New York law asks of a voter, a candidate or a backer without a party, with the sections cited. Dates for 2027 are computed from the statutes until the state publishes its calendar." }),
      ...Object.entries(I).filter(([, v]) => Array.isArray(v)).map(([k, pts]) => el("section", { class: "ssec" }, el("h3", { class: "sh3", text: human(k) }),
        el("ul", { class: "cpos" }, ...pts.map((p) => el("li", {}, p.point + " ", el("span", { class: "fine" }, ...(p.cite || []).flatMap((c, i) => [i ? " · " : "", isUrl(c) ? link(c, hostOf(c), "srcl") : el("span", { text: c })]))))))),
    ];
  }
  openSheet([
    el("span", { class: "mlabel", text: "Beacon · Dutchess" + ((L.meta || {}).as_of ? " · as of " + L.meta.as_of : "") }),
    el("h2", { id: "sheet-title", class: "stitle", text: "Local politics" }),
    tabs, ...body.filter(Boolean),
    el("p", { class: "fine", text: "Public records and local reporting only, each with its source. People appear in their public roles; no one is profiled beyond that." }),
  ], "Local politics");
}

// --------------------------------------------------------------- Reels (2026-10-26)
// Joe's own clips, spliced in order for his reporting: start and end marks on a meeting video, a
// news clip or a podcast, with a note or quote. A clip is a reference (YouTube id or the
// publisher's audio URL plus times), never a copy; playback uses YouTube's own player and the
// publisher's file. Reels are private (/reels, KV). Export gives a script: sources, times, notes.
let myReels = null;
async function loadReels(force) {
  if (myReels && !force) return myReels;
  try { const r = await fetch("reels", { credentials: "same-origin" }); myReels = r.ok ? await r.json() : { reels: [] }; } catch (e) { myReels = myReels || { reels: [] }; }
  return myReels;
}
const reelPost = (body) => fetch("reels", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "HTTP " + r.status); myReels = j; return j; });
// A YouTube embed that reports its time and state (the player's postMessage protocol; no extra script).
function ytPlayer(vid, opts) {
  opts = opts || {};
  const q = "enablejsapi=1&playsinline=1&rel=0&origin=" + encodeURIComponent(location.origin) + (opts.start != null ? "&start=" + Math.floor(opts.start) : "") + (opts.end != null ? "&end=" + Math.ceil(opts.end) : "") + (opts.autoplay ? "&autoplay=1" : "");
  const frame = el("iframe", { class: "meetframe", allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: "", src: "https://www.youtube.com/embed/" + encodeURIComponent(vid) + "?" + q, title: opts.title || "Video" });
  const st = { t: opts.start || 0, state: -1 };
  const send = (o) => { try { frame.contentWindow.postMessage(JSON.stringify(o), "*"); } catch (e) { /* not ready */ } };
  frame.addEventListener("load", () => send({ event: "listening", id: 1, channel: "widget" }));
  const onMsg = (ev) => {
    if (ev.source !== frame.contentWindow) return;
    let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d && d.info) {
      if (typeof d.info.currentTime === "number") { st.t = d.info.currentTime; if (opts.onTime) opts.onTime(st.t); }
      if (typeof d.info.playerState === "number") { st.state = d.info.playerState; if (st.state === 0 && opts.onEnd) opts.onEnd(); }
    }
  };
  window.addEventListener("message", onMsg);
  return { frame, now: () => st.t, seek: (t) => { send({ event: "command", func: "seekTo", args: [t, true] }); send({ event: "command", func: "playVideo", args: [] }); }, stop: () => window.removeEventListener("message", onMsg) };
}
// Start/end controls for any source. getNow() gives the current time; base describes the source.
function clipControls(getNow, base) {
  let start = null;
  const status = el("span", { class: "fine", text: "" });
  const startBtn = el("button", { class: "sbtn", text: "⏺ Clip start" });
  const endBtn = el("button", { class: "sbtn", text: "⏹ Clip end", disabled: true });
  startBtn.onclick = () => { start = Math.floor(getNow()); status.textContent = "from " + mmss(start) + "…"; endBtn.disabled = false; };
  endBtn.onclick = () => { const end = Math.ceil(getNow()); if (start == null || end <= start) { status.textContent = "Play a little past the start first."; return; }
    saveClipSheet(Object.assign({}, base, { start, end }), () => { start = null; endBtn.disabled = true; status.textContent = "✓ clipped " + mmss(start || 0); }); };
  return el("div", { class: "clipctl" }, startBtn, endBtn, status);
}
function saveClipSheet(c, done) {
  loadReels().then(() => {
    const box = el("div", { class: "clipsave" });
    let pick = (myReels.reels[0] || {}).id || null;
    const title = el("input", { class: "tin", type: "text", placeholder: "New reel title" });
    const note = el("textarea", { class: "tin", rows: "2", placeholder: "Your note: why this matters (optional)" });
    const quote = el("input", { class: "tin", type: "text", placeholder: "A quote you heard (optional)" });
    const chips = el("div", { class: "wrow" }, ...myReels.reels.slice(0, 8).map((r) => { const b = el("button", { class: "chip" + (r.id === pick ? " on" : ""), text: r.title });
      b.onclick = () => { pick = r.id; title.value = ""; [...chips.children].forEach((x) => x.classList.toggle("on", x === b)); }; return b; }));
    title.oninput = () => { if (title.value) { pick = null; [...chips.children].forEach((x) => x.classList.remove("on")); } };
    const status = el("p", { class: "fine" });
    box.replaceChildren(el("b", { text: "Save clip " + mmss(c.start) + "–" + mmss(c.end) }), myReels.reels.length ? chips : null, title, note, quote,
      el("button", { class: "sbtn primary wide", text: "Save to reel", onclick: async () => {
        try { await reelPost({ action: "add", reel: pick, title: title.value || (pick ? null : "Untitled reel"), clip: Object.assign({}, c, { note: note.value, quote: quote.value }) });
          box.replaceChildren(el("p", { class: "okmsg", text: "✓ Saved to your reel." })); engage({ k: "story", f: "video", t: "reel clip" }); if (done) done(); }
        catch (e) { status.className = "errmsg"; status.textContent = e.message; } } }), status);
    const host = document.querySelector("#sheet .clipctl");
    if (host) host.after(box); else openSheet([box], "Save clip");
  });
}
function reelsEntry() {
  return el("div", { class: "rbox quizbox" }, el("span", { class: "mlabel", text: "Reels" }),
    el("p", { class: "rjob", text: "Your clips of meetings, hearings, news video and podcasts, in order: play them straight through or export a script for your own reporting." }),
    el("button", { class: "sbtn primary wide", text: "Open", onclick: () => openReels() }));
}
async function openReels() {
  await loadReels(true);
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "Reels" }),
    el("p", { class: "sdesc", text: "Clip from a Beacon meeting, a Watch clip or any podcast with ⏺ Clip start and ⏹ Clip end. Clips are references, not copies: they play from YouTube and the publisher." }),
    myReels.reels.length ? el("ul", { class: "admin" }, ...myReels.reels.map((r) => el("li", { class: "aqrow" },
      el("button", { class: "doclink", text: r.title, onclick: () => openReel(r.id) }),
      el("span", { class: "asrc", text: r.clips.length + " clip" + (r.clips.length === 1 ? "" : "s") + " · " + mmss(r.clips.reduce((s, c) => s + (c.end - c.start), 0)) })))) : el("p", { class: "fine", text: "No reels yet." }),
  ], "Reels");
}
const clipLink = (c) => c.kind === "yt" ? "https://www.youtube.com/watch?v=" + c.v + "&t=" + c.start + "s" : (c.link || c.src);
function reelScript(r) {
  const lines = [r.title.toUpperCase(), "Clips: " + r.clips.length + " · running time " + mmss(r.clips.reduce((s, c) => s + (c.end - c.start), 0)), ""];
  r.clips.forEach((c, i) => { lines.push((i + 1) + ". " + (c.source ? c.source + " · " : "") + c.title + " · " + mmss(c.start) + "–" + mmss(c.end));
    if (c.quote) lines.push("   “" + c.quote + "”"); if (c.note) lines.push("   Note: " + c.note); lines.push("   " + clipLink(c)); lines.push(""); });
  return lines.join("\n");
}
async function openReel(id) {
  await loadReels();
  const r = myReels.reels.find((x) => x.id === id);
  if (!r) return openReels();
  const save = async (clips, title) => { await reelPost({ action: "update", reel: r.id, clips, title }); openReel(r.id); };
  const rows = r.clips.map((c, i) => el("div", { class: "reelclip" },
    el("div", { class: "aqrow" }, el("b", { text: (i + 1) + ". " + c.title }), el("span", { class: "asrc", text: mmss(c.start) + "–" + mmss(c.end) })),
    el("span", { class: "asrc", text: (c.source || (c.kind === "yt" ? "YouTube" : "Audio")) }),
    c.quote ? el("p", { class: "fine", text: "“" + c.quote + "”" }) : null, c.note ? el("p", { text: c.note }) : null,
    el("div", { class: "wrow" },
      el("button", { class: "chip", text: "▶ Play", onclick: () => playReel(r, i, true) }),
      i > 0 ? el("button", { class: "chip", text: "↑", onclick: () => { const a = r.clips.slice(); [a[i - 1], a[i]] = [a[i], a[i - 1]]; save(a); } }) : null,
      i < r.clips.length - 1 ? el("button", { class: "chip", text: "↓", onclick: () => { const a = r.clips.slice(); [a[i + 1], a[i]] = [a[i], a[i + 1]]; save(a); } }) : null,
      el("button", { class: "chip", text: "−5s start", onclick: () => { const a = r.clips.slice(); a[i] = Object.assign({}, c, { start: Math.max(0, c.start - 5) }); save(a); } }),
      el("button", { class: "chip", text: "+5s end", onclick: () => { const a = r.clips.slice(); a[i] = Object.assign({}, c, { end: c.end + 5 }); save(a); } }),
      el("button", { class: "chip", text: "Note", onclick: () => { const n = prompt("Note for this clip", c.note || ""); if (n != null) { const a = r.clips.slice(); a[i] = Object.assign({}, c, { note: n }); save(a); } } }),
      el("button", { class: "unsave", text: "Remove", onclick: () => save(r.clips.filter((_, j) => j !== i)) }))));
  openSheet([
    el("button", { class: "linkbtn", text: "‹ Reels", onclick: () => openReels() }),
    el("h2", { id: "sheet-title", class: "stitle", text: r.title }),
    el("div", { class: "sactions" },
      r.clips.length ? el("button", { class: "sbtn primary", text: "▶ Play straight through", onclick: () => playReel(r, 0) }) : null,
      el("button", { class: "sbtn", text: "Copy script", onclick: async (ev) => { try { await navigator.clipboard.writeText(reelScript(r)); ev.target.textContent = "✓ Copied"; } catch (e) { ev.target.textContent = "Couldn't copy"; } } }),
      el("button", { class: "sbtn", text: "Rename", onclick: () => { const t = prompt("Reel title", r.title); if (t) save(null, t); } })),
    ...rows,
    el("p", { class: "fine", text: "The script lists each clip's source, times, quote, note and a link that opens at the right moment. To make an edited video, get the original files (a FOIL request to the city clerk for Beacon meetings; House and Senate floor video is free to download) and ask Claude to cut them in Descript from this script." }),
    el("p", { class: "fine" }, el("button", { class: "unsave", text: "Delete this reel", onclick: async () => { if (confirm("Delete “" + r.title + "”?")) { await reelPost({ action: "delete", reel: r.id }); openReels(); } } })),
  ].filter(Boolean), r.title);
}
// Plays clips in order: YouTube clips in its own player with start and end; audio clips from the
// publisher's file with a separate player that stops at the end mark.
let reelAudio = null;
function playReel(r, i, single) {
  const c = r.clips[i];
  if (!c) return openReel(r.id);
  if (typeof aud !== "undefined" && !aud.paused) aud.pause();
  if (playing) { playing = false; render(); }
  if (reelAudio) { reelAudio.pause(); reelAudio = null; }
  const next = () => { if (!single && i + 1 < r.clips.length) playReel(r, i + 1); };
  let media;
  if (c.kind === "yt") {
    let done = false;
    const p = ytPlayer(c.v, { start: c.start, end: c.end, autoplay: true, title: c.title, onEnd: () => { if (!done) { done = true; p.stop(); next(); } },
      onTime: (t) => { if (!done && t >= c.end - 0.3) { done = true; p.stop(); next(); } } });
    media = el("div", { class: "meetwrap" }, p.frame);
  } else {
    reelAudio = new Audio(c.src); reelAudio.preload = "auto";
    reelAudio.addEventListener("loadedmetadata", () => { reelAudio.currentTime = c.start; reelAudio.play().catch(() => {}); }, { once: true });
    reelAudio.addEventListener("timeupdate", () => { if (reelAudio && reelAudio.currentTime >= c.end) { reelAudio.pause(); next(); } });
    media = el("div", { class: "reelaudio" }, el("p", { class: "fine", text: "▶ Audio · " + mmss(c.start) + "–" + mmss(c.end) }), el("button", { class: "sbtn", text: "Pause / play", onclick: () => (reelAudio.paused ? reelAudio.play() : reelAudio.pause()) }));
  }
  openSheet([
    el("button", { class: "linkbtn", text: "‹ " + r.title, onclick: () => { if (reelAudio) reelAudio.pause(); openReel(r.id); } }),
    el("span", { class: "mlabel", text: "Clip " + (i + 1) + " of " + r.clips.length + " · " + mmss(c.start) + "–" + mmss(c.end) + (c.source ? " · " + c.source : "") }),
    el("h2", { id: "sheet-title", class: "stitle", text: c.title }),
    media,
    c.quote ? el("p", { class: "fine", text: "“" + c.quote + "”" }) : null, c.note ? el("p", { text: c.note }) : null,
    el("div", { class: "sactions" },
      i > 0 ? el("button", { class: "sbtn", text: "‹ Previous", onclick: () => playReel(r, i - 1, single) }) : null,
      i < r.clips.length - 1 ? el("button", { class: "sbtn primary", text: "Next ›", onclick: () => playReel(r, i + 1, single) }) : null),
  ].filter(Boolean), c.title);
}

// --------------------------------------------------------------- engagement log (2026-10-25)
// Joe: "see what I actually engage with versus what I think I engage with." Private: events go to
// /engage (KV, behind Access), batched: sent when 25 pile up or the page is hidden.
// Event: k kind, f format (article|video|podcast|audio|doc), t title, d desk, s seconds, h host.
const engageQ = [];
function engage(e) {
  engageQ.push(Object.assign({ at: new Date().toISOString() }, e));
  if (engageQ.length >= 25) flushEngage();
}
function flushEngage(keepalive) {
  if (!engageQ.length) return;
  const events = engageQ.splice(0);
  try { fetch("engage", { method: "POST", credentials: "same-origin", keepalive: Boolean(keepalive), headers: { "content-type": "application/json" }, body: JSON.stringify({ events }) }); } catch (e) { /* best effort */ }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { closeSheetTimer(); flushEngage(true); } });
window.addEventListener("pagehide", () => flushEngage(true));
function linkFormat(href) {
  const u = String(href || "").toLowerCase();
  if (/youtube\.com|youtu\.be|vimeo\.com|c-span\.org|\/video\//.test(u)) return "video";
  if (/podcast|megaphone|simplecast|libsyn|acast|anchor\.fm|spotify\.com\/(episode|show)|apple\.com\/.*podcast|\.mp3/.test(u)) return "podcast";
  if (/\.pdf($|\?)|courtlistener|legislation|nysenate\.gov|congress\.gov|gov\/.*(press|release)/.test(u)) return "doc";
  return "article";
}
// Every outbound link click, wherever it is on the page.
document.addEventListener("click", (ev) => {
  const a = ev.target.closest && ev.target.closest("a[href^='http']");
  if (!a) return;
  let host = ""; try { host = new URL(a.href).hostname.replace(/^www\./, ""); } catch (x) { /* ignore */ }
  engage({ k: "link", f: linkFormat(a.href), t: (a.textContent || "").trim().slice(0, 140) || $("sheet-title")?.textContent || "", h: host, d: tab });
}, true);
// Time spent on each sheet (stories, threads, explainers, quizzes).
let sheetOpen = null;
function closeSheetTimer() {
  if (!sheetOpen) return;
  const s = (Date.now() - sheetOpen.at) / 1000;
  if (s >= 3) engage({ k: "sheet", t: sheetOpen.title, s, d: tab });
  sheetOpen = null;
}

// --------------------------------------------------------------- detail sheet
let sheetReturn = null;
function openSheet(nodes, title) {
  closeSheetTimer();
  sheetOpen = { title: String(title || "").slice(0, 140), at: Date.now() };
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
  closeSheetTimer();
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
    it.meeting_video && it.video ? el("button", { class: "sbtn primary wide", text: "▶ Watch" + (pairMeeting(it, false) ? " with the agenda" : ""), onclick: () => openMeeting(it, pairMeeting(it, false)) }) : null,
    it.agenda && pairMeeting(it, true) ? el("button", { class: "sbtn primary wide", text: "▶ Watch this meeting with its agenda", onclick: () => openMeeting(pairMeeting(it, true), it) }) : null,
    it.agenda ? agendaList(it) : null,
    it.blotter ? blotterTable(it.blotter) : null,
    el("div", { class: "sactions" },
      link(it.link, "Open " + it.source + " ↗", "sbtn primary"),
      navigator.share ? el("button", { class: "sbtn", text: "Share", onclick: () => navigator.share({ title: it.title, url: it.link }).catch(() => {}) }) : null,
      saveBtn,
      el("button", { class: "sbtn", text: "Add to a thread", onclick: () => openAttachSheet(it) })),
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
      el("span", { class: "cht" + (v.live ? " onair" : v.live === false ? " offair" : ""), text: on ? "Playing" : v.link ? "Opens their site"
        : v.live ? "● Live" + (v.live_title ? " · " + v.live_title.replace(/^\s*(?:🔴|🟡)?\s*(?:LIVE(?: NEWS)?\s*:)?\s*/i, "") : "") : v.live === false ? "Not live now" + (v.note ? " · " + v.note : "")
        : (v.note || (v.audio ? "Live radio" : "Live stream")) }));
    return v.link
      ? el("div", { class: "chrow" }, el("a", { class: "chmain", href: v.link, target: "_blank", rel: "noopener" }, info, el("span", { class: "chgo out", "aria-hidden": "true", text: "↗" })), star)
      : el("div", { class: "chrow" + (on ? " on" : "") }, el("button", { class: "chmain", onclick: () => play(v.id) }, info, el("span", { class: "chgo", "aria-hidden": "true", text: on ? "■" : "▶" })), star);
  });
  return [
    el("div", { class: "stage", id: "stage" }, playing ? null : el("div", { class: "stage-empty", text: "Choose a channel below. It keeps playing in a small player while you read other tabs." })),
    pills,
    el("div", { class: "chlist" }, ...rows),
    onAirSection(),
    el("button", { class: "sbtn wide", text: "🎙 Debate night: react as you watch", onclick: () => { dState.mode = "night"; dSave(); openDebate(); } }),
    el("p", { class: "fine", text: "Official streams only: the publishers' own YouTube channels, players and radio streams. Live status is checked every 20 minutes; a channel that isn't live may still say the video is unavailable." }),
  ].filter(Boolean);
}

function play(id) {
  if (typeof aud !== "undefined" && !aud.paused) aud.pause();   // one thing at a time
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
  const key = (v.live_id ? v.live_id + "@" : "") + (v.channel_id || v.audio || v.embed);
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
      // The channel's current live video when the build found one (YouTube's channel-level
      // live embed misses most streams); otherwise the channel embed.
      src: (v.live_id ? "https://www.youtube.com/embed/" + encodeURIComponent(v.live_id) + "?" : "https://www.youtube.com/embed/live_stream?channel=" + encodeURIComponent(v.channel_id) + "&")
        + "autoplay=1&mute=0&playsinline=1&enablejsapi=1&origin=" + encodeURIComponent(location.origin),
      title: v.name + " live", "data-channel": key,
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
function openSettings() { go("settings"); }
if ($("settings-btn")) $("settings-btn").addEventListener("click", () => go("settings"));

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
  return { document: "Document", confirmed: "Confirmed by a second outlet", spread: "Spread", figures: "Figures changed", update: "Update", revived: "Back after a quiet spell", added: "Added by you" }[reason] || "Update";
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

// Today's strip: followed threads with something new, then the rest, four at most; the Threads tab has everything.
function threadsStrip() {
  const mine = (data.threads || []).filter((t) => isFollowed(t.id));
  const since = prevVisit && Date.now() - prevVisit < 48 * 3600e3 ? prevVisit : Date.now() - 24 * 3600e3;
  const ranked = mine.slice().sort((a, b) => ((b.developments || []).some((d) => Date.parse(d.t) > since) - (a.developments || []).some((d) => Date.parse(d.t) > since)) || Date.parse(b.last) - Date.parse(a.last));
  const head = sectionHead("Your threads", mine.length ? mine.length + " followed" : null, () => goThreads(mine.length ? "following" : "browse"), mine.length ? "All threads" : "Find threads");
  if (!mine.length) return [head, el("p", { class: "sdesc", text: "Follow any story with the Follow button, start a thread from any report, or browse the live threads. Followed threads collect every report, development and document." })];
  const out = [head, el("div", { class: "threads" }, ...ranked.slice(0, 4).map(threadCard))];
  const sugg = (data.suggest || []).map((id) => (data.threads || []).find((t) => t.id === id)).filter((t) => t && !isFollowed(t.id));
  if (sugg.length) out.push(el("p", { class: "fine" }, "You might follow: ", ...sugg.slice(0, 2).flatMap((t, i) => [i ? " · " : "", el("button", { class: "linkbtn", text: t.title, onclick: () => openThread(t) })])));
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
      t.revived_at ? el("span", { class: "dev back", text: "Back after a quiet spell" }) : null,
      t.standing ? el("span", { class: "dev standing", text: t.desk === "LAW" ? "Area of law" : "Standing thread" }) : el("span", { text: (t.kind || "thread")[0].toUpperCase() + (t.kind || "thread").slice(1) }),
      el("span", { class: "dk", style: "--c: var(--" + t.desk.toLowerCase() + ")", text: DESK_NAME[t.desk] || t.desk }),
      el("span", { text: "Opened " + exact(Date.parse(t.opened)) })),
    el("h2", { id: "sheet-title", class: "stitle", text: t.title }),
    el("p", { class: "fine" }, (t.outlets > 1 ? t.outlets + " outlets · " : "") + t.n_reports + " reports · " + devs.length + " developments" + (newCount ? " · " : ""),
      newCount ? el("span", { class: "since", text: newCount + " new since you last looked" }) : null),
    el("div", { class: "sactions" }, follow, briefBtn, ...signalButtons(t)),
    askBox(t),
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
        it ? el("button", { class: "doclink", text: d.title, onclick: () => openItem(it) }) : link(d.link, d.title),
        d.excerpt ? el("blockquote", { class: "excerpt" }, el("span", { class: "mlabel", text: "Opening, verbatim" }), el("p", { text: d.excerpt }), link(d.link, "Read the document ↗")) : null); }))) : null,
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
      el("li", {}, el("span", { class: "asrc", text: ago(it.ms) + " · " + byline(it) + (it.translated ? " · translated" : "") + ((t.added || []).includes(it.id) ? " · added by you" : "") }), link(it.link, it.title)))),
      addReportBox(t)),
    t.standing ? el("p", { class: "fine", text: "A standing area of law (threads.yaml). Decisions, rules and notices accrue here. Watching for: " + (t.pattern || t.title) }) :
      t.manual ? el("p", { class: "fine", text: "A thread you built by hand. Only reports you add belong to it; add watch terms from Follow a topic to let it grow on its own." }) :
      t.named ? el("p", { class: "fine", text: "A topic you named. Watching for: " + (t.pattern || t.title) }) : null,
    el("div", { class: "endline", text: "End of thread" }),
  ];
  openSheet(nodes.filter(Boolean), t.title);
}

// More / less like this (stage 4): a signal stored with the follows; the build re-ranks by it.
function kindLabel(t) { return t.standing ? (t.desk === "LAW" ? "area of law" : "standing thread") : t.manual ? "hand-built" : t.kind || "thread"; }
function signalOf(tid) { const sg = (followsNow().signals || []).find((x) => x.id === tid); return sg ? sg.value : null; }
function signalButtons(t) {
  const cur = signalOf(t.id);
  return [["more", "More like this"], ["less", "Less like this"]].map(([v, label]) => {
    const b = el("button", { class: "sbtn signal" + (cur === v ? " on" : ""), text: (cur === v ? "✓ " : "") + label });
    b.onclick = async () => {
      b.textContent = "…";
      const ok = await setFollow({ action: "signal", id: t.id, value: cur === v ? "clear" : v, title: t.title, desk: t.desk, kind: t.kind });
      if (ok) openThread((data.threads || []).find((x) => x.id === t.id) || t);
      else b.textContent = "Couldn't save";
    };
    return b;
  });
}

// Ask this thread a question (stage 3): answered only from the thread's sources, with citations.
function askBox(t) {
  const input = el("input", { type: "text", class: "tin ask", placeholder: "Ask this thread: what did the court hold? who said what? what changed?", enterkeyhint: "send" });
  const btn = el("button", { class: "sbtn primary", text: "Ask" });
  const out = el("div", { class: "answer" });
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 3) return;
    btn.textContent = "Reading the sources…"; btn.disabled = true;
    out.replaceChildren();
    try {
      const r = await fetch("ask", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread: t.id, question: q }) });
      const j = await r.json();
      if (!r.ok) { out.append(el("p", { class: "fine", text: j.error || "Couldn't ask (HTTP " + r.status + ")." })); return; }
      const byN = Object.fromEntries((j.sources || []).map((src) => [src.n, src]));
      if (j.answer && j.answer.length) {
        out.append(el("span", { class: "mlabel", text: "Answer · written from " + (j.sources || []).length + " of this thread's " + j.n_sources + " sources · every number and quote checked" }));
        for (const a of j.answer) {
          const p = el("p", { text: a.text + " " });
          for (const n of a.refs) { const src = byN[n]; if (src) p.append(el("a", { class: "cite", href: src.link, target: "_blank", rel: "noopener", text: "[" + n + "]", title: src.source + ": " + src.title })); }
          out.append(p);
        }
      }
      if (j.notice) out.append(el("p", { class: "fine", text: j.notice }));
      if (j.sources && j.sources.length) out.append(el("ol", { class: "cites" }, ...j.sources.map((src) => el("li", { value: src.n },
        el("span", { class: "asrc", text: (src.kind === "document" ? "Document · " : "") + src.source + " · " + ago(Date.parse(src.t)) + " · " }), link(src.link, src.title)))));
    } catch (e) {
      out.append(el("p", { class: "fine", text: "Couldn't reach the site. Are you online and signed in?" }));
    } finally { btn.textContent = "Ask"; btn.disabled = false; }
  };
  btn.onclick = run;
  input.onkeydown = (e) => { if (e.key === "Enter") run(); };
  return el("div", { class: "askbox" }, el("div", { class: "askrow" }, input, btn), out);
}

// Add a report to a thread, or start a new thread with it. Attachments live with the follows;
// the next build puts the report on the thread and logs it as "Added by you".
function attachTo(target, it) {
  if (target.standing || (target.id || "").startsWith("topic_") || target.named) {
    return setFollow({ action: "attach", type: "topic", id: target.id, item: it.id, title: target.title, desk: target.desk, kind: target.kind, pattern: target.pattern || "" });
  }
  return setFollow({ action: "attach", type: "thread", id: target.id, item: it.id, title: target.title });
}
function threadRow(t, it, after) {
  const b = el("button", { class: "sbtn follow compact", text: "Add" });
  b.onclick = async () => { b.textContent = "…"; const ok = await attachTo(t, it); b.textContent = ok ? "✓ Added" : "Couldn't save"; if (ok && after) after(); };
  return el("li", {}, el("span", { class: "asrc", text: kindLabel(t) + " · " + (DESK_NAME[t.desk] || t.desk) + " · " + t.n_reports + " reports" + (isFollowed(t.id) ? " · following" : "") }),
    el("button", { class: "doclink", text: t.title, onclick: () => openThread(t) }), el("span", { class: "sgrow" }, b));
}
function openAttachSheet(it) {
  const q = el("input", { type: "text", class: "tin", placeholder: "Find a thread by name" });
  const list = el("ul", { class: "suggest" });
  const all = (data.threads || []).slice().sort((a, b) => (isFollowed(b.id) - isFollowed(a.id)) || Date.parse(b.last) - Date.parse(a.last));
  const draw = () => {
    const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = all.filter((t) => !(t.members || []).includes(it.id) && words.every((w) => t.title.toLowerCase().includes(w))).slice(0, 12);
    list.replaceChildren(...hits.map((t) => threadRow(t, it)));
    if (!hits.length) list.append(el("li", { class: "fine", text: "No thread by that name. Start one below." }));
  };
  q.oninput = draw; draw();
  const title = el("input", { type: "text", class: "tin", value: it.title.slice(0, 120) });
  const pattern = el("input", { type: "text", class: "tin", placeholder: "Optional: words to watch for, comma-separated, so it grows on its own" });
  const desk = el("select", { class: "tin" }, ...["BEACON", "GOV", "LAW", "WORLD", "SPORTS"].map((d) => el("option", { value: d, text: DESK_NAME[d], selected: d === it.desk || undefined })));
  const kind = el("select", { class: "tin" }, ...[["subject", "Subject"], ["process", "Process (an application, bill or case)"], ["entity", "Entity (a place, company or team)"], ["law", "Area of law"], ["event", "Event"]].map(([v, l]) => el("option", { value: v, text: l })));
  const status = el("p", { class: "fine" });
  const start = el("button", { class: "sbtn primary wide", text: "Start a thread with this" });
  start.onclick = async () => {
    if (!title.value.trim()) { status.textContent = "Give the thread a name."; return; }
    start.textContent = "Saving…";
    const ok = await setFollow({ action: "attach", type: "topic", item: it.id, title: title.value.trim(), pattern: pattern.value.trim(), desk: desk.value, kind: kind.value });
    status.textContent = ok ? "Started. The next build (within 15 minutes) opens the thread with this report in it; it appears under Threads you follow." : "Couldn't save. Are you signed in?";
    start.textContent = "Start a thread with this";
  };
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "Add to a thread" }),
    el("p", { class: "sdesc", text: it.title }),
    el("label", { class: "flab", text: "An existing thread" }), q, list,
    el("h3", { class: "sh3", text: "Or start a new one" }),
    el("label", { class: "flab", text: "Name" }), title,
    el("label", { class: "flab", text: "Watch for" }), pattern,
    el("label", { class: "flab", text: "Desk" }), desk,
    el("label", { class: "flab", text: "Kind" }), kind,
    el("div", { class: "sactions" }, start), status,
  ], "Add to a thread");
}

// On a thread page: search the feed and add a report to this thread.
function addReportBox(t) {
  const q = el("input", { type: "text", class: "tin", placeholder: "Add a report: search headlines" });
  const list = el("ul", { class: "also" });
  const have = new Set(t.members || []);
  q.oninput = () => {
    const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length < 1 || q.value.trim().length < 3) { list.replaceChildren(); return; }
    const hits = data.items.filter((it) => !have.has(it.id) && words.every((w) => it.title.toLowerCase().includes(w))).slice(0, 10);
    list.replaceChildren(...hits.map((it) => {
      const b = el("button", { class: "sbtn follow compact", text: "Add" });
      b.onclick = async () => { b.textContent = "…"; const ok = await attachTo(t, it); b.textContent = ok ? "✓ Added" : "Couldn't save"; };
      return el("li", { class: "addrow" }, el("span", { class: "asrc", text: ago(it.ms) + " · " + byline(it) }), el("span", { text: it.title }), b);
    }));
    if (!hits.length) list.append(el("li", { class: "fine", text: "Nothing in the feed matches." }));
  };
  return el("div", { class: "addbox" }, q, list, el("p", { class: "fine", text: "Added reports join the thread on the next build and are marked as yours." }));
}


// Threads you might follow (stage 4): the build's suggestions, with a reason.
function suggestSection() {
  const ids = data.suggest || [];
  const threads = ids.map((id) => (data.threads || []).find((t) => t.id === id)).filter((t) => t && !isFollowed(t.id));
  if (!threads.length) return [];
  return [sectionHead("You might follow", "from what you follow and ask for more of"),
    el("ul", { class: "suggest" }, ...threads.map((t) => el("li", {},
      el("span", { class: "asrc", text: (t.kind || "thread") + " · " + (DESK_NAME[t.desk] || t.desk) + " · " + (t.outlets > 1 ? t.outlets + " outlets · " : "") + (t.developments || []).length + " developments" }),
      el("button", { class: "doclink", text: t.title, onclick: () => openThread(t) }),
      el("span", { class: "sgrow" }, followButton({ thread: t.id }, true)))))];
}

// Areas of law (stage 3): the standing threads from threads.yaml, on the Law tab.
function areasOfLaw(desk) {
  const areas = (data.threads || []).filter((t) => t.standing && t.desk === desk);
  if (!areas.length) return [];
  const since = prevVisit && Date.now() - prevVisit < 48 * 3600e3 ? prevVisit : Date.now() - 24 * 3600e3;
  return [desk === "LAW" ? sectionHead("Areas of law", "decisions, rules and notices as they accrue") : sectionHead("Standing threads", "subjects tracked over time"),
    el("ul", { class: "areas" }, ...areas.map((t) => {
      const devs = t.developments || [];
      const last = devs[devs.length - 1];
      const fresh = devs.filter((d) => Date.parse(d.t) > since).length;
      return el("li", {}, el("button", { class: "area", onclick: () => openThread(t) },
        el("span", { class: "headline", text: t.title }),
        el("span", { class: "meta" }, el("span", { text: t.n_reports + " reports" }), el("span", { text: (t.docs || []).length + " documents" }),
          fresh ? el("span", { class: "since", text: fresh + " new" }) : null),
        last ? el("span", { class: "tnew" }, el("b", { text: ago(Date.parse(last.t)) + " ago: " }), last.text + " · " + last.source) : el("span", { class: "tnew quiet", text: "Nothing matched yet." })));
    }))];
}

// --------------------------------------------------------------- News › Israel (2026-10-21)
// The election first (key dates, the latest polls by pollster, the thread), then Israel's
// standing threads, its top stories as units, and every report under a heading: election,
// politics, daily life, culture, security, the rest, and a small Jewish-world list.
const ITOPIC = [["election", "Election"], ["politics", "Politics and government"], ["society", "Society and daily life"], ["culture", "Culture, food and sport"],
  ["security", "Security"], ["news", "More from Israel"], ["jewish", "Jewish world"]];
const ilShown = {};
function israelView() {
  const out = [el("h1", { class: "yw", text: "Israel" }),
    el("div", { class: "ywsub", text: "Politics, daily life and culture · Hebrew headlines translated · as of " + fmtTime.format(new Date(Date.parse(data.generated_at))) })];
  const threads = data.threads || [];
  const elec = threads.find((t) => t.id === "il_election_2026");
  out.push(...electionBox(elec));
  const standing = threads.filter((t) => t.standing && t.group === "israel" && t.id !== "il_election_2026");
  if (standing.length) out.push(sectionHead("Israel threads", "tracked over time"), el("div", { class: "threads" }, ...standing.map(threadCard)));
  const cutoff = Date.now() - 48 * 3600e3;
  const isIl = (it) => it && it.itopic && it.itopic !== "jewish";
  const tops = (data.stories || []).filter((s) => storyOf.get(s.lead) === s && isIl(byId.get(s.lead)) && Date.parse(s.last) >= cutoff && (s.what || s.card || s.summary)).slice(0, 3);
  const featured = new Set(tops.map((s) => s.lead));
  if (tops.length) out.push(sectionHead("Top stories"), ...tops.map((s) => unit(s)).filter(Boolean));
  const pool = data.items.filter((it) => it.itopic && !featured.has(it.id) && !folded.has(it.id) && !isMuted(it) && it.ms >= cutoff);
  for (const [k, label] of ITOPIC) {
    const list = pool.filter((it) => it.itopic === k).sort((a, b) => b.ms - a.ms);
    if (!list.length) continue;
    const n = ilShown[k] || (k === "jewish" ? 4 : 6);
    const fresh = prevVisit ? list.filter((it) => !isSeen(it)).length : 0;
    out.push(sectionHead(label, list.length + (fresh ? " · " + fresh + " new" : "")));
    out.push(el("ol", { class: "list" }, ...list.slice(0, n).map((it) => row(it, { desk: false }))));
    if (list.length > n) out.push(el("button", { class: "more-btn", text: "Show " + Math.min(10, list.length - n) + " more",
      onclick: () => { const y = window.scrollY; ilShown[k] = n + 10; renderView("news"); window.scrollTo(0, y); } }));
  }
  out.push(el("p", { class: "fine", text: "Sources range from Haaretz and +972 on the left, through Ynet, Walla, N12 and the Times of Israel, to the Jerusalem Post, Israel Hayom and Arutz Sheva on the right. Creators Eitan Levine and Holy Land Speaks appear under From people you follow." }));
  out.push(el("div", { class: "endline", text: "End of Israel" }));
  return out;
}

function electionBox(t) {
  const P = data.il_polls;
  const out = [];
  const day = Date.parse("2026-10-27T20:00:00Z");     // polls close 10 PM Israel time (4 PM New York)
  const days = Math.ceil((day - Date.now()) / 86400e3);
  out.push(sectionHead("Election", days > 0 ? "Tuesday, Oct 27 · " + (days === 1 ? "tomorrow" : "in " + days + " days") : days > -9 ? "results due Nov 4" : null,
    t ? () => openThread(t) : null, t ? "Open the thread" : null));
  // The Israel match questionnaire (which lists your views sit closest to).
  if (data.il_quiz) {
    const qb = myQuiz ? ilEntry(myQuiz) : (loadQuiz().then(() => { if (myQuiz && tab === "news") render(); }), null);
    if (qb) out.push(qb);
  }
  if (t && t.dates) out.push(el("ol", { class: "ildates" }, ...t.dates.map((d) => el("li", { class: d.date && d.date < new Date().toISOString().slice(0, 10) ? "past" : "" },
    el("span", { class: "tlt", text: d.date ? fmtDate.format(new Date(d.date + "T12:00:00Z")) : "Then" }), el("span", { text: d.label })))));
  const R = data.il_results;
  if (R && R.lists && R.lists.length) out.push(...resultsBlock(R));
  if (P && P.latest && P.latest.length) {
    out.push(el("p", { class: "fine", text: "Latest poll from each pollster, in seats out of 120; 61 is a majority. The government bloc is Likud, Shas, UTJ, Religious Zionism and Otzma Yehudit." + (P.gov_range ? " Range across pollsters: " + P.gov_range[0] + "–" + P.gov_range[1] + " for the government bloc." : "") }));
    out.push(el("ul", { class: "polls" }, ...P.latest.map((p) => el("li", {},
      el("span", { class: "asrc", text: p.publisher + " · " + p.firm + " · " + fmtDate.format(new Date(p.date + "T12:00:00Z")) + (p.sample ? " · n=" + p.sample : "") }),
      el("div", { class: "ilbar", role: "img", "aria-label": "Government bloc " + p.gov + ", opposition " + p.opp + ", Arab lists " + p.arab },
        el("span", { class: "pg", style: "flex:" + p.gov }, String(p.gov)), el("span", { class: "po", style: "flex:" + p.opp }, String(p.opp)), el("span", { class: "pa", style: "flex:" + p.arab }, String(p.arab)), el("i", { class: "p61" }))))));
    out.push(el("p", { class: "plegend" }, el("span", { class: "pg", text: "Government bloc" }), " ", el("span", { class: "po", text: "Opposition" }), " ", el("span", { class: "pa", text: "Arab lists" }), " · the line is 61"));
    const lists = [...new Set(P.latest.flatMap((p) => Object.keys(p.seats)))].filter((k) => P.latest.some((p) => p.seats[k] > 0))
      .sort((a, b) => Math.max(...P.latest.map((p) => p.seats[b] || 0)) - Math.max(...P.latest.map((p) => p.seats[a] || 0)));
    const head = el("tr", {}, el("th", { text: "List" }), ...P.latest.map((p) => el("th", { text: p.publisher.replace(/^HaHadashot 12$/, "N12") })));
    const body = lists.map((k) => el("tr", {}, el("td", { text: k }), ...P.latest.map((p) => el("td", { text: p.seats[k] == null ? "–" : String(p.seats[k]) }))));
    const table = el("div", { class: "ptable" }, el("table", {}, el("thead", {}, head), el("tbody", {}, ...body)));
    const note = el("p", { class: "fine" }, "0 means below the 3.25% threshold; – means not polled. Source: ", link(P.source, "Wikipedia's poll table"),
      ", which links each poll" + (P.as_of ? "; read " + ago(Date.parse(P.as_of)) + " ago." : "."));
    out.push(el("details", { class: "rest" }, el("summary", {}, el("span", { text: "Seats by list, each pollster" }), el("span", { class: "chev", text: "▾" })), table, note));
  } else if (!R) {
    out.push(el("p", { class: "fine", text: "Polls appear here after the next build reads them." }));
  }
  if (R && R.lists && R.lists.length) {
    // Once there's a count, the polls fold away under the results.
    const i = out.findIndex((n) => n && n.classList && n.classList.contains("rbox"));
    const polls = out.splice(i + 1);
    if (polls.length) out.push(el("details", { class: "rest" }, el("summary", {}, el("span", { text: "The final pre-election polls" }), el("span", { class: "chev", text: "▾" })), ...polls));
  }
  return out;
}

function resultsBlock(R) {
  const b = R.blocs || {};
  const status = R.final ? "Final count" : R.counted_pct != null ? "Counting · about " + R.counted_pct + "% of expected votes counted" : "Counting";
  const seated = R.lists.filter((x) => x.seats > 0);
  const out = el("div", { class: "rbox" },
    el("div", { class: "rhead" }, el("span", { class: "dev", text: R.final ? "Result" : "Live count" }), el("span", { class: "asrc", text: status + " · " + (R.source ? R.source.name : "") + " · " + (ago(Date.parse(R.at)) === "now" ? "just now" : ago(Date.parse(R.at)) + " ago") })),
    el("div", { class: "ilbar big", role: "img", "aria-label": "Government bloc " + b.gov + ", opposition " + b.opp + ", Arab lists " + b.arab },
      el("span", { class: "pg", style: "flex:" + (b.gov || 0) }, String(b.gov || 0)), el("span", { class: "po", style: "flex:" + (b.opp || 0) }, String(b.opp || 0)),
      el("span", { class: "pa", style: "flex:" + (b.arab || 0) }, String(b.arab || 0)), el("i", { class: "p61" })),
    el("p", { class: "plegend" }, el("span", { class: "pg", text: "Government bloc " + (b.gov || 0) }), " ", el("span", { class: "po", text: "Opposition " + (b.opp || 0) }), " ", el("span", { class: "pa", text: "Arab lists " + (b.arab || 0) }), " · 61 to govern"),
    el("div", { class: "ptable" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", { text: "List" }), el("th", { text: "Seats" }), el("th", { text: "Votes" }), el("th", { text: "%" }))),
      el("tbody", {}, ...seated.map((x) => el("tr", { class: "b-" + x.bloc }, el("td", { text: x.name }), el("td", { text: String(x.seats) }),
        el("td", { text: x.votes != null ? x.votes.toLocaleString() : "–" }), el("td", { text: x.pct != null ? x.pct.toFixed(2) : "–" })))))),
    R.lists.length > seated.length ? el("p", { class: "fine", text: "Under the 3.25% threshold: " + R.lists.filter((x) => !x.seats && (x.pct || 0) >= 0.5).map((x) => x.name + (x.pct != null ? " " + x.pct.toFixed(2) + "%" : "")).join(", ") }) : null,
    el("p", { class: "fine" }, (R.source && !R.source.official ? "From Wikipedia's results table, which editors copy from the committee's count; the official site wasn't reachable. " : "") + "Seats shift as the count goes on; the official result is due Nov 4. ", R.source ? link(R.source.link, "Source ↗") : null));
  return [out];
}

// --------------------------------------------------------------- Voter guide (2026-10-23)
// From elections.yaml: key dates, every race on a Beacon ballot (what the job is, why it touches
// Joe, the candidates' own positions with sources, ratings and polls, the race's news thread),
// and ballot proposals (what Yes and No do, who argues each side). The Wire recommends nothing.
// "My pick" marks stay on this phone only.
function nextDate(g) {
  const today = new Date().toISOString().slice(0, 10);
  return (g.dates || []).find((d) => d.date >= today);
}
function guideCard() {
  const g = data.voter_guide;
  const n = nextDate(g);
  const when = g.days_until > 1 ? "in " + g.days_until + " days" : g.days_until === 1 ? "tomorrow" : g.days_until === 0 ? "today" : "results";
  return el("button", { class: "tellcard guidecard", onclick: () => openGuide() },
    el("span", { class: "bc-ico", "aria-hidden": "true", text: "☑" }),
    el("span", { class: "bc-txt" }, el("span", { class: "bc-t", text: "Voter guide · " + g.title + " · " + fmtDate.format(new Date(g.date + "T12:00:00")) + " · " + when }),
      el("span", { class: "bc-s", text: (n ? "Next: " + n.label + " · " + fmtDate.format(new Date(n.date + "T12:00:00")) + " · " : "") + (g.races || []).length + " races" + ((g.proposals || []).length ? ", " + g.proposals.length + " proposals" : "")
        + (g.scorecard || (myBallot && myBallot.election === g.id) ? " · ✓ your scorecard" : " · scorecard not imported") })));
}
let myBallot = null;          // the private scorecard from /ballot (KV), loaded when the guide opens
async function loadBallot(force) {
  if (myBallot && !force) return myBallot;
  try { const r = await fetch("ballot", { credentials: "same-origin" }); myBallot = r.ok ? await r.json() : {}; } catch (e) { myBallot = myBallot || {}; }
  return myBallot;
}
function weighted(c, crit) {
  const have = crit.filter((k) => c[k.id] && c[k.id].score != null);
  if (have.length < 2) return null;
  const w = have.reduce((a, k) => a + k.weight, 0);
  return Math.round(10 * have.reduce((a, k) => a + k.weight * c[k.id].score, 0) / w) / 10;
}
function dots(n) {
  return n == null ? el("span", { class: "nr", text: "–" }) : el("span", { class: "dots", "aria-label": n + " of 5" }, ...[1, 2, 3, 4, 5].map((i) => el("i", { class: i <= n ? "on" : "" })));
}
async function openGuide(focus) {
  const g = data.voter_guide;
  if (!g) return;
  const B = await loadBallot();
  const mine = B && B.election === g.id ? B : null;
  const picks = store.json(KEY.picks, {});
  const today = new Date().toISOString().slice(0, 10);
  const src = (u, label) => u ? link(u, label || "source ↗", "srcl") : null;
  const nodes = [
    el("div", { class: "smeta" }, el("span", { text: g.jurisdiction || "" }), el("span", { text: fmtDate.format(new Date(g.date + "T12:00:00")) })),
    el("h2", { id: "sheet-title", class: "stitle", text: "Voter guide · " + g.title }),
    el("p", { class: "sdesc", text: g.about || "" }),
    el("p", { class: "fine", text: "Positions are the candidates' own words or as reported, each linked to its source. The Wire describes; it doesn't recommend. Your picks stay on this phone." }),
  ];
  if (mine) nodes.push(...scorecardTop(g, mine));
  if (g.quiz) nodes.push(await quizEntry(g));
  if ((g.dates || []).length) nodes.push(el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "Key dates" }),
    el("ol", { class: "ildates" }, ...g.dates.map((d) => el("li", { class: d.date < today ? "past" : d === nextDate(g) ? "next" : "" },
      el("span", { class: "tlt", text: fmtDate.format(new Date(d.date + "T12:00:00")) }),
      el("span", {}, d.label + (d.note ? " · " + d.note : "") + " ", src(d.source)))))));
  if ((g.links || []).length) nodes.push(el("p", { class: "fine" }, ...g.links.flatMap((l, i) => [i ? " · " : "", link(l.url, l.label)])));
  const levels = [["federal", "Federal"], ["state", "New York State"], ["judicial", "Courts"], ["county", "Dutchess County"], ["local", "Beacon"]];
  nodes.push(el("h3", { class: "sh3 big", text: "Your ballot" }));
  for (const [lv, label] of levels) {
    const races = (g.races || []).filter((r) => (r.level || "state") === lv);
    if (!races.length) continue;
    nodes.push(el("p", { class: "glevel", text: label }));
    for (const r of races) nodes.push(raceBlock(r, picks, focus === r.id, mine));
  }
  if ((g.proposals || []).length) {
    nodes.push(el("h3", { class: "sh3 big", text: "Ballot proposals" }));
    for (const p of g.proposals) nodes.push(proposalBlock(p, picks, focus === p.id));
  }
  if ((g.sources || []).length) nodes.push(el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "Sources" }),
    el("ul", { class: "also" }, ...g.sources.map((s0) => el("li", {}, link(s0.url, s0.label))))));
  nodes.push(el("p", { class: "fine", text: "Written " + (g.updated || "") + " from official sources and established outlets; checked before each election. Tell me in a session if anything is wrong or missing." }));
  nodes.push(el("div", { class: "endline", text: "End of the guide" }));
  openSheet(nodes.filter(Boolean), "Voter guide");
}
function raceBlock(r, picks, open, mine) {
  const th = r.thread && (data.threads || []).find((t) => t.id === r.thread);
  const P = mine && mine.races ? mine.races[r.id] || null : null;
  const keep = mine && mine.where && mine.where.keep ? mine.where.keep[r.id] : null;
  const voteFor = mine && mine.where && mine.where.vote_for ? mine.where.vote_for[r.id] : null;
  const myDistrict = mine && mine.where && mine.where.district_of ? mine.where.district_of[r.id] : null;
  if (keep) r = Object.assign({}, r, { candidates: (r.candidates || []).filter((c) => c.name === keep), district: myDistrict || r.district, note: "Your district's candidate (from your scorecard)." });
  const devs = th ? (th.developments || []).slice(-3).reverse() : [];
  const pickKey = "race:" + r.id;
  const cands = (r.candidates || []).map((c) => {
    const picked = picks[pickKey] === c.name;
    const pick = el("button", { class: "pick" + (picked ? " on" : ""), text: picked ? "✓ My pick" : "My pick" });
    pick.onclick = (e) => { e.preventDefault(); const pk = store.json(KEY.picks, {}); pk[pickKey] = picked ? null : c.name; store.set(KEY.picks, JSON.stringify(pk)); openGuide(r.id); };
    return el("div", { class: "cand" },
      el("div", { class: "chead" }, el("span", { class: "cname", text: c.name }), c.incumbent ? el("span", { class: "inc", text: "incumbent" }) : null, pick),
      (c.lines || []).length ? el("div", { class: "lines" }, ...c.lines.map((l) => el("span", { class: "line" + (l === bestLine(c) ? " best" : ""), text: l }))) : null,
      (c.lines || []).length > 1 ? whichLine(c) : null,
      c.running_mate ? el("p", { class: "fine", text: "Running mate: " + c.running_mate }) : null,
      c.bio ? el("p", { class: "cbio", text: c.bio }) : null,
      (c.positions || []).length ? el("ul", { class: "cpos" }, ...c.positions.map((p) => el("li", {}, p.topic ? el("b", { text: p.topic + ": " }) : null, p.text + " ", p.source ? link(p.source, "↗", "srcl") : null))) : null,
      c.site ? el("p", { class: "fine" }, link(c.site, "Campaign site ↗")) : null,
      P && P.candidates && P.candidates[c.name] ? candScores(P.candidates[c.name], mine.criteria) : null);
  });
  const myPick = picks[pickKey];
  return el("details", { class: "race", open: open ? true : null },
    el("summary", {}, el("span", { class: "rtitle" }, el("b", { text: r.office }), r.district ? " · " + r.district : ""),
      el("span", { class: "rsub", text: (r.candidates || []).map((c) => c.name.split(" ").slice(-1)[0]).join(" vs. ") + (myPick ? " · your pick: " + myPick : "") + matchLine(r) }), el("span", { class: "chev", text: "▾" })),
    r.job ? el("p", { class: "rjob" }, el("b", { text: "The job: " }), r.job) : null,
    r.why ? el("p", { class: "rjob" }, el("b", { text: "Why it touches you: " }), r.why) : null,
    r.note ? el("p", { class: "fine", text: r.note }) : null,
    voteFor ? el("p", { class: "rjob" }, el("b", { text: "Vote for up to " + voteFor + "." })) : null,
    P && P.analysis ? el("div", { class: "foryou" }, el("span", { class: "mlabel", text: "For you · analysis" }), el("p", { text: P.analysis })) : null,
    ...((P && P.facts) || []).map((f) => el("p", { class: "fine" }, f.text + " ", f.source ? link(f.source, "↗", "srcl") : null)),
    el("div", { class: "cands" }, ...cands),
    (r.ratings || []).length || (r.polls || []).length ? el("div", { class: "rstat" },
      ...(r.ratings || []).map((x) => el("span", { class: "chip" }, x.who + ": " + x.rating + " ", x.source ? link(x.source, "↗", "srcl") : null)),
      ...(r.polls || []).map((x) => el("span", { class: "chip" }, x.who + (x.dates ? " (" + x.dates + ")" : "") + ": " + x.result + " ", x.source ? link(x.source, "↗", "srcl") : null))) : null,
    devs.length ? el("div", { class: "rnews" }, el("span", { class: "mlabel", text: "Latest in this race" }),
      el("ul", { class: "also" }, ...devs.map((d) => el("li", {}, el("span", { class: "asrc", text: ago(Date.parse(d.t)) + " · " + d.source }), link(d.link, d.text))))) : null,
    th ? el("button", { class: "sbtn wide", text: "Open the race thread (news, Ask) ›", onclick: () => openThread(th) }) : null);
}
// "Which line?" (2026-10-24): for a candidate on more than one line, what each line stands for,
// how fusion voting works, and which of the candidate's lines sits closest to Joe's own answers
// ("Where you stand" plus the election check's statements on the same scales).
function myLean() {
  const A = myQuiz && myQuiz.values && myQuiz.values.answers;
  if (!data.values_bank || !myQuiz) return null;
  const sc = standScores(A || {}, electionExtra(myQuiz));
  return sc.econ.s == null || sc.culture.s == null || sc.econ.n + sc.culture.n < 4 ? null : [sc.econ.s, sc.culture.s];
}
function bestLine(c) {
  const g = data.voter_guide, me = myLean();
  if (!g || !g.line_info || !me || (c.lines || []).length < 2) return null;
  return c.lines.filter((l) => g.line_info[l]).map((l) => [l, Math.hypot(g.line_info[l].pos[0] - me[0], g.line_info[l].pos[1] - me[1])]).sort((a, b) => a[1] - b[1])[0][0];
}
function whichLine(c) {
  const g = data.voter_guide;
  if (!g || !g.line_info) return null;
  const best = bestLine(c);
  const major = ["Democratic", "Republican"];
  return el("details", { class: "whichline" },
    el("summary", { text: best && !major.includes(best) ? "Which line? Your answers sit closest to the " + best + " line" : best ? "Which line? Your answers sit closest to the " + best + " line" : "Which line?" }),
    el("ul", { class: "cpos" }, ...c.lines.map((l) => { const L = g.line_info[l] || {}; return el("li", {}, el("b", { text: l + (l === best ? " · closest to your answers" : "") + ": " }), (L.what || "") + " ", L.source ? link(L.source, "↗", "srcl") : null); })),
    el("p", { class: "fine", text: g.fusion }),
    best ? el("p", { class: "fine", text: "Closest is from your economic and cultural answers on “Where you stand” and the election check, against The Wire's rough placement of each line. It describes fit, not what to do." })
      : el("p", { class: "fine", text: "Take “Where you stand” (Settings › Questionnaires) and this shows which of the lines is closest to your answers." }));
}

function candScores(c, crit) {
  const total = weighted(c, crit);
  return el("details", { class: "scores" },
    el("summary", {}, el("span", { class: "mlabel", text: "Your scores" }),
      ...crit.map((k) => el("span", { class: "sc" }, el("span", { class: "sck", text: k.label }), dots(c[k.id] ? c[k.id].score : null))),
      el("span", { class: "sct", text: total != null ? "weighted " + total.toFixed(1) : "too thin to total" })),
    ...crit.map((k) => { const x = c[k.id] || {}; return el("div", { class: "scrow" },
      el("b", { text: k.label + (x.score != null ? " · " + x.score + " of 5" : " · no record") }),
      x.why ? el("p", { class: "scwhy", text: x.why }) : null,
      (x.evidence || []).length ? el("ul", { class: "cpos" }, ...x.evidence.map((e) => el("li", {}, e.text + " ", e.source ? link(e.source, "↗", "srcl") : null))) : null); }));
}
function scorecardTop(g, B) {
  const w = B.where || {};
  const crit = B.criteria || [];
  const rows = [];
  for (const r of g.races || []) {
    const P = (B.races || {})[r.id];
    if (!P || !P.candidates) continue;
    rows.push(el("tr", { class: "race" }, el("td", { colspan: String(crit.length + 2), text: r.office + (r.district ? " · " + r.district : "") })));
    for (const c of r.candidates || []) {
      const s0 = P.candidates[c.name];
      if (!s0) continue;
      const t = weighted(s0, crit);
      rows.push(el("tr", {}, el("td", { class: "cn", text: c.name + " (" + (c.lines || []).map((l) => l[0]).join(", ") + ")" + (c.incumbent ? " · inc." : "") }),
        ...crit.map((k) => el("td", { class: "n", text: s0[k.id] && s0[k.id].score != null ? String(s0[k.id].score) : "–" })),
        el("td", { class: "n tot", text: t != null ? t.toFixed(1) : "thin" })));
    }
  }
  return [
    el("div", { class: "rbox mine" },
      el("span", { class: "mlabel", text: "Your ballot · private, from your scorecard" }),
      el("p", { class: "rjob" }, el("b", { text: (w.ward || "") }), w.label ? " · " + w.label : ""),
      w.districts ? el("p", { class: "fine", text: Object.entries(w.districts).map(([k, v]) => k + " " + v).join(" · ") }) : null,
      w.sample_ballot ? el("p", { class: "fine" }, link(w.sample_ballot, "Your district's official sample ballot ↗"), w.note ? " " + w.note : "") : null),
    el("details", { class: "rest" }, el("summary", {}, el("span", { text: "Your scorecard: " + crit.map((k) => k.label + " " + Math.round(k.weight * 100) + "%").join(", ") }), el("span", { class: "chev", text: "▾" })),
      el("p", { class: "fine", text: B.method || "" }),
      el("ul", { class: "cpos" }, ...crit.map((k) => el("li", {}, el("b", { text: k.label + ": " }), k.means || ""))),
      el("div", { class: "ptable" }, el("table", { class: "score" },
        el("thead", {}, el("tr", {}, el("th", { text: "Candidate" }), ...crit.map((k) => el("th", { class: "n", text: k.short || k.label.split(" ")[0] })), el("th", { class: "n", text: "Weighted" }))),
        el("tbody", {}, ...rows))),
      el("p", { class: "fine", text: "A filter on your priorities, not a recommendation. Totals over two criteria are reweighted over those two. Updated " + (B.updated || "") + "." })),
  ];
}

function proposalBlock(p, picks, open) {
  const pickKey = "prop:" + p.id;
  const mine = picks[pickKey];
  const choose = (v) => { const b = el("button", { class: "pick" + (mine === v ? " on" : ""), text: (mine === v ? "✓ " : "") + "Leaning " + v });
    b.onclick = (e) => { e.preventDefault(); const pk = store.json(KEY.picks, {}); pk[pickKey] = mine === v ? null : v; store.set(KEY.picks, JSON.stringify(pk)); openGuide(p.id); }; return b; };
  const side = (label, list) => (list || []).length ? el("div", { class: "pside" }, el("b", { text: label }),
    el("ul", { class: "cpos" }, ...list.map((a) => el("li", {}, a.who ? el("b", { text: a.who + ": " }) : null, a.text + " ", a.source ? link(a.source, "↗", "srcl") : null)))) : null;
  return el("details", { class: "race", open: open ? true : null },
    el("summary", {}, el("span", { class: "rtitle" }, el("b", { text: (p.number ? "Proposal " + p.number + ": " : "") + p.title })),
      el("span", { class: "rsub", text: mine ? "you: " + mine : "" }), el("span", { class: "chev", text: "▾" })),
    p.summary ? el("p", { class: "rjob", text: p.summary }) : null,
    p.yes ? el("p", { class: "rjob" }, el("b", { text: "A Yes vote: " }), p.yes) : null,
    p.no ? el("p", { class: "rjob" }, el("b", { text: "A No vote: " }), p.no) : null,
    p.why ? el("p", { class: "rjob" }, el("b", { text: "Why it touches you: " }), p.why) : null,
    side("Arguments for", p.for), side("Arguments against", p.against),
    p.text ? el("details", { class: "rest" }, el("summary", {}, el("span", { text: "The ballot language" }), el("span", { class: "chev", text: "▾" })), el("p", { class: "excerpt" }, p.text)) : null,
    el("div", { class: "pickrow" }, choose("Yes"), choose("No")),
    p.source ? el("p", { class: "fine" }, link(p.source, "Official source ↗")) : null);
}

// --------------------------------------------------------------- Questionnaires (2026-10-23)
// Statements rated without seeing what they measure: shuffled, no labels or running score,
// results only behind "See my results". Answers live in KV (/quiz), never in the repository.
const SCALE = [[2, "Strongly agree"], [1, "Agree"], [0, "Neutral"], [-1, "Disagree"], [-2, "Strongly disagree"]];
const WEIGHT = [[1, "Matters a little"], [2, "Matters"], [3, "Matters a lot"]];
let myQuiz = null;
async function loadQuiz(force) {
  if (myQuiz && !force) return myQuiz;
  if (force && Object.keys(quizPending).length) await flushQuiz();
  try { const r = await fetch("quiz", { credentials: "same-origin" }); myQuiz = r.ok ? await r.json() : null; } catch (e) { myQuiz = myQuiz || null; }
  return myQuiz || { elections: {}, pulse: [], values: {} };
}
// Answers are batched (2026-10-25): every save is a Workers KV write, and the free plan allows
// 1,000 a day. Single answers wait until six have piled up, 20 seconds pass, the quiz finishes,
// or the page is hidden; anything else (done, a new take, clear, pulse) flushes them first.
const quizPending = {};
let quizTimer = null;
function quizPost(body, keepalive) {
  return fetch("quiz", { method: "POST", credentials: "same-origin", keepalive: Boolean(keepalive), headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function flushQuiz(keepalive) {
  clearTimeout(quizTimer); quizTimer = null;
  const jobs = Object.values(quizPending).filter((p) => Object.keys(p.answers).length);
  for (const k of Object.keys(quizPending)) delete quizPending[k];
  for (const body of jobs) {
    try { const r = await quizPost(body, keepalive); if (r.ok && !keepalive) myQuiz = await r.json(); } catch (e) { /* the next save retries nothing; answers stay in myQuiz below */ }
  }
}
async function saveQuiz(body) {
  const plain = body.answers && !Array.isArray(body.answers) && !body.done && !body.take && !body.restart && !body.round && ["election", "values", "baseline", "memes", "topup"].includes(body.kind);
  if (plain) {
    const k = body.kind + ":" + (body.id || "");
    const p = quizPending[k] || (quizPending[k] = { kind: body.kind, id: body.id, answers: {} });
    Object.assign(p.answers, body.answers);
    // Keep the local copy current so results and resumes see unsent answers.
    if (myQuiz) {
      const slot = body.kind === "election" ? ((myQuiz.elections = myQuiz.elections || {})[body.id] = myQuiz.elections[body.id] || { answers: {} })
        : (myQuiz[body.kind] = myQuiz[body.kind] || { answers: {} });
      slot.answers = Object.assign(slot.answers || {}, body.answers);
    }
    if (Object.keys(p.answers).length >= 6) await flushQuiz();
    else { clearTimeout(quizTimer); quizTimer = setTimeout(() => flushQuiz(), 20000); }
    return true;
  }
  // Anything else: send pending answers along when they're for the same questionnaire, then post.
  const k = body.kind + ":" + (body.id || "");
  if (quizPending[k] && body.answers && !Array.isArray(body.answers)) { body = Object.assign({}, body, { answers: Object.assign({}, quizPending[k].answers, body.answers) }); delete quizPending[k]; }
  await flushQuiz();
  try { const r = await quizPost(body); if (r.ok) myQuiz = await r.json(); return r.ok; } catch (e) { return false; }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushQuiz(true); });
window.addEventListener("pagehide", () => flushQuiz(true));
function shuffled(arr, seed) {
  const a = arr.slice(); let x = seed || 1;
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1103515245 + 12345) % 2147483648; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
async function quizEntry(g) {
  const Q = await loadQuiz();
  const mine = (Q.elections || {})[g.id] || {};
  const n = g.quiz.items.length;
  const answered = Object.keys(mine.answers || {}).length;
  const box = el("div", { class: "rbox quizbox" }, el("span", { class: "mlabel", text: g.quiz.title || "Election check" }));
  if (!mine.done_at) {
    box.append(el("p", { class: "rjob", text: n + " statements, about " + Math.ceil(n / 4) + " minutes. Answer how you see it; what each one measures is explained only afterwards." }),
      el("button", { class: "sbtn primary wide", text: answered ? "Continue (" + answered + " of " + n + " answered)" : "Start the election check", onclick: () => openQuiz(g) }));
  } else {
    // Statements reworded after you answered them (elections.yaml `changed`).
    const stale = g.quiz.items.filter((it) => it.changed && mine.answers[it.id] && Date.parse(mine.updated || mine.done_at) < Date.parse(it.changed + "T04:00:00Z"));
    const fresh = g.quiz.items.filter((it) => !mine.answers[it.id]);
    if (fresh.length) box.append(el("button", { class: "sbtn primary wide", text: "Answer " + fresh.length + " new statement" + (fresh.length === 1 ? "" : "s"), onclick: () => openQuiz(g, fresh.map((it) => it.id)) }));
    if (stale.length) box.append(el("button", { class: "sbtn wide", text: stale.length + " statement" + (stale.length === 1 ? " was" : "s were") + " reworded: re-answer " + (stale.length === 1 ? "it" : "them"), onclick: () => openQuiz(g, stale.map((it) => it.id)) }));
    box.append(el("p", { class: "rjob", text: "Done " + fmtDate.format(new Date(Date.parse(mine.done_at))) + ". Your results compare your answers with the candidates' stated positions." }),
      el("div", { class: "sactions" }, el("button", { class: "sbtn primary", text: "See my results", onclick: () => openMatch(g) }),
        el("button", { class: "sbtn", text: "Retake", onclick: async () => { await saveQuiz({ kind: "clear", id: g.id }); openQuiz(g); } })));
  }
  return box;
}
function openQuiz(g, only) {
  const Q = myQuiz || { elections: {} };
  const prior = ((Q.elections || {})[g.id] || {}).answers || {};
  const seed = Number(store.get("wire.quizSeed." + g.id)) || (Date.now() % 100000) + 1;
  store.set("wire.quizSeed." + g.id, seed);
  // `only`: re-answer just these statements (ones reworded after you answered them).
  const order = shuffled(only ? g.quiz.items.filter((it) => only.includes(it.id)) : g.quiz.items, seed);
  let i = only ? 0 : order.findIndex((it) => !prior[it.id]);
  if (i < 0) i = 0;
  const answers = Object.assign({}, prior);
  let weight = 2;
  const render1 = () => {
    if (i >= order.length) {
      saveQuiz({ kind: "election", id: g.id, answers, done: true }).then(() => openSheet([
        el("h2", { id: "sheet-title", class: "stitle", text: "Done" }),
        el("p", { class: "sdesc", text: "Your answers are saved privately. Look at the results whenever you like; they're not shown anywhere until you do." }),
        el("div", { class: "sactions" }, el("button", { class: "sbtn primary", text: "See my results", onclick: () => openMatch(g) }),
          el("button", { class: "sbtn", text: "Back to the guide", onclick: () => openGuide() })),
      ], "Done"));
      return;
    }
    const it = order[i];
    const cur = answers[it.id];
    weight = cur && cur.w ? cur.w : 2;
    const wrow = el("div", { class: "wrow" }, ...WEIGHT.map(([w, label]) => { const b = el("button", { class: "chip" + (w === weight ? " on" : ""), text: label });
      b.onclick = () => { weight = w; [...wrow.children].forEach((c) => c.classList.toggle("on", c === b)); }; return b; }));
    const pick = (v) => { answers[it.id] = { v, w: weight }; saveQuiz({ kind: "election", id: g.id, answers: { [it.id]: answers[it.id] } }); i += 1; render1(); };
    openSheet([
      el("div", { class: "qprog" }, el("span", { text: (i + 1) + " of " + order.length }), el("span", { class: "qbar" }, el("i", { style: "width:" + Math.round(100 * i / order.length) + "%" }))),
      el("h2", { id: "sheet-title", class: "qtext", text: it.text }),
      explainBtn(it.id, render1),
      el("p", { class: "fine", text: "How much does this matter to you? (set this first)" }), wrow,
      el("div", { class: "qscale" }, ...SCALE.map(([v, label]) => el("button", { class: "qopt" + (cur && cur.v === v ? " on" : ""), text: label, onclick: () => pick(v) }))),
      el("div", { class: "qnav" },
        i > 0 ? el("button", { class: "linkbtn", text: "‹ Back", onclick: () => { i -= 1; render1(); } }) : el("span", {}),
        el("button", { class: "linkbtn", text: "Skip", onclick: () => { answers[it.id] = { skip: true }; saveQuiz({ kind: "election", id: g.id, answers: { [it.id]: { skip: true } } }); i += 1; render1(); } }),
        el("button", { class: "linkbtn", text: "Finish later", onclick: () => openGuide() })),
    ], g.quiz.title || "Election check");
  };
  render1();
}
// Agreement with a candidate: over the statements both you and they have a position on,
// 1 − |yours − theirs| / 4, weighted by how much each matters to you.
function matchFor(g, name, answers) {
  const st = ((g.quiz || {}).stances || {})[name] || {};
  let num = 0, den = 0, n = 0;
  const rows = [];
  for (const [q, x] of Object.entries(st)) {
    const a = answers[q];
    if (!a || a.skip || a.v == null) continue;
    const agree = 1 - Math.abs(a.v - x.v) / 4;
    num += a.w * agree; den += a.w; n += 1;
    rows.push({ q, you: a.v, them: x.v, w: a.w, agree, source: x.source, note: x.note, from: a.from });
  }
  return { pct: den ? Math.round(100 * num / den) : null, n, rows: rows.sort((a, b) => b.agree - a.agree) };
}
function matchLine(r) {
  const g = data.voter_guide;
  if (!g || !g.quiz || !prefs.showMatch || !myQuiz) return "";
  const own = ((myQuiz.elections || {})[g.id] || {}).answers;
  if (!own && !myProps) return "";
  const a = withProposals("election", own || {});
  const parts = (r.candidates || []).map((c) => { const m = matchFor(g, c.name, a); return m.n >= 2 ? c.name.split(" ").slice(-1)[0] + " " + m.pct + "%" : null; }).filter(Boolean);
  return parts.length ? " · your match: " + parts.join(", ") : "";
}
async function openMatch(g) {
  const [Q] = await Promise.all([loadQuiz(true), loadProps()]);
  const own = ((Q.elections || {})[g.id] || {}).answers || {};
  const a = withProposals("election", own), fromProps = propCount("election", own);
  const text = Object.fromEntries(g.quiz.items.map((x) => [x.id, x.text]));
  const label = (v) => (SCALE.find(([k]) => k === v) || [0, "–"])[1];
  const nodes = [
    el("h2", { id: "sheet-title", class: "stitle", text: "Your election check" }),
    el("p", { class: "sdesc", text: "How closely your answers match each candidate's stated positions, weighted by how much each statement matters to you. Only statements a candidate has a sourced position on count for them; a candidate with fewer than two isn't scored. Agreement on stated positions is one input, not a recommendation." }),
    answerWarnings(g.quiz.items, a),
    fromProps ? el("p", { class: "fine", text: fromProps + (fromProps > 1 ? " statements you haven't answered count" : " statement you haven't answered counts") + " from Your solutions (marked “from your proposal”)." }) : null,
    el("button", { class: "linkbtn", text: "How this works ›", onclick: () => methodSheet("the election check", { statements: g.quiz.items.length, actor: "candidate", min: 2 }, () => openMatch(g)) }),
  ].filter(Boolean);
  for (const r of g.races || []) {
    const ms = (r.candidates || []).map((c) => ({ c, m: matchFor(g, c.name, a) })).filter((x) => x.m.n > 0);
    if (!ms.length) continue;
    nodes.push(el("section", { class: "ssec" }, el("h3", { class: "sh3", text: r.office + (r.district ? " · " + r.district : "") }),
      ...ms.map(({ c, m }) => el("details", { class: "race" },
        el("summary", {}, el("span", { class: "rtitle" }, el("b", { text: c.name }), m.n >= 2 ? " · " + m.pct + "% agreement" + (ms.some((y) => y !== ms.find((z) => z.c === c) && y.m.n >= 2 && y.m.pct === m.pct) ? " · tied" : "") : " · too few stated positions"),
          el("span", { class: "rsub", text: m.n + " statement" + (m.n === 1 ? "" : "s") + " in common" }), el("span", { class: "chev", text: "▾" })),
        el("ul", { class: "cpos" }, ...m.rows.map((x) => el("li", {}, el("b", { text: x.agree >= 0.75 ? "Agree · " : x.agree <= 0.25 ? "Differ · " : "Partly · " }),
          "“" + text[x.q] + "” You: " + label(x.you) + (x.from ? " (from your proposal)" : "") + (x.w === 3 ? " (matters a lot)" : "") + ". " + c.name.split(" ").slice(-1)[0] + ": " + label(x.them) + (x.note ? " (" + x.note + ")" : "") + " ",
          x.source ? link(x.source, "↗", "srcl") : null)))))));
  }
  const show = el("label", { class: "trow" }, el("span", { text: "Show my match on each race in the guide" }),
    el("input", { type: "checkbox", checked: prefs.showMatch ? true : null, onchange: (e) => { prefs.showMatch = e.target.checked; savePrefs(); } }));
  nodes.push(show, el("div", { class: "sactions" }, el("button", { class: "sbtn", text: "Back to the guide", onclick: () => openGuide() })));
  openSheet(nodes, "Your election check");
}

// --------------------------------------------------------------- the pulse (2026-10-23)
// Five quick questions from live threads: three "which would you rather read about" pairs and
// two "how much do you care how this turns out". Blind: nothing says what an answer does. The
// build (pipeline/pulse.py) turns the answers into taste; "See what this changed" shows it.
const CARE = [[2, "A lot"], [1, "Quite a bit"], [0, "Somewhat"], [-1, "Not much"], [-2, "Not at all"]];
const PULSE_EVERY = 7 * 86400e3;
function lastPulse(Q) {
  const p = (Q && Q.pulse) || [];
  return p.length ? Date.parse(p[p.length - 1].at) : 0;
}
function pulsePool(Q) {
  const recent = new Set(((Q && Q.pulse) || []).filter((a) => Date.now() - Date.parse(a.at) < 21 * 86400e3)
    .flatMap((a) => a.t === "pair" ? [a.a.id, a.b.id] : [a.id]));
  return (data.threads || []).filter((t) => t.title && t.last && Date.now() - Date.parse(t.last) < 4 * 86400e3
    && (t.n_reports || 0) >= 2 && !recent.has(t.id))
    .sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
}
function pulseQuestions(Q, min) {
  const pool = pulsePool(Q);
  if (pool.length < (min || 8)) return null;
  // Pairs across different desks where possible; care questions favor what he follows.
  const seed = (Date.now() / 86400e3) | 0;
  const mixed = shuffled(pool.slice(0, 30), seed + 7);
  // One care question is new territory (data.explore) when there is some; the other is something he follows.
  const explore = new Set(data.explore || []);
  const care = [...mixed.filter((t) => explore.has(t.id)).slice(0, 1), ...mixed.filter((t) => (t.followed || t.standing) && !explore.has(t.id))].slice(0, 2);
  while (care.length < Math.min(2, mixed.length)) care.push(mixed.find((t) => !care.includes(t)));
  const rest = mixed.filter((t) => !care.includes(t));
  const pairs = [];
  while (pairs.length < 3 && rest.length >= 2) {
    const a = rest.shift();
    const j = rest.findIndex((t) => t.desk !== a.desk);
    const b = rest.splice(j >= 0 ? j : 0, 1)[0];
    pairs.push({ t: "pair", a, b });
  }
  const qs = [...pairs, ...care.map((t) => ({ t: "care", th: t }))];
  return shuffled(qs, seed + 3);
}
function pulseCard(Q) {
  if (Date.now() - (Number(store.get("wire.pulseSnooze")) || 0) < 3 * 86400e3) return null;
  if (data.baseline_bank && !(Q.baseline || {}).done_at) {
    // First things first: the starting questionnaire gives everything else a baseline.
    const card = el("div", { class: "pulsecard" },
      el("button", { class: "pc-go", onclick: () => openBaseline() },
        el("span", { class: "bc-ico", "aria-hidden": "true", text: "?" }),
        el("span", { class: "bc-txt" }, el("span", { class: "bc-t", text: "What you want to follow" }), el("span", { class: "bc-s", text: data.baseline_bank.items.length + " quick questions · about three minutes" }))),
      el("button", { class: "linkbtn", text: "Not now", onclick: () => { store.set("wire.pulseSnooze", Date.now()); card.remove(); } }));
    return card;
  }
  if (Date.now() - lastPulse(Q) < PULSE_EVERY) return null;
  if (pulsePool(Q).length < 8) return null;
  const card = el("div", { class: "pulsecard" },
    el("button", { class: "pc-go", onclick: () => openPulse() },
      el("span", { class: "bc-ico", "aria-hidden": "true", text: "?" }),
      el("span", { class: "bc-txt" }, el("span", { class: "bc-t", text: "Five quick questions" }), el("span", { class: "bc-s", text: "About a minute · no right answers" }))),
    el("button", { class: "linkbtn", text: "Not now", onclick: () => { store.set("wire.pulseSnooze", Date.now()); card.remove(); } }));
  return card;
}
async function openPulse(again) {
  const Q = await loadQuiz(true);
  const qs = pulseQuestions(Q, again ? 3 : 8);
  if (!qs) { openSheet([el("h2", { id: "sheet-title", class: "stitle", text: again ? "That's everything for now" : "Not enough going on" }),
    el("p", { class: "sdesc", text: again ? "You've answered about every live thread. New ones come up through the day." : "There aren't enough live threads to ask about right now. Try again later today." }),
    el("div", { class: "sactions" }, el("button", { class: "sbtn", text: "Close", onclick: closeSheet }))], "Questions"); return; }
  const out = [];
  let i = 0;
  const next = (ans) => { if (ans) out.push(ans); i += 1; step(); };
  const step = async () => {
    if (i >= qs.length) {
      if (out.length) await saveQuiz({ kind: "pulse", answers: out });
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Thanks" }),
        el("p", { class: "sdesc", text: "Saved privately." }),
        el("div", { class: "sactions" }, el("button", { class: "sbtn primary", text: "Keep going", onclick: () => openPulse(true) }),
          el("button", { class: "sbtn", text: "See what this changed", onclick: () => pulseEffect() }), el("button", { class: "sbtn", text: "Close", onclick: closeSheet }))], "Thanks");
      render();
      return;
    }
    const q = qs[i];
    const prog = el("div", { class: "qprog" }, el("span", { text: (i + 1) + " of " + qs.length }), el("span", { class: "qbar" }, el("i", { style: "width:" + Math.round(100 * i / qs.length) + "%" })));
    const side = (t) => ({ id: t.id, title: t.title });
    const body = q.t === "pair"
      ? [el("h2", { id: "sheet-title", class: "qtext", text: "Which would you rather read more about?" }),
        el("div", { class: "qscale" },
          el("button", { class: "qopt tall", text: q.a.title, onclick: () => next({ t: "pair", a: side(q.a), b: side(q.b), pick: "a" }) }),
          el("button", { class: "qopt tall", text: q.b.title, onclick: () => next({ t: "pair", a: side(q.a), b: side(q.b), pick: "b" }) })),
        el("div", { class: "wrow" }, el("button", { class: "chip", text: "Both", onclick: () => next({ t: "pair", a: side(q.a), b: side(q.b), pick: "both" }) }),
          el("button", { class: "chip", text: "Neither", onclick: () => next({ t: "pair", a: side(q.a), b: side(q.b), pick: "neither" }) }))]
      : [el("p", { class: "fine", text: "How much do you care how this turns out?" }), el("h2", { id: "sheet-title", class: "qtext", text: q.th.title }),
        el("div", { class: "qscale" }, ...CARE.map(([v, label]) => el("button", { class: "qopt", text: label, onclick: () => next({ t: "care", id: q.th.id, title: q.th.title, v }) })))];
    openSheet([prog, ...body, el("div", { class: "qnav" }, el("span", {}),
      el("button", { class: "linkbtn", text: "Skip", onclick: () => next(null) }),
      el("button", { class: "linkbtn", text: "Stop here", onclick: () => { i = qs.length; step(); } }))], "Five quick questions");
  };
  step();
}
// What the pulse does, shown only when asked: the subjects it now leans toward and away from.
async function pulseEffect() {
  const Q = await loadQuiz(true);
  const cutoff = Date.now() - 120 * 86400e3;
  const latest = new Map();
  for (const a of (Q.pulse || []).slice(-60).filter((a) => Date.parse(a.at) >= cutoff)) {
    if (a.t === "pair") for (const k of ["a", "b"]) {
      if (a.pick === k || a.pick === "both") latest.set(a[k].id || a[k].title, [a[k].title, 1]);
      else if (a.pick === "neither") latest.set(a[k].id || a[k].title, [a[k].title, -1]);
    } else if (a.t === "care") latest.set(a.id || a.title, [a.title, a.v >= 1 ? 1 : a.v <= -1 ? -1 : 0]);
  }
  const more = [...latest.values()].filter(([, v]) => v > 0).map(([t]) => t);
  const less = [...latest.values()].filter(([, v]) => v < 0).map(([t]) => t);
  const list = (xs) => xs.length ? el("ul", { class: "admin" }, ...xs.map((t) => el("li", { text: t }))) : el("p", { class: "fine", text: "Nothing." });
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "What your answers changed" }),
    el("p", { class: "sdesc", text: "Your most recent 60 answers (none older than four months) shape what rises: stories and suggested threads that read like what you picked move up, and ones like what you said you don't care about move down. The other option in a pair counts for nothing, and a newer answer about the same thread replaces the older one. Your starting questionnaire's subjects count too, and don't fade." }),
    el("h3", { class: "sh3", text: "Leaning toward · " + more.length }), list(more),
    el("h3", { class: "sh3", text: "Leaning away from · " + less.length }), list(less),
    ...baselineEffect(Q),
    el("div", { class: "sactions" }, el("button", { class: "sbtn", text: "Forget all pulse answers", onclick: async (e) => { e.currentTarget.textContent = "…"; await saveQuiz({ kind: "clear", id: "pulse" }); pulseEffect(); } })),
  ], "What your answers changed");
}

// "What's this about?" (2026-10-23): background on a statement before answering it, from
// explain.yaml (where things stand, the case on each side and who makes it, sources) plus the
// newest matching coverage the build found. Neutral by rule; says nothing about scoring.
function explainBtn(id, back) {
  const e = (data.explain || {})[id];
  if (!e || !e.now) return null;
  return el("button", { class: "explainbtn", text: "ⓘ What's this about?", onclick: () => openExplain(id, back) });
}
function openExplain(id, back) {
  const e = data.explain[id];
  engage({ k: "explain", t: id + " " + String((document.getElementById("sheet-title") || {}).textContent || "").slice(0, 120) });
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (x) { return u; } };
  openSheet([
    el("button", { class: "linkbtn", text: "‹ Back to the question", onclick: () => back() }),
    el("h2", { id: "sheet-title", class: "stitle", text: "What's this about?" }),
    el("h3", { class: "sh3", text: "Where things stand" }), el("p", { text: e.now }),
    (e.latest || []).length ? el("h3", { class: "sh3", text: "Latest coverage" }) : null,
    (e.latest || []).length ? el("ul", { class: "admin" }, ...e.latest.map((x) => el("li", {}, el("span", { class: "asrc", text: (x.source || "") + " · " + ago(Date.parse(x.t)) + " ago" }), link(x.link, x.title)))) : null,
    el("h3", { class: "sh3", text: "The case for agreeing" }), el("p", { text: e.case_for }),
    el("h3", { class: "sh3", text: "The case for disagreeing" }), el("p", { text: e.case_against }),
    (e.sources || []).length ? el("p", { class: "fine" }, "Sources: ", ...e.sources.flatMap((u, i) => [i ? " · " : "", link(u, host(u))])) : null,
    el("p", { class: "fine", text: "Background written from the sources above; the latest coverage is matched automatically. Neither says anything about how your answer is used." }),
    el("button", { class: "sbtn primary wide", text: "Back to the question", onclick: () => back() }),
  ].filter(Boolean), "What's this about?");
}

// Results-page standards (QUIZZES.md rules 19–25, 2026-10-25): warnings when answers are thin,
// ties shown as ties, and a "How this works" page with the method, version and limits.
function answerWarnings(items, answers) {
  const ids = items.map((it) => it.id);
  const given = ids.filter((id) => answers[id]);
  const soft = given.filter((id) => answers[id].skip || answers[id].v === 0).length;
  const out = [];
  if (given.length && soft / given.length > 1 / 3) out.push("More than a third of your answers are Neutral or Skip (" + soft + " of " + given.length + "), so these matches rest on fewer real differences. Answering more of them firmly, where you have a view, makes the result more meaningful.");
  if (given.length < ids.length) out.push((ids.length - given.length) + " statement" + (ids.length - given.length === 1 ? " is" : "s are") + " still unanswered.");
  return out.length ? el("div", { class: "warnbox" }, ...out.map((t) => el("p", { text: t }))) : null;
}
const tieTag = (list, i, key) => (list.some((x, j) => j !== i && x[key] === list[i][key]) ? " · tied" : "");
function methodSheet(name, opts, back) {
  openSheet([
    back ? el("button", { class: "linkbtn", text: "‹ Back to results", onclick: back }) : null,
    el("h2", { id: "sheet-title", class: "stitle", text: "How this works: " + name }),
    el("ul", { class: "cpos" },
      el("li", { text: opts.statements + " statements, shuffled, with what each measures hidden until the results. Each was written to be one concrete proposal in neutral words, and checked for joined claims, conditions and negations." }),
      el("li", { text: "You answer on five points (strongly agree to strongly disagree) or skip, and set how much each statement matters (1 to 3). Neutral counts as a middle position; a skip is left out." }),
      el("li", { text: "Each " + opts.actor + "'s position on a statement is coded only from a source (platform, votes, their own statements, or reliable reporting), never from party or bloc. A first coder codes it with a citation; a second checks it independently, and disagreements are settled with evidence. A related vote standing in for the exact question counts at most halfway, with a note. A missing position stays missing." }),
      el("li", { text: "Agreement = 1 − (weighted distance ÷ largest possible weighted distance), using city-block distance over the statements where both of you have a position. That's the method Vote Compass and the research recommend; it doesn't reward middle answers the way Euclidean distance does." }),
      el("li", { text: "A " + opts.actor + " is ranked only with at least " + opts.min + " statements in common. Equal scores are shown as tied, never ordered alphabetically. Every " + opts.actor + " is listed, not just a top pick." }),
      opts.map ? el("li", { text: opts.map }) : null),
    el("h3", { class: "sh3", text: "Limits" }),
    el("p", { text: "It measures agreement on these statements only: they cover part of what the race is about, positions can shift during a campaign, and a match is one input for your own decision, not advice." }),
    el("p", { class: "fine", text: "Standard: QUIZZES.md in the repository, based on Wahl-O-Mat, StemWijzer, Kieskompas, Vote Compass, smartvote and the research on them. Version " + (opts.version || "2026-10-25") + "." }),
  ].filter(Boolean), "How this works");
}

// --------------------------------------------------------------- Israel match (2026-10-24)
// Joe: "a questionnaire to help determine my political leanings in the Israeli electorate."
// 24 blind statements on four scales (security, religion and state, the courts, the economy),
// each list coded only where a sourced position exists (israel_quiz.yaml, shipped as
// data.il_quiz). Answers are private (quiz.json, kind election, id il_2026); results only on
// "See my results": lists ranked by agreement, the blocs, a map of security against religion with
// every list on it, and the other two scales.
const IL_ID = "il_2026";
function ilEntry(Q) {
  const B = data.il_quiz;
  if (!B) return null;
  const mine = ((Q && Q.elections) || {})[IL_ID] || {};
  const n = B.items.length, answered = Object.keys(mine.answers || {}).length;
  const box = el("div", { class: "rbox quizbox" }, el("span", { class: "mlabel", text: B.title }));
  if (!mine.done_at) box.append(el("p", { class: "rjob", text: n + " statements, about " + Math.ceil(n / 4) + " minutes. Which of the " + B.lists.length + " lists your views sit closest to; what each statement measures is shown only afterwards." }),
    el("button", { class: "sbtn primary wide", text: answered ? "Continue (" + answered + " of " + n + ")" : "Start", onclick: () => openIlQuiz() }));
  else {
    const fresh = B.items.filter((it) => !mine.answers[it.id]).map((it) => it.id);
    const stale = B.items.filter((it) => it.changed && mine.answers[it.id] && Date.parse(mine.updated || mine.done_at) < Date.parse(it.changed + "T04:00:00Z")).map((it) => it.id);
    const ids = [...new Set([...fresh, ...stale])];
    if (ids.length) box.append(el("button", { class: "sbtn primary wide", text: "Answer " + ids.length + " new or reworded statement" + (ids.length === 1 ? "" : "s"), onclick: () => openIlQuiz(ids) }));
  }
  if (mine.done_at) box.append(el("p", { class: "rjob", text: "Done " + fmtDate.format(new Date(Date.parse(mine.done_at))) + "." }),
    el("div", { class: "sactions" }, el("button", { class: "sbtn primary", text: "See my results", onclick: () => openIlMatch() }),
      el("button", { class: "sbtn", text: "Retake", onclick: async () => { store.set("wire.quizSeed." + IL_ID, ""); await saveQuiz({ kind: "clear", id: IL_ID }); openIlQuiz(); } })));
  return box;
}
async function openIlQuiz(only) {
  const Q = await loadQuiz(true);
  const B = data.il_quiz;
  runStatements({
    title: B.title, items: only ? B.items.filter((it) => only.includes(it.id)) : B.items, redo: Boolean(only), seedKey: "wire.quizSeed." + IL_ID, prior: ((Q.elections || {})[IL_ID] || {}).answers || {},
    save: (partial) => saveQuiz({ kind: "election", id: IL_ID, answers: partial }),
    later: () => { closeSheet(); render(); },
    done: async () => {
      await saveQuiz({ kind: "election", id: IL_ID, answers: {}, done: true });
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Done" }),
        el("p", { class: "sdesc", text: "Saved privately. Your results aren't shown anywhere until you open them." }),
        el("div", { class: "sactions" }, el("button", { class: "sbtn primary", text: "See my results", onclick: () => openIlMatch() }), el("button", { class: "sbtn", text: "Close", onclick: () => { closeSheet(); render(); } }))], "Done");
    },
  });
}
function ilAxis(B, pick) {
  // pick(item) -> v or null; returns {axisId: -1..1}
  const out = {};
  for (const ax of B.axes) {
    let num = 0, den = 0;
    for (const it of B.items.filter((x) => x.axis === ax.id)) { const v = pick(it); if (v == null) continue; num += v * it.dir; den += 2; }
    out[ax.id] = den >= 4 ? num / den : null;
  }
  return out;
}
async function openIlMatch() {
  const [Q] = await Promise.all([loadQuiz(true), loadProps()]);
  const B = data.il_quiz;
  const a = withProposals("israel", ((Q.elections || {})[IL_ID] || {}).answers || {});
  const text = Object.fromEntries(B.items.map((x) => [x.id, x.text]));
  const label = (v) => (SCALE.find(([k]) => k === v) || [0, "–"])[1];
  const ms = B.lists.map((l) => {
    const st = B.stances[l.id] || {};
    let num = 0, den = 0, n = 0;
    const rows = [];
    for (const [q, x] of Object.entries(st)) {
      const y = a[q];
      if (!y || y.skip || y.v == null) continue;
      const agree = 1 - Math.abs(y.v - x.v) / 4;
      num += (y.w || 2) * agree; den += y.w || 2; n += 1;
      rows.push({ q, you: y.v, them: x.v, agree, source: x.source, note: x.note });
    }
    return { l, n, pct: den ? Math.round(100 * num / den) : null, rows: rows.sort((p, q) => q.agree - p.agree) };
  });
  const scored = ms.filter((m) => m.n >= 3).sort((p, q) => q.pct - p.pct);
  const me = ilAxis(B, (it) => (a[it.id] && !a[it.id].skip ? a[it.id].v : null));
  const pos = Object.fromEntries(B.lists.map((l) => [l.id, ilAxis(B, (it) => ((B.stances[l.id] || {})[it.id] || {}).v ?? null)]));
  const [X, Yax] = B.map;
  const P = (v) => 20 + (v + 1) * 110, Yp = (v) => 20 + (1 - v) * 110;
  const dots = B.lists.filter((l) => pos[l.id][X] != null && pos[l.id][Yax] != null).map((l) => {
    const x = P(pos[l.id][X]), y = Yp(pos[l.id][Yax]);
    return `<circle class="cur bloc-${l.bloc}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"/><text class="cl" x="${(x + 6).toFixed(1)}" y="${(y + 3).toFixed(1)}">${l.short || l.name}</text>`;
  }).join("");
  const ax = Object.fromEntries(B.axes.map((x) => [x.id, x]));
  const box = el("div", { class: "vmapbox" });
  if (me[X] != null && me[Yax] != null) box.innerHTML = `<svg class="vmap mmap" viewBox="0 0 260 260" role="img" aria-label="Your position among the lists">
    <rect x="20" y="20" width="220" height="220" class="frame"/><line x1="130" y1="20" x2="130" y2="240" class="axis"/><line x1="20" y1="130" x2="240" y2="130" class="axis"/>
    <text x="130" y="14" class="ax" text-anchor="middle">${ax[Yax].right}</text><text x="130" y="256" class="ax" text-anchor="middle">${ax[Yax].left}</text>
    <text x="14" y="130" class="ax" text-anchor="middle" transform="rotate(-90 14 130)">${ax[X].left}</text><text x="250" y="130" class="ax" text-anchor="middle" transform="rotate(90 250 130)">${ax[X].right}</text>
    ${dots}<circle class="me" cx="${P(me[X]).toFixed(1)}" cy="${Yp(me[Yax]).toFixed(1)}" r="7"/></svg>`;
  const blocs = ["gov", "opp", "arab"].map((b) => { const xs = scored.filter((m) => m.l.bloc === b); return [b, xs.length ? Math.round(xs.reduce((s, m) => s + m.pct, 0) / xs.length) : null]; });
  const polls = data.il_polls && data.il_polls.latest ? data.il_polls.latest : [];
  const seatRange = (l) => { const v = polls.map((p) => p.seats[l.poll_name]).filter((x) => x != null); return v.length ? (Math.min(...v) === Math.max(...v) ? Math.min(...v) : Math.min(...v) + "–" + Math.max(...v)) + " seats in the latest polls" : ""; };
  const listRow = (m) => el("details", { class: "race" },
    el("summary", {}, el("span", { class: "rtitle" }, el("b", { text: m.l.name }), " · " + m.pct + "% agreement" + (scored.some((y) => y !== m && y.pct === m.pct) ? " · tied" : "")),
      el("span", { class: "rsub", text: [m.l.leader, B.bloc_names[m.l.bloc], seatRange(m.l), m.n + " statements in common"].filter(Boolean).join(" · ") }), el("span", { class: "chev", text: "▾" })),
    m.l.what ? el("p", { class: "rjob", text: m.l.what }) : null,
    el("ul", { class: "cpos" }, ...m.rows.map((x) => el("li", {}, el("b", { text: x.agree >= 0.75 ? "Agree · " : x.agree <= 0.25 ? "Differ · " : "Partly · " }),
      "“" + text[x.q] + "” You: " + label(x.you) + ". " + (m.l.short || m.l.name) + ": " + label(x.them) + (x.note ? " (" + x.note + ")" : "") + " ", x.source ? link(x.source, "↗", "srcl") : null))));
  const nodes = [
    el("h2", { id: "sheet-title", class: "stitle", text: "Your Israel match" }),
    el("p", { class: "sdesc", text: "How closely your answers match each list's stated positions, weighted by how much each statement matters to you. Lists are coded only where a source shows their position, and a list needs three statements in common to be ranked. Agreement on stated positions is a guide to where you sit, not a verdict." }),
    answerWarnings(B.items, a),
    el("button", { class: "linkbtn", text: "How this works ›", onclick: () => methodSheet("the Israel match", { statements: B.items.length, actor: "list", min: 3, map: "The map places you and each list on security (Israel's main left-right divide, per expert surveys) and religion and state, each built from several statements; the courts and the economy are shown separately because in Israel they don't line up with left and right. Approximate.", version: B.version }, () => openIlMatch()) }),
    scored.length ? el("h3", { class: "sh3", text: "Closest lists" }) : null,
    ...scored.map(listRow),
    el("h3", { class: "sh3", text: "By bloc" }),
    el("div", { class: "subjrow" }, ...blocs.map(([b, v]) => el("span", { class: "subj" + (v != null && v === Math.max(...blocs.map(([, x]) => x ?? -1)) ? " on" : ""), text: B.bloc_names[b] + (v != null ? " " + v + "%" : " —") }))),
    el("p", { class: "fine", text: "Average agreement with the ranked lists in each bloc." }),
    box.innerHTML ? el("h3", { class: "sh3", text: "Where you sit" }) : null, box.innerHTML ? box : null,
    box.innerHTML ? el("p", { class: "fine", text: "Each list placed from its own coded positions on the same statements; the large dot is you." }) : null,
    ...B.axes.filter((x) => !B.map.includes(x.id) && me[x.id] != null).map((x) => barRow(x, { s: me[x.id], n: 1 })),
    el("details", { class: "rest" }, el("summary", {}, el("span", { text: "Every statement and its scale" }), el("span", { class: "chev", text: "▾" })),
      el("ul", { class: "cpos" }, ...B.items.map((it) => el("li", {}, el("b", { text: ax[it.axis].label + " · agreeing points " + (it.dir > 0 ? ax[it.axis].right : ax[it.axis].left).toLowerCase() + ". " }), "“" + it.text + "” You: " + (a[it.id] ? (a[it.id].skip ? "skipped" : label(a[it.id].v)) : "not answered") + ".")))),
    el("div", { class: "sactions" }, el("button", { class: "sbtn", text: "Close", onclick: closeSheet })),
  ];
  openSheet(nodes.filter(Boolean), "Your Israel match");
}

// --------------------------------------------------------------- Get up to speed (2026-10-25)
// Joe: "learn how I like to learn … see what I actually engage with versus what I think I engage
// with, then help me get up to speed on issues I don't yet have a full grasp of."
// learn.yaml (data.learn): topics, each with curated resources in four formats. A topic surfaces
// when Joe answers a statement on it Neutral or Skip, or opens its explainer. Resources are
// ordered by the formats he actually opens (the engagement log), or by what he says he prefers
// until there's enough of a log. Statements carry `topic` in their questionnaire files.
const FORMATS = [["video", "Videos", "▶"], ["article", "Articles", "¶"], ["podcast", "Podcasts", "🎧"], ["deep", "Deep dives", "📚"]];
let engageData = null;
async function loadEngage(force) {
  if (engageData && !force) return engageData;
  try { const r = await fetch("engage", { credentials: "same-origin" }); engageData = r.ok ? await r.json() : { events: [] }; } catch (e) { engageData = { events: [] }; }
  return engageData;
}
function allQuizItems() {
  const out = [];
  const g = data.voter_guide;
  if (g && g.quiz) for (const it of g.quiz.items) out.push({ ...it, quiz: "election", answers: () => (((myQuiz || {}).elections || {})[g.id] || {}).answers || {} });
  if (data.il_quiz) for (const it of data.il_quiz.items) out.push({ ...it, quiz: "israel", answers: () => (((myQuiz || {}).elections || {})[IL_ID] || {}).answers || {} });
  if (data.values_bank) for (const it of data.values_bank.items) out.push({ ...it, quiz: "values", answers: () => ((myQuiz || {}).values || {}).answers || {} });
  return out.filter((it) => it.topic);
}
// Which topics need attention, and why.
function flaggedTopics(E) {
  const flags = {};
  const add = (t, why) => { (flags[t] = flags[t] || new Set()).add(why); };
  for (const it of allQuizItems()) {
    const a = it.answers()[it.id];
    if (a && a.skip) add(it.topic, "skipped");
    else if (a && a.v === 0) add(it.topic, "answered Neutral");
  }
  const byId = Object.fromEntries(allQuizItems().map((it) => [it.id, it]));
  for (const e of (E && E.events) || []) if (e.k === "explain") { const id = String(e.t || "").split(" ")[0]; if (byId[id]) add(byId[id].topic, "opened the explainer"); }
  return flags;
}
// Formats by what he actually opens: link clicks in the last 60 days, by format.
function actualFormats(E) {
  const cut = Date.now() - 60 * 86400e3;
  const n = { video: 0, article: 0, podcast: 0, doc: 0 };
  let sheetSec = 0, sheets = 0;
  for (const e of (E && E.events) || []) {
    if (Date.parse(e.at) < cut) continue;
    if (e.k === "link" && n[e.f] != null) n[e.f] += 1;
    if (e.k === "sheet" && e.s) { sheetSec += e.s; sheets += 1; }
  }
  const links = n.video + n.article + n.podcast + n.doc;
  return { n, links, avgSheet: sheets ? Math.round(sheetSec / sheets) : null, sheets };
}
function formatOrder(E) {
  const A = actualFormats(E);
  if (A.links >= 15) {
    const deep = A.n.doc;
    return [["video", A.n.video], ["article", A.n.article], ["podcast", A.n.podcast], ["deep", deep]].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  }
  const st = (E && E.stated) || {};
  const rank = { often: 0, sometimes: 1, rarely: 2 };
  return FORMATS.map(([f]) => f).sort((a, b) => (rank[st[a]] ?? 1) - (rank[st[b]] ?? 1));
}
// --------------------------------------------------------------- Your solutions (2026-10-25)
// Joe writes his own fix for an issue. /solve sends it to Workers AI with the statements and
// policy mechanisms on that issue (solutions.yaml, public: mechanisms and each candidate's or
// list's sourced plan), and returns codes, each tied to a quote from his text. Nothing counts
// until he confirms it. Confirmed statement codes fill in the election check and the Israel match
// where he hasn't answered that statement himself (his own answer always wins, and a clash is
// flagged); confirmed mechanism codes are compared plan to plan with the candidates. All of it
// lives only in KV (proposals.json) and is processed only in Cloudflare.
let myProps = null;
async function loadProps(force) {
  if (myProps && !force) return myProps;
  try { const r = await fetch("solve", { credentials: "same-origin" }); myProps = r.ok ? await r.json() : { issues: {} }; } catch (e) { myProps = myProps || { issues: {} }; }
  return myProps;
}
function solvePost(body) {
  return fetch("solve", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "HTTP " + r.status); return j; });
}
// Statement answers implied by confirmed proposals, for one instrument ("election" or "israel").
function proposalAnswers(kind) {
  const out = {};
  const items = Object.fromEntries(allQuizItems().filter((it) => it.quiz === kind).map((it) => [it.id, it]));
  for (const [iss, p] of Object.entries((myProps || {}).issues || {})) {
    for (const [q, c] of Object.entries(p.codes || {})) if (items[q] && out[q] == null) out[q] = { v: c.v, w: p.w || 2, from: "proposal", issue: iss };
  }
  return out;
}
// His own answers win; proposals fill the gaps.
function withProposals(kind, answers) {
  const P = proposalAnswers(kind);
  const merged = Object.assign({}, P);
  for (const [k, a] of Object.entries(answers || {})) if (a && !a.skip && a.v != null) merged[k] = a; else if (a && a.skip && !P[k]) merged[k] = a;
  return merged;
}
function propCount(kind, answers) { return Object.keys(proposalAnswers(kind)).filter((k) => !(answers || {})[k] || (answers[k].skip)).length; }
// Clashes: a proposal and his own answer two or more steps apart.
function propClashes(issue) {
  const p = ((myProps || {}).issues || {})[issue];
  if (!p) return [];
  const out = [];
  for (const it of allQuizItems()) {
    const c = (p.codes || {})[it.id], a = it.answers()[it.id];
    if (c && a && !a.skip && a.v != null && Math.abs(c.v - a.v) >= 2) out.push({ it, c, a });
  }
  return out;
}
function solveActors(S) {
  if (S.instrument === "israel" && data.il_quiz) return Object.fromEntries(data.il_quiz.lists.map((l) => [l.id, l.name]));
  return Object.fromEntries(Object.keys(S.plans || {}).map((n) => [n, n]));
}
function planMatch(S, mine) {
  const names = solveActors(S);
  return Object.entries(S.plans || {}).map(([k, cells]) => {
    let num = 0, n = 0;
    const rows = [];
    for (const [m, x] of Object.entries(cells)) {
      const y = mine[m];
      if (!y || y.v == null || x.unverified) continue;
      const agree = 1 - Math.abs(y.v - x.v) / 2;
      num += agree; n += 1;
      rows.push({ m, you: y.v, them: x.v, agree, note: x.note, source: x.source });
    }
    return { k, name: names[k] || k, n, pct: n ? Math.round(100 * num / n) : null, rows: rows.sort((a, b) => b.agree - a.agree) };
  }).filter((x) => x.n > 0).sort((a, b) => (b.n >= 2) - (a.n >= 2) || (b.pct ?? -1) - (a.pct ?? -1));
}
const MECH = [[1, "Propose"], [0, "Mixed"], [-1, "Reject"]];
const mechWord = (v) => (MECH.find(([k]) => k === v) || [0, "–"])[1];
function solveEntry() {
  const S = data.solutions;
  if (!S || !Object.keys(S).length) return null;
  const done = Object.keys(((myProps || {}).issues) || {}).filter((k) => S[k]).length;
  if (!myProps) loadProps().then(() => { const t = document.querySelector(".solveentry .rjob"); if (t) t.textContent = solveLine(); });
  function solveLine() { const n = Object.keys(((myProps || {}).issues) || {}).filter((k) => S[k]).length; return n ? n + " of " + Object.keys(S).length + " issues written." : "Write your own fix for an issue; see whose plans come closest to it."; }
  return el("div", { class: "rbox quizbox solveentry" }, el("span", { class: "mlabel", text: "Your solutions" }),
    el("p", { class: "rjob", text: myProps ? solveLine() : (done ? "" : "Write your own fix for an issue; see whose plans come closest to it.") }),
    el("button", { class: "sbtn primary wide", text: "Open", onclick: () => openSolutions() }));
}
async function openSolutions() {
  await Promise.all([loadProps(true), loadQuiz(true)]);
  const S = data.solutions || {};
  const P = myProps.issues || {};
  const row = (k) => { const p = P[k], cl = propClashes(k).length;
    return el("li", {}, el("button", { class: "doclink", text: S[k].title, onclick: () => openIssue(k) }),
      el("span", { class: "asrc", text: p ? " · written " + fmtDate.format(new Date(p.saved_at)) + (cl ? " · " + cl + " clash" + (cl > 1 ? "es" : "") + " with your answers" : "") : "" })); };
  const groups = [["election", "On your ballot"], ["israel", "Israel"]];
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "Your solutions" }),
    el("p", { class: "sdesc", text: "Say what you'd do about an issue, in your own words. The Wire reads it against the statements and the concrete plans on that issue, and shows you what it understood, quoting you. Nothing counts until you confirm it." }),
    ...groups.flatMap(([g, label]) => { const ks = Object.keys(S).filter((k) => (S[k].instrument || "election") === g); return ks.length ? [el("h3", { class: "sh3", text: label }), el("ul", { class: "admin" }, ...ks.map(row))] : []; }),
    el("button", { class: "linkbtn", text: "How this works ›", onclick: () => solveMethod() }),
    el("p", { class: "fine", text: "Private: your text and everything read from it are stored only in your Cloudflare storage behind your login, read by Cloudflare's AI (which doesn't keep or train on it), and never reach the code repository, its logs or Ballot Match." }),
  ], "Your solutions");
}
function solveMethod() {
  openSheet([
    el("button", { class: "linkbtn", text: "‹ Your solutions", onclick: () => openSolutions() }),
    el("h2", { id: "sheet-title", class: "stitle", text: "How Your solutions works" }),
    el("p", { text: "Each issue has the statements from your questionnaires on that subject, and a menu of concrete mechanisms: the specific things a government could do, including ones no candidate proposes. Each candidate or list is coded on a mechanism only where a source shows their position; the source is linked on every row, and a second researcher checked the codes." }),
    el("p", { text: "When you ask The Wire to read your proposal, a language model codes it against those statements and mechanisms. Every code must quote your own words: if the quote isn't in your text, the code is thrown out. You then accept, change or drop each one, and can set mechanisms your text didn't mention." }),
    el("p", { text: "Confirmed statement codes count in the election check and the Israel match only where you haven't answered that statement yourself, at the importance you gave the issue. Your own answer always wins, and when a proposal and an answer are two or more steps apart, both are shown so you can decide which is you." }),
    el("p", { text: "Closest plans: agreement on each mechanism you and they both have a position on (same = 100%, one step apart = 50%, opposite = 0%), averaged. Two shared mechanisms are needed for a percentage. It compares what you'd do with what they say they'd do; it isn't a recommendation." }),
    el("p", { text: "Ideas in your text that no statement or mechanism covers are listed as gaps. If you send them to Claude, they can become new statements, written neutrally and mixed into the bank, so nothing in the public code shows which ideas were yours." }),
  ], "How Your solutions works");
}
async function openIssue(k, notice) {
  await loadProps();
  const S = data.solutions[k], p = (myProps.issues || {})[k];
  const items = allQuizItems().filter((it) => it.topic === k);
  const box = el("textarea", { class: "tin", rows: "7", placeholder: "In your own words: what would you do, how would you pay for it, what would you leave alone?" });
  box.value = p ? p.text : "";
  let w = p ? p.w || 2 : 2;
  const wrow = el("div", { class: "wrow" }, ...[[1, "Matters a little"], [2, "Matters"], [3, "Matters a lot"]].map(([v, t]) => { const b = el("button", { class: "chip" + (w === v ? " on" : ""), text: t });
    b.onclick = () => { w = v; [...wrow.children].forEach((c) => c.classList.toggle("on", c === b)); }; return b; }));
  const status = el("p", { class: notice ? "okmsg" : "fine", text: notice || "" });
  const go = el("button", { class: "sbtn primary wide", text: p ? "Read my proposal again" : "Read my proposal" });
  go.onclick = async () => {
    const text = box.value.trim();
    if (text.split(/\s+/).length < 8) { status.className = "errmsg"; status.textContent = "Write a little more first: a sentence or two about what you'd do."; return; }
    go.textContent = "Reading…"; go.disabled = true;
    try {
      const R = await solvePost({ action: "read", issue: k, title: S.title, text, statements: items.map((it) => ({ id: it.id, text: it.text })), mechanisms: S.mechanisms });
      engage({ k: "quiz", t: "solve:" + k });
      openConfirm(k, text, w, R);
    } catch (e) { status.className = "errmsg"; status.textContent = "Couldn't read it: " + e.message; go.textContent = "Read my proposal"; go.disabled = false; }
  };
  const mine = p ? p.mech || {} : {};
  const pm = p ? planMatch(S, mine) : [];
  const mtext = Object.fromEntries((S.mechanisms || []).map((m) => [m.id, m.text]));
  const clashes = propClashes(k);
  const label = (v) => (SCALE.find(([x]) => x === v) || [0, "–"])[1];
  openSheet([
    el("button", { class: "linkbtn", text: "‹ Your solutions", onclick: () => openSolutions() }),
    el("span", { class: "mlabel", text: "Your solutions" }),
    el("h2", { id: "sheet-title", class: "stitle", text: S.title }),
    el("p", { class: "sdesc", text: S.prompt }),
    items.length ? el("details", { class: "rest" }, el("summary", {}, el("span", { text: "Background: the statements on this" }), el("span", { class: "chev", text: "▾" })),
      el("ul", { class: "admin" }, ...items.map((it) => el("li", {}, (data.explain || {})[it.id] ? el("button", { class: "doclink", text: it.text, onclick: () => openExplain(it.id, () => openIssue(k)) }) : el("span", { text: it.text })))),
      data.learn && data.learn.topics[k] ? el("button", { class: "linkbtn", text: "Get up to speed on this ›", onclick: () => openTopic(k) }) : null) : null,
    box,
    el("p", { class: "fine", text: "How much does this issue matter to you?" }), wrow,
    go, status,
    el("p", { class: "fine", text: "Reading sends your text to Cloudflare's AI and back to you. Nothing is saved until you confirm." }),
    p && clashes.length ? el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "Your proposal and your answers disagree" }),
      el("ul", { class: "cpos" }, ...clashes.map(({ it, c, a }) => el("li", {}, "“" + it.text + "” Your proposal reads as " + label(c.v) + (c.quote ? " (“" + c.quote + "”)" : "") + "; you answered " + label(a.v) + ". Your answer is the one that counts."))),
      el("p", { class: "fine", text: "Either can be right: proposals are concrete, statements are general. Re-answer the statement if your answer no longer fits." })) : null,
    p ? el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "Closest plans" }),
      pm.length ? el("div", {}, ...pm.map((x) => el("details", { class: "race" },
        el("summary", {}, el("span", { class: "rtitle" }, el("b", { text: x.name }), x.n >= 2 ? " · " + x.pct + "% alike" + (pm.some((y) => y !== x && y.n >= 2 && y.pct === x.pct) ? " · tied" : "") : " · one shared mechanism"),
          el("span", { class: "rsub", text: x.n + " mechanism" + (x.n === 1 ? "" : "s") + " in common" }), el("span", { class: "chev", text: "▾" })),
        el("ul", { class: "cpos" }, ...x.rows.map((r) => el("li", {}, el("b", { text: r.agree === 1 ? "Same · " : r.agree === 0 ? "Opposite · " : "Partly · " }),
          mtext[r.m] + ". You: " + mechWord(r.you) + ". " + x.name.split(" ").slice(-1)[0] + ": " + mechWord(r.them) + (r.note ? " (" + r.note + ")" : "") + " ", r.source ? link(r.source, "↗", "srcl") : null)))))) 
        : el("p", { class: "fine", text: "None of your confirmed mechanisms overlaps a coded plan yet. Set a few in the reading, or write more about how you'd do it." }),
      (p.goals || []).length ? el("p", { class: "fine", text: "What your proposal is after: " + p.goals.join("; ") + "." }) : null,
      (p.gaps || []).length ? el("p", { class: "fine", text: "Not covered by any statement or plan yet: " + p.gaps.join("; ") + ". Send these to Claude if you'd like them added as statements." }) : null,
      el("p", { class: "fine", text: "Agreement on stated plans is one input, not a recommendation. Last saved " + fmtDate.format(new Date(p.saved_at)) + "." }),
      el("p", { class: "fine" }, el("button", { class: "unsave", text: "Delete this proposal", onclick: async () => { await solvePost({ action: "delete", issue: k }); await loadProps(true); openSolutions(); } }))) : null,
  ].filter(Boolean), S.title);
}
function openConfirm(k, text, w, R) {
  const S = data.solutions[k];
  const items = Object.fromEntries(allQuizItems().filter((it) => it.topic === k).map((it) => [it.id, it]));
  const codes = {}, mech = {};
  for (const x of R.statements || []) codes[x.id] = { v: x.v, quote: x.quote, by: "read" };
  for (const x of R.mechanisms || []) mech[x.id] = { v: x.v, quote: x.quote, by: "read" };
  const chips = (opts, get, set) => { const row = el("div", { class: "wrow" });
    const draw = () => { row.replaceChildren(...opts.map(([v, t]) => { const b = el("button", { class: "chip" + (get() === v ? " on" : ""), text: t }); b.onclick = () => { set(v); draw(); }; return b; })); };
    draw(); return row; };
  const stRows = (R.statements || []).map((x) => el("div", { class: "vbar" },
    el("p", {}, el("b", { text: items[x.id] ? items[x.id].text : x.id })), el("p", { class: "fine", text: "From your words: “" + x.quote + "”" }),
    chips([...SCALE, [null, "Drop"]], () => (codes[x.id] ? codes[x.id].v : null), (v) => { if (v == null) delete codes[x.id]; else codes[x.id] = { v, quote: x.quote, by: v === x.v ? "read" : "you" }; })));
  const mRows = (S.mechanisms || []).map((m) => { const r = (R.mechanisms || []).find((x) => x.id === m.id);
    return el("div", { class: "vbar" }, el("p", {}, el("b", { text: m.text })),
      r ? el("p", { class: "fine", text: "From your words: “" + r.quote + "”" }) : el("p", { class: "fine", text: "Your text doesn't say. Set it only if you want it to count." }),
      chips([...MECH, [null, r ? "Drop" : "Leave out"]], () => (mech[m.id] ? mech[m.id].v : null), (v) => { if (v == null) delete mech[m.id]; else mech[m.id] = { v, quote: r ? r.quote : null, by: r && v === r.v ? "read" : "you" }; })); });
  const status = el("p", { class: "fine" });
  const save = el("button", { class: "sbtn primary wide", text: "Save what's confirmed" });
  save.onclick = async () => {
    save.textContent = "Saving…"; save.disabled = true;
    try { myProps = await solvePost({ action: "save", issue: k, text, w, codes, mech, gaps: R.gaps, goals: R.goals }); openIssue(k, "✓ Saved. Private: Cloudflare only."); }
    catch (e) { status.className = "errmsg"; status.textContent = "Couldn't save: " + e.message; save.textContent = "Save what's confirmed"; save.disabled = false; }
  };
  openSheet([
    el("button", { class: "linkbtn", text: "‹ Back to your text", onclick: () => openIssue(k) }),
    el("span", { class: "mlabel", text: "Check the reading" }),
    el("h2", { id: "sheet-title", class: "stitle", text: S.title }),
    el("p", { class: "sdesc", text: "This is what The Wire understood, each point tied to your own words. Keep, change or drop each one. Only what you save counts." }),
    R.dropped ? el("p", { class: "fine", text: R.dropped + " reading" + (R.dropped > 1 ? "s were" : " was") + " thrown out because the quote wasn't in your text." }) : null,
    el("h3", { class: "sh3", text: "Statements · " + stRows.length }),
    stRows.length ? el("div", {}, ...stRows) : el("p", { class: "fine", text: "Your text doesn't take a clear position on any of the statements." }),
    el("h3", { class: "sh3", text: "Plans: what you'd do" }), ...mRows,
    (R.goals || []).length ? el("p", { class: "fine", text: "What it's after: " + R.goals.join("; ") + "." }) : null,
    (R.gaps || []).length ? el("p", { class: "fine", text: "Ideas nothing here covers yet: " + R.gaps.join("; ") + "." }) : null,
    save, status,
  ].filter(Boolean), "Check the reading");
}
function learnEntry() {
  if (!data.learn) return null;
  const box = el("div", { class: "rbox quizbox" }, el("span", { class: "mlabel", text: "Get up to speed" }),
    el("p", { class: "rjob", text: "Topics from your questionnaires you're less sure about, with a short video, an article, a podcast and a deep dive on each, in the formats you actually use." }),
    el("button", { class: "sbtn primary wide", text: "Open", onclick: () => openLearn() }));
  return box;
}
async function openLearn() {
  const [E] = await Promise.all([loadEngage(true), loadQuiz(true)]);
  const L = data.learn.topics;
  const flags = flaggedTopics(E);
  const flagged = Object.keys(flags).filter((t) => L[t]).sort((a, b) => flags[b].size - flags[a].size);
  const rest = Object.keys(L).filter((t) => !flags[t]);
  const A = actualFormats(E);
  const st = E.stated || null;
  const topicRow = (t) => el("li", {}, el("button", { class: "doclink", text: L[t].title, onclick: () => openTopic(t) }),
    flags[t] ? el("span", { class: "asrc", text: " · you " + [...flags[t]].join(", ") }) : null);
  const label = { video: "videos", article: "articles", podcast: "podcasts", doc: "documents" };
  const actualLine = A.links ? "In the last 60 days you opened " + Object.entries(A.n).filter(([, v]) => v).map(([f, v]) => v + " " + (v === 1 ? label[f].replace(/s$/, "") : label[f])).join(", ") + (A.avgSheet ? "; you spend about " + A.avgSheet + " seconds on a story or explainer." : ".") : "Nothing logged yet: the log started Oct 25 and fills in as you read.";
  const statedLine = st ? "You said: " + FORMATS.map(([f, name]) => name.toLowerCase() + " " + (st[f] || "—")).join(", ") + (st.minutes ? "; usually " + st.minutes + " to get the gist." : ".") : null;
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "Get up to speed" }),
    el("h3", { class: "sh3", text: "How you learn" }),
    statedLine ? el("p", { text: statedLine }) : el("p", { class: "fine", text: "Tell The Wire how you like to learn; it compares that with what you actually open." }),
    el("p", { text: actualLine }),
    A.links >= 15 && st ? el("p", { class: "fine", text: "Resources are ordered by what you actually open." }) : el("p", { class: "fine", text: "Until there are 15 or more opens to go on, resources are ordered by what you say you prefer." }),
    el("button", { class: "sbtn", text: st ? "Change how you like to learn" : "How do you like to learn?", onclick: () => openStated(E) }),
    flagged.length ? el("h3", { class: "sh3", text: "Worth getting up to speed on · " + flagged.length }) : null,
    flagged.length ? el("ul", { class: "admin" }, ...flagged.map(topicRow)) : el("p", { class: "fine", text: "No topics flagged yet. They appear when you answer a statement Neutral or Skip, or open its explainer." }),
    el("h3", { class: "sh3", text: "All topics" }),
    el("ul", { class: "admin" }, ...rest.map(topicRow)),
  ].filter(Boolean), "Get up to speed");
}
function openStated(E) {
  const st = Object.assign({}, E.stated || {});
  const rows = FORMATS.map(([f, name, icon]) => el("div", { class: "vbar" }, el("div", { class: "vbl" }, el("b", { text: icon + " " + name })),
    el("div", { class: "wrow" }, ...["often", "sometimes", "rarely"].map((v) => { const b = el("button", { class: "chip" + (st[f] === v ? " on" : ""), text: v });
      b.onclick = () => { st[f] = v; [...b.parentNode.children].forEach((c) => c.classList.toggle("on", c === b)); }; return b; }))));
  const mins = el("div", { class: "wrow" }, ...["5 minutes", "20 minutes", "an hour or more"].map((v) => { const b = el("button", { class: "chip" + (st.minutes === v ? " on" : ""), text: v });
    b.onclick = () => { st.minutes = v; [...mins.children].forEach((c) => c.classList.toggle("on", c === b)); }; return b; }));
  openSheet([
    el("button", { class: "linkbtn", text: "‹ Back", onclick: () => openLearn() }),
    el("h2", { id: "sheet-title", class: "stitle", text: "How do you like to learn?" }),
    el("p", { class: "sdesc", text: "When you want to understand something new, how often would you reach for each of these?" }),
    ...rows,
    el("p", { class: "fine", text: "How long would you usually give it, to get the gist?" }), mins,
    el("button", { class: "sbtn primary wide", text: "Save", onclick: async () => {
      try { await fetch("engage", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ stated: st }) }); } catch (e) { /* best effort */ }
      await loadEngage(true); openLearn(); } }),
  ], "How do you like to learn?");
}
async function openTopic(t) {
  const E = await loadEngage();
  const T = data.learn.topics[t];
  const order = formatOrder(E);
  const res = (T.resources || []).slice().sort((a, b) => order.indexOf(a.format) - order.indexOf(b.format));
  const items = allQuizItems().filter((it) => it.topic === t);
  const icon = Object.fromEntries(FORMATS.map(([f, , i]) => [f, i]));
  const reanswer = () => {
    const el1 = items.filter((it) => it.quiz === "election").map((it) => it.id);
    const il = items.filter((it) => it.quiz === "israel").map((it) => it.id);
    if (il.length) openIlQuiz(il); else if (el1.length && data.voter_guide) openQuiz(data.voter_guide, el1);
  };
  engage({ k: "story", t: "learn:" + t });
  openSheet([
    el("button", { class: "linkbtn", text: "‹ All topics", onclick: () => openLearn() }),
    el("span", { class: "mlabel", text: "Get up to speed" }),
    el("h2", { id: "sheet-title", class: "stitle", text: T.title }),
    T.intro ? el("p", { class: "sdesc", text: T.intro }) : null,
    items.length ? el("h3", { class: "sh3", text: "Start here: the statements on this" }) : null,
    items.length ? el("ul", { class: "admin" }, ...items.map((it) => el("li", {}, (data.explain || {})[it.id] ? el("button", { class: "doclink", text: it.text, onclick: () => openExplain(it.id, () => openTopic(t)) }) : el("span", { text: it.text })))) : null,
    el("h3", { class: "sh3", text: "Go further" }),
    el("ul", { class: "reslist" }, ...res.map((r) => el("li", {},
      el("span", { class: "asrc", text: (icon[r.format] || "") + " " + (r.format === "deep" ? "Deep dive" : r.format[0].toUpperCase() + r.format.slice(1)) + " · " + r.outlet + (r.minutes ? " · " + r.minutes + " min" : "") + (r.perspective ? " · " + r.perspective : "") + (r.paywall ? " · paywall" : "") + (r.date ? " · " + r.date : "") }),
      link(r.url, r.title, "doclink"),
      r.why ? el("span", { class: "rdline", text: r.why }) : null))),
    items.some((it) => it.quiz !== "values") ? el("button", { class: "sbtn wide", text: "Re-answer these statements", onclick: reanswer }) : null,
    data.solutions && data.solutions[t] ? el("button", { class: "sbtn wide", text: "Write your own fix", onclick: () => openIssue(t) }) : null,
    el("p", { class: "fine", text: "Resources picked for quality and balance from reputable outlets; perspective labels are The Wire's." }),
  ].filter(Boolean), T.title);
}

// --------------------------------------------------------------- the starting questionnaire
// What Joe wants to follow, by subject (baseline.yaml). Standing preferences: they don't fade.
// Shuffled, one subject per screen, no hint of the effect until "What it changed".
function baselineEffect(Q) {
  const bank = data.baseline_bank;
  const A = ((Q && Q.baseline) || {}).answers || {};
  if (!bank || !Object.keys(A).length) return [];
  const scale = Object.fromEntries(bank.scale);
  const rows = (pick) => bank.items.filter((it) => !it.kind && A[it.id] && !A[it.id].skip && pick(A[it.id].v));
  const list = (xs) => xs.length ? el("ul", { class: "admin" }, ...xs.map((it) => el("li", {}, it.text, el("span", { class: "asrc", text: " " + scale[A[it.id].v] })))) : el("p", { class: "fine", text: "Nothing." });
  const h = bank.items.find((it) => it.kind === "habit");
  const hv = h && A[h.id] && !A[h.id].skip ? (h.options.find(([v]) => v === A[h.id].v) || [])[1] : null;
  return [el("h3", { class: "sh3", text: "Your starting questionnaire: more of" }), list(rows((v) => v >= 1)),
    el("h3", { class: "sh3", text: "Your starting questionnaire: less of" }), list(rows((v) => v <= -1)),
    hv ? el("p", { class: "fine", text: "“" + h.text + "” " + hv + ". " + h.effect }) : null].filter(Boolean);
}
function baselineEntry(Q) {
  const bank = data.baseline_bank;
  if (!bank) return null;
  const B = (Q && Q.baseline) || {};
  const n = bank.items.length, answered = Object.keys(B.answers || {}).length;
  const box = el("div", { class: "rbox quizbox" }, el("span", { class: "mlabel", text: bank.title }));
  if (!B.done_at) box.append(el("p", { class: "rjob", text: n + " quick questions, about three minutes. Start here: it gives the rest a baseline." }),
    el("button", { class: "sbtn primary wide", text: answered ? "Continue (" + answered + " of " + n + " answered)" : "Start", onclick: () => openBaseline() }));
  else box.append(el("p", { class: "rjob", text: "Done " + fmtDate.format(new Date(Date.parse(B.done_at))) + ". Change any answer by retaking it." }),
    el("div", { class: "sactions" }, el("button", { class: "sbtn", text: "What it changed", onclick: () => pulseEffect() }),
      el("button", { class: "sbtn", text: "Retake", onclick: async () => { store.set("wire.quizSeed.baseline", ""); await saveQuiz({ kind: "clear", id: "baseline" }); openBaseline(); } })));
  return box;
}
async function openBaseline() {
  const Q = await loadQuiz(true);
  const bank = data.baseline_bank;
  const seed = Number(store.get("wire.quizSeed.baseline")) || (Date.now() % 100000) + 1;
  store.set("wire.quizSeed.baseline", seed);
  const order = shuffled(bank.items, seed);
  const answers = Object.assign({}, ((Q.baseline || {}).answers) || {});
  let i = order.findIndex((it) => !answers[it.id]);
  if (i < 0) i = order.length;
  const step = async () => {
    if (i >= order.length) {
      await saveQuiz({ kind: "baseline", answers: {}, done: true });
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Baseline set" }),
        el("p", { class: "sdesc", text: "Saved privately. From here, five quick questions a week (or as many as you like) keep it current." }),
        el("div", { class: "sactions" }, el("button", { class: "sbtn primary", text: "Five quick questions", onclick: () => openPulse() }),
          el("button", { class: "sbtn", text: "See what this changed", onclick: () => pulseEffect() }), el("button", { class: "sbtn", text: "Close", onclick: () => { closeSheet(); render(); } }))], "Baseline set");
      return;
    }
    const it = order[i];
    const cur = answers[it.id];
    const put = (x) => { answers[it.id] = x; saveQuiz({ kind: "baseline", answers: { [it.id]: x } }); i += 1; step(); };
    const opts = it.kind === "habit" ? it.options : bank.scale;
    openSheet([
      el("div", { class: "qprog" }, el("span", { text: (i + 1) + " of " + order.length }), el("span", { class: "qbar" }, el("i", { style: "width:" + Math.round(100 * i / order.length) + "%" }))),
      it.kind === "habit" ? null : el("p", { class: "fine", text: bank.prompt }),
      el("h2", { id: "sheet-title", class: "qtext", text: it.text }),
      el("div", { class: "qscale" }, ...opts.map(([v, label]) => el("button", { class: "qopt" + (cur && cur.v === v ? " on" : ""), text: label, onclick: () => put({ v }) }))),
      el("div", { class: "qnav" },
        i > 0 ? el("button", { class: "linkbtn", text: "‹ Back", onclick: () => { i -= 1; step(); } }) : el("span", {}),
        el("button", { class: "linkbtn", text: "Skip", onclick: () => put({ skip: true }) }),
        el("button", { class: "linkbtn", text: "Finish later", onclick: () => { closeSheet(); render(); } })),
    ].filter(Boolean), bank.title);
  };
  step();
}
// How many "From people you follow" items Today shows, from the habit question.
function followingCount() {
  const a = myQuiz && myQuiz.baseline && (myQuiz.baseline.answers || {}).h01;
  return !a || a.skip || a.v == null ? 5 : a.v > 0 ? 8 : a.v < 0 ? 3 : 5;
}

// --------------------------------------------------------------- where you stand (2026-10-23)
// About 30 blind statements (values.yaml), taken about once a year. The map, readings,
// suggested scorecard weights and Undercurrents appear only on "See my results".
function runStatements(cfg) {
  // cfg: {title, items, seedKey, prior, save(partial), done(), later()}
  const seed = Number(store.get(cfg.seedKey)) || (Date.now() % 100000) + 1;
  store.set(cfg.seedKey, seed);
  const order = shuffled(cfg.items, seed);
  const answers = Object.assign({}, cfg.prior);
  let i = cfg.redo ? 0 : order.findIndex((it) => !answers[it.id]);
  if (i < 0) i = order.length;
  const render1 = () => {
    if (i >= order.length) { cfg.done(answers); return; }
    const it = order[i];
    const cur = answers[it.id];
    let weight = cur && cur.w ? cur.w : 2;
    const wrow = el("div", { class: "wrow" }, ...WEIGHT.map(([w, label]) => { const b = el("button", { class: "chip" + (w === weight ? " on" : ""), text: label });
      b.onclick = () => { weight = w; [...wrow.children].forEach((c) => c.classList.toggle("on", c === b)); }; return b; }));
    const put = (x) => { answers[it.id] = x; cfg.save({ [it.id]: x }); i += 1; render1(); };
    openSheet([
      el("div", { class: "qprog" }, el("span", { text: (i + 1) + " of " + order.length }), el("span", { class: "qbar" }, el("i", { style: "width:" + Math.round(100 * i / order.length) + "%" }))),
      el("h2", { id: "sheet-title", class: "qtext", text: it.text }),
      explainBtn(it.id, render1),
      el("p", { class: "fine", text: "How much does this matter to you? (set this first)" }), wrow,
      el("div", { class: "qscale" }, ...SCALE.map(([v, label]) => el("button", { class: "qopt" + (cur && cur.v === v ? " on" : ""), text: label, onclick: () => put({ v, w: weight }) }))),
      el("div", { class: "qnav" },
        i > 0 ? el("button", { class: "linkbtn", text: "‹ Back", onclick: () => { i -= 1; render1(); } }) : el("span", {}),
        el("button", { class: "linkbtn", text: "Skip", onclick: () => put({ skip: true }) }),
        el("button", { class: "linkbtn", text: "Finish later", onclick: () => cfg.later() })),
    ], cfg.title);
  };
  render1();
}
function valuesEntry(Q) {
  const bank = data.values_bank;
  if (!bank) return null;
  const V = (Q && Q.values) || {};
  const n = bank.items.length, answered = Object.keys(V.answers || {}).length;
  const due = V.done_at && Date.now() - Date.parse(V.done_at) > (bank.retake_days || 330) * 86400e3;
  const box = el("div", { class: "rbox quizbox" }, el("span", { class: "mlabel", text: bank.title }));
  if (!V.done_at) {
    box.append(el("p", { class: "rjob", text: n + " statements, about " + Math.ceil(n / 4) + " minutes. Answer how you see it; what each one measures is explained only afterwards." }),
      el("button", { class: "sbtn primary wide", text: answered ? "Continue (" + answered + " of " + n + " answered)" : "Start", onclick: () => openValues() }));
  } else {
    box.append(el("p", { class: "rjob", text: "Done " + fmtDate.format(new Date(Date.parse(V.done_at))) + (due ? ". It's been about a year: a retake shows how far you've moved." : ". Take it again in about a year to see how you've moved.") }),
      el("div", { class: "sactions" }, el("button", { class: "sbtn primary", text: "See my results", onclick: () => openStand() }),
        el("button", { class: "sbtn", text: "Retake", onclick: async () => { store.set("wire.quizSeed.values", ""); await saveQuiz({ kind: "values", restart: true, answers: {} }); openValues(); } })));
  }
  return box;
}
async function openValues() {
  const Q = await loadQuiz(true);
  const bank = data.values_bank;
  runStatements({
    title: bank.title, items: bank.items, seedKey: "wire.quizSeed.values", prior: (Q.values || {}).answers || {},
    save: (partial) => saveQuiz({ kind: "values", answers: partial }),
    later: () => { closeSheet(); render(); },
    done: async () => {
      await saveQuiz({ kind: "values", answers: {}, done: true });
      openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Done" }),
        el("p", { class: "sdesc", text: "Your answers are saved privately. Your results aren't shown anywhere until you open them." }),
        el("div", { class: "sactions" }, el("button", { class: "sbtn primary", text: "See my results", onclick: () => openStand() }), el("button", { class: "sbtn", text: "Close", onclick: () => { closeSheet(); render(); } }))], "Done");
    },
  });
}
// Each scale from -1 to +1: Σ(answer × direction × importance) / Σ(2 × importance), over the
// values statements and the election check's statements that measure the same scale.
function standScores(answers, extra) {
  const bank = data.values_bank;
  const items = [...bank.items.map((it) => [it, answers]), ...(extra || [])];
  const out = {};
  for (const ax of bank.axes) out[ax.id] = { num: 0, den: 0, n: 0 };
  for (const [it, ans] of items) {
    const a = ans && ans[it.id];
    if (!it.axis || !out[it.axis] || !a || a.skip || a.v == null) continue;
    const w = a.w || 2;
    out[it.axis].num += a.v * it.dir * w; out[it.axis].den += 2 * w; out[it.axis].n += 1;
  }
  return Object.fromEntries(Object.entries(out).map(([k, x]) => [k, { s: x.den ? x.num / x.den : null, n: x.n }]));
}
function electionExtra(Q) {
  const g = data.voter_guide;
  const out = [];
  const a = g && g.quiz ? ((Q.elections || {})[g.id] || {}).answers : null;
  if (a) out.push(...g.quiz.items.filter((it) => it.axis).map((it) => [it, a]));
  // Top-up statements from "Sharpen my profile" count on the same scales (2026-10-26).
  const t = ((Q && Q.topup) || {}).answers;
  if (t && data.values_bank && data.values_bank.topup) out.push(...data.values_bank.topup.map((it) => [it, t]));
  return out;
}
// How sure the profile is on each scale: how many answers, and how consistently they point one way.
function axisConfidence(Q) {
  const bank = data.values_bank;
  const pairs = [...bank.items.map((it) => [it, ((Q.values || {}).answers) || {}]), ...electionExtra(Q)];
  const out = {};
  for (const ax of bank.axes) out[ax.id] = { n: 0, signs: [] };
  for (const [it, ans] of pairs) {
    const x = ans && ans[it.id];
    if (!it.axis || !out[it.axis] || !x || x.skip || x.v == null) continue;
    out[it.axis].n += 1;
    if (x.v !== 0) out[it.axis].signs.push(Math.sign(x.v * it.dir));
  }
  for (const [k, o] of Object.entries(out)) {
    const pos = o.signs.filter((v) => v > 0).length, neg = o.signs.length - pos;
    o.cons = o.signs.length ? Math.max(pos, neg) / o.signs.length : 0;
    o.level = o.n >= 10 && o.cons >= 0.75 ? "High" : o.n >= 6 && o.cons >= 0.6 ? "Medium" : "Low";
    o.need = Math.max(0, 10 - o.n) + (o.cons < 0.75 ? (0.75 - o.cons) * 12 : 0);
  }
  return out;
}
async function sharpenProfile() {
  const Q = await loadQuiz(true);
  const bank = data.values_bank;
  const pool = (bank.topup || []).filter((it) => !(((Q.topup || {}).answers || {})[it.id]));
  const conf = axisConfidence(Q);
  const axes = Object.entries(conf).filter(([k]) => pool.some((it) => it.axis === k)).sort((a, b) => b[1].need - a[1].need).slice(0, 2).map(([k]) => k);
  const items = axes.flatMap((k) => pool.filter((it) => it.axis === k).slice(0, 3));
  if (!items.length) {
    openSheet([el("h2", { id: "sheet-title", class: "stitle", text: "Nothing to sharpen" }), el("p", { class: "sdesc", text: "You've answered every top-up statement. New ones are added in small, checked batches; ask Claude for more." }),
      el("button", { class: "sbtn wide", text: "‹ Your profile", onclick: () => openProfile() })], "Sharpen");
    return;
  }
  const names = Object.fromEntries(bank.axes.map((a) => [a.id, a.label.toLowerCase()]));
  runStatements({
    title: "Sharpen my profile", items, seedKey: "wire.quizSeed.topup", prior: {}, redo: true,
    save: (partial) => saveQuiz({ kind: "topup", answers: partial }),
    later: () => openProfile(),
    done: async () => { await saveQuiz({ kind: "topup", answers: {}, round: axes }); await loadQuiz(true);
      openProfile("✓ " + items.length + " more answers on " + axes.map((k) => names[k]).join(" and ") + "."); },
  });
}
const lean = (s, ax) => s == null ? "not enough answers" : Math.abs(s) < 0.15 ? "near the middle" : (Math.abs(s) < 0.45 ? "leans " : "firmly ") + (s < 0 ? ax.left : ax.right).toLowerCase();
const fmtS = (s) => (s > 0 ? "+" : s < 0 ? "−" : "") + Math.abs(s).toFixed(2);
function mapSvg(sc, past) {
  // x: economics (Government ← → Markets); y: culture (Tradition up, Change down).
  const P = (x) => 20 + (x + 1) * 110;
  const Y = (y) => 20 + (1 - y) * 110;
  const dot = (s, cls) => s.econ.s == null || s.culture.s == null ? "" : `<circle class="${cls}" cx="${P(s.econ.s).toFixed(1)}" cy="${Y(s.culture.s).toFixed(1)}" r="${cls === "me" ? 7 : 5}"/>`;
  let trail = "";
  const pts = [...past, sc].filter((s) => s.econ.s != null && s.culture.s != null);
  if (pts.length > 1) trail = `<polyline class="trail" points="${pts.map((s) => P(s.econ.s).toFixed(1) + "," + Y(s.culture.s).toFixed(1)).join(" ")}"/>`;
  return `<svg class="vmap" viewBox="0 0 260 260" role="img" aria-label="Your position: economics ${fmtS(sc.econ.s || 0)}, culture ${fmtS(sc.culture.s || 0)}">
    <rect x="20" y="20" width="220" height="220" class="frame"/><line x1="130" y1="20" x2="130" y2="240" class="axis"/><line x1="20" y1="130" x2="240" y2="130" class="axis"/>
    <text x="130" y="14" class="ax" text-anchor="middle">Tradition</text><text x="130" y="256" class="ax" text-anchor="middle">Change</text>
    <text x="14" y="130" class="ax" text-anchor="middle" transform="rotate(-90 14 130)">Government</text><text x="250" y="130" class="ax" text-anchor="middle" transform="rotate(90 250 130)">Markets</text>
    ${trail}${past.map((s) => dot(s, "was")).join("")}${dot(sc, "me")}</svg>`;
}
function barRow(ax, x) {
  const pct = x.s == null ? 50 : Math.round(50 + 50 * x.s);
  return el("div", { class: "vbar" }, el("div", { class: "vbl" }, el("b", { text: ax.label }), el("span", { class: "asrc", text: " " + lean(x.s, ax) + (x.s != null ? " (" + fmtS(x.s) + ")" : "") })),
    el("div", { class: "vtrack" }, el("span", { class: "vpole", text: ax.left }), el("span", { class: "vline" }, x.s != null ? el("i", { style: "left:" + pct + "%" }) : null), el("span", { class: "vpole r", text: ax.right })));
}
async function openStand() {
  const Q = await loadQuiz(true);
  const bank = data.values_bank;
  const V = Q.values || {};
  const ans = V.answers || {};
  const extra = electionExtra(Q);
  const sc = standScores(ans, extra);
  const past = (V.past || []).map((p) => Object.assign(standScores(p.answers || {}), { at: p.done_at }));
  const ax = Object.fromEntries(bank.axes.map((a) => [a.id, a]));
  const holder = el("div", { class: "vmapbox" });
  holder.innerHTML = mapSvg(sc, past);
  const heavy = bank.items.filter((it) => ans[it.id] && ans[it.id].w === 3 && !ans[it.id].skip);
  // Suggested scorecard weights: average importance of the statements tied to each criterion.
  const B = await loadBallot();
  const crits = (B && B.criteria) || [];
  const imp = {};
  const cmap = (B && B.crit_map) || {};          // private: which statements inform which criterion
  for (const it of bank.items) {
    const a = ans[it.id], cr = cmap[it.id];
    if (!cr || !a || a.skip) continue;
    (imp[cr] = imp[cr] || []).push(a.w || 2);
  }
  const avg = Object.fromEntries(Object.entries(imp).map(([k, xs]) => [k, xs.reduce((s, x) => s + x, 0) / xs.length]));
  const tot = Object.values(avg).reduce((s, x) => s + x, 0);
  const weights = crits.length && tot ? el("table", { class: "score" },
    el("tr", {}, el("th", { text: "Criterion" }), el("th", { text: "Now" }), el("th", { text: "Your answers suggest" })),
    ...crits.map((c) => el("tr", {}, el("td", { class: "cn", text: c.label }), el("td", { text: Math.round(100 * c.weight) + "%" }),
      el("td", { text: avg[c.id] ? Math.round(100 * avg[c.id] / tot) + "%" : "–" })))) : null;
  const drift = past.length ? past[past.length - 1] : null;
  const nodes = [
    el("h2", { id: "sheet-title", class: "stitle", text: "Where you stand" }),
    el("p", { class: "sdesc", text: "Each scale runs from −1 to +1: your answers times the direction each statement points, weighted by how much it matters to you." + (extra.length ? " The election check's statements on the same questions count too." : "") }),
    holder,
    drift ? el("p", { class: "fine", text: "Faded dot: your take on " + fmtYear.format(new Date(Date.parse(drift.at))) + ". The line shows the path." }) : null,
    el("section", { class: "ssec" }, ...bank.axes.map((a) => barRow(a, sc[a.id]))),
    el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "Readings" }),
      el("ul", { class: "cpos" }, ...bank.axes.filter((a) => sc[a.id].n).map((a) => el("li", {}, el("b", { text: a.label + ": " }), lean(sc[a.id].s, a) + ". " + a.means + " " + sc[a.id].n + " statement" + (sc[a.id].n === 1 ? "" : "s") + "."
        + (drift && drift[a.id].s != null && sc[a.id].s != null && Math.abs(sc[a.id].s - drift[a.id].s) >= 0.1 ? " Moved " + Math.abs(sc[a.id].s - drift[a.id].s).toFixed(2) + " toward " + (sc[a.id].s > drift[a.id].s ? a.right : a.left).toLowerCase() + " since your last take." : ""))))),
    heavy.length ? el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "What you said matters a lot" }), el("ul", { class: "cpos" }, ...heavy.map((it) => el("li", { text: "“" + it.text + "” " + (SCALE.find(([k]) => k === ans[it.id].v) || [0, ""])[1] + "." })))) : null,
    weights ? el("section", { class: "ssec" }, el("h3", { class: "sh3", text: "Your scorecard's weights" }),
      el("p", { class: "fine", text: "From how much the statements tied to each criterion matter to you. Shown only: your scorecard keeps its weights until you change them." }), weights) : null,
    selfLabels(Q),
    el("button", { class: "sbtn primary wide", text: "Undercurrents", onclick: () => openLens(sc, past) }),
    el("button", { class: "sbtn wide", text: "Meme map (for fun)", onclick: () => openMemes() }),
    el("details", { class: "rest" }, el("summary", {}, el("span", { text: "Every statement and how it counted" }), el("span", { class: "chev", text: "▾" })),
      el("ul", { class: "cpos" }, ...bank.items.map((it) => { const a = ans[it.id]; return el("li", {},
        el("b", { text: (it.axis ? ax[it.axis].label + " · agreeing points " + (it.dir > 0 ? ax[it.axis].right : ax[it.axis].left).toLowerCase() : "Not on the map") + (cmap[it.id] ? " · informs " + cmap[it.id] : "") + ". " }),
        "“" + it.text + "” You: " + (!a ? "not answered" : a.skip ? "skipped" : (SCALE.find(([k]) => k === a.v) || [0, ""])[1] + ", " + (WEIGHT.find(([k]) => k === a.w) || [0, ""])[1].toLowerCase()) + "."); }))),
    el("div", { class: "sactions" }, el("button", { class: "sbtn", text: "Close", onclick: closeSheet })),
  ];
  openSheet(nodes.filter(Boolean), "Where you stand");
}

// Your own labels (2026-10-25): established instruments rather than home-made ones (QUIZZES.md
// rule 19): the American National Election Studies' 7-point self-placement, with its "haven't
// thought much about this" option, and Pew's 2026 Political Typology (taken on Pew's own site).
const ANES = [[-3, "Extremely liberal"], [-2, "Liberal"], [-1, "Slightly liberal"], [0, "Moderate; middle of the road"], [1, "Slightly conservative"], [2, "Conservative"], [3, "Extremely conservative"], ["unsure", "Haven't thought much about this"]];
const PEW_GROUPS = ["No Apologies Right", "Faith First Conservatives", "Unconventional Right", "Pragmatic and Polite Right", "Tuned-Out Middle", "Order and Opportunity Left", "Left-Out Left", "Loyal Liberals", "Leftward Progressives"];
const PEW_QUIZ = "https://www.pewresearch.org/politics/quiz/political-typology/";
function selfLabels(Q) {
  const me = (Q && Q.self) || {};
  const box = el("section", { class: "ssec" });
  const draw = () => {
    box.replaceChildren(
      el("h3", { class: "sh3", text: "Your own labels" }),
      el("p", { class: "fine", text: "Two established measures, to set beside the map above. The first is the American National Election Studies' self-placement question, asked of voters since 1972: “Where would you place yourself on this scale?”" }),
      el("div", { class: "qscale" }, ...ANES.map(([v, label]) => el("button", { class: "qopt" + (me.anes === v ? " on" : ""), text: label,
        onclick: async () => { me.anes = v; draw(); await saveQuiz({ kind: "self", anes: v }); } }))),
      el("p", { class: "fine" }, "The second is Pew Research Center's 2026 Political Typology, which sorts Americans into nine groups from their values. Take it on ", link(PEW_QUIZ, "Pew's site"), " (about 5 minutes; Pew keeps the answers), then record your group here:"),
      el("select", { class: "tin", onchange: async (e) => { me.pew = e.target.value; await saveQuiz({ kind: "self", pew: e.target.value }); draw(); } },
        el("option", { value: "", text: me.pew ? "Change your group…" : "Choose your group…" }), ...PEW_GROUPS.map((g) => el("option", { value: g, text: g, selected: me.pew === g ? true : null }))),
      me.pew ? el("p", { class: "rjob" }, el("b", { text: "Pew typology: " }), me.pew + " ", link("https://www.pewresearch.org/politics/2026/06/10/beyond-red-vs-blue-the-political-typology/", "what that group believes ↗")) : null);
  };
  draw();
  return box;
}

// --------------------------------------------------------------- Undercurrents (frameworks from Joshua Citarella, cited)
const fmtYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
// Joe's answers read through frameworks from Joshua Citarella's published research on online
// politics. Written in The Wire's voice: no quotes put in his mouth, every framework credited
// and linked. The frameworks are his; the reading is The Wire's.
const CITARELLA = {
  home: "https://joshuacitarella.substack.com/about",
  politigram: ["Politigram & the Post-left (2018)", "https://joshuacitarella.substack.com/p/politigram-and-the-post-left"],
  tag: ["Tag Yourself (2019)", "https://joshuacitarella.substack.com/p/tag-yourself"],
  pipeline: ["A New Pipeline (2025)", "https://joshuacitarella.substack.com/p/a-new-pipeline"],
};
function lensReadings(sc, past) {
  const v = (k) => (sc[k] && sc[k].s != null ? sc[k].s : 0);
  const e = v("econ"), c = v("culture"), tr = v("trust"), w = v("world"), gr = v("growth"), gn = v("green");
  const out = [];
  // 1. Class or culture (A New Pipeline).
  const louder = Math.abs(e) >= Math.abs(c) + 0.1 ? "class" : Math.abs(c) >= Math.abs(e) + 0.1 ? "culture" : "even";
  let quad;
  if (e < -0.15 && c > 0.15) quad = "Government on economics and tradition on culture: a pairing neither party offers. It's close to the voter the 2025 Pipeline piece is aimed at: economic frustration that could feed right-wing populism or be drawn into a class politics.";
  else if (e > 0.15 && c < -0.15) quad = "Markets on economics and change on culture: the economic common ground the piece says the two parties now share, with one party's culture.";
  else if (e < -0.15 && c < -0.15) quad = "Government and change: the left's usual pairing.";
  else if (e > 0.15 && c > 0.15) quad = "Markets and tradition: the right's usual pairing.";
  else if (Math.abs(e) >= 0.15) quad = "Toward " + (e > 0 ? "markets" : "government") + " on economics, near the middle on culture.";
  else if (Math.abs(c) >= 0.15) quad = "Toward " + (c > 0 ? "tradition" : "change") + " on culture, near the middle on economics.";
  else quad = "Close to the middle on both.";
  out.push({ head: "Class or culture", src: "pipeline",
    text: (louder === "class" ? "Your economic answers come through stronger than your cultural ones (" + fmtS(e) + " against " + fmtS(c) + "). In the piece's terms, you're sorted more by class, the line the piece argues politics should be redrawn along." :
      louder === "culture" ? "Your cultural answers come through stronger than your economic ones (" + fmtS(c) + " against " + fmtS(e) + "). You're sorted more by culture, the axis the piece says the parties fight on while largely agreeing on economics." :
      "Your economic and cultural answers are about equally strong (" + fmtS(e) + " and " + fmtS(c) + "): neither class nor culture sorts you more than the other.") + " " + quad });
  // 2. Nearest current in the catalog (Politigram 2018, Tag Yourself 2019).
  let cur;
  if (gn > 0.4 && gr < -0.3 && e < 0) cur = ["The post-left's degrowth wing", "politigram", "Climate first and preserve over build, on the economic left: the direction of the post-left current the 2018 Politigram essay documents, without its anti-civilization end point."];
  else if (e < -0.4 && tr < -0.2) cur = ["The ultra-left and left-communist currents", "tag", "Firmly for government economically and skeptical of the institutions that run it: the anti-party left the 2019 survey covers."];
  else if (e < -0.15) cur = ["The Bernie-era socialists", "politigram", "Government on economics, without the turn against institutions: where the 2018 Politigram essay starts the left's drift, before some of it moved further out."];
  else if (e > 0.4 && tr < -0.2 && c < 0.2) cur = ["Anarcho-capitalism", "politigram", "Firmly for markets, skeptical of institutions and not traditional on culture: the ancaps the 2018 Politigram essay catalogs, and the start of one of the drift paths it traces."];
  else if (c > 0.25 && w < -0.15) cur = ["The Zoomer Right", "tag", "Tradition at home and restraint abroad: the young right the 2019 survey describes, set apart from the free-market right by protectionism and wariness of troops overseas." + (ansOf("v04") != null && ansOf("v04") < 0 ? " Your doubts about free trade fit it too." : "")];
  else if (e > 0.15 && c > 0.15 && w > 0.15) cur = ["The free-market right the Zoomer Right broke from", "tag", "Markets, tradition and engagement abroad: closer to the Tea Party-era right the 2019 Tag Yourself survey says the younger right left behind."];
  else cur = ["Outside the catalog", "politigram", "The currents the research documents live at the edges. Your answers sit inside the mainstream range the 2018 Politigram essay describes them pushing past."];
  out.push({ head: "Nearest current: " + cur[0], src: cur[1], text: cur[2] + (cur[0] === "Outside the catalog" ? "" : " The catalog describes online currents, mostly of teenagers in 2018 and 2019; a match here means your answers point the same way on the questions they care about, not that you share their politics.") });
  // 3. Institutions.
  out.push({ head: "Inside or outside the window", src: "politigram",
    text: tr < -0.3 ? "You're skeptical of institutions (" + fmtS(tr) + "). The radical currents in that research, left and right, share that distrust of the mainstream; on this you're closer to them than to it." :
      tr > 0.3 ? "You largely trust the institutions (" + fmtS(tr) + "). That puts you with the mainstream the currents it covers define themselves against." :
      "Your trust in institutions is mixed (" + fmtS(tr) + "): neither the mainstream's confidence nor the distrust the currents it covers share." });
  // 4. Drift.
  const last = past.length ? past[past.length - 1] : null;
  if (last && last.econ.s != null && last.culture.s != null) {
    const de = e - last.econ.s, dc = c - last.culture.s;
    const dist = Math.hypot(de, dc);
    out.push({ head: "Drift", src: "politigram",
      text: dist < 0.1 ? "Since " + fmtYear.format(new Date(Date.parse(last.at))) + " you've barely moved. The 2018 Politigram essay found politics shifting in steps over time; yours is holding." :
        "Since " + fmtYear.format(new Date(Date.parse(last.at))) + " you've moved " + dist.toFixed(2) + ": " + (Math.abs(de) >= 0.05 ? (de > 0 ? "toward markets" : "toward government") : "") + (Math.abs(de) >= 0.05 && Math.abs(dc) >= 0.05 ? " and " : "") + (Math.abs(dc) >= 0.05 ? (dc > 0 ? "toward tradition" : "toward change") : "") + ". The 2018 Politigram essay calls this drift: politics moving in steps over time." });
  } else {
    out.push({ head: "Drift", src: "politigram", text: "This is your first take. The 2018 Politigram essay tracks how people's politics drift in steps over time; retake this in a year and the lens shows how far yours has moved." });
  }
  return out;
  function ansOf(id) { const a = ((myQuiz || {}).values || {}).answers || {}; return a[id] && !a[id].skip ? a[id].v : null; }
}
function openLens(sc, past) {
  const rs = lensReadings(sc, past);
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "Undercurrents" }),
    el("p", { class: "sdesc", text: "Your answers read through frameworks from research on how online politics forms and moves. The readings are The Wire's; the sources are at the bottom." }),
    ...rs.map((r) => el("section", { class: "ssec" }, el("h3", { class: "sh3", text: r.head }), el("p", { class: "lens", text: r.text }),
      el("p", { class: "fine" }, "From ", link(CITARELLA[r.src][1], CITARELLA[r.src][0])))),
    el("p", { class: "fine" }, "Sources, by Joshua Citarella: ", link(CITARELLA.politigram[1], CITARELLA.politigram[0]), " · ", link(CITARELLA.tag[1], CITARELLA.tag[0]), " · ", link(CITARELLA.pipeline[1], CITARELLA.pipeline[0])),
    el("div", { class: "sactions" }, el("button", { class: "sbtn", text: "Back to your results", onclick: () => openStand() })),
  ], "Undercurrents");
}
// Share the ballot quiz (2026-10-24): a public page, separate from The Wire, where friends and
// neighbors can take the election check on the same races and see their own matches. Public
// information only; their answers stay on their phones. Joe's toggle opens or closes it.
const SHARE_URL = "https://wire-ballot.pages.dev/";
function shareBox() {
  const status = el("p", { class: "rjob", text: "Checking…" });
  const tog = el("input", { type: "checkbox" });
  const actions = el("div", { class: "sactions" });
  const draw = (on) => {
    tog.checked = on;
    status.textContent = on ? "Open: anyone with the link can take it." : "Closed: the link shows “not open right now.”";
    actions.replaceChildren(...(on ? [
      el("button", { class: "sbtn primary", text: "Share the link", onclick: async () => { try { await navigator.share({ title: "Ballot Match", text: "A quick quiz that matches your views to the candidates on our ballot. Your answers stay on your phone.", url: SHARE_URL }); } catch (e) { try { await navigator.clipboard.writeText(SHARE_URL); status.textContent = "Link copied."; } catch (x) { status.textContent = SHARE_URL; } } } }),
      el("a", { class: "sbtn", href: SHARE_URL, target: "_blank", rel: "noopener", text: "Preview" })] : []));
  };
  tog.onchange = async () => {
    status.textContent = "Saving…";
    try { const r = await fetch("share", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: tog.checked }) }); draw(Boolean((await r.json()).on)); }
    catch (e) { status.textContent = "Couldn't save. Try again."; tog.checked = !tog.checked; }
  };
  fetch("share", { credentials: "same-origin" }).then((r) => r.json()).then((j) => draw(Boolean(j.on))).catch(() => { status.textContent = "Couldn't check."; });
  return el("div", { class: "rbox quizbox" }, el("span", { class: "mlabel", text: "Share the ballot quiz" }),
    el("p", { class: "fine", text: "A separate public page with the election check on the same races, for friends, family and neighbors. It shows only public information: the statements, the explainers, and the candidates' sourced positions. Never your answers, scorecard or anything from The Wire. Their answers stay on their own phones." }),
    el("label", { class: "trow" }, el("span", { text: "Open to anyone with the link" }), tog), status, actions);
}

function questionnairesSection(Q) {
  const lp = lastPulse(Q);
  const g = data.voter_guide;
  return [
    el("h2", { class: "sh2", text: "Questionnaires" }),
    el("p", { class: "fine", text: "Private: your answers, results and proposals are stored only on Cloudflare behind your login, never in the code repository, its logs or Ballot Match. Results show only when you open them." }),
    profileEntry(),
    localEntry(),
    reelsEntry(),
    baselineEntry(Q),
    el("div", { class: "rbox quizbox" }, el("span", { class: "mlabel", text: "Five quick questions" }),
      el("p", { class: "rjob", text: lp ? "Last answered " + fmtDate.format(new Date(lp)) + "." : "Not answered yet." }),
      el("p", { class: "fine", text: "Answer as often as you like: after five, Keep going asks more." }),
      el("div", { class: "sactions" }, el("button", { class: "sbtn primary", text: "Answer now", onclick: () => openPulse() }), lp ? el("button", { class: "sbtn", text: "What it changed", onclick: () => pulseEffect() }) : null)),
    valuesEntry(Q),
    ilEntry(Q),
    debateEntry(),
    solveEntry(),
    learnEntry(),
    el("div", { class: "rbox quizbox memeentry" }, el("span", { class: "mlabel", text: "For fun" }),
      el("p", { class: "rjob", text: (Q.memes || {}).done_at ? "Your meme map is ready." : "Twelve rounds of picture cards from online political subcultures. Pick on instinct; get placed among them." }),
      el("button", { class: "sbtn primary wide", text: (Q.memes || {}).done_at ? "See my meme map" : "Start the meme map", onclick: () => ((Q.memes || {}).done_at ? openMemeMap() : openMemes()) })),
    g && g.quiz ? el("button", { class: "doclink", text: "Election check for " + g.title + " ›", onclick: () => openGuide() }) : null,
    shareBox(),
  ].filter(Boolean);
}

// --------------------------------------------------------------- worth reading (2026-10-23)
// Books being talked about, essays worth the time, and what political writers are arguing
// about (pipeline/reading.py). Takeaways are our own, from open text: a book's come from its
// reviews (never the book), an essay's from the essay. Paywalled pieces are headline only.
const PERSP = { left: "left", "center-left": "center-left", center: "center", heterodox: "heterodox", "center-right": "center-right", right: "right", libertarian: "libertarian" };
function worthReading() {
  const R = data.reading;
  if (!R) return null;
  const day = Math.floor(Date.now() / 86400e3);
  const books = R.books || [], essays = (R.essays || []).filter((e) => e.takeaways.length || e.desc);
  const picks = [];
  if (books.length) picks.push(["book", books[day % books.length]]);
  if (essays.length) picks.push(["essay", essays[day % essays.length]]);
  if (!picks.length) return null;
  return [sectionHead("Worth reading", "a book and an essay, new each day", () => { seg.news = "IDEAS"; store.set(KEY.seg, JSON.stringify(seg)); go("news"); }, "Ideas"),
    el("ul", { class: "suggest" }, ...picks.map(([k, x]) => readingRow(k, x)))];
}
function readingRow(k, x) {
  const has = (x.takeaways || []).length;
  const meta = k === "book" ? "Book" + (x.author ? " · " + x.author : "") + " · " + (x.reviews || []).length + " review" + ((x.reviews || []).length === 1 ? "" : "s")
    : "Essay · " + x.source + (x.perspective ? " · " + (PERSP[x.perspective] || x.perspective) : "") + (x.t ? " · " + ago(Date.parse(x.t)) + " ago" : "");
  return el("li", {},
    el("span", { class: "asrc", text: meta }),
    el("button", { class: "doclink", text: x.title, onclick: () => openReading(k, x) }),
    el("span", { class: "rdline", text: x.line || x.hook || x.desc || "" }),
    el("span", { class: "sgrow" }, el("button", { class: "chip", text: has ? "Key takeaways" : k === "book" ? "Reviews" : "Read it ↗", onclick: () => has || k === "book" ? openReading(k, x) : window.open(x.link, "_blank", "noopener") })));
}
function openReading(k, x) {
  engage({ k: "takeaways", f: k, t: x.title });
  const nodes = [el("span", { class: "mlabel", text: k === "book" ? "Book being talked about" : "Essay · " + x.source }),
    el("h2", { id: "sheet-title", class: "stitle", text: x.title }),
    x.author ? el("p", { class: "sdesc", text: (k === "book" ? "by " : "") + x.author }) : null];
  if (x.line) nodes.push(el("p", { class: "lens", text: x.line }));
  if ((x.takeaways || []).length) nodes.push(el("h3", { class: "sh3", text: "Key takeaways" }), el("ul", { class: "cpos" }, ...x.takeaways.map((t) => el("li", { text: t }))));
  if (x.reception) nodes.push(el("h3", { class: "sh3", text: "How it was received" }), el("p", { text: x.reception }));
  if (!x.line && (x.hook || x.desc)) nodes.push(el("p", { text: x.hook || x.desc }));
  nodes.push(el("p", { class: "fine", text: k === "book"
    ? "Machine-written from the reviews below, not from the book. Check a review before quoting it."
    : (x.takeaways || []).length ? "Machine-written from the essay's own text. The argument is the author's." : "This publication is paywalled or doesn't allow reading, so there's only its own description." }));
  if (k === "book") nodes.push(el("h3", { class: "sh3", text: "Reviews and coverage" }), el("ul", { class: "admin" }, ...(x.reviews || []).map((r) => el("li", {}, el("span", { class: "asrc", text: r.source }), link(r.link, r.title)))));
  else nodes.push(el("div", { class: "sactions" }, el("a", { class: "sbtn primary", href: x.link, target: "_blank", rel: "noopener", text: "Read the essay ↗" })));
  openSheet(nodes.filter(Boolean), x.title);
}
function ideasView() {
  const R = data.reading;
  const out = [];
  if (!R) return [el("p", { class: "sdesc", text: "Nothing yet: the reading list builds every few hours." })];
  out.push(el("p", { class: "fine", text: "As of " + fmtTime.format(new Date(Date.parse(R.at))) + ". Takeaways are machine-written: a book's from its reviews, an essay's from its own text." }));
  if ((R.books || []).length) out.push(sectionHead("Books people are talking about", "from the last three weeks of reviews"), el("ul", { class: "suggest" }, ...R.books.map((b) => readingRow("book", b))));
  if ((R.essays || []).length) out.push(sectionHead("Essays", "across publications and perspectives, new each day"), el("ul", { class: "suggest" }, ...R.essays.map((e) => readingRow("essay", e))));
  if ((R.talk || []).length) out.push(sectionHead("What political writers are arguing about", "via Memeorandum"),
    el("ol", { class: "list plainlist" }, ...R.talk.map((t) => el("li", {}, link(t.link, t.title), t.by ? el("span", { class: "asrc", text: " · " + t.by }) : null))));
  if ((R.recent || []).length) out.push(sectionHead("New in books coverage"),
    el("ol", { class: "list plainlist" }, ...R.recent.map((t) => el("li", {}, link(t.link, t.title), el("span", { class: "asrc", text: " · " + t.source })))));
  out.push(el("div", { class: "endline", text: "End of Ideas" }));
  return out;
}

// --------------------------------------------------------------- the meme map (2026-10-23, for fun)
// Twelve rounds of four picture cards a take, drawn from a growing bank (memes.json, built from
// memes.yaml), in the registers of the online political subcultures documented in published
// research (credited by title at the bottom of the results). Each take: four map rounds, one
// round each for six dials and the collective subject, and a 2045 finale; rounds you've seen
// least come first, so every take is different. Results: the ideology map with the currents,
// the nearest current and runner-up, a stacked label, six dials, the collective subject, your
// 2045, and drift since your last take. Pictures are freely licensed (Wikimedia Commons, credited
// under the cards); "the real thing" links go to the meme formats in their original context.
// Currents defined by racism, fascism or violence are left out entirely.
let memeBank = null;
async function loadMemeBank() {
  if (memeBank) return memeBank;
  const r = await fetch("memes.json", { credentials: "same-origin" });
  memeBank = await r.json();
  return memeBank;
}
const DIAL_KEYS = ["anti", "ir", "cls", "col", "fun", "body"];
const MEME_LINK_NAME = { gadsden: "Taxation Is Theft", ancap: "Anarcho-capitalism", compass: "Political compass memes", anprim: "Anarcho-primitivism",
  eacc: "e/acc", touchgrass: "Touch grass", galaxy: "Galaxy brain", centrist: "Centrist dad", trad: "Trad", bernie: "Once again asking",
  doomer: "Doomer", bloomer: "Bloomer", accel: "Accelerationism" };
function memeDraw(B, M) {
  // Least-seen first: count how often each question appeared in past takes and this one.
  const seen = {};
  for (const t of [...(M.past || []), M]) for (const id of Object.keys((t && t.answers) || {})) seen[id] = (seen[id] || 0) + 1;
  const seed = Date.now() % 100000;
  const pick = (dim, n) => shuffled(B.questions.filter((q) => q.dim === dim), seed + dim.length)
    .sort((a, b) => (seen[a.id] || 0) - (seen[b.id] || 0)).slice(0, n);
  const body = shuffled([...pick("map", 4), ...["anti", "ir", "cls", "subj", "col", "fun", "body"].flatMap((d) => pick(d, 1))], seed);
  return [...body, ...pick("future", 1)].map((q) => q.id);
}
function memeScore(B, ans) {
  const byId = Object.fromEntries(B.questions.map((q) => [q.id, q]));
  const acc = { x: [], y: [], subj: { nation: 0, class: 0, individual: 0 }, words: {}, picks: [] };
  for (const k of DIAL_KEYS) acc[k] = [];
  for (const [id, k] of Object.entries(ans || {})) {
    const q = byId[id];
    const c = q && q.cards[k];
    if (!c) continue;
    acc.picks.push({ q, c });
    if (c.x != null) { acc.x.push(c.x); acc.y.push(c.y); }
    for (const d of DIAL_KEYS) if (c[d] != null) acc[d].push(d === "ir" || d === "fun" ? c[d] - 1 : c[d]);
    if (c.subj) acc.subj[c.subj] += 1;
    if (c.w) acc.words[c.w] = (acc.words[c.w] || 0) + 1;
  }
  if (!acc.x.length) return null;
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const r = { x: avg(acc.x), y: avg(acc.y), subj: acc.subj, words: acc.words, picks: acc.picks };
  for (const d of DIAL_KEYS) r[d] = avg(acc[d]);
  r.near = B.currents.map((c) => ({ c, d: Math.hypot(c.x - r.x, c.y - r.y) })).sort((a, b) => a.d - b.d);
  r.future = (acc.picks.find((p) => p.q.dim === "future") || {}).c;
  return r;
}
// A stacked label in the style of the internet-born hybrids the research documents: the
// strongest dial, the word your cards leaned on most, and your nearest current.
function memeLabel(r) {
  const QUAL = { anti: ["Institutionalist", "Anti-Establishment"], ir: ["Earnest", "Irony-Poisoned"], cls: ["Culture-First", "Class-First"],
    col: ["Orthodox", "Flair-Collecting"], fun: ["Casual", "Theory-Brained"], body: ["Terminally Online", "Gym-Pilled"] };
  const strong = DIAL_KEYS.filter((d) => r[d] != null).sort((a, b) => Math.abs(r[b]) - Math.abs(r[a]))[0];
  const qual = strong && Math.abs(r[strong]) >= 0.35 ? QUAL[strong][r[strong] > 0 ? 1 : 0] : "";
  const core = r.near[0].c.short;
  const coreWords = new Set(core.toLowerCase().split(/[\s-]+/));
  const word = Object.entries(r.words).sort((a, b) => b[1] - a[1]).map(([w]) => w)
    .find((w) => !w.toLowerCase().split(/[\s-]+/).some((p) => coreWords.has(p)));
  return [qual, word, core].filter(Boolean).join(" ");
}
function memeCard(B, c, onpick) {
  const im = c.img && B.images[c.img];
  return el("button", { class: "mcard" + (im ? " pic" : "") + (im && im.light ? " light" : ""), style: "background:" + (c.bg || "#33363a"), onclick: onpick },
    im ? el("img", { class: "mimg", src: im.thumb, alt: "", loading: "eager", referrerpolicy: "no-referrer" }) : el("span", { class: "mart", text: c.art }),
    el("span", { class: "mcap", text: c.c }));
}
async function openMemes(fresh) {
  const [B, Q] = await Promise.all([loadMemeBank(), loadQuiz(true)]);
  const M = Q.memes || {};
  if (M.done_at && !fresh) { openMemeMap(); return; }
  if (fresh || !M.take || M.done_at) {
    const take = memeDraw(B, M);
    await saveQuiz({ kind: "memes", restart: Boolean(M.done_at), take, answers: {} });
  }
  const M2 = (myQuiz && myQuiz.memes) || {};
  const take = M2.take || memeDraw(B, M2);
  const ans = Object.assign({}, M2.answers || {});
  const byId = Object.fromEntries(B.questions.map((q) => [q.id, q]));
  const order = take.map((id) => byId[id]).filter(Boolean);
  let i = order.findIndex((q) => ans[q.id] == null);
  if (i < 0) i = order.length;
  const seed = take.join("").length;
  const step = () => {
    if (i >= order.length) { saveQuiz({ kind: "memes", answers: {}, done: true }).then(() => openMemeMap()); return; }
    const q = order[i];
    const cards = shuffled(q.cards.map((c, k) => [c, k]), seed + i);
    const pics = cards.map(([c]) => c.img && B.images[c.img]).filter(Boolean);
    const sees = cards.map(([c]) => c.see).filter(Boolean);
    openSheet([el("div", { class: "memezone" },
      el("div", { class: "qprog" }, el("span", { text: (i + 1) + " of " + order.length }), el("span", { class: "qbar" }, el("i", { style: "width:" + Math.round(100 * i / order.length) + "%" }))),
      el("h2", { id: "sheet-title", class: "mq", text: q.q }),
      el("div", { class: "mgrid" }, ...cards.map(([c, k]) => memeCard(B, c, () => { ans[q.id] = k; saveQuiz({ kind: "memes", answers: { [q.id]: k } }); i += 1; step(); }))),
      sees.length ? el("p", { class: "fine" }, "The real thing: ", ...sees.flatMap((s, n) => [n ? " · " : "", link(B.links[s], (MEME_LINK_NAME[s] || s) + " ↗")])) : null,
      pics.length ? el("p", { class: "mcredit" }, "Pictures: ", ...pics.flatMap((p, n) => [n ? " · " : "", link(p.page, p.title.replace(/\.(jpg|png|svg|jpeg)$/i, "")), " (" + p.credit + ", " + p.license + ")"])) : null,
      el("div", { class: "qnav" }, i > 0 ? el("button", { class: "linkbtn", text: "‹ Back", onclick: () => { i -= 1; step(); } }) : el("span", {}),
        el("button", { class: "linkbtn", text: "Finish later", onclick: closeSheet }))),
    ], "Meme map");
  };
  step();
}
function memeMapSvg(B, r, past) {
  const P = (v) => 20 + (v + 1) * 110, Y = (v) => 20 + (1 - v) * 110;
  const curr = B.currents.map((c, k) => `<circle class="cur" cx="${P(c.x)}" cy="${Y(c.y)}" r="4"/><text class="cl" x="${P(c.x) + (c.x > 0.5 ? -6 : 6)}" y="${Y(c.y) + 3}" text-anchor="${c.x > 0.5 ? "end" : "start"}">${k + 1}</text>`).join("");
  const pts = [...past, r];
  const trail = pts.length > 1 ? `<polyline class="trail" points="${pts.map((p) => P(p.x).toFixed(1) + "," + Y(p.y).toFixed(1)).join(" ")}"/>` : "";
  return `<svg class="vmap mmap" viewBox="0 0 260 260" role="img" aria-label="Your position among online political currents">
    <rect x="20" y="20" width="220" height="220" class="frame"/><line x1="130" y1="20" x2="130" y2="240" class="axis"/><line x1="20" y1="130" x2="240" y2="130" class="axis"/>
    <text x="130" y="14" class="ax" text-anchor="middle">Accelerate</text><text x="130" y="256" class="ax" text-anchor="middle">Return</text>
    <text x="14" y="130" class="ax" text-anchor="middle" transform="rotate(-90 14 130)">Collective</text><text x="250" y="130" class="ax" text-anchor="middle" transform="rotate(90 250 130)">Market</text>
    ${curr}${trail}${past.map((p) => `<circle class="was" cx="${P(p.x)}" cy="${Y(p.y)}" r="5"/>`).join("")}<circle class="me" cx="${P(r.x).toFixed(1)}" cy="${Y(r.y).toFixed(1)}" r="7"/></svg>`;
}
async function openMemeMap() {
  const [B, Q] = await Promise.all([loadMemeBank(), loadQuiz(true)]);
  const M = Q.memes || {};
  const r = memeScore(B, M.answers);
  if (!r || !M.done_at) { openMemes(true); return; }
  const past = (M.past || []).map((p) => memeScore(B, p.answers)).filter(Boolean);
  const last = past[past.length - 1];
  const src = (k) => el("p", { class: "fine" }, "From ", link(B.sources[k].u, B.sources[k].t));
  const box = el("div", { class: "vmapbox" });
  box.innerHTML = memeMapSvg(B, r, past);
  const top = r.near[0], second = r.near[1];
  const dials = DIAL_KEYS.filter((d) => r[d] != null).map((d) => {
    const D = B.dims[d];
    const v = Math.max(-1, Math.min(1, r[d]));
    const moved = last && last[d] != null && Math.abs(v - last[d]) >= 0.25 ? " · moved toward " + (v > last[d] ? D.hi : D.lo).toLowerCase() + " since last time" : "";
    return el("div", { class: "vbar" },
      el("div", { class: "vbl" }, el("b", { text: D.t }), el("span", { class: "asrc", text: " " + (Math.abs(v) < 0.2 ? "in between" : (v < 0 ? D.lo : D.hi).toLowerCase()) + moved })),
      el("div", { class: "vtrack" }, el("span", { class: "vpole", text: D.lo }), el("span", { class: "vline" }, el("i", { style: "left:" + Math.round(50 + 50 * v) + "%" })), el("span", { class: "vpole r", text: D.hi })),
      el("details", { class: "dialwhy" }, el("summary", { text: "What this measures" }), el("p", { class: "fine", text: D.d }), src(D.src)));
  });
  const S = r.subj, tot = S.nation + S.class + S.individual;
  const subjRow = tot ? el("div", { class: "subjrow" }, ...[["nation", "Nation"], ["class", "Class"], ["individual", "Individual"]].map(([k, l]) =>
    el("span", { class: "subj" + (S[k] === Math.max(S.nation, S.class, S.individual) ? " on" : ""), text: l + " " + S[k] }))) : null;
  openSheet([el("div", { class: "memezone" },
    el("span", { class: "mlabel", text: "For fun" }),
    el("h2", { id: "sheet-title", class: "stitle", text: "Your meme map" }),
    el("p", { class: "elabel", text: memeLabel(r) }),
    el("p", { class: "fine", text: "Your stacked label, in the style of the internet-born hybrid ideologies the research documents: your strongest dial, the word your cards leaned on most, your nearest current." }),
    src("edeo"),
    box,
    el("p", { class: "fine", text: "Economics " + (Math.abs(r.x) < 0.15 ? "in the middle" : (r.x < 0 ? "collective" : "market")) + " (" + fmtS(r.x) + "); time " + (Math.abs(r.y) < 0.15 ? "in the middle" : (r.y < 0 ? "return" : "accelerate")) + " (" + fmtS(r.y) + ")." + (past.length ? " Faded dots: your earlier takes." : "") }),
    el("h3", { class: "sh3", text: "Nearest current: " + top.c.n }), el("p", { class: "lens", text: top.c.d }), src(top.c.src),
    el("h3", { class: "sh3", text: "Runner-up: " + second.c.n }), el("p", { text: second.c.d }), src(second.c.src),
    el("h3", { class: "sh3", text: "The dials" }), ...dials,
    subjRow ? el("h3", { class: "sh3", text: "Who 'we' are" }) : null, subjRow,
    subjRow ? el("p", { class: "fine", text: B.dims.subj.d }) : null, subjRow ? src(B.dims.subj.src) : null,
    r.future ? el("h3", { class: "sh3", text: "Your 2045" }) : null, r.future ? el("p", { class: "lens", text: "“" + r.future.c + "”" }) : null,
    r.future ? src("aeoh") : null,
    el("details", { class: "rest" }, el("summary", {}, el("span", { text: "The currents on the map" }), el("span", { class: "chev", text: "▾" })),
      el("ol", { class: "cpos" }, ...B.currents.map((c) => el("li", {}, el("b", { text: c.n + ". " }), c.d)))),
    el("details", { class: "rest" }, el("summary", {}, el("span", { text: "Your picks this take" }), el("span", { class: "chev", text: "▾" })),
      el("ul", { class: "cpos" }, ...r.picks.map((p) => el("li", {}, el("b", { text: p.q.q + " " }), p.c.c)))),
    el("p", { class: "fine" }, "Frameworks and currents from Joshua Citarella's published research, cited by title above; the cards, their placement, the label and these readings are The Wire's. Pictures are freely licensed from Wikimedia Commons and credited under each round. Currents the research documents that are defined by racism, fascism or violence are left out. It's a toy: twelve picks, not a profile."),
    el("div", { class: "sactions" }, el("button", { class: "sbtn primary", text: "Play again (new rounds)", onclick: () => openMemes(true) }),
      el("button", { class: "sbtn", text: "Close", onclick: closeSheet }))),
  ].filter(Boolean), "Your meme map");
}

// --------------------------------------------------------------- Tell The Wire (2026-10-22)
// Joe writes or dictates what matters; the model proposes changes; he ticks and applies.
// Nothing changes until Apply. functions/tell.js does the work; everything stays in KV.
const TELL_LINE = {
  topic: (p) => ["Follow a topic", p.title + " · watching " + p.terms.join(", ") + " · " + (DESK_NAME[p.desk] || p.desk)],
  search: (p) => ["Add a news search", "“" + p.query + "” · " + (DESK_NAME[p.desk] || p.desk)],
  follow: (p) => ["Follow the thread", p.title],
  more: (p) => ["More about", p.terms.join(", ")],
  less: (p) => ["Less about", p.terms.join(", ")],
  mute: (p) => ["Hide everywhere", p.words.join(", ")],
  claude: (p) => ["Note for Claude", p.note],
};
function tellCard() {
  return el("button", { class: "tellcard", onclick: () => openTell() },
    el("span", { class: "bc-ico", "aria-hidden": "true", text: "✎" }),
    el("span", { class: "bc-txt" }, el("span", { class: "bc-t", text: "Tell The Wire" }),
      el("span", { class: "bc-s", text: "Say what matters or what you want to know more about; it proposes changes" })));
}
async function openTell(prefill) {
  const box = el("textarea", { class: "tin tellin", rows: "6", placeholder: "Type or dictate (tap the mic on the keyboard). For example: I want to understand what the Haredi draft fight means for the coalition, less crypto, and keep an eye on the Newburgh waterfront." });
  if (prefill) box.value = prefill;
  const go = el("button", { class: "sbtn primary wide", text: "Propose changes" });
  const result = el("div", { class: "tellres" });
  const history = el("div", {});
  go.onclick = async () => {
    const text = box.value.trim();
    if (text.length < 8) { result.replaceChildren(el("p", { class: "fine", text: "Say a little more." })); return; }
    go.textContent = "Reading what you said…"; go.disabled = true;
    try {
      const r = await fetch("tell", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      result.replaceChildren(...proposalView(j.entry));
    } catch (e) {
      result.replaceChildren(el("p", { class: "fine", text: "Couldn't propose anything: " + e.message }));
    } finally { go.textContent = "Propose changes"; go.disabled = false; }
  };
  openSheet([
    el("h2", { id: "sheet-title", class: "stitle", text: "Tell The Wire" }),
    el("p", { class: "sdesc", text: "What matters to you, what you want to know more about, what you're tired of. The Wire proposes changes; nothing changes until you tap Apply." }),
    box, go, result, history,
  ], "Tell The Wire");
  try {
    const r = await fetch("tell", { credentials: "same-origin" });
    const j = await r.json();
    const past = (j.entries || []).slice(0, 6);
    if (past.length) history.replaceChildren(el("h3", { class: "sh3", text: "What you said before" }),
      el("ul", { class: "admin" }, ...past.map((e) => el("li", {},
        el("span", { class: "asrc", text: fmtDate.format(new Date(Date.parse(e.at))) + " · " + e.proposals.filter((p) => p.applied).length + " of " + e.proposals.length + " applied" }),
        el("button", { class: "doclink", text: e.text.length > 140 ? e.text.slice(0, 140) + "…" : e.text, onclick: () => result.replaceChildren(...proposalView(e)) })))));
  } catch (e) { /* history is a convenience */ }
}
function proposalView(entry) {
  if (!entry.proposals.length) return [el("p", { class: "fine", text: (entry.summary ? entry.summary + " " : "") + "Nothing concrete to change. Try naming a subject, a place, a person or something you want less of." })];
  const boxes = [];
  const list = el("ul", { class: "props" }, ...entry.proposals.map((p, i) => {
    const [k, v] = (TELL_LINE[p.type] || (() => [p.type, ""]))(p);
    const cb = el("input", { type: "checkbox", checked: p.applied ? null : true, disabled: p.applied ? true : null });
    boxes.push(cb);
    return el("li", { class: p.applied ? "done" : "" }, el("label", {}, cb,
      el("span", { class: "pk", text: k + (p.applied ? " · applied" : "") }), el("span", { class: "pv", text: v }),
      p.why ? el("span", { class: "asrc", text: p.why }) : null));
  }));
  const status = el("p", { class: "fine" });
  const apply = el("button", { class: "sbtn primary wide", text: "Apply the ticked changes" });
  apply.onclick = async () => {
    const picks = boxes.map((b, i) => (b.checked && !b.disabled ? i : -1)).filter((i) => i >= 0);
    if (!picks.length) { status.textContent = "Nothing ticked."; return; }
    apply.textContent = "Applying…"; apply.disabled = true;
    try {
      const r = await fetch("tell", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "apply", id: entry.id, picks }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      follows = j.follows;
      if (j.mute && j.mute.length) {
        const cur = (prefs.mutedWords || "").split(",").map((w) => w.trim()).filter(Boolean);
        prefs.mutedWords = [...new Set([...cur, ...j.mute])].join(", ");
        savePrefs();
      }
      boxes.forEach((b, i) => { if (picks.includes(i)) { b.checked = false; b.disabled = true; b.closest("li").classList.add("done"); } });
      status.textContent = "Applied. Topics, searches and more/less take effect on the next build (within 15 minutes); hidden words right away. Notes for Claude wait in Settings › Admin.";
      render();
    } catch (e) {
      status.textContent = "Couldn't apply: " + e.message;
    } finally { apply.textContent = "Apply the ticked changes"; apply.disabled = false; }
  };
  return [entry.summary ? el("p", { class: "tellsum", text: "What I heard: " + entry.summary }) : null, list, apply, status].filter(Boolean);
}

// --------------------------------------------------------------- the Threads tab
const GROUP_LABEL = { election: "Your ballot", business: "Optima's business", law: "Law", government: "Government and policy", israel: "Israel" };
function threadsView(segment) {
  const out = [];
  const threads = data.threads || [];
  if (segment === "following") {
    const mine = threads.filter((t) => isFollowed(t.id));
    out.push(sectionHead("Following", mine.length ? mine.length + " threads and topics" : null, openTopicForm, "Follow a topic"));
    if (!mine.length) out.push(el("p", { class: "sdesc", text: "Nothing followed yet. Use Follow on any story, Add to a thread on any report, or browse the live threads." }));
    else {
      const since = prevVisit && Date.now() - prevVisit < 48 * 3600e3 ? prevVisit : Date.now() - 24 * 3600e3;
      const fresh = mine.filter((t) => (t.developments || []).some((d) => Date.parse(d.t) > since));
      const quiet = mine.filter((t) => !fresh.includes(t));
      if (fresh.length) out.push(el("h3", { class: "sh3", text: "New since you last looked" }), el("div", { class: "threads" }, ...fresh.map(threadCard)));
      if (quiet.length) out.push(el("h3", { class: "sh3", text: fresh.length ? "Quiet" : "All" }), el("div", { class: "threads" }, ...quiet.map(threadCard)));
    }
  }
  if (segment === "standing") {
    out.push(sectionHead("Standing threads", "tracked whether or not you follow them · threads.yaml"));
    for (const g of ["election", "business", "law", "government", "israel"]) {
      const list = threads.filter((t) => t.standing && (t.group || (t.desk === "LAW" ? "law" : "government")) === g);
      if (!list.length) continue;
      out.push(el("h3", { class: "sh3", text: GROUP_LABEL[g] }), standingList(list));
    }
  }
  if (segment === "suggested") {
    out.push(sectionHead("You might follow", "from what you follow and ask for more of"));
    const sugg = (data.suggest || []).map((id) => threads.find((t) => t.id === id)).filter((t) => t && !isFollowed(t.id));
    const more = threads.filter((t) => !isFollowed(t.id) && !t.named && (t.outlets >= 3 || (t.developments || []).length >= 3) && !sugg.includes(t)).slice(0, 12);
    if (!sugg.length && !more.length) out.push(el("p", { class: "sdesc", text: "Nothing to suggest yet. Suggestions come from the threads you follow and the ones you ask for more of." }));
    if (sugg.length) out.push(suggestList(sugg));
    if (more.length) out.push(el("h3", { class: "sh3", text: "Busy threads you don't follow" }), suggestList(more));
  }
  if (segment === "browse") out.push(...browseInline());
  return out;
}
function standingList(list) {
  const since = prevVisit && Date.now() - prevVisit < 48 * 3600e3 ? prevVisit : Date.now() - 24 * 3600e3;
  return el("ul", { class: "areas" }, ...list.map((t) => {
    const devs = t.developments || [];
    const last = devs[devs.length - 1];
    const fresh = devs.filter((d) => Date.parse(d.t) > since).length;
    return el("li", {}, el("button", { class: "area", onclick: () => openThread(t) },
      el("span", { class: "headline", text: t.title }),
      el("span", { class: "meta" }, el("span", { text: t.n_reports + " reports" }), el("span", { text: (t.docs || []).length + " documents" }),
        fresh ? el("span", { class: "since", text: fresh + " new" }) : null, isFollowed(t.id) ? el("span", { text: "following" }) : null),
      last ? el("span", { class: "tnew" }, el("b", { text: ago(Date.parse(last.t)) + " ago: " }), last.text + " · " + last.source) : el("span", { class: "tnew quiet", text: "Nothing matched yet." })));
  }));
}
function suggestList(list) {
  return el("ul", { class: "suggest" }, ...list.map((t) => el("li", {},
    el("span", { class: "asrc", text: kindLabel(t) + " · " + (DESK_NAME[t.desk] || t.desk) + " · " + (t.outlets > 1 ? t.outlets + " outlets · " : "") + (t.developments || []).length + " developments · " + ago(Date.parse(t.last)) + " ago" }),
    el("button", { class: "doclink", text: t.title, onclick: () => openThread(t) }),
    el("span", { class: "sgrow" }, followButton({ thread: t.id }, true)))));
}
let browseDesk = "ALL", browseQ = "";
function browseInline() {
  const q = el("input", { type: "text", class: "tin", placeholder: "Search threads", value: browseQ });
  const chips = el("div", { class: "chips" });
  const list = el("ul", { class: "suggest" });
  const all = (data.threads || []).slice().sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
  const draw = () => {
    chips.replaceChildren(...["ALL", "BEACON", "GOV", "LAW", "WORLD", "SPORTS"].map((d) => el("button", { class: "chip" + (browseDesk === d ? " on" : ""), text: d === "ALL" ? "All" : DESK_NAME[d], onclick: () => { browseDesk = d; draw(); } })));
    const words = browseQ.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = all.filter((t) => (browseDesk === "ALL" || t.desk === browseDesk) && words.every((w) => t.title.toLowerCase().includes(w)));
    list.replaceChildren(...hits.slice(0, 80).map((t) => el("li", {},
      el("span", { class: "asrc", text: kindLabel(t) + " · " + (DESK_NAME[t.desk] || t.desk) + " · " + (t.outlets > 1 ? t.outlets + " outlets · " : "") + t.n_reports + " reports · " + ago(Date.parse(t.last)) + " ago" }),
      el("button", { class: "doclink", text: t.title, onclick: () => openThread(t) }),
      el("span", { class: "sgrow" }, followButton({ thread: t.id }, true)))));
    if (!hits.length) list.append(el("li", { class: "fine", text: "No threads match." }));
  };
  q.oninput = () => { browseQ = q.value; draw(); };
  draw();
  return [sectionHead("All threads", all.length + " live", openTopicForm, "Follow a topic"), q, chips, list];
}

// The private voter-guide scorecard: import (paste or file) and clear. Stored in KV only.
function scorecardAdmin() {
  const status = el("p", { class: "fine", text: "Loading…" });
  const box = el("textarea", { class: "tin", rows: "4", placeholder: "Paste the scorecard file's contents here" });
  const file = el("input", { type: "file", accept: ".json,application/json" });
  const go = el("button", { class: "sbtn wide", text: "Import scorecard" });
  const clear = el("button", { class: "unsave", text: "Remove" });
  const send = async (text) => {
    go.textContent = "Importing…";
    try {
      const r = await fetch("ballot", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: text });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      myBallot = j; box.value = "";
      status.className = "okmsg";
      if (/"crit_map"/.test(text) && !/"races"/.test(text)) { status.textContent = "✓ Criteria links saved (" + Object.keys(j.crit_map || {}).length + " statements). Private: Cloudflare only."; go.textContent = "Import scorecard"; return; }
      status.textContent = "✓ Imported: " + Object.keys(j.races || {}).length + " races. Opening the voter guide…";
      setTimeout(() => openGuide(), 900);
    } catch (e) { status.className = "errmsg"; status.textContent = "Couldn't import: " + e.message; }
    go.textContent = "Import scorecard";
  };
  go.onclick = () => box.value.trim() ? send(box.value.trim()) : (status.textContent = "Paste the file, or choose it below.");
  file.onchange = async () => { if (file.files[0]) send(await file.files[0].text()); };
  clear.onclick = async () => { await fetch("ballot", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "clear" }) }); myBallot = {}; status.textContent = "Removed."; };
  loadBallot(true).then((b) => { status.className = b && b.election ? "okmsg" : "fine"; status.textContent = b && b.election ? "✓ " +  "Stored: " + b.election + ", " + Object.keys(b.races || {}).length + " races, updated " + (b.updated || "") + ". Private: it lives only on Cloudflare, never in the repository." : "None stored. The scorecard adds your address-level districts and scores on your own priorities to the voter guide."; });
  return el("div", {}, status, box, el("p", { class: "fine" }, "Or choose the file: ", file), go, el("p", { class: "fine" }, clear));
}

// Notes for Claude: work Tell The Wire couldn't do itself. Copy them into a session.
function notesForClaude() {
  const box = el("div", {}, el("p", { class: "fine", text: "Loading…" }));
  fetch("tell", { credentials: "same-origin" }).then((r) => r.json()).then((j) => {
    const q = j.queue || [];
    if (!q.length) { box.replaceChildren(el("p", { class: "fine", text: "None waiting. When Tell The Wire hears something that needs a new outlet, section or rule, it lands here." })); return; }
    const text = q.map((n) => "- " + n.note + " (" + fmtDate.format(new Date(Date.parse(n.at))) + ")").join("\n");
    const copy = el("button", { class: "sbtn wide", text: "Copy all " + q.length + " for a Claude session" });
    copy.onclick = async () => { try { await navigator.clipboard.writeText("Notes from Tell The Wire:\n" + text); copy.textContent = "Copied"; } catch (e) { copy.textContent = "Couldn't copy; select the text above"; } };
    box.replaceChildren(el("ul", { class: "admin" }, ...q.map((n) => { const b = el("button", { class: "unsave", text: "Done" });
      b.onclick = async () => { b.textContent = "…"; await fetch("tell", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "done", note: n.id }) }); b.closest("li").remove(); };
      return el("li", {}, el("span", { class: "asrc", text: fmtDate.format(new Date(Date.parse(n.at))) }), el("span", { text: n.note }), b); })), copy);
  }).catch(() => box.replaceChildren(el("p", { class: "fine", text: "Couldn't load the notes." })));
  return box;
}

// --------------------------------------------------------------- the Settings tab
function settingsView() {
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
  const srcList = el("details", { class: "rest" }, el("summary", {}, el("span", { text: "Sources shown · " + (srcs.length - prefs.mutedSources.length) + " of " + srcs.length }), el("span", { class: "chev", text: "▾" })),
    el("div", { class: "srclist" }, ...srcs.map((s) => el("label", { class: "trow" },
      el("span", {}, s.name, el("span", { class: "dk", style: "--c: var(--" + s.desk.toLowerCase() + ")", text: DESK_NAME[s.desk] || s.desk })),
      el("input", { type: "checkbox", id: "src-" + s.id, checked: prefs.mutedSources.includes(s.id) ? null : true,
        onchange: (e) => { prefs.mutedSources = prefs.mutedSources.filter((x) => x !== s.id); if (!e.target.checked) prefs.mutedSources.push(s.id); savePrefs(); render(); } })))));
  const savedList = saved.length
    ? el("ol", { class: "savedlist" }, ...saved.map((x) => el("li", {}, link(x.link, x.title),
        el("span", { class: "asrc", text: x.source + " · " + fmtDate.format(new Date(x.ms)) }),
        el("button", { class: "unsave", text: "Remove", onclick: (e) => { saved = saved.filter((y) => y.id !== x.id); saveSaved(); e.currentTarget.parentNode.remove(); } }))))
    : el("p", { class: "fine", text: "Nothing saved yet. Use ☆ Save on any item." });
  const bad = failingSources().length;
  const f = followsNow();
  const removeBtn = (label, body) => { const b = el("button", { class: "unsave", text: label }); b.onclick = async () => { b.textContent = "…"; const ok = await setFollow(body); if (!ok) b.textContent = "Couldn't save"; }; return b; };
  const adminList = (rows) => rows.length ? el("ul", { class: "admin" }, ...rows) : el("p", { class: "fine", text: "None." });
  const threadRows = f.threads.map((x) => { const t = (data.threads || []).find((y) => y.id === x.id); return el("li", {},
    el("span", { class: "asrc", text: "since " + fmtDate.format(new Date(Date.parse(x.since))) + (t ? " · " + t.n_reports + " reports" : " · not live right now") + ((x.items || []).length ? " · " + x.items.length + " added by you" : "") }),
    t ? el("button", { class: "doclink", text: x.title || t.title, onclick: () => openThread(t) }) : el("span", { text: x.title }),
    removeBtn("Unfollow", { action: "unfollow", type: "thread", id: x.id })); });
  const topicRows = f.topics.map((x) => { const t = (data.threads || []).find((y) => y.id === x.id); return el("li", {},
    el("span", { class: "asrc", text: (x.kind || "subject") + " · " + (DESK_NAME[x.desk] || x.desk) + (x.pattern ? " · watching: " + x.pattern : " · hand-built") + ((x.items || []).length ? " · " + x.items.length + " added by you" : "") }),
    t ? el("button", { class: "doclink", text: x.title, onclick: () => openThread(t) }) : el("span", { text: x.title }),
    removeBtn("Unfollow", { action: "unfollow", type: "topic", id: x.id })); });
  const signalRows = (f.signals || []).map((x) => { const t = (data.threads || []).find((y) => y.id === x.id); return el("li", {},
    el("span", { class: "asrc", text: (x.value === "more" ? "More like this" : "Less like this") + " · " + fmtDate.format(new Date(Date.parse(x.at))) }),
    t ? el("button", { class: "doclink", text: x.title || t.title, onclick: () => openThread(t) }) : el("span", { text: x.title || x.id }),
    removeBtn("Clear", { action: "signal", id: x.id, value: "clear" })); });
  const standing = (data.threads || []).filter((t) => t.standing);
  const qbox = el("div", {});
  loadQuiz().then((Q) => qbox.replaceChildren(...questionnairesSection(Q)));
  const mutedPeople = (prefs.mutedPeople || []).map((pid) => (data.people || []).find((p) => p.id === pid)).filter(Boolean);
  return [
    el("h1", { class: "yw", text: "Settings" }),
    el("h2", { class: "sh2", text: "Reading" }),
    el("h3", { class: "sh3", text: "Appearance" }),
    el("div", { class: "segmini three" }, ...THEMES.map(([v, label]) => el("button", {
      "aria-pressed": String(prefs.theme === v),
      onclick: (e) => { prefs.theme = v; savePrefs(); applyTheme(); [...e.currentTarget.parentNode.children].forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); },
    }, label))),
    el("h3", { class: "sh3", text: "Text size" }), sizeRow,
    el("p", { class: "fine", text: "“iPhone” follows Settings › Display & Brightness › Text Size." }),
    el("h3", { class: "sh3", text: "Display" }),
    toggle("World clocks on Today", "clocks"), toggle("Read briefings aloud right away", "speak"), toggle("Desks open on new items only", "newOnly"),
    el("h3", { class: "sh3", text: "Mute words" }), words,
    el("p", { class: "fine", text: "Comma-separated. Items whose headline or description contains one are hidden everywhere." }),
    el("h3", { class: "sh3", text: "Saved" }), savedList,
    el("p", { class: "fine", text: "Reading settings and saved items stay on this device." }),

    qbox,
    el("h2", { class: "sh2", text: "Admin" }),
    el("p", { class: "fine", text: "Follows, topics and signals are stored on Cloudflare (follows.json) and reach the build; they work on every device." }),
    el("h3", { class: "sh3", text: "Threads you follow · " + f.threads.length }), adminList(threadRows),
    el("h3", { class: "sh3", text: "Topics you named · " + f.topics.length }), adminList(topicRows),
    el("button", { class: "sbtn wide", text: "Follow a topic", onclick: openTopicForm }),
    el("h3", { class: "sh3", text: "More / less signals · " + (f.signals || []).length }), adminList(signalRows),
    el("h3", { class: "sh3", text: "Searches you added · " + (f.searches || []).length }),
    el("p", { class: "fine", text: "News searches the build runs as sources (from Tell The Wire). The one exception to sources.yaml: they live with your follows, never in the public repository." }),
    adminList((f.searches || []).map((x) => { const h = (data.sources || []).find((s0) => s0.id === x.id); return el("li", {},
      el("span", { class: "asrc", text: (DESK_NAME[x.desk] || x.desk) + " · since " + fmtDate.format(new Date(Date.parse(x.since))) + (h ? " · " + (h.last_error ? "not updating" : h.items + " items") : " · starts on the next build") }),
      el("span", { text: "“" + x.query + "”" }), removeBtn("Remove", { action: "unsearch", id: x.id })); })),
    el("h3", { class: "sh3", text: "More and less of · " + (((f.taste || {}).more || []).length + ((f.taste || {}).less || []).length) }),
    adminList([...((f.taste || {}).more || []).map((t) => ["more", t]), ...((f.taste || {}).less || []).map((t) => ["less", t])].map(([k, t]) =>
      el("li", {}, el("span", { class: "asrc", text: k === "more" ? "More about" : "Less about" }), el("span", { text: t }), removeBtn("Remove", { action: "untaste", kind: k, term: t })))),
    el("button", { class: "sbtn wide", text: "Tell The Wire ›", onclick: () => openTell() }),
    el("h3", { class: "sh3", text: "Notes for Claude" }), notesForClaude(),
    el("h3", { class: "sh3", text: "Your scorecard (voter guide)" }), scorecardAdmin(),
    el("h3", { class: "sh3", text: "Standing threads · " + standing.length }),
    el("p", { class: "fine", text: "Configured in threads.yaml in the repository; the build reads it every run. Edit the file to add, rename or retire one." }),
    el("ul", { class: "admin" }, ...standing.map((t) => el("li", {}, el("span", { class: "asrc", text: (GROUP_LABEL[t.group] || DESK_NAME[t.desk] || t.desk) + " · " + t.n_reports + " reports" }), el("button", { class: "doclink", text: t.title, onclick: () => openThread(t) })))),
    el("h3", { class: "sh3", text: "People" }),
    el("button", { class: "sbtn wide", text: "People you follow (" + ((data && data.people) || []).length + ") ›", onclick: openPeople }),
    mutedPeople.length ? el("p", { class: "fine", text: "Muted: " + mutedPeople.map((p) => p.name).join(", ") + ". Unmute from the People list." }) : null,
    el("h3", { class: "sh3", text: "Sources" }),
    el("button", { class: "sbtn wide" + (bad ? " warn" : ""), text: bad ? "Source health · " + bad + " not updating ›" : "Source health · all updating ›", onclick: openHealth }),
    srcList,
    el("h3", { class: "sh3", text: "Version" }),
    el("p", { class: "fine", text: "Version " + (APP_VERSION.startsWith("__") ? "local" : APP_VERSION) + (deployedAt ? " · deployed " + exact(Date.parse(deployedAt)) : "") + ". The Wire checks for a new version every time you open it." }),
    el("button", { class: "sbtn wide", text: "Check for updates now", onclick: async (e) => { e.currentTarget.textContent = "Checking…"; const b = e.currentTarget; await checkVersion(); if (!updateReady) b.textContent = "You're on the newest version"; } }),
    el("div", { class: "endline", text: "End of settings" }),
  ].filter(Boolean);
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

// "The other side" (2026-10-23, Joe: "push my political leanings"): one recent piece from a voice
// on the side his answers lean against. With "Where you stand" done, the side is the opposite of
// his economic and cultural lean (both scales averaged); near the middle, or before he's taken
// it, it rotates daily among left, right, libertarian and heterodox voices. Never a voice already
// shown under From people you follow.
function otherSide(shown) {
  const A = myQuiz && myQuiz.values && myQuiz.values.done_at ? myQuiz.values.answers : null;
  let want, why;
  if (A && data.values_bank) {
    const sc = standScores(A, electionExtra(myQuiz));
    const lean = ((sc.econ.s || 0) + (sc.culture.s || 0)) / 2;
    if (lean > 0.15) { want = ["left", "center-left"]; why = "from the left; your answers lean right"; }
    else if (lean < -0.15) { want = ["right", "center-right", "libertarian"]; why = "from the right; your answers lean left"; }
    else { want = ["heterodox", "cross", "libertarian"]; why = "from outside both camps; your answers sit near the middle"; }
  } else {
    const turn = [["left", "center-left"], ["right", "center-right"], ["libertarian"], ["heterodox", "cross"]];
    want = turn[Math.floor(Date.now() / 86400e3) % turn.length];
    why = "a different voice each day";
  }
  const seen = new Set((shown || []).flatMap((it) => it.people || []));
  const pool = data.items.filter((it) => it.people && it.perspective && want.includes(it.perspective) && it.kind !== "POST"
    && Date.now() - it.ms < 4 * 86400e3 && !isMuted(it) && !it.people.some((p) => seen.has(p) || (prefs.mutedPeople || []).includes(p)))
    .sort((a, b) => b.ms - a.ms);
  return pool.length ? { it: pool[0], why } : null;
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
