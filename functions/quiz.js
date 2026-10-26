// Questionnaires (2026-10-23): Joe's answers, kept only in Workers KV (quiz.json), never in
// the public repository. The questions and the candidates' codings are public (elections.yaml);
// the answers, his map position and his matches are private.
//
// GET  /quiz                                   -> {elections:{id:{answers,done_at}}, pulse:[...], values:{...}}
// POST /quiz {kind:"election", id, answers:{q:{v:-2..2, w:1..3}}, done}
// POST /quiz {kind:"baseline", answers:{id:{v}}, done}  (the starting questionnaire)
// POST /quiz {kind:"pulse", answers:[...]}     -> appended (kept to the last 200)
// POST /quiz {kind:"values", answers:{...}, done, restart}  (restart keeps the last take in values.past)
// POST /quiz {kind:"clear", id}                -> forget one election's answers
const KEY = "quiz.json";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const clean = (a) => {
  const out = {};
  for (const [k, x] of Object.entries(a || {})) {
    if (!/^[a-z0-9_]{1,24}$/i.test(k) || !x) continue;
    const v = Number(x.v), w = Number(x.w || 2);
    if (x.skip) out[k] = { skip: true };
    else if (Number.isFinite(v) && v >= -2 && v <= 2) out[k] = { v: Math.round(v), w: Math.min(3, Math.max(1, Math.round(w))) };
  }
  return out;
};

// One pulse answer: a pair ({t:"pair", a:{id,title}, b:{id,title}, pick:"a"|"b"|"both"|"neither"})
// or a care question ({t:"care", id, title, v:-2..2}). Anything else is dropped.
const side = (x) => (x && typeof x.title === "string" ? { id: String(x.id || "").slice(0, 40), title: x.title.slice(0, 160) } : null);
function pulseOne(a) {
  if (!a) return null;
  if (a.t === "pair" && side(a.a) && side(a.b) && ["a", "b", "both", "neither"].includes(a.pick)) return { t: "pair", a: side(a.a), b: side(a.b), pick: a.pick };
  const v = Number(a.v);
  if (a.t === "care" && typeof a.title === "string" && Number.isFinite(v) && v >= -2 && v <= 2) return { t: "care", id: String(a.id || "").slice(0, 40), title: a.title.slice(0, 160), v: Math.round(v) };
  return null;
}

