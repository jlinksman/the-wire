// What Joe actually engages with (2026-10-25): a private log of opens, link clicks (article,
// video, podcast, audio), explainer and takeaway opens, and time spent on each sheet, kept only
// in Workers KV (engage.json) behind Cloudflare Access, never in the repository. The page batches
// events and sends them a few times a session, so KV writes stay low. Kept 180 days, 3,000 events.
// GET -> {events:[...], stated:{...}}   POST {events:[...]} | {stated:{...}} | {clear:true}
const KEY = "engage.json";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const KINDS = new Set(["sheet", "link", "explain", "takeaways", "brief", "story", "thread", "quiz", "listen"]);

export async function onRequestGet({ env }) {
  return new Response(JSON.stringify((await env.WIRE.get(KEY, "json")) || { events: [], stated: null }), { headers });
}

export async function onRequestPost({ request, env }) {
  let b;
  try { b = await request.json(); } catch (e) { return new Response(JSON.stringify({ error: "bad JSON" }), { status: 400, headers }); }
  const cur = (await env.WIRE.get(KEY, "json")) || { events: [], stated: null };
  if (b.clear) { cur.events = []; }
  if (b.stated && typeof b.stated === "object") cur.stated = { ...b.stated, at: new Date().toISOString() };
  if (Array.isArray(b.events)) {
    const clean = b.events.slice(0, 200).filter((e) => e && KINDS.has(e.k)).map((e) => ({
      k: e.k, at: String(e.at || "").slice(0, 24), f: e.f ? String(e.f).slice(0, 12) : undefined,
      t: e.t ? String(e.t).slice(0, 140) : undefined, d: e.d ? String(e.d).slice(0, 16) : undefined,
      s: Number.isFinite(e.s) ? Math.min(3600, Math.max(0, Math.round(e.s))) : undefined, h: e.h ? String(e.h).slice(0, 60) : undefined,
      p: Number.isFinite(e.p) ? Math.min(100, Math.max(0, Math.round(e.p))) : undefined,
    }));
    const cutoff = Date.now() - 180 * 86400e3;
    cur.events = [...cur.events, ...clean].filter((e) => Date.parse(e.at) > cutoff).slice(-3000);
  }
  await env.WIRE.put(KEY, JSON.stringify(cur));
  return new Response(JSON.stringify({ ok: true, n: cur.events.length }), { headers });
}
