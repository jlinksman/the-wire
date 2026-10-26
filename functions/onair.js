// On air later (2026-10-26): the broadcasts Joe starred for a push 10 minutes before they start.
// Private: Workers KV (onair_stars.json), read by the timer Worker's 3-minute check.
// GET -> {stars:[{id, at, title, watch}]}   POST {action:"star"|"unstar", id, at, title, watch}
const KEY = "onair_stars.json";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export async function onRequestGet({ env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  return json((await env.WIRE.get(KEY, "json")) || { stars: [] });
}

export async function onRequestPost({ request, env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "bad JSON" }, 400); }
  const id = String(b.id || "");
  if (!/^oa_[\w-]{1,40}$/.test(id)) return json({ error: "Which event?" }, 400);
  const cur = (await env.WIRE.get(KEY, "json")) || { stars: [] };
  const now = Date.now();
  cur.stars = (cur.stars || []).filter((s) => s.id !== id && Date.parse(s.at) > now - 6 * 3600e3);   // drop past ones
  if (b.action === "star") {
    const at = new Date(b.at);
    if (isNaN(at)) return json({ error: "When?" }, 400);
    const watch = /^https:\/\//.test(String(b.watch || "")) ? String(b.watch).slice(0, 300) : null;
    cur.stars.push({ id, at: at.toISOString(), title: String(b.title || "").slice(0, 160), watch });
  } else if (b.action !== "unstar") return json({ error: "Unknown action." }, 400);
  await env.WIRE.put(KEY, JSON.stringify(cur));
  return json(cur);
}

function json(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers }); }
