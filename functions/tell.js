// "Tell The Wire" (2026-10-22): Joe writes or dictates what matters to him; the large model
// turns it into proposed changes; he ticks the ones that are right and applies them. Nothing
// changes without that tap. Everything here lives in Workers KV (tell.json, follows.json),
// never in the public repository.
//
// POST /tell {text}                          -> {entry: {id, at, text, summary, proposals:[...]}}
// POST /tell {action:"apply", id, picks:[i]} -> {entry, follows, mute:[words]}   (mute words are applied on the device)
// POST /tell {action:"done", note}           -> marks a note for Claude as handled
// GET  /tell                                 -> {entries:[...newest first], queue:[notes for Claude]}
//
// Proposal types: topic (follow a named topic with watch terms), search (a news search, run by
// the build as a source), follow (an existing thread), more / less (subjects to rank up or
// down), mute (words to hide), claude (work that needs a session: new outlets, new sections).
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const TELL = "tell.json";
const FOLLOWS = "follows.json";
const DESKS = ["BEACON", "GOV", "LAW", "WORLD", "SPORTS"];
const KINDS = ["subject", "process", "entity", "law", "event"];
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const SYSTEM = `You help one reader, Joe, shape his private news site, The Wire. He lives in Beacon, New York. He runs Optima Environmental Services (petroleum bulk storage compliance, tank installation and removal, spill response, remediation, Phase I site assessments, public-works jobs) and is a New York attorney with a background in AML, commercial real estate finance and bankruptcy. He follows Beacon and the Hudson Valley, New York and federal government, the law, the world (Paris and Israel especially) and his teams. He keeps business and markets out unless he asks for them.

He will tell you, in his own words, what he cares about or wants to know more about. Turn that into a short list of concrete changes The Wire can make. Use only these types:
- "topic": follow a named topic. Give a short title and 2 to 8 watch terms (words or short phrases that would appear in headlines; a trailing * matches endings, like rezon*). Choose desk (BEACON, GOV, LAW, WORLD, SPORTS) and kind (subject, process, entity, law, event).
- "search": add a news search when the subject is probably not covered by his existing sources (a niche local subject, a specific company, a person). Give a title and a plain search query of 2 to 6 words, as someone would type into a news search. No quotes or operators unless a phrase must be exact.
- "follow": follow one of the existing threads listed below; give its id exactly.
- "more" or "less": subjects to rank up or down, as 1 to 4 short terms.
- "mute": words to hide everywhere (only when he says he never wants to see something).
- "claude": anything that needs real work: a new named outlet or newsletter, a new section, a change to how stories are written. Write it as a clear note.

Rules: propose only what he actually said or plainly meant; never invent interests. Prefer following an existing thread over creating a duplicate topic. Prefer a topic over a search when his sources already cover the subject. At most 8 proposals. Each has a "why" of under 15 words quoting or paraphrasing what he said.

Reply with JSON only: {"summary":"one sentence: what you heard","proposals":[{"type":"topic","title":"...","terms":["..."],"desk":"BEACON","kind":"subject","why":"..."}, ...]}`;

export async function onRequestGet({ env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  const t = (await env.WIRE.get(TELL, "json")) || { entries: [], queue: [] };
  return json({ entries: (t.entries || []).slice().reverse().slice(0, 30), queue: (t.queue || []).filter((q) => !q.done) });
}

export async function onRequestPost({ request, env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad JSON" }, 400); }
  const tell = (await env.WIRE.get(TELL, "json")) || { entries: [], queue: [] };
  tell.entries = tell.entries || [];
  tell.queue = tell.queue || [];

  if (body.action === "apply") return apply(env, tell, body);
  if (body.action === "done") {
    for (const q of tell.queue) if (q.id === body.note) q.done = new Date().toISOString();
    await env.WIRE.put(TELL, JSON.stringify(tell));
    return json({ queue: tell.queue.filter((q) => !q.done) });
  }

  const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 2000);
  if (text.length < 8) return json({ error: "Say a little more." }, 400);
  if (!env.AI) return json({ error: "Workers AI isn't bound to this site." }, 500);

  // What exists already, so the model can point at it instead of duplicating it.
  const data = await env.WIRE.get("data.json", "json");
  const follows = (await env.WIRE.get(FOLLOWS, "json")) || {};
  const threads = ((data && data.threads) || []).filter((t) => t.followed || t.standing || (t.outlets || 0) >= 2).slice(0, 60);
  const context = "Existing threads (id · title):\n" + threads.map((t) => `${t.id} · ${t.title}${t.followed ? " (he follows)" : ""}${t.standing ? " (standing)" : ""}`).join("\n")
    + "\n\nTopics he already follows: " + ((follows.topics || []).map((t) => t.title).join("; ") || "none")
    + "\nSearches he already runs: " + ((follows.searches || []).map((s) => s.query).join("; ") || "none");

  let out = null, model = null, err = null;
  for (const m of [MODEL, FALLBACK_MODEL]) {
    try {
      const r = await env.AI.run(m, { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: context + "\n\nWhat Joe said:\n" + text }], max_tokens: 900, temperature: 0.1 });
      out = parse(r && r.response);
      if (out) { model = m; break; }
    } catch (e) { err = String(e.message || e).slice(0, 120); }
  }
  if (!out) return json({ error: "The writing model didn't answer" + (err ? " (" + err + ")" : "") + ". Try again in a minute." }, 502);

  const known = new Set(threads.map((t) => t.id));
  const proposals = (out.proposals || []).map((p) => clean(p, known, threads)).filter(Boolean).slice(0, 8);
  const entry = { id: "tell_" + Date.now().toString(36), at: new Date().toISOString(), text, summary: String(out.summary || "").slice(0, 300), proposals, model };
  tell.entries = [...tell.entries, entry].slice(-50);
  await env.WIRE.put(TELL, JSON.stringify(tell));
  return json({ entry });
}

