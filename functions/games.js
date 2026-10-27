// Puzzle Page (GAMES.md, approved 2026-10-27). Assembles Joe's four daily slots from the pool the
// daily games.yml workflow writes (games-today.json), the chess sample (chess.json) and his own
// results (games.json). Private: results, review items and ratings live only here in Workers KV
// behind Cloudflare Access (CLAUDE.md rule 10); the build never sees them.
//
// GET  /games                 -> today's slots, callbacks, stats, health
// GET  /games?shadow=1        -> Connections shadow-mode board and generator health (Admin)
// POST {action:"result", ...} -> record a finished puzzle (≤ 30 writes a day)
// POST {action:"pick", brain} -> default brain break ("logic" | "chess" | "tactics")
const KEY = "games.json";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const WRITE_CAP = 30;
const CALLBACK_CAP = 3;
const CONNECTIONS_LIVE = false;      // force on; otherwise the pool turns it on after 10 of 14 days without a drop (GAMES.md)

// Tatham puzzles at each game's top tier that needs no guessing, by Joe's ladder tier (1–3).
// Params are Tatham game parameter strings; the seed comes from the date, so a reload is the same puzzle.
const LOGIC = {
  loopy: ["7x7t0dn", "8x8t0dh", "10x10t0dh"],
  keen: ["5dn", "6dh", "6dx"],
  towers: ["5dh", "6dh", "6dx"],
  galaxies: ["7x7dn", "8x8dn", "10x10dn"],
  signpost: ["5x5c", "6x6c", "7x7c"],
  dominosa: ["5db", "6dh", "6de"],
  unequal: ["5dk", "6dk", "6dx"],
  slant: ["6x6de", "8x8dh", "10x10dh"],
  range: ["7x7", "9x6", "12x8"],
  pattern: ["10x10", "15x15", "20x20"],
};
const LOGIC_ORDER = Object.keys(LOGIC);
const BRAINS = ["logic", "chess", "tactics"];
let POOL = null;                     // set by assemble() (synchronous), read by brainBreak()

export async function onRequestGet({ request, env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  const url = new URL(request.url);
  const pool = (await env.WIRE.get("games-today.json", "json")) || null;
  if (url.searchParams.get("shadow")) return json({ pool_day: pool && pool.day, connections: pool && pool.connections_shadow, health: pool && pool.health });
  if (url.searchParams.get("library")) return json({ day: pool && pool.day, lists: (pool && pool.library) || [], who_left: (pool && pool.who_left) || [] });
  if (url.searchParams.get("quiz")) return json({ day: pool && pool.day, quiz: (pool && pool.wirequiz) || null });
  const st = await load(env);
  const today = nyDay();
  let day = st.days[today];
  if (!day) {
    const chess = (await env.WIRE.get("chess.json", "json")) || null;
    day = assemble(st, pool, chess, today);
    st.days[today] = day;
    trim(st, today);
    await save(env, st, today);
  }
  return json({
    day: today, slots: day.slots, done: day.done || {}, callbacks: callbacks(st, today, day),
    pick: st.pick || "logic", stats: stats(st, today), as_of: pool ? pool.made : null,
    health: [...((pool && pool.health) || []), ...(day.health || [])], connections_live: CONNECTIONS_LIVE,
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "bad JSON" }, 400); }
  const st = await load(env);
  const today = nyDay();
  const w = (st.writes[today] || 0);
  if (w >= WRITE_CAP) return json({ ok: false, error: "Daily write cap reached; this result is kept on the page and sent tomorrow.", retry: true }, 429);
  if (b.action === "pick") {
    if (!BRAINS.includes(b.brain)) return json({ error: "Unknown brain break." }, 400);
    st.pick = b.brain;
  } else if (b.action === "result") {
    record(st, b, today);
  } else return json({ error: "Unknown action." }, 400);
  await save(env, st, today);
  return json({ ok: true, stats: stats(st, today), callbacks: callbacks(st, today, st.days[today] || {}) });
}

