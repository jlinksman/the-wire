// The Wire — Cloudflare Worker with two jobs, both on cron (it has no public page:
// workers.dev is disabled in wrangler.toml).
//
// 1. Every 15 minutes: start the GitHub "Build feed" workflow on time, because GitHub's
//    own scheduler runs it hours late.
// 2. Every 3 minutes: push alerts (V6). Reads the build's candidate list from KV
//    (alerts.json), checks NWS for Beacon warnings directly, and sends through ntfy.sh.
//    At most `daily_cap` pushes a New York day; nothing is ever sent twice. Its state
//    (alerts_state in KV) feeds the source-health list on the page.

const UA = "TheWire/1.0 (private personal news reader; github.com/jlinksman/the-wire)";

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "*/15 * * * *") return dispatchBuild(env);
    return checkAlerts(env);
  },
};

async function dispatchBuild(env) {
  const res = await fetch(
    `https://api.github.com/repos/${env.REPO}/actions/workflows/build.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "the-wire-build-timer",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  if (res.status !== 204) {
    throw new Error(`dispatch failed: HTTP ${res.status} ${await res.text()}`);
  }
}

function nyDay(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

async function checkAlerts(env) {
  const now = new Date();
  const fresh = await env.WIRE.get("alerts_state", "json");
  const state = fresh || { day: "", count: 0, sent: {}, last_ok: null, last_error: null, log: [] };
  const before = JSON.stringify(state);
  const errors = [];

  if (state.day !== nyDay(now)) { state.day = nyDay(now); state.count = 0; }
  if (!env.NTFY_TOPIC) errors.push("NTFY_TOPIC secret not set, so no pushes can be sent");

  const feed = (await env.WIRE.get("alerts.json", "json")) || { config: {}, candidates: [] };
  const cfg = feed.config || {};
  const cap = cfg.daily_cap ?? 5;
  const cands = [];

  // NWS warnings for Beacon, fetched here so they arrive within minutes.
  if (cfg.nws && cfg.nws.url) {
    try {
      const r = await fetch(cfg.nws.url, { headers: { "User-Agent": UA, Accept: "application/geo+json" } });
      if (!r.ok) throw new Error(`NWS HTTP ${r.status}`);
      const pat = new RegExp(cfg.nws.event_pattern || "Warning$");
      const always = cfg.nws.always_severity || [];
      for (const f of (await r.json()).features || []) {
        const p = f.properties || {};
        if (p.status !== "Actual" || p.messageType === "Cancel") continue;
        if (!(pat.test(p.event || "") || always.includes(p.severity))) continue;
        const until = p.ends || p.expires;
        cands.push({
          key: `nws:${p.event}|${p.onset || p.effective}`,
          priority: p.severity === "Extreme" ? 5 : 4,
          tags: ["warning"],
          title: `${p.event} — Beacon`,
          message: (p.headline || p.event) + (until ? ` Until ${new Date(until).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" })}.` : ""),
          click: cfg.nws.page,
        });
      }
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  cands.push(...(feed.candidates || []));

  // On air later (2026-10-26): broadcasts Joe starred, 10 minutes before they start (same daily cap).
  try {
    const st = (await env.WIRE.get("onair_stars.json", "json")) || { stars: [] };
    for (const s of st.stars || []) {
      const lead = new Date(s.at) - now;
      if (lead <= 12 * 60000 && lead > -5 * 60000) {
        cands.push({ key: `onair:${s.id}`, priority: 3, tags: ["tv"], title: "Starting soon: " + s.title.slice(0, 120),
          message: "Starts " + new Date(s.at).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) + ".",
          click: s.watch || "https://the-wire-8je.pages.dev/" });
      }
    }
  } catch (e) {
    errors.push("on-air stars: " + String(e.message || e));
  }

  // First run: record what's already there instead of pushing a backlog.
  if (!fresh) {
    for (const c of cands) state.sent[c.key] = now.toISOString();
  } else {
    for (const c of cands) {
      if (state.sent[c.key]) continue;
      if (state.count >= cap) {
        state.sent[c.key] = now.toISOString();
        state.log = [`${now.toISOString()} skipped (daily cap): ${c.title}`, ...(state.log || [])].slice(0, 20);
        continue;
      }
      if (!env.NTFY_TOPIC) break;
      try {
        const r = await fetch("https://ntfy.sh/", {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": UA },
          body: JSON.stringify({ topic: env.NTFY_TOPIC, title: c.title, message: c.message, priority: c.priority, tags: c.tags, click: c.click }),
        });
        if (!r.ok) throw new Error(`ntfy HTTP ${r.status}`);
        state.sent[c.key] = now.toISOString();
        state.count += 1;
        state.log = [`${now.toISOString()} sent: ${c.title}`, ...(state.log || [])].slice(0, 20);
      } catch (e) {
        errors.push(String(e.message || e));
        break;
      }
    }
  }

  // Forget sent keys after 3 days.
  for (const [k, t] of Object.entries(state.sent)) {
    if (now - new Date(t) > 3 * 86400000) delete state.sent[k];
  }
  state.last_error = errors.length ? errors.join("; ").slice(0, 300) : null;
  // Heartbeat at most hourly, so KV writes stay far under the free plan's 1,000 a day.
  if (!state.last_error && (!state.last_ok || now - new Date(state.last_ok) > 3600000)) state.last_ok = now.toISOString();

  if (JSON.stringify(state) !== before) await env.WIRE.put("alerts_state", JSON.stringify(state));
}
