// Debate mode (2026-10-26). Joe talks an idea in; The Wire spars with it (the strongest opposing
// case), coaches it (unsupported claims, the rebuttal he'll get, a 30-second version), or checks it
// during a debate. Every reply also notes the claims he made (each tied to his exact words) and, when
// he was answering a challenge, whether he held, softened or changed. Ending a session writes a recap
// and folds his claims into a private list of positions, which the page rates firm, forming or passing.
//
// Private end to end (CLAUDE.md rule 10): Workers KV only (debate_now.json, debate_log.json,
// positions.json), processed only here and by Workers AI, never logged or cached.
//
// Budget: Workers AI's free allowance is 10,000 neurons a day (resets 00:00 UTC). The build publishes
// its own use today and its 7-day average as data.json's KV metadata; debate mode uses what's left
// after the build's expected use for the rest of the day, with a reserve for the page's other AI.
//
// GET  /debate                              -> {now, log:[{id, started, mode, topic, recap}], positions, budget}
// POST {action:"say", text, mode, topic, context:{title, items:[{n, text, source}]}, who}
// POST {action:"end"}                       -> recap; positions updated
// POST {action:"reframe", text, audience}   -> {reframed, values}
// POST {action:"position", id, confirm: true|false|null} | {action:"forget", id}
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SMALL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const RATES = { [MODEL]: [26668, 204805], [SMALL]: [4119, 34868] };   // neurons per million tokens in/out
const DAILY = 10000, RESERVE = 600;
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const COMMON = `Facts: use only the numbered material you are given, and cite it like [2]. If the material doesn't cover something, say so rather than guessing. Never invent statistics, quotes or events.
Also return "claims": the distinct claims the person made in THIS message, each as an exact quote from their words (3 to 30 words, copied character for character) with "certainty": "high" (always, never, must, definitely, no question, flat statements), "low" (maybe, I think, not sure, I wonder, could), or "medium". And "challenge": if the person's message answers a challenge from your previous turn, "held", "softened" or "changed"; otherwise "none".`;
const SYSTEM = {
  spar: `You are a sparring partner for one person who wants to test his political ideas. Argue the strongest, fair version of the opposing case to what he just said: the best argument a thoughtful opponent would make, not a straw man and not a lecture. Be direct and specific, 70 to 140 words, and end with one pointed question that makes him defend his weakest link. Don't tell him what to believe and don't concede just to be agreeable.
${COMMON}
Reply with JSON only: {"reply":"...","refs":[1],"claims":[{"quote":"...","certainty":"high"}],"challenge":"none"}`,
  coach: `You are a debate coach for one person sharpening his own political argument. You don't argue the other side; you make his case stronger and more honest. Give: "unsupported": up to 3 of his claims that need evidence, each {"quote": exact words, "why": under 20 words}; "rebuttal": the single strongest rebuttal he will get, under 50 words; "tight": his argument in his own voice in 60 words or fewer, using only claims he made (don't add new ones).
${COMMON}
Reply with JSON only: {"unsupported":[{"quote":"...","why":"..."}],"rebuttal":"...","tight":"...","refs":[1],"claims":[...],"challenge":"none"}`,
  night: `You are a fact-checker sitting beside one person watching a political debate. He reacts to what a candidate just said. In 45 words or fewer, say what the numbered material shows about it: "verdict" is "supported", "disputed", "mixed" or "not in our material". Be neutral and exact; you're checking facts, not taking sides.
${COMMON}
Reply with JSON only: {"check":"...","verdict":"mixed","refs":[1],"claims":[...],"challenge":"none"}`,
};
const RECAP = `You review one person's debate-practice session (his words and the replies). Reply with JSON only:
{"sharpest":["exact quote of his strongest point", ...up to 2],
 "weakest":[{"quote":"exact quote","why":"under 20 words"}, ...up to 2],
 "positions":[{"match":"existing position id or null","topic":"short subject","summary":"his position in under 20 neutral words","quotes":["exact quotes of his"],"certainty":"high|medium|low","challenge":"held|softened|changed|none"}]}
Quotes must be copied exactly from HIS turns. Match a position to an existing one only when it is clearly the same stance on the same subject.`;
const REFRAME = `Rewrite one person's political argument so it would land with an audience whose values differ from his, following moral reframing research (Feinberg and Willer): connect the SAME position to the audience's own values. For a right-leaning audience lean on loyalty, liberty, tradition, security, fairness as proportionality; for a left-leaning audience lean on care, fairness as equality, harm reduction. Keep his position and his facts; don't add claims. 60 to 100 words. Reply with JSON only: {"reframed":"...","values":["loyalty", "..."]}`;

