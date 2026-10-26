// Meeting moments (2026-10-26): the spots Joe marks while watching a meeting video, optionally tied
// to an agenda item, so the agenda can jump straight to them. Private: Workers KV only (moments.json).
//
// GET  /moments                                        -> {moments: [{v, t, meeting, n, note, at}]}
// POST /moments {action:"add", v, t, meeting, n, note}  -> the list
// POST /moments {action:"delete", v, t}                 -> the list
const KEY = "moments.json";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const VID = /^[A-Za-z0-9_-]{6,20}$/;

export async function onRequestGet({ env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  return json((await env.WIRE.get(KEY, "json")) || { moments: [] });
}

export async function onRequestPost({ request, env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "bad JSON" }, 400); }
  const cur = (await env.WIRE.get(KEY, "json")) || { moments: [] };
  const v = String(b.v || ""), t = Math.max(0, Math.round(Number(b.t) || 0));
  if (!VID.test(v)) return json({ error: "Which video?" }, 400);
  if (b.action === "delete") cur.moments = cur.moments.filter((m) => !(m.v === v && m.t === t));
  else if (b.action === "add") {
    cur.moments = cur.moments.filter((m) => !(m.v === v && m.t === t));
    cur.moments.push({
      v, t, at: new Date().toISOString(),
      meeting: String(b.meeting || "").slice(0, 40) || null,
      n: b.n != null && /^[\w.]{1,8}$/.test(String(b.n)) ? String(b.n) : null,
      note: String(b.note || "").replace(/\s+/g, " ").trim().slice(0, 200) || null,
    });
    cur.moments = cur.moments.slice(-800);
  } else return json({ error: "Unknown action." }, 400);
  await env.WIRE.put(KEY, JSON.stringify(cur));
  return json(cur);
}

function json(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers }); }
