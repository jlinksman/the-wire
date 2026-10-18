// Serves the latest build from Workers KV. The 15-minute GitHub job writes the
// "data.json" key with the build time as metadata; the page sends that back as
// If-None-Match and gets an empty 304 when nothing has changed since its last load.
export async function onRequest({ request, env }) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (!env.WIRE) {
    return new Response(JSON.stringify({ error: "KV binding WIRE is not configured" }), { status: 500, headers });
  }
  const { value, metadata } = await env.WIRE.getWithMetadata("data.json");
  if (!value) {
    return new Response(JSON.stringify({ error: "No data yet. The first build hasn't run." }), { status: 503, headers });
  }
  const etag = metadata && metadata.v ? '"' + metadata.v + '"' : null;
  if (etag) headers.etag = etag;
  if (etag && request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(value, { headers });
}
