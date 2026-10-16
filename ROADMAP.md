# ROADMAP.md — After V1 (do not build until I say so)

Everything here was researched and scoped, then held back so V1 could start simple. I'll pick the next version after using V1 for a few weeks. The order below is a default, not a commitment. Source details for every item are already in `sources.yaml` with `enabled: false`.

## V2 — Beacon depth (in progress, started 2026-10-16)
- [x] Daily police blotter PDFs parsed into rows. Each city upload batch is one feed item with call counts and the posting lag; officer names are left out. Never used for alerts.
- [x] City documents labeled by type (Resolution, Local law, Public hearing, Bid/RFP, Agenda, Minutes, Budget, Schedule, Notice).
- [x] Meetings on the TODAY line link to their agenda, with a ▶ WATCH button from 30 minutes before until 4 hours after the start.
- [x] Beacon row in the live player: City meetings channel and the school board's channel.
- [ ] Agenda item lists and running items (follow an application across meetings). Waiting on Joe's call: Granicus's robots.txt disallows the linked agenda pages.
- [ ] School board agendas: BoardDocs blocks cloud servers. Moved to the V8 home fetcher.
- Note: YouTube's robots.txt disallows its RSS feeds (/feeds/videos.xml), so meeting recordings come through the live player and links, not feeds.

## V3 — Government and law depth
- **Federal:** Congress.gov bills and committee meetings, House and Senate floor schedules, a "Today in government" view, and Federal Register items filtered by agency (EPA, FinCEN, Treasury, DOJ). Free api.data.gov key.
- **Albany:** follow NY bills by number through the NY Senate Open Legislation API (free key). City & State and New York Focus already cover Albany as news in V1.
- **Dutchess County Legislature:** meeting dates, agendas, and minutes.
- **Courts:** Appellate Division decisions filtered by watchlist terms and by the Second Department (which covers Dutchess); Southern District of New York and its bankruptcy court; court system notices on attorney registration, CLE, and the Rules of Professional Conduct; the weekly NYS Register for proposed state rules (NYSDEC especially); NYSDEC's proposed and adopted regulations page; JD Supra bankruptcy, real estate, and finance feeds; Volokh Conspiracy.
- **Docket following:** follow specific federal cases by docket number through CourtListener. State cases on NYSCEF have no public API, so those stay manual.

## V4 — Video Desk and Watch Now
- Live and upcoming detection across government and news YouTube channels (free YouTube Data API key), a Watch Now rail with LIVE and STARTING IN badges, schedule merging (hearings, floor sessions, Supreme Court arguments, Beacon meetings), a docked player that keeps playing while I scroll, and video attached to related items.
- Link out where embedding is blocked (C-SPAN's own networks, Pentagon webcasts, UN Web TV pages).

## V5 — Quotes and story grouping
- Group the same story across outlets into one card with several sources.
- Rule-based extraction of verbatim, attributed quotes from open text. **Quote integrity rule:** a quote shown in quote styling must be string-matched against the stored source text before display; never show a generated or paraphrased quote as a quote.
- Ranking by desk weight (see BRIEF.md), recency, number of sources, and my "more like this / less like this" feedback, after a two-week calibration.

## V6 — Push alerts
- Through ntfy.sh (free). Beacon: National Weather Service warnings and official city or police posts matching approved keywords. Geopolitical: the same event from at least three independent outlets within 30 minutes, or a confirmed alert source. At most 5 a day, deduplicated.
- A Cloudflare Worker on a 1–5 minute cron for the fast checks, which also triggers the GitHub build on time instead of relying on GitHub's scheduler.

## V7 — World expansion
- **City desks:** Paris and Tel Aviv, with original-language headlines and labeled machine translation.
- **OSINT desk:** military flight activity compared against a regional baseline, as a signal only.
- GDELT for multilingual city monitoring.

## V8 — Home fetcher
- An optional fetcher on a home machine (an old Intel MacBook is the candidate) for the sources that block cloud servers: AP, BBC, NPR, the Guardian, Le Monde, Le Parisien, Times of Israel, the Poughkeepsie Journal, Reddit, and the NY court system's own site. The site keeps working without it.

## Parked (no version yet)
- Morning email digest, once I know what belongs in it.
- Quotes from hearing and council-meeting transcripts.
- Paid AI summaries (would break the $0 rule).
- Multi-stream video wall. More city desks.
- **Local color sources:** A Little Beacon Blog, Chronogram, Hudson Valley One, Hudson Valley Magazine, Patch Fishkill, Spectrum News Hudson Valley, Metro-North service alerts, NYSDEC press releases, Secret Tel Aviv, ISRAEL21c. Still to find: Times Union, Riverkeeper, Dia Beacon events, Dutchess County news, Sortir à Paris.