// ------------------------------------------------------------------ state
async function load(env) {
  const st = (await env.WIRE.get(KEY, "json")) || {};
  return Object.assign({ v: 1, days: {}, items: {}, ladder: {}, results: [], served: {}, writes: {}, pick: null, side: {} }, st);
}
async function save(env, st, today) {
  st.writes[today] = (st.writes[today] || 0) + 1;
  for (const d of Object.keys(st.writes)) if (d < addDays(today, -7)) delete st.writes[d];
  await env.WIRE.put(KEY, JSON.stringify(st));
}
function trim(st, today) {
  for (const d of Object.keys(st.days)) if (d < addDays(today, -14)) delete st.days[d];
  const cut = addDays(today, -90);
  st.results = st.results.filter((r) => r.day >= cut);
  for (const [id, d] of Object.entries(st.served)) if (d < cut) delete st.served[id];
  for (const d of Object.keys(st.side)) if (d < addDays(today, -35)) delete st.side[d];
  for (const d of Object.keys(st.defect || {})) if (d < addDays(today, -35)) delete st.defect[d];
  const ids = Object.keys(st.items);
  if (ids.length > 3000) ids.sort((a, b) => (st.items[a].due || "").localeCompare(st.items[b].due || "")).slice(0, ids.length - 3000).forEach((k) => delete st.items[k]);
}

// ------------------------------------------------------------------ assembly
function assemble(st, pool, chess, today) {
  POOL = pool;
  const rng = seeded("wire-day-" + today);
  const slots = [];
  const health = [];
  const brain = st.pick || "logic";
  const other = brain === "logic" ? "chess" : "logic";       // tactics days put logic in the grid slot
  const tier = (g) => ((st.ladder[g] || {}).tier || (g === "cryptoquote" && weekday(today) === 1 ? 1 : 2));

  // Slot 1: the daily grid. Connections is in shadow mode, so the grid slot holds the other brain break.
  slots.push(Object.assign({ slot: 1, label: "Grid" }, (CONNECTIONS_LIVE || (pool && pool.connections_live)) && pool && pool.connections_shadow && !st.served[pool.connections_shadow.id]
    ? { game: "connections", puzzle: pool.connections_shadow } : brainBreak(other, st, chess, today, rng, health)));

  // Slot 2: the news slot, rotating by weekday (GAMES.md): Tue Defectors; the rest of the rotation
  // falls back to Who said it until its games exist.
  const dow = weekday(today);
  let news = null;
  if (dow === 2) { const d = pickDefectors(st, pool, today); if (d) news = { game: "defectors", puzzle: d }; }
  if (dow === 3) { const k = ((pool && pool.docket) || []).find((x) => !st.served[x.id]); if (k) news = { game: "docket", puzzle: k }; }
  if (dow === 4) { const l = ((pool && pool.ledger) || []).find((x) => !st.served[x.id]); if (l) news = { game: "ledger", puzzle: l }; }
  if (dow === 6) { const t = ((pool && pool.timeline) || []).find((x) => !st.served[x.id]); if (t) news = { game: "timeline", puzzle: t }; }
  if (dow === 0) {
    const items = ((pool && pool.beacon_agenda) || []).filter((x) => !st.served[x.id]).slice(0, 5);
    if (items.length >= 2) news = { game: "beacon_agenda", puzzle: { id: "ba" + today, items } };
  }
  if (dow === 5 && pool && pool.friday_quiz && !st.served[pool.friday_quiz.id]) news = { game: "friday_quiz", puzzle: pool.friday_quiz };
  let wsi = null;
  if (!news) { wsi = pickWho(st, pool, today); if (wsi) news = { game: "who_said_it", puzzle: wsi }; }
  if (!news) { const d = pickDefectors(st, pool, today); if (d) news = { game: "defectors", puzzle: d }; }
  if (news) slots.push(Object.assign({ slot: 2, label: "News" }, news));
  else health.push({ game: "news", made: 0, dropped: 0, why: [["no fresh news puzzle today; filled with a logic puzzle", 1]] });

  // Slot 3: Tue/Thu a legal refresher session; otherwise the cipher (graded tier near Joe's ladder,
  // never the same quote as slot 2). A refresher day with no verified cards falls back to the cipher.
  const lg = (dow === 2 || dow === 4) ? pickLegal(st, pool, today) : null;
  const wk = (pool && pool.weekend) || {};
  if (lg) slots.push({ slot: 3, label: "Law", game: "legal", puzzle: lg });
  else if (dow === 5 && wk.keyed && !st.served[wk.keyed.id]) slots.push({ slot: 3, label: "Cipher", game: "keyed", puzzle: wk.keyed });
  else if (dow === 0 && wk.patristocrat && !st.served[wk.patristocrat.id]) slots.push({ slot: 3, label: "Cipher", game: "patristocrat", puzzle: wk.patristocrat });
  else if (dow === 6 && pool && pool.meta && !st.served[pool.meta.id]) slots.push({ slot: 3, label: "Meta", game: "meta", puzzle: pool.meta });
  else {
    const cq = pickCipher(st, pool, today, tier("cryptoquote"), wsi && wsi.id);
    if (cq) slots.push({ slot: 3, label: "Cipher", game: "cryptoquote", puzzle: cq });
  }

  // Slot 4: Joe's brain break (defaults to his last pick); on Sunday the case-file grid takes it.
  if (dow === 0 && pool && pool.casefile && !st.served[pool.casefile.id]) slots.push({ slot: 4, label: "Case file", game: "casefile", puzzle: pool.casefile });
  else slots.push(Object.assign({ slot: 4, label: "Brain break" }, brainBreak(brain, st, chess, today, rng, health)));

  // Never fewer than four: fill from logic and chess.
  let k = 0;
  while (slots.length < 4 && k < 6) {
    const g = k % 2 ? "chess" : "logic";
    const extra = brainBreak(g, st, chess, today, seeded(today + "fill" + k), health, slots);
    if (extra) slots.push(Object.assign({ slot: slots.length + 1, label: "Brain break" }, extra));
    k += 1;
  }
  slots.forEach((s, i) => { s.slot = i + 1; s.id = s.puzzle && s.puzzle.id; if (s.id) st.served[s.id] = today; });
  return { slots, made: new Date().toISOString(), done: {}, health };
}