async function apply(env, tell, body) {
  const entry = tell.entries.find((e) => e.id === body.id);
  if (!entry) return json({ error: "That entry is gone." }, 404);
  const picks = new Set((body.picks || []).map(Number));
  const f = (await env.WIRE.get(FOLLOWS, "json")) || { threads: [], topics: [] };
  for (const k of ["threads", "topics", "signals", "searches"]) f[k] = f[k] || [];
  f.taste = f.taste || { more: [], less: [] };
  const now = new Date().toISOString();
  const mute = [];
  entry.proposals.forEach((p, i) => {
    if (!picks.has(i) || p.applied) return;
    if (p.type === "topic") {
      const id = "topic_" + slug(p.title);
      f.topics = [...f.topics.filter((x) => x.id !== id), { id, title: p.title, pattern: p.terms.join(", "), kind: p.kind, desk: p.desk, since: now, from: entry.id }].slice(-60);
    } else if (p.type === "search") {
      const id = "u_" + hash(p.query);
      f.searches = [...f.searches.filter((x) => x.id !== id), { id, title: p.title, query: p.query, desk: p.desk, since: now, from: entry.id }].slice(-30);
    } else if (p.type === "follow") {
      f.threads = [...f.threads.filter((x) => x.id !== p.thread), { id: p.thread, title: p.title, since: now }].slice(-60);
    } else if (p.type === "more" || p.type === "less") {
      const other = p.type === "more" ? "less" : "more";
      f.taste[other] = (f.taste[other] || []).filter((t) => !p.terms.includes(t));
      f.taste[p.type] = [...new Set([...(f.taste[p.type] || []), ...p.terms])].slice(-60);
    } else if (p.type === "mute") {
      mute.push(...p.words);
    } else if (p.type === "claude") {
      tell.queue = [...tell.queue, { id: "note_" + Date.now().toString(36) + i, at: now, note: p.note, said: entry.text.slice(0, 400) }].slice(-40);
    }
    p.applied = now;
  });
  await env.WIRE.put(FOLLOWS, JSON.stringify(f));
  await env.WIRE.put(TELL, JSON.stringify(tell));
  return json({ entry, follows: f, mute });
}

// Keep only well-formed proposals, trimmed to sane sizes.
function clean(p, known, threads) {
  if (!p || typeof p !== "object") return null;
  const why = String(p.why || "").slice(0, 140);
  const terms = (a, n, len) => (Array.isArray(a) ? a : []).map((x) => String(x).replace(/["“”]/g, "").trim().slice(0, len)).filter((x) => x.length >= 2).slice(0, n);
  const desk = DESKS.includes(p.desk) ? p.desk : "GOV";
  switch (p.type) {
    case "topic": {
      const title = String(p.title || "").trim().slice(0, 80);
      const t = terms(p.terms, 8, 40);
      return title && t.length ? { type: "topic", title, terms: t, desk, kind: KINDS.includes(p.kind) ? p.kind : "subject", why } : null;
    }
    case "search": {
      const query = String(p.query || "").replace(/\s+/g, " ").trim().slice(0, 80);
      return query.length >= 3 ? { type: "search", title: String(p.title || query).slice(0, 80), query, desk, why } : null;
    }
    case "follow": {
      if (!known.has(p.thread)) return null;
      const t = threads.find((x) => x.id === p.thread);
      return { type: "follow", thread: p.thread, title: t.title, why };
    }
    case "more": case "less": {
      const t = terms(p.terms, 4, 40);
      return t.length ? { type: p.type, terms: t, why } : null;
    }
    case "mute": {
      const w = terms(p.words || p.terms, 6, 30);
      return w.length ? { type: "mute", words: w, why } : null;
    }
    case "claude": {
      const note = String(p.note || "").trim().slice(0, 500);
      return note ? { type: "claude", note, why } : null;
    }
    default: return null;
  }
}

function parse(text) {
  if (!text) return null;
  if (typeof text === "object") return Array.isArray(text.proposals) ? text : null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const j = JSON.parse(m[0]); return Array.isArray(j.proposals) ? j : null; } catch (e) { return null; }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
function hash(s) {
  let h = 2166136261;
  for (const c of String(s).toLowerCase()) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function json(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers }); }
