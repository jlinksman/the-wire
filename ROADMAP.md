# ROADMAP.md — After V1 (do not build until I say so)

Everything here was researched and scoped, then held back so V1 could start simple. I'll pick the next version after using V1 for a few weeks. The order below is a default, not a commitment. Source details for every item are already in `sources.yaml` with `enabled: false`.

## V2 — Beacon depth (in progress, started 2026-10-16)
- [x] Daily police blotter PDFs parsed into rows. Each city upload batch is one feed item with call counts and the posting lag; officer names are left out. Never used for alerts.
- [x] City documents labeled by type (Resolution, Local law, Public hearing, Bid/RFP, Agenda, Minutes, Budget, Schedule, Notice).
- [x] Meetings on the TODAY line link to their agenda, with a ▶ WATCH button from 30 minutes before until 4 hours after the start.
- [x] Beacon row in the live player: City meetings channel and the school board's channel.
- [x] Agenda item lists: each Granicus agenda PDF is parsed into numbered items with flags (HEARING, ADJOURNED, LOCAL LAW, RESOLUTION). Joe approved fetching the linked agenda documents as part of the feed subscription (2026-10-16); upcoming agendas refresh every 6 hours, older ones are fetched once, at most 10 new per run.
- [x] Running items: agenda items that name an address (or a named site like Edgewater Place) show "↺ N earlier" with links to each earlier meeting, over the last 120 days.
- [ ] School board agendas: BoardDocs blocks cloud servers. Moved to the V8 home fetcher.
- Note: YouTube's robots.txt disallows its RSS feeds (/feeds/videos.xml), so meeting recordings come through the live player and links, not feeds.

## V3 — Government and law depth
- **Federal:** Congress.gov bills and committee meetings, House and Senate floor schedules, a "Today in government" view, and Federal Register items filtered by agency (EPA, FinCEN, Treasury, DOJ). Free api.data.gov key.
- **Albany:** follow NY bills by number through the NY Senate Open Legislation API (free key). City & State and New York Focus already cover Albany as news in V1.
- **Dutchess County Legislature:** meeting dates, agendas, and minutes.
- **Courts:** Appellate Division decisions filtered by watchlist terms and by the Second Department (which covers Dutchess); Southern District of New York and its bankruptcy court; court system notices on attorney registration, CLE, and the Rules of Professional Conduct; the weekly NYS Register for proposed state rules (NYSDEC especially); NYSDEC's proposed and adopted regulations page; JD Supra bankruptcy, real estate, and finance feeds; Volokh Conspiracy.
- **Docket following:** follow specific federal cases by docket number through CourtListener. State cases on NYSCEF have no public API, so those stay manual.