function pickWho(st, pool, today) {
  const cands = ((pool && pool.who_said_it) || []).filter((q) => !st.served[q.id]);
  if (!cands.length) return null;
  // Balance (rule 7): no party over 60% of the week's speakers. Counted here only, never logged.
  const week = Object.entries(st.side).filter(([d]) => d >= addDays(today, -6)).flatMap(([, v]) => v);
  const share = (p) => week.length ? week.filter((x) => x === p).length / (week.length + 1) : 0;
  const ok = cands.filter((q) => !q.party || share(q.party) < 0.6);
  const q = (ok.length ? ok : cands)[0];
  (st.side[today] = st.side[today] || []).push(q.party || "none");
  return q;
}

// Defectors: in the news first; across the month, defections alternate between the parties
// (counted here only).
function pickDefectors(st, pool, today) {
  const cands = ((pool && pool.defectors) || []).filter((d) => !st.served[d.id]);
  if (!cands.length) return null;
  const month = Object.entries(st.defect || {}).filter(([d]) => d >= addDays(today, -30)).flatMap(([, v]) => v);
  const n = (p) => month.filter((x) => x === p).length;
  const score = (d) => (d.in_news ? 10 : 0) - Math.min(...d.defect_party.map(n)) * 3;
  cands.sort((a, b) => score(b) - score(a));
  const d = cands[0];
  st.defect = st.defect || {};
  (st.defect[today] = st.defect[today] || []).push(...d.defect_party);
  return d;
}

// Legal refreshers: three cards a session. Cards with due elements first, then a card featured by
// today's news, then the next card in syllabus order not started yet. A cloze card leads, so the
// session never opens on a type-in.
function pickLegal(st, pool, today) {
  const L = pool && pool.legal;
  if (!L || !(L.cards || []).length) return null;
  const byId = Object.fromEntries(L.cards.map((c) => [c.id, c]));
  const started = new Set(Object.keys(st.items).filter((k) => k.startsWith("el:")).map((k) => k.split(":")[1]));
  const due = [...new Set(Object.values(st.items).filter((x) => x.type === "element" && !x.retired && x.due && x.due <= today).sort((a, b) => a.due.localeCompare(b.due)).map((x) => x.id.split(":")[1]))];
  const featured = (L.featured || []).map((f) => f.card).filter((id) => byId[id] && !started.has(id));
  const order = (L.order || []).flatMap((area) => L.cards.filter((c) => c.area === area).map((c) => c.id));
  const fresh = order.filter((id) => !started.has(id));
  const pick = [];
  for (const id of [...due, ...featured, ...fresh]) if (byId[id] && !pick.includes(id) && pick.length < 3) pick.push(id);
  if (!pick.length) return null;
  const cards = pick.map((id) => byId[id]);
  cards.sort((a, b) => (b.cloze ? 1 : 0) - (a.cloze ? 1 : 0));
  return { id: "law" + today, cards, featured: (L.featured || []).filter((f) => pick.includes(f.card)) };
}

