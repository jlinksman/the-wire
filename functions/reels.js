// Reels (2026-10-26): Joe's own clips of meetings, hearings, news video and podcasts, put in order
// for his reporting. A clip is a reference, never a copy: a YouTube video id or the publisher's own
// audio URL, with start and end times, a note and an optional quote. Private: Workers KV only
// (reels.json), behind Cloudflare Access.
//
// GET  /reels -> {reels:[{id, title, created, updated, clips:[...]}]}
// POST {action:"add", reel?, title?, clip}           add a clip (to a reel by id, or a new reel by title)
// POST {action:"update", reel, clips?, title?}        reorder, edit notes, rename
// POST {action:"delete", reel}                       delete a reel
const KEY = "reels.json";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

function cleanClip(c) {
  if (!c || typeof c !== "object") return null;
  const kind = c.kind === "audio" ? "audio" : "yt";
  const v = kind === "yt" ? String(c.v || "") : null;
  const src = kind === "audio" ? String(c.src || "") : null;
  if (kind === "yt" && !/^[A-Za-z0-9_-]{6,20}$/.test(v)) return null;
  if (kind === "audio" && !/^https:\/\//.test(src)) return null;
  const start = Math.max(0, Math.round(Number(c.start) || 0));
  const end = Math.max(start + 1, Math.round(Number(c.end) || start + 30));
  return {
    id: /^[\w-]{4,30}$/.test(String(c.id || "")) ? String(c.id) : "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    kind, ...(v ? { v } : {}), ...(src ? { src: src.slice(0, 600) } : {}),
    start, end, title: clip(c.title, 200), source: clip(c.source, 80), link: /^https:\/\//.test(String(c.link || "")) ? String(c.link).slice(0, 600) : null,
    note: clip(c.note, 600) || null, quote: clip(c.quote, 400) || null, at: c.at || new Date().toISOString(),
  };
}

export async function onRequestGet({ env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  return json((await env.WIRE.get(KEY, "json")) || { reels: [] });
}

export async function onRequestPost({ request, env }) {
  if (!env.WIRE) return json({ error: "KV binding WIRE is not configured" }, 500);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "bad JSON" }, 400); }
  const cur = (await env.WIRE.get(KEY, "json")) || { reels: [] };
  const now = new Date().toISOString();
  if (b.action === "add") {
    const c = cleanClip(b.clip);
    if (!c) return json({ error: "That clip is missing its video or audio." }, 400);
    let reel = b.reel && cur.reels.find((r) => r.id === b.reel);
    if (!reel) {
      reel = { id: "r" + Date.now().toString(36), title: clip(b.title, 120) || "Untitled reel", created: now, clips: [] };
      cur.reels.unshift(reel);
    }
    reel.clips = [...reel.clips, c].slice(-200);
    reel.updated = now;
  } else if (b.action === "update") {
    const reel = cur.reels.find((r) => r.id === b.reel);
    if (!reel) return json({ error: "No such reel." }, 404);
    if (b.title != null) reel.title = clip(b.title, 120) || reel.title;
    if (Array.isArray(b.clips)) reel.clips = b.clips.map(cleanClip).filter(Boolean).slice(0, 200);
    reel.updated = now;
  } else if (b.action === "delete") {
    cur.reels = cur.reels.filter((r) => r.id !== b.reel);
  } else return json({ error: "Unknown action." }, 400);
  cur.reels = cur.reels.slice(0, 100);
  await env.WIRE.put(KEY, JSON.stringify(cur));
  return json(cur);
}

function json(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers }); }
