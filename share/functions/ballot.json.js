// The public ballot quiz's data (2026-10-24). Served only while Joe's toggle in The Wire is
// on (KV key share.json, written by The Wire's /share function behind Cloudflare Access).
// The data is public information only (pipeline/share_build.py): statements, candidates'
// sourced positions, explainers, dates and official links. Nothing personal.
import data from "../ballot-data.json";

const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export async function onRequestGet({ env }) {
  let on = false;
  try { on = Boolean(((await env.WIRE.get("share.json", "json")) || {}).on); } catch (e) { on = false; }
  if (!on) return new Response(JSON.stringify({ closed: true }), { status: 200, headers });
  return new Response(JSON.stringify(data), { headers });
}