**V3 to-dos (Joe, when ready; deferred 2026-10-16):**
- [ ] Get a free api.data.gov key (https://api.data.gov/signup/) and save it as the GitHub secret `DATA_GOV_API_KEY`. Unlocks Congress.gov bills and committee meetings.
- [ ] Get a free NY Senate Open Legislation key (https://legislation.nysenate.gov/) and save it as the GitHub secret `NYSENATE_API_KEY`. Unlocks following NY bills by number and watch-term bill search.
- [ ] Send the federal and NY bill numbers to follow (optional; watch terms work without them).

## V4 — Video Desk and Watch Now
- Live and upcoming detection across government and news YouTube channels (free YouTube Data API key), a Watch Now rail with LIVE and STARTING IN badges, schedule merging (hearings, floor sessions, Supreme Court arguments, Beacon meetings), a docked player that keeps playing while I scroll, and video attached to related items.
- Link out where embedding is blocked (C-SPAN's own networks, Pentagon webcasts, UN Web TV pages).

## V5 — Quotes and story grouping
- Group the same story across outlets into one card with several sources.
- Rule-based extraction of verbatim, attributed quotes from open text. **Quote integrity rule:** a quote shown in quote styling must be string-matched against the stored source text before display; never show a generated or paraphrased quote as a quote.
- Ranking by desk weight (see BRIEF.md), recency, number of sources, and my "more like this / less like this" feedback, after a two-week calibration.
- **Synthesis (approved 2026-10-16: both routes, open article text allowed):**
  - *Input:* the build reads the text of open (non-paywalled) articles and the primary documents already fetched (agendas, minutes, Federal Register abstracts, opinions, floor logs). That text feeds summaries and quotes only; it is never displayed, and it lives in the Actions cache, never git. Paywalled sources stay headlines only.
  - *Route 1, every build:* Cloudflare Workers AI (free plan, 10,000 neurons a day; hard stop at the cap, no billing) writes a one- or two-sentence summary per story cluster with a small model (Llama 3.1 8B class). It sees only the source text; every sentence links to the sources it came from. Needs the Cloudflare API token to gain the Workers AI permission.
  - *Route 2, morning edition (optional evening):* a Claude scheduled task on Joe's plan writes a front page with analysis and implications ("what this means for Optima, Beacon, my practice areas"). It publishes as a private page, linked from a FRONT PAGE line at the top of The Wire. It holds no Cloudflare or GitHub secrets.
  - *Rules:* analysis is styled differently from reporting and labeled as such; every claim cites its sources; the quote integrity rule applies to both routes; a summary that can't be traced to source text is dropped, not shown.

- [x] **Brief me (built 2026-10-17):** on-demand spoken briefing from the build's signal list (`briefing:` in sources.yaml, `pipeline/brief.py`, `functions/brief.js`). Later: a Siri Shortcut ("Hey Siri, brief me") using a Cloudflare Access service token, and optional generated audio (MeloTTS) for lock-screen playback.

## V6 — Push alerts (built 2026-10-16)
- [x] Through ntfy.sh (free) to the ntfy iPhone app, on a private topic kept in the NTFY_TOPIC secret.
- [x] Beacon: National Weather Service warnings (checked directly every 3 minutes) and City of Beacon posts matching approved keywords.
- [x] Geopolitical: the same story from at least three independent outlets within 30 minutes, with a keyword gate for military and major events.
- [x] At most 5 a day (New York time), never the same thing twice; nothing from before the first run.
- [x] The Cloudflare Worker that times the build also runs the 3-minute alert check; its state shows in source health.
- Rules live in sources.yaml under `push_alerts`.

## V7 — World expansion
- **Built 2026-10-17 (source round 2):** 30 more outlets as quiet, corroborating sources (they count toward grouping, ranking and the briefing but don't add lone rows to the desks); event-level grouping (same foreign place + same kind of event within 30 hours) with volume and a "Developing" flag in ranking; Brief me by category (All, Local, State, National, World, Paris, Israel).
- Still to do: Le Parisien (French) and other non-English feeds need the translation step before they can group with English coverage.
- **City desks:** Paris and Tel Aviv, with original-language headlines and labeled machine translation.
- **OSINT desk:** military flight activity compared against a regional baseline, as a signal only.
- GDELT for multilingual city monitoring.

## V8 — Home fetcher
- An optional fetcher on a home machine (an old Intel MacBook is the candidate) for the sources that block cloud servers: AP, Le Parisien's local feeds, Times of Israel, the Poughkeepsie Journal, Reddit, and the NY court system's own site. The site keeps working without it.

## Parked (no version yet)
- Morning email digest, once I know what belongs in it.
- Quotes from hearing and council-meeting transcripts.
- Paid AI summaries (would break the $0 rule; free routes are in V5).
- Multi-stream video wall. More city desks.
- **Local color sources:** A Little Beacon Blog, Chronogram, Hudson Valley One, Hudson Valley Magazine, Patch Fishkill, Spectrum News Hudson Valley, Metro-North service alerts, NYSDEC press releases, Secret Tel Aviv, ISRAEL21c. Still to find: Times Union, Riverkeeper, Dia Beacon events, Dutchess County news, Sortir à Paris.