export async function onRequestGet({ env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  const [now, log, pos, budget] = await Promise.all([env.WIRE.get("debate_now.json", "json"), env.WIRE.get("debate_log.json", "json"), env.WIRE.get("positions.json", "json"), allowance(env)]);
  return json({ now: now || null, log: ((log || {}).sessions || []).map((s) => ({ id: s.id, started: s.started, ended: s.ended, mode: s.mode, topic: s.topic, turns: s.turns.length, recap: s.recap })), positions: (pos || {}).positions || [], budget });
}

export async function onRequestPost({ request, env }) {
  if (!env.WIRE || !env.AI) return json({ error: "KV or AI binding is not configured" }, 500);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "bad JSON" }, 400); }
  if (b.action === "say") return say(b, env);
  if (b.action === "end") return end(env);
  if (b.action === "reframe") return reframe(b, env);
  if (b.action === "position" || b.action === "forget") return editPosition(b, env);
  return json({ error: "Unknown action." }, 400);
}

// ---------------------------------------------------------------- budget
async function allowance(env) {
  const day = new Date().toISOString().slice(0, 10);
  let build = 0, avg = 6000;
  try {
    const l = await env.WIRE.list({ prefix: "data.json", limit: 1 });
    const m = (l.keys[0] || {}).metadata || {};
    if (m.day === day) build = Number(m.ai) || 0;
    avg = Number(m.ai7) || avg;
  } catch (e) { /* assume the worst */ }
  const u = (await env.WIRE.get("ai_usage.json", "json")) || {};
  const mine = u.day === day ? u.debate || 0 : 0;
  const left = 1 - (Date.now() % 86400000) / 86400000;          // share of the UTC day still to come
  const expectBuild = Math.max(build, build + left * avg);
  const room = Math.max(0, DAILY - RESERVE - expectBuild);
  return { day, used: Math.round(mine), allowed: Math.round(room), left: Math.max(0, Math.round(room - mine)) };
}
async function charge(env, n) {
  const day = new Date().toISOString().slice(0, 10);
  const u = (await env.WIRE.get("ai_usage.json", "json")) || {};
  const rec = u.day === day ? u : { day, debate: 0, history: u.history || {} };
  rec.debate = (rec.debate || 0) + n;
  rec.history = rec.history || {};
  rec.history[day] = Math.round(rec.debate);
  for (const k of Object.keys(rec.history).sort().slice(0, -30)) delete rec.history[k];
  await env.WIRE.put("ai_usage.json", JSON.stringify(rec));
}
async function run(env, system, prompt, maxTokens, budget) {
  // The large model while there's room; the small one when the day's allowance is nearly spent.
  const model = budget.left > 400 ? MODEL : budget.left > 60 ? SMALL : null;
  if (!model) throw new Error("Today's free AI allowance is used up; it resets at midnight UTC (evening in New York).");
  const out = await env.AI.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.4 });
  const usage = out && out.usage ? out.usage : { prompt_tokens: (system.length + prompt.length) / 4, completion_tokens: maxTokens };
  const [ri, ro] = RATES[model];
  const n = (usage.prompt_tokens * ri + usage.completion_tokens * ro) / 1e6;
  return { j: parse(out && (out.response ?? out.result ?? out)), n, model };
}

