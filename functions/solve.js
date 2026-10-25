// Your solutions (2026-10-25): Joe writes his own fix for an issue; Workers AI reads it against the
// statements and policy mechanisms on that issue; he confirms what counts. Private end to end:
// the text and everything derived from it live only in Workers KV (proposals.json) behind
// Cloudflare Access, are processed only here (never in GitHub Actions), and are never logged or
// cached. Workers AI does not train on or retain inputs (developers.cloudflare.com/workers-ai/platform/privacy/).
//
// GET  /solve                                  -> {issues:{id:{text, w, codes, mech, gaps, goals, saved_at, past}}}
// POST /solve {action:"read", issue, text, statements:[{id,text}], mechanisms:[{id,text}]}
//      -> {statements:[{id,v,quote}], mechanisms:[{id,v,quote}], gaps:[], goals:[], dropped, model}  (nothing saved)
// POST /solve {action:"save", issue, text, w, codes:{id:{v,quote}}, mech:{id:{v,quote}}, gaps, goals}
// POST /solve {action:"delete", issue}
const KEY = "proposals.json";
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const ID = /^[a-z0-9_]{1,40}$/i;

const SYSTEM = `You read one person's own proposal for solving a public-policy issue and code it, carefully and literally.

You get: the issue, the person's text, a list of statements (id, text), and a list of policy mechanisms (id, text).
For each statement or mechanism the text clearly takes a position on, give:
- v: for statements, the person's likely answer on a 5-point scale: 2 strongly agree, 1 agree, 0 neutral, -1 disagree, -2 strongly disagree. For mechanisms: 1 proposes or supports it, -1 rejects it, 0 mixed.
- quote: the exact words from the person's text (copied character for character, 3 to 25 words) that show it.
Only code what the text actually says. If the text doesn't address a statement or mechanism, leave it out. Never infer from what people "like this" usually think. Use strong values (2 or -2) only when the wording is strong.
Also give:
- gaps: up to 4 short phrases (under 12 words each) naming concrete ideas in the text that no listed statement or mechanism covers.
- goals: up to 3 short phrases naming what the proposal is trying to achieve (e.g. "lower monthly bills", "keep the grid reliable").

Reply with JSON only: {"statements":[{"id":"q01","v":1,"quote":"..."}],"mechanisms":[{"id":"m2","v":1,"quote":"..."}],"gaps":["..."],"goals":["..."]}`;

export async function onRequestGet({ env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  return json((await env.WIRE.get(KEY, "json")) || { issues: {} });
}

export async function onRequestPost({ request, env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "bad JSON" }, 400); }
  const issue = String(b.issue || "");
  if (!ID.test(issue)) return json({ error: "Which issue?" }, 400);

  if (b.action === "read") return read(b, env);

  const cur = (await env.WIRE.get(KEY, "json")) || { issues: {} };
  cur.issues = cur.issues || {};
  if (b.action === "delete") {
    delete cur.issues[issue];
    await env.WIRE.put(KEY, JSON.stringify(cur));
    return json(cur);
  }
  if (b.action === "save") {
    const text = clip(b.text, 4000);
    if (!text) return json({ error: "Write something first." }, 400);
    const prev = cur.issues[issue];
    const past = prev ? [{ text: prev.text, saved_at: prev.saved_at }, ...(prev.past || [])].slice(0, 5) : [];
    cur.issues[issue] = {
      text, saved_at: new Date().toISOString(), past,
      w: Math.min(3, Math.max(1, Math.round(Number(b.w) || 2))),
      codes: codes(b.codes, -2, 2, text), mech: codes(b.mech, -1, 1, text),
      gaps: list(b.gaps, 4, 120), goals: list(b.goals, 3, 80),
    };
    await env.WIRE.put(KEY, JSON.stringify(cur));
    return json(cur);
  }
  return json({ error: "Unknown action." }, 400);
}

async function read(b, env) {
  if (!env.AI) return json({ error: "Workers AI binding AI is not configured" }, 500);
  const text = clip(b.text, 4000);
  if (text.split(/\s+/).length < 8) return json({ error: "Write a little more first: a sentence or two about what you'd do." }, 400);
  const sts = (b.statements || []).filter((s) => s && ID.test(String(s.id))).slice(0, 30).map((s) => ({ id: String(s.id), text: clip(s.text, 300) }));
  const mcs = (b.mechanisms || []).filter((s) => s && ID.test(String(s.id))).slice(0, 12).map((s) => ({ id: String(s.id), text: clip(s.text, 200) }));
  const prompt = `Issue: ${clip(b.title || b.issue, 120)}\n\nThe person's proposal:\n"""\n${text}\n"""\n\nStatements:\n${sts.map((s) => s.id + ": " + s.text).join("\n") || "(none)"}\n\nMechanisms:\n${mcs.map((s) => s.id + ": " + s.text).join("\n") || "(none)"}`;
  let out = null, model = null, notice = null;
  for (const m of [MODEL, FALLBACK_MODEL]) {
    try {
      const r = await env.AI.run(m, { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], max_tokens: 900, temperature: 0 });
      out = parse(r && (r.response ?? r.result ?? r));
      if (out) { model = m; break; }
    } catch (e) { notice = "Reading model unavailable."; }
  }
  if (!out) return json({ error: notice || "The model's reading didn't come back in a usable form. Try again." }, 502);
  const sIds = new Set(sts.map((s) => s.id)), mIds = new Set(mcs.map((s) => s.id));
  let dropped = 0;
  const keep = (arr, ids, lo, hi) => (Array.isArray(arr) ? arr : []).filter((x) => {
    const ok = x && ids.has(String(x.id)) && Number.isFinite(Number(x.v)) && Number(x.v) >= lo && Number(x.v) <= hi && inText(x.quote, text);
    if (!ok) dropped += 1;
    return ok;
  }).map((x) => ({ id: String(x.id), v: Math.round(Number(x.v)), quote: clip(x.quote, 240) }));
  return json({
    statements: dedupe(keep(out.statements, sIds, -2, 2)), mechanisms: dedupe(keep(out.mechanisms, mIds, -1, 1)),
    gaps: list(out.gaps, 4, 120), goals: list(out.goals, 3, 80), dropped, model,
  });
}

// A code counts only if its quote is really in his text (the model can't put words in his mouth).
const norm = (s) => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
function inText(q, text) { const n = norm(q); return n.length >= 6 && norm(text).includes(n); }
function codes(o, lo, hi, text) {
  const out = {};
  for (const [k, x] of Object.entries(o || {})) {
    if (!ID.test(k) || !x) continue;
    const v = Math.round(Number(x.v));
    if (Number.isFinite(v) && v >= lo && v <= hi) out[k] = { v, quote: inText(x.quote, text) ? clip(x.quote, 240) : null, by: x.by === "you" ? "you" : "read" };
  }
  return out;
}
function dedupe(a) { const seen = new Set(); return a.filter((x) => !seen.has(x.id) && seen.add(x.id)); }
function list(a, n, len) { return (Array.isArray(a) ? a : []).map((s) => clip(s, len)).filter(Boolean).slice(0, n); }
function clip(s, n) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, n); }
function parse(r) {
  if (r && typeof r === "object" && (r.statements || r.mechanisms)) return r;
  const s = String(r || "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
}
function json(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers }); }
