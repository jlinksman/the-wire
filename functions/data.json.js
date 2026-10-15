// Serves the latest build from Workers KV. The 15-minute GitHub job writes
// the "data.json" key; the site itself only redeploys when code changes.
export async function onRequest({ env }) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (!env.WIRE) {
    return new Response(JSON.stringify({ error: "KV binding WIRE is not configured" }), { status: 500, headers });
  }
  const body = await env.WIRE.get("data.json");
  if (!body) {
    return new Response(JSON.stringify({ error: "No data yet. The first build hasn't run." }), { status: 503, headers });
  }
  return new Response(body, { headers });
}
