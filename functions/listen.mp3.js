// The audio edition (2026-10-26): the MP3 the build writes to Workers KV (listen.mp3), served
// behind Cloudflare Access like everything else. Supports byte ranges, which iPhones need to
// play and seek audio.
const KEY = "listen.mp3";

export async function onRequestGet({ request, env }) {
  if (!env.WIRE) return new Response("KV binding WIRE is not configured", { status: 500 });
  const buf = await env.WIRE.get(KEY, "arrayBuffer");
  if (!buf) return new Response("No edition yet.", { status: 404, headers: { "cache-control": "no-store" } });
  const size = buf.byteLength;
  const base = { "content-type": "audio/mpeg", "accept-ranges": "bytes", "cache-control": "private, max-age=600" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
  if (!m) return new Response(buf, { headers: { ...base, "content-length": String(size) } });
  let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!(start >= 0) || start >= size || end < start) {
    return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
  });
}

export const onRequestHead = async (ctx) => {
  const r = await onRequestGet(ctx);
  return new Response(null, { status: r.status, headers: r.headers });
};
