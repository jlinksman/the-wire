// Follows: the threads and named topics Joe follows, kept in Workers KV so they work on
// every device and reach the build (which fetches follows.json before each run).
//
// GET  /follow                      -> {threads:[{id,title,since}], topics:[{id,title,pattern,kind,desk,since}]}
// POST /follow {action:"follow"|"unfollow", type:"thread"|"topic", id, title, kind?, desk?, pattern?}
// POST /follow {action:"signal", id, value:"more"|"less"|"clear", title?, desk?, kind?}   (stage 4: more/less like this)
const KEY = "follows.json";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export async function onRequestGet({ env }) {
  if (!env.WIRE) return new Response(JSON.stringify({ error: "KV binding WIRE is not configured" }), { status: 500, headers });
  const cur = (await env.WIRE.get(KEY, "json")) || { threads: [], topics: [] };
  return new Response(JSON.stringify(cur), { headers });
}

export async function onRequestPost({ request, env }) {
  if (!env.WIRE) return new Response(JSON.stringify({ error: "KV binding WIRE is not configured" }), { status: 500, headers });
  let body;
  try { body = await request.json(); } catch (e) { return new Response(JSON.stringify({ error: "bad JSON" }), { status: 400, headers }); }
  const cur = (await env.WIRE.get(KEY, "json")) || { threads: [], topics: [] };
  if (body.action === "signal") {
    const id = String(body.id || "").slice(0, 40);
    if (!id) return new Response(JSON.stringify({ error: "an id is required" }), { status: 400, headers });
    const rest = (cur.signals || []).filter((x) => x.id !== id);
    cur.signals = body.value === "more" || body.value === "less"
      ? [...rest, { id, value: body.value, title: String(body.title || "").slice(0, 140), desk: String(body.desk || "").slice(0, 10), kind: String(body.kind || "").slice(0, 10), at: new Date().toISOString() }].slice(-200)
      : rest;
    await env.WIRE.put(KEY, JSON.stringify(cur));
    return new Response(JSON.stringify(cur), { headers });
  }
  const type = body.type === "topic" ? "topics" : "threads";
  const list = cur[type] || [];
  const now = new Date().toISOString();
  if (body.action === "unfollow") {
    cur[type] = list.filter((x) => x.id !== body.id);
  } else {
    const title = String(body.title || "").trim().slice(0, 140);
    if (!title) return new Response(JSON.stringify({ error: "a title is required" }), { status: 400, headers });
    const id = body.type === "topic"
      ? "topic_" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
      : String(body.id || "");
    if (!id) return new Response(JSON.stringify({ error: "an id is required" }), { status: 400, headers });
    const entry = { id, title, since: now };
    if (body.type === "topic") {
      entry.pattern = String(body.pattern || title).slice(0, 300);
      entry.kind = ["event", "process", "subject", "entity", "law"].includes(body.kind) ? body.kind : "subject";
      entry.desk = ["BEACON", "GOV", "LAW", "WORLD", "SPORTS"].includes(body.desk) ? body.desk : "GOV";
    }
    cur[type] = [...list.filter((x) => x.id !== id), entry].slice(-60);
  }
  await env.WIRE.put(KEY, JSON.stringify(cur));
  return new Response(JSON.stringify(cur), { headers });
}
