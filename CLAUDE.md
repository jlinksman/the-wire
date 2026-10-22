# CLAUDE.md — The Wire (standing rules)

Read this file, BRIEF.md, V1.md, DESIGN.md, and sources.yaml at the start of every session. ROADMAP.md is for context only.

## Your role
You are my build partner on a private, single-user news site. I set scope; you implement. BRIEF.md (second brief, 2026-10-18) defines what The Wire is and the four-stage iteration we're in; V1.md records the first version's scope and "done when" list. Do not add features beyond the current stage without asking. If you think something should change, say so in one line and keep working on what was asked.

## How we work
- Start by showing a short plan for V1. Wait for my go-ahead before writing code.
- Build in small working steps and commit after each one with a plain-English message.
- Finish by reporting against every item in V1.md's "Done when" list, with evidence (a screenshot, a URL, a log line). "Done" means every item is met, not that the code runs.
- Walk me through any account setup (GitHub, Cloudflare) step by step. I create the accounts; you never handle my passwords.
- Ask before deleting files, changing the folder layout, or adding any paid service.

## Hard constraints
1. **$0 running cost.** Free tiers only. No paid APIs, including the Anthropic API. V1 needs no API keys at all.
2. **No computer of mine runs 24/7.** Everything runs on GitHub and Cloudflare.
3. **Config, not code, for sources.** Every source lives in `sources.yaml`. V1 uses only entries marked `enabled: true`. Turning a source on or off is a config edit. One approved exception (2026-10-22): news searches Joe adds from the page through Tell The Wire live in `follows.json` in KV, listed in Admin with their own health rows and a remove button.
4. **Headlines and links, not articles.** Show headlines, the feed's own short description, our own summary, short verified quotes, and a link. Never republish full articles. The build may read the text of open (non-paywalled) articles to write summaries and pull quotes (approved 2026-10-16), honoring robots.txt; that text is never displayed or stored in git. Never scrape paywalled text (WSJ and the New York Law Journal are headlines and links only).
5. **Polite fetching.** Honor robots.txt, use ETag and If-Modified-Since, send an honest User-Agent, and back off on 403 and 429. Never try to get around a block.
6. **Video is official embed or link only.** Never rehost, restream, or download video.
7. **No silent failures.** Every source records its last success, last error, and item count, and the page shows a source-health list. A broken source must be visible, never hidden.
8. **Private.** The site sits behind Cloudflare Access, locked to my email. The code repository is public, so it must never contain fetched content, my data, or keys. Fetched data goes straight to Cloudflare, not into git.
9. **Secrets** (Cloudflare API token, account ID, KV namespace ID, GitHub dispatch token, ntfy topic) live in GitHub Actions secrets. Never commit them.

## V1 architecture
- **GitHub Actions in a public repository** (Actions minutes are free in public repos).
  - `build.yml` runs every 15 minutes: fetch the enabled sources, build `data.json`, and write it to **Workers KV** (free plan: 1,000 writes a day; this uses about 96). Fetch state lives in the Actions cache, never in git.
  - `deploy-site.yml` deploys the page to **Cloudflare Pages** only when site code changes, so deploys stay far under Pages' free build limits. A Pages Function (`functions/data.json.js`) serves the latest data from KV.
  - `worker/` is a Cloudflare Worker on a 15-minute cron that starts `build.yml` through GitHub's dispatch API, because GitHub's own scheduler ran it 3–5 hours late. `deploy-timer.yml` deploys it. GitHub's schedule stays as a backup.
  - The same Worker runs a 3-minute push-alert check (V6): it reads `alerts.json` from KV (written by the build), checks NWS directly, and sends at most 5 pushes a day through ntfy.sh. `push-test.yml` sends one test push.
  - Every site deploy stamps the commit into the page, `sw.js` and `version.json`. The page checks `version.json` each time it's opened or resumed and reloads into a newer version when nothing is in progress (otherwise a pill offers it). The service worker is network-first with an offline fallback, and `_headers` keeps the page files from being cached stale.
  - `keepalive.yml` makes a tiny monthly commit, because GitHub disables scheduled workflows in public repos after 60 days without commits.
- **Cloudflare Access** (Zero Trust free plan) locks the whole site, data included, to my email.
- GitHub's scheduler can run late under load. That's acceptable for V1; the page's "as of" time shows true freshness.
- Python 3.11+ for the build. Plain HTML, CSS, and vanilla JavaScript for the page. No framework and no build step unless I approve one.
- Confirm current GitHub and Cloudflare free-tier limits from their official documentation before changing this design, and stay well under them.

## Style
Dark, dense, monospace, timestamped, like a terminal. Mobile first (iPhone), desktop second. Every view shows an "as of" time.
