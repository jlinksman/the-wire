// Home brief (2026-10-28): 3 to 5 top stories for the kitchen speaker, read by Home Assistant
// every 15 minutes. The build writes "home-brief.json" to Workers KV (pipeline/home_brief.py);
// this only serves it. News only: nothing private is in that key. Read-only (GET and HEAD).
// Like the rest of the site it sits behind Cloudflare Access; Home Assistant authenticates with an
// Access service token (CF-Access-Client-Id / CF-Access-Client-Secret headers).
export async function onRequest({ request, env }) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "read-only" }), { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
  }
  if (!env.WIRE) return new Response(JSON.stringify({ error: "KV binding WIRE is not configured" }), { status: 500, headers });
  const value = await env.WIRE.get("home-brief.json");
  if (!value) return new Response(JSON.stringify({ updated: null, items: [], error: "Not built yet; the next 15-minute build writes it." }), { status: 503, headers });
  return new Response(request.method === "HEAD" ? null : value, { headers });
}
