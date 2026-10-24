// The share toggle (2026-10-24): whether the public ballot quiz (wire-ballot.pages.dev) is open.
// This function sits behind Cloudflare Access with the rest of The Wire, so only Joe can flip it.
// GET -> {on, at}   POST {on: true|false} -> {on, at}
const KEY = "share.json";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export async function onRequestGet({ env }) {
  if (!env.WIRE) return new Response(JSON.stringify({ error: "KV binding WIRE is not configured" }), { status: 500, headers });
  return new Response(JSON.stringify((await env.WIRE.get(KEY, "json")) || { on: false }), { headers });
}

export async function onRequestPost({ request, env }) {
  if (!env.WIRE) return new Response(JSON.stringify({ error: "KV binding WIRE is not configured" }), { status: 500, headers });
  let b;
  try { b = await request.json(); } catch (e) { return new Response(JSON.stringify({ error: "bad JSON" }), { status: 400, headers }); }
  const rec = { on: Boolean(b.on), at: new Date().toISOString() };
  await env.WIRE.put(KEY, JSON.stringify(rec));
  return new Response(JSON.stringify(rec), { headers });
}