// ---------------------------------------------------------------- turns
async function say(b, env) {
  const text = clip(b.text, 2500);
  if (text.split(/\s+/).length < 4) return json({ error: "Say a little more." }, 400);
  const mode = SYSTEM[b.mode] ? b.mode : "spar";
  const ctx = b.context || {};
  const items = (ctx.items || []).slice(0, 24).map((x, i) => ({ n: i + 1, text: clip(x.text, 600), source: clip(x.source, 300) }));
  let now = (await env.WIRE.get("debate_now.json", "json")) || null;
  if (!now) now = { id: "d" + Date.now().toString(36), started: new Date().toISOString(), mode, topic: clip(ctx.title || b.topic, 80) || null, turns: [] };
  now.mode = mode;
  if (ctx.title) now.topic = clip(ctx.title, 80);
  const budget = await allowance(env);
  const history = now.turns.slice(-6).map((t) => (t.who === "you" ? "HIM: " : "YOU: ") + clip(t.text, 700)).join("\n");
  const prompt = `Subject: ${now.topic || "(not set)"}${b.who ? "\nThe candidate he's reacting to: " + clip(b.who, 60) : ""}\n\nNumbered material:\n${items.map((x) => `[${x.n}] ${x.text}${x.source ? " (" + x.source + ")" : ""}`).join("\n") || "(none)"}\n\nThe conversation so far:\n${history || "(start)"}\n\nHIS NEW MESSAGE:\n"""\n${text}\n"""`;
  let r;
  try { r = await run(env, SYSTEM[mode], prompt, mode === "night" ? 260 : 520, budget); } catch (e) { return json({ error: String(e.message || e).slice(0, 160) }, 503); }
  if (!r.j) return json({ error: "The reply didn't come back in a usable form. Try again." }, 502);
  const refs = (Array.isArray(r.j.refs) ? r.j.refs : []).map(Number).filter((n) => n >= 1 && n <= items.length);
  const claims = (Array.isArray(r.j.claims) ? r.j.claims : []).filter((c) => c && inText(c.quote, text)).slice(0, 6)
    .map((c) => ({ quote: clip(c.quote, 240), certainty: ["high", "medium", "low"].includes(c.certainty) ? c.certainty : "medium" }));
  const reply = mode === "spar" ? { reply: clip(r.j.reply, 1400) }
    : mode === "coach" ? { unsupported: (r.j.unsupported || []).filter((u) => u && inText(u.quote, text)).slice(0, 3).map((u) => ({ quote: clip(u.quote, 240), why: clip(u.why, 160) })), rebuttal: clip(r.j.rebuttal, 400), tight: clip(r.j.tight, 500) }
    : { check: clip(r.j.check, 400), verdict: ["supported", "disputed", "mixed", "not in our material"].includes(r.j.verdict) ? r.j.verdict : "not in our material" };
  const sources = refs.map((n) => items[n - 1]).filter(Boolean).map((x) => ({ n: x.n, text: clip(x.text, 160), source: x.source }));
  const at = new Date().toISOString();
  now.turns.push({ who: "you", text, at, mode, claims, challenge: ["held", "softened", "changed"].includes(r.j.challenge) ? r.j.challenge : "none", ...(b.who ? { re: clip(b.who, 60) } : {}) });
  now.turns.push({ who: "wire", text: reply.reply || reply.check || reply.tight || "", at, mode, ...reply, sources });
  now.turns = now.turns.slice(-80);
  await env.WIRE.put("debate_now.json", JSON.stringify(now));
  await charge(env, r.n);
  return json({ now, turn: now.turns[now.turns.length - 1], you: now.turns[now.turns.length - 2], budget: { ...budget, used: budget.used + Math.round(r.n), left: Math.max(0, Math.round(budget.left - r.n)) } });
}

