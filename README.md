# The Wire

A private, single-reader news page. Every 15 minutes a GitHub Actions job fetches
the sources enabled in `sources.yaml`, and the page on Cloudflare Pages (behind
Cloudflare Access) shows them as one terminal-style feed.

- `sources.yaml` — every source, the live-channel presets, and the watchlist. Turn a
  source on with `enabled: true`.
- `pipeline/build.py` — the fetcher. Run locally with `python pipeline/build.py`, then
  open `dist/index.html` through any static server.
- `site/` — the page. `functions/data.json.js` serves the latest build from Workers KV.
- `CLAUDE.md`, `BRIEF.md`, `V1.md`, `ROADMAP.md` — the build brief and what comes next.

This repository holds code only. Fetched content and keys never live here.