function pickCipher(st, pool, today, tier, avoid) {
  const cands = ((pool && pool.cryptoquote) || []).filter((c) => !st.served[c.id] && c.source !== avoid);
  if (!cands.length) return null;
  cands.sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier));
  const c = Object.assign({}, cands[0]);
  c.give = tier <= 1 || weekday(today) === 1;          // Monday: one given letter
  return c;
}

function brainBreak(kind, st, chess, today, rng, health, taken) {
  if (kind === "tactics") {
    const T = ((POOL && POOL.tactics) || []).filter((b) => !st.served[b.id] && !(taken || []).some((s) => s.id === b.id));
    if (!T.length) { health.push({ game: "tactics", made: 0, dropped: 0, why: [["no tactics board today; a logic puzzle instead", 1]] }); return brainBreak("logic", st, chess, today, rng, health, taken); }
    const t = ((st.ladder.tactics || {}).tier) || 2;
    T.sort((a, b) => Math.abs(a.tier - t) - Math.abs(b.tier - t));
    return { game: "tactics", puzzle: T[0] };
  }
  if (kind === "chess") {
    const P = (chess && chess.puzzles) || [];
    if (!P.length) { health.push({ game: "chess", made: 0, dropped: 0, why: [["chess sample not loaded yet (monthly workflow)", 1]] }); return kind === "chess" ? brainBreak("logic", st, chess, today, rng, health, taken) : null; }
    const r = ((st.ladder.chess || {}).rating) || 1200;
    const near = P.filter((p) => Math.abs(p[3] - r) <= 150 && !st.served["ch" + p[0]] && !(taken || []).some((s) => s.id === "ch" + p[0]));
    const pool = near.length ? near : P.filter((p) => !st.served["ch" + p[0]]);
    const p = pool[Math.floor(rng() * pool.length)];
    return { game: "chess", puzzle: { id: "ch" + p[0], fen: p[1], moves: p[2].split(" "), rating: p[3], themes: p[4].split(" "), url: "https://lichess.org/training/" + p[0] } };
  }
  const t = ((st.ladder.logic || {}).tier) || 2;
  const used = (taken || []).filter((s) => s.game === "logic").map((s) => s.puzzle.game);
  const order = LOGIC_ORDER.filter((g) => !used.includes(g));
  const g = order[(dayNumber(today) + (taken ? taken.length : 0)) % order.length];
  const seed = today.replace(/-/g, "") + (taken ? "x" + taken.length : "");
  return { game: "logic", puzzle: { id: "lg" + g + seed, game: g, params: LOGIC[g][t - 1], seed, tier: t } };
}

// ------------------------------------------------------------------ results, ladders, review items
function record(st, b, today) {
  const day = st.days[today] || (st.days[today] = { slots: [], done: {}, made: new Date().toISOString() });
  const game = String(b.game || "");
  const r = {
    day: today, game, id: String(b.puzzle || "").slice(0, 40), ok: !!b.ok, score: num(b.score),
    ms: num(b.ms), hints: num(b.hints) || 0, cert: ["sure", "think", "guess"].includes(b.cert) ? b.cert : null,
  };
  if (b.slot != null) day.done[String(b.slot)] = { ok: r.ok, score: r.score, ms: r.ms, hints: r.hints };
  st.results.push(r);
  ladder(st, game, r, b);
  for (const it of (Array.isArray(b.items) ? b.items.slice(0, 20) : [])) schedule(st, it, today);
}