async function end(env) {
  const now = await env.WIRE.get("debate_now.json", "json");
  if (!now || !now.turns.length) return json({ error: "No session to end." }, 400);
  const pos = (await env.WIRE.get("positions.json", "json")) || { positions: [] };
  const mineText = now.turns.filter((t) => t.who === "you").map((t) => t.text).join("\n");
  const budget = await allowance(env);
  let recap = null;
  try {
    const existing = pos.positions.slice(-40).map((p) => `${p.id}: [${p.topic}] ${p.summary}`).join("\n");
    const convo = now.turns.map((t) => (t.who === "you" ? "HIM: " : "REPLY: ") + clip(t.text, 600)).join("\n");
    const r = await run(env, RECAP, `Existing positions:\n${existing || "(none)"}\n\nSession on: ${now.topic || "various"}\n${convo}`, 700, budget);
    await charge(env, r.n);
    recap = r.j;
  } catch (e) { recap = null; }
  const sid = now.id;
  const day = now.started.slice(0, 10);
  if (recap) {
    recap.sharpest = (recap.sharpest || []).filter((q) => inText(q, mineText)).slice(0, 2);
    recap.weakest = (recap.weakest || []).filter((w) => w && inText(w.quote, mineText)).slice(0, 2).map((w) => ({ quote: clip(w.quote, 240), why: clip(w.why, 160) }));
    recap.new = [];
    for (const p of (recap.positions || []).slice(0, 8)) {
      const quotes = (p.quotes || []).filter((q) => inText(q, mineText)).slice(0, 3).map((q) => clip(q, 240));
      if (!quotes.length || !p.summary) continue;
      let cur = p.match && pos.positions.find((x) => x.id === p.match);
      if (!cur) {
        cur = { id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), topic: clip(p.topic, 60), summary: clip(p.summary, 160), sessions: [], days: [], quotes: [], certainty: { high: 0, medium: 0, low: 0 }, challenge: { held: 0, softened: 0, changed: 0 }, confirmed: null, first: now.started };
        pos.positions.push(cur);
        recap.new.push(cur.summary);
      }
      if (!cur.sessions.includes(sid)) cur.sessions.push(sid);
      if (!cur.days.includes(day)) cur.days.push(day);
      cur.quotes = [...quotes.map((q) => ({ q, at: now.started })), ...cur.quotes].slice(0, 8);
      const c = ["high", "medium", "low"].includes(p.certainty) ? p.certainty : "medium";
      cur.certainty[c] += 1;
      if (["held", "softened", "changed"].includes(p.challenge)) cur.challenge[p.challenge] += 1;
      cur.last = now.started;
    }
    delete recap.positions;
  }
  // The turn-by-turn challenge results count too.
  const log = (await env.WIRE.get("debate_log.json", "json")) || { sessions: [] };
  log.sessions.unshift({ ...now, ended: new Date().toISOString(), recap });
  log.sessions = log.sessions.slice(0, 60);
  await env.WIRE.put("debate_log.json", JSON.stringify(log));
  await env.WIRE.put("positions.json", JSON.stringify({ positions: pos.positions.slice(-300) }));
  await env.WIRE.delete("debate_now.json");
  return json({ recap, session: sid, positions: pos.positions });
}

async function reframe(b, env) {
  const text = clip(b.text, 1500);
  if (!text) return json({ error: "Nothing to reframe." }, 400);
  const aud = b.audience === "left" ? "left-leaning" : "right-leaning";
  const budget = await allowance(env);
  try {
    const r = await run(env, REFRAME, `Audience: ${aud}\n\nHis argument:\n"""\n${text}\n"""`, 300, budget);
    await charge(env, r.n);
    return json({ reframed: clip((r.j || {}).reframed, 900), values: ((r.j || {}).values || []).slice(0, 5).map((v) => clip(v, 30)), audience: aud });
  } catch (e) { return json({ error: String(e.message || e).slice(0, 160) }, 503); }
}

async function editPosition(b, env) {
  const pos = (await env.WIRE.get("positions.json", "json")) || { positions: [] };
  if (b.action === "forget") pos.positions = pos.positions.filter((p) => p.id !== b.id);
  else { const p = pos.positions.find((x) => x.id === b.id); if (p) p.confirmed = b.confirm === true ? true : b.confirm === false ? false : null; }
  await env.WIRE.put("positions.json", JSON.stringify(pos));
  return json(pos);
}

// A claim counts only if its quote is really in his words.
const norm = (s) => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
function inText(q, text) { const n = norm(q); return n.length >= 6 && norm(text).includes(n); }
function clip(s, n) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, n); }
function parse(r) {
  if (r && typeof r === "object") return r;
  const s = String(r || ""); const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
}
function json(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers }); }