export async function onRequestGet({ env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  return json((await env.WIRE.get(KEY, "json")) || { elections: {}, pulse: [], values: {} });
}

export async function onRequestPost({ request, env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "bad JSON" }, 400); }
  const q = (await env.WIRE.get(KEY, "json")) || { elections: {}, pulse: [], values: {} };
  q.elections = q.elections || {}; q.pulse = q.pulse || []; q.values = q.values || {};
  const now = new Date().toISOString();
  if (b.kind === "election" && /^[a-z0-9_]{1,40}$/i.test(b.id || "")) {
    const cur = q.elections[b.id] || { answers: {} };
    cur.answers = Object.assign(cur.answers || {}, clean(b.answers));
    cur.updated = now;
    if (b.done) cur.done_at = now;
    q.elections[b.id] = cur;
  } else if (b.kind === "values") {
    if (b.restart && q.values.done_at) {
      // A retake keeps the earlier take (answers and date), so drift can be shown; last 5.
      q.values.past = [...(q.values.past || []), { answers: q.values.answers, done_at: q.values.done_at }].slice(-5);
      q.values.answers = {}; delete q.values.done_at;
    }
    q.values.answers = Object.assign(q.values.answers || {}, clean(b.answers));
    q.values.updated = now;
    if (b.done) q.values.done_at = now;
  } else if (b.kind === "topup") {
    // "Sharpen my profile" (2026-10-26): top-up statements for Where you stand, kept apart from the
    // frozen core so yearly retakes stay comparable.
    q.topup = q.topup || {};
    q.topup.answers = Object.assign(q.topup.answers || {}, clean(b.answers));
    q.topup.updated = now;
    if (b.round) q.topup.rounds = [...(q.topup.rounds || []), { at: now, axes: (b.round || []).filter((x) => /^[a-z]{2,10}$/.test(x)).slice(0, 3) }].slice(-40);
  } else if (b.kind === "baseline") {
    q.baseline = q.baseline || {};
    q.baseline.answers = Object.assign(q.baseline.answers || {}, clean(b.answers));
    q.baseline.updated = now;
    if (b.done) q.baseline.done_at = now;
  } else if (b.kind === "memes") {
    // The meme map: a take is 12 question ids (take) and the card picked for each ({p01: 0..3}).
    // A new take after a finished one keeps the finished one in past (last 8) for drift.
    q.memes = q.memes || {};
    if (Array.isArray(b.take)) {
      if (b.restart && q.memes.done_at) q.memes.past = [...(q.memes.past || []), { answers: q.memes.answers, done_at: q.memes.done_at }].slice(-8);
      q.memes.take = b.take.filter((id) => /^[a-z]\d{2}$/.test(id)).slice(0, 16);
      q.memes.answers = {}; delete q.memes.done_at;
    }
    const ok = {};
    for (const [k, v] of Object.entries(b.answers || {})) if (/^[a-z]\d{2}$/.test(k) && [0, 1, 2, 3].includes(v)) ok[k] = v;
    q.memes.answers = Object.assign(q.memes.answers || {}, ok);
    if (b.done) q.memes.done_at = now;
  } else if (b.kind === "self") {
    // Joe's own labels (2026-10-25): the ANES 7-point self-placement (-3 extremely liberal ..
    // +3 extremely conservative, or "unsure" = haven't thought much) and his Pew typology group.
    q.self = q.self || {};
    if ([-3, -2, -1, 0, 1, 2, 3, "unsure"].includes(b.anes)) { q.self.anes = b.anes; q.self.anes_at = now; }
    if (typeof b.pew === "string") { q.self.pew = b.pew.slice(0, 60); q.self.pew_at = now; }
    // More outside labels (2026-10-26): the Political Compass's two coordinates, the Advocates'
    // Nolan-chart quiz result, Moral Foundations scores from YourMorals, and the 8values ideology.
    const num = (x, lo, hi) => { const v = Number(x); return Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 100) / 100 : null; };
    if (b.pc && typeof b.pc === "object") { const e = num(b.pc.econ, -10, 10), so = num(b.pc.soc, -10, 10); if (e != null && so != null) { q.self.pc = { econ: e, soc: so }; q.self.pc_at = now; } }
    if (["Libertarian", "Left (liberal)", "Right (conservative)", "Statist", "Centrist"].includes(b.nolan)) { q.self.nolan = b.nolan; q.self.nolan_at = now; }
    if (b.mf && typeof b.mf === "object") { const mf = {}; for (const k of ["care", "fairness", "loyalty", "authority", "purity", "liberty"]) { const v = num(b.mf[k], 0, 5); if (v != null) mf[k] = v; } if (Object.keys(mf).length) { q.self.mf = mf; q.self.mf_at = now; } }
    if (typeof b.v8 === "string") { q.self.v8 = b.v8.replace(/[^\w '()-]/g, "").slice(0, 40); q.self.v8_at = now; }
  } else if (b.kind === "pulse" && Array.isArray(b.answers)) {
    q.pulse = [...q.pulse, ...b.answers.slice(0, 20).map(pulseOne).filter(Boolean).map((a) => ({ ...a, at: now }))].slice(-200);
  } else if (b.kind === "clear") {
    if (b.id === "values") q.values = {}; else if (b.id === "memes") q.memes = {}; else if (b.id === "baseline") q.baseline = {}; else if (b.id === "pulse") q.pulse = []; else delete q.elections[b.id];
  } else {
    return json({ error: "unknown questionnaire" }, 400);
  }
  await env.WIRE.put(KEY, JSON.stringify(q));
  return json(q);
}

function json(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers }); }