function ladder(st, game, r, b) {
  if (["callback", "name_all", "match"].includes(game)) return;
  if (game === "chess") {
    const L = st.ladder.chess || (st.ladder.chess = { rating: 1200, n: 0 });
    const pr = num(b.rating) || L.rating;
    const exp = 1 / (1 + Math.pow(10, (pr - L.rating) / 400));
    const k = L.n < 20 ? 40 : 20;
    L.rating = Math.round(L.rating + k * ((r.ok && !r.hints ? 1 : 0) - exp));
    L.n += 1;
    return;
  }
  // Three clean solves up, one miss down (settles near 80%).
  const L = st.ladder[game] || (st.ladder[game] = { tier: 2, clean: 0 });
  if (r.ok && !r.hints) { L.clean += 1; if (L.clean >= 3) { L.tier = Math.min(3, L.tier + 1); L.clean = 0; } }
  else if (!r.ok) { L.tier = Math.max(1, L.tier - 1); L.clean = 0; }
}

// Intervals (GAMES.md rule 6): first 1 day; sure hit ×2.5, think ×1.5, guess or hint unchanged;
// miss → 1 day; cap 120; retired after two sure hits at ≥ 60 days.
function schedule(st, it, today) {
  const id = String(it.id || "").slice(0, 40);
  if (!id) return;
  const cur = st.items[id] || {
    id, type: String(it.type || "").slice(0, 20), q: clip(it.q, 300), a: clip(it.a, 120),
    accept: (Array.isArray(it.accept) ? it.accept : []).map((x) => clip(x, 60)).slice(0, 12),
    hint: clip(it.hint, 120), link: clip(it.link, 400), story: clip(it.story, 40), thread: clip(it.thread, 40), iv: 0, hist: [], sure60: 0,
  };
  const ok = !!it.ok, cert = it.cert, hinted = !!it.hinted;
  let iv = cur.iv || 0;
  if (!ok) iv = 1;
  else if (!iv) iv = 1;
  else if (hinted || cert === "guess") iv = iv;
  else if (cert === "sure") iv = iv * 2.5;
  else iv = iv * 1.5;
  iv = Math.min(120, Math.max(1, Math.round(iv)));
  if (ok && cert === "sure" && (cur.iv || 0) >= 60) cur.sure60 += 1;
  if (cur.sure60 >= 2) cur.retired = today;
  cur.iv = iv;
  cur.due = addDays(today, iv);
  cur.hist = [...cur.hist, [today, ok ? 1 : 0, cert || "", hinted ? 1 : 0, num(it.ms) || 0]].slice(-12);
  st.items[id] = cur;
}

// Due items, capped at 3 a day; overdue ones spread over the following days (oldest first) and
// lateness never counts against the interval. Items tied to a voided story are skipped.
function callbacks(st, today, day) {
  const served = new Set(Object.keys((day && day.done) || {}));
  const due = Object.values(st.items).filter((x) => !x.retired && !x.void && x.due && x.due <= today && x.lastAsked !== today)
    .sort((a, b) => a.due.localeCompare(b.due));
  return due.slice(0, CALLBACK_CAP).map((x) => ({ id: x.id, type: x.type, q: x.q, a: x.a, accept: x.accept, hint: x.hint, link: x.link, thread: x.thread, served: served.size }));
}

function stats(st, today) {
  const last7 = new Set(st.results.filter((r) => r.day >= addDays(today, -6)).map((r) => r.day));
  const sure = st.results.filter((r) => r.cert === "sure" && r.day >= addDays(today, -6));
  return {
    played7: last7.size,
    sure_right: sure.length >= 5 ? Math.round(100 * sure.filter((r) => r.ok).length / sure.length) : null,
    chess: (st.ladder.chess || {}).rating || null,
    tiers: Object.fromEntries(Object.entries(st.ladder).filter(([k]) => k !== "chess").map(([k, v]) => [k, v.tier])),
    due: Object.values(st.items).filter((x) => !x.retired && x.due && x.due <= today).length,
    ranges90: (() => { const L = st.results.filter((r) => r.game === "ledger" && r.day >= addDays(today, -60)); return L.length >= 3 ? { hit: L.filter((r) => r.ok).length, of: L.length } : null; })(),
  };
}

// ------------------------------------------------------------------ helpers
function nyDay(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d || new Date());
}
function addDays(day, n) { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekday(day) { return new Date(day + "T12:00:00Z").getUTCDay(); }
function dayNumber(day) { return Math.floor(Date.parse(day + "T12:00:00Z") / 86400e3); }
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function clip(s, n) { return s == null ? null : String(s).replace(/\s+/g, " ").trim().slice(0, n); }
function seeded(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}
function json(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers }); }
