// Your scorecard (2026-10-23): the private layer of the voter guide. Address-level districts
// and scores on his own priorities live only in Workers KV (ballot.json), never in the
// public repository. The guide sheet reads it and shows it beside the neutral guide.
//
// GET  /ballot              -> the stored scorecard, or {}
// POST /ballot {ballot}     -> store it (replaces the previous one)
// POST /ballot {action:"clear"}
const KEY = "ballot.json";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export async function onRequestGet({ env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  return json((await env.WIRE.get(KEY, "json")) || {});
}

export async function onRequestPost({ request, env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  const raw = await request.text();
  if (raw.length > 400000) return json({ error: "That's too large to be a scorecard." }, 413);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json({ error: "That isn't valid JSON. Paste the whole file." }, 400); }
  if (body.action === "clear") { await env.WIRE.delete(KEY); return json({}); }
  // Which statements inform which criterion (2026-10-25): private, so it lives here, not in values.yaml.
  if (body.crit_map && !body.races) {
    const cur = (await env.WIRE.get(KEY, "json")) || {};
    const m = {};
    for (const [k, v] of Object.entries(body.crit_map || {})) if (/^[a-z0-9_]{1,24}$/i.test(k) && /^[a-z0-9_]{1,40}$/i.test(String(v))) m[k] = String(v);
    cur.crit_map = m;
    await env.WIRE.put(KEY, JSON.stringify(cur));
    return json(cur);
  }
  const b = body.ballot || body;
  if (!b || typeof b !== "object" || !b.election || !b.races || typeof b.races !== "object") {
    return json({ error: "That doesn't look like a scorecard (it needs election and races)." }, 400);
  }
  b.imported = new Date().toISOString();
  if (!b.crit_map) { const cur = (await env.WIRE.get(KEY, "json")) || {}; if (cur.crit_map) b.crit_map = cur.crit_map; }
  await env.WIRE.put(KEY, JSON.stringify(b));
  return json(b);
}

function json(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers }); }
