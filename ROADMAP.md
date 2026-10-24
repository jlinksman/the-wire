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

## Stage 1 — Threads (built 2026-10-19; BRIEF.md second brief)
- `pipeline/threads.py`: persistent threads in the build state with stable ids, matched to each build's clusters by shared reports then headline similarity; developments logged only on material change (a document, a second outlet, +3 outlets, a changed figure, or a fresh batch after 4 quiet hours); primary documents attached; dormant after 14 quiet days. Named topic threads from follows. `functions/follow.js` keeps follows in KV; `build.yml` fetches them before each build; followed threads get first claim on the writing budget and count as briefing signal.
- Next: stage 2, Your Wire (composed Today page, units on every tab).

## Stages 3 and 4 — Depth and learning (built 2026-10-19)
- **Ask a thread.** `functions/ask.js` answers a question about a thread from `evidence.json` only (written by the build to KV: each thread's numbered sources with headline, description, verified quotes and, for the model's eyes only, an opening excerpt of open article text). Every sentence cites [n]; numbers and quotations are checked against the cited sources and names against the thread's sources; an answer that fails isn't shown. 70B model, 8B fallback, 15-minute cache.
- **Areas of law.** `threads.yaml` lists standing threads (Navigation Law and the Oil Spill Fund, PFAS, brownfields, bankruptcy, FinCEN and beneficial ownership, land use in the Second Department). They accrue decisions, rules and notices as developments, never go dormant, and show under "Areas of law" on the Law tab.
- **Document excerpts.** Court opinions and rules (`public_doc: true` sources) show their opening verbatim on the thread page, from the feed's own text (CourtListener's HTML sits behind a bot check; its feeds carry the opinion's first lines).
- **More / less like this.** Stored with the follows (`/follow` action "signal"); the build lifts a thread Joe wants more of (×1.5), sinks one he wants less of (×0.4), and nudges stories that read like either.
- **You might follow.** Up to three unfollowed live threads close to what he follows and likes, local and law first, on Today.
- **Revival.** A dormant thread comes back when a new cluster on its desk clearly matches it (similarity ≥ 0.5) and is labeled "Back after a quiet spell" for two days.
- **Explore and build threads** (2026-10-19, after Joe's first read): "Browse all" lists every live thread by desk and name; "Add to a thread" on any report attaches it to an existing thread or starts a new hand-built one (optionally with watch terms); a thread page has "Add a report" search. Attachments live with the follows (`/follow` attach/detach) and the build logs them as "Added by you".
- **The day so far** is now at most four labeled parts, one story each, tappable into the thread, instead of one paragraph that jumped between topics.
- Standing threads reworked around Optima's lines (PBS and tanks, spills, brownfields and Phase I ESAs, prevailing wage) plus bankruptcy, FinCEN, Second Department land use, and student loans (SAVE's end and repayment reform). PFAS stays a topic watch, not a standing thread.
- **Reorganized by topic** (2026-10-19): tabs are Today · Threads · News · Live · Settings. Threads tab: Following (new first), Standing (grouped business · law · government, `group:` in threads.yaml), Suggested, Browse. News holds the six desk segments. Settings tab: Reading (device) and Admin (follows, topics, signals with remove; standing threads read-only; people; sources and health; version). Today keeps a four-card strip of followed threads.
- **Coverage gaps closed** (2026-10-19): a standing thread "Spills reported to DEC in Optima's counties" fed by the NYSDEC spill incidents dataset (data.ny.gov u44d-k5fk; Dutchess, Orange, Ulster, Putnam; one record per spill, kind Record, kept 30 days); Governor and Attorney General press releases (undated link lists, so they show from the next new release); Supreme Court opinions (CourtListener, public document); Kyiv Independent, SCMP, Al-Monitor, MercoPress as quiet world sources; Bing topic watches for the Comptroller, Dutchess County government, EPA enforcement in New York, and the Coast Guard on the Hudson. Probed and unavailable from the cloud: EPA feeds (robots), news.uscg.mil (403), dec.ny.gov press (robots), osc.ny.gov and dutchessny.gov (no feeds). Still to build: an email inbox source (Cloudflare Email Routing) for the ENB and newsletters; YouTube Data API for live meeting detection.
- Held back: nothing. Learning signals were planned for after two weeks of use; built now at Joe's request.

## Voter guide (built 2026-10-23)
- `elections.yaml` + `pipeline/elections.py`: every election Joe votes in. The active guide (60 days out to a week after) shows as a card on Today and News › Gov and a guide sheet: key dates with sources, every race on a Beacon ballot grouped federal → state → courts → county → Beacon (the job, why it touches him as plain fact, candidates with party lines, positions in their own words or as reported, each linked; ratings, polls; the race's latest news), ballot proposals (Yes/No, arguments and who makes them, ballot text), and "My pick" marks kept on the phone only. Each race becomes a standing thread (group "Your ballot") with Ask; each race's `search` runs as a news source. `recurring` rules (general, June primary, May school vote) keep "what's next" known; a health row flags an election within 45 days with no guide. A scheduled task checks twice a month and writes or refreshes the next guide.
- **Your scorecard** (2026-10-23, merged from a second ballot page built in another chat): a private layer on the same guide. `functions/ballot.js` keeps ballot.json in KV only (never the repo): address-level ward and districts, your district's sample ballot, your own district's legislator, "vote for up to 3", and scores 1–5 on Joe's three priorities (small business 40%, development 35%, antisemitism 25%) with the evidence and links for each score and a "For you" analysis per race. Imported once from Settings › Admin (paste or file). The neutral guide stays neutral; the scores are labeled as a filter on his priorities, not a recommendation.
- Nov 3, 2026 guide written from the Dutchess BOE candidate list, the State BOE office certification, the AG's key dates, Spectrum/NY1, City & State, the Highlands Current and campaign sites. Describes, never recommends.

## Israel election night (built 2026-10-22)
- `pipeline/israel_results.py`, active from 30 minutes before polls close (Oct 27, 20:00 UTC; 4 PM New York) to Nov 20: reads the Central Elections Committee's national results page (votes26.bechirot.gov.il, same layout as 2022's votes25, tested against it) every build for the first day, hourly after; falls back to Wikipedia's results table, labeled crowd-edited. The election box shows a live-count bar (blocs, 61 line), seats/votes/% by list, lists under the threshold, how much is counted, and folds the polls away. Exit polls stay headlines.

## Tell The Wire (built 2026-10-22)
- A box on the Threads tab (and in Settings › Admin): Joe types or dictates what matters; `functions/tell.js` asks the 70B model for proposed changes of seven kinds (follow a topic with watch terms, add a news search, follow an existing thread, more of, less of, hide words, a note for Claude); he ticks and applies. Nothing changes without Apply. Invented thread ids and malformed proposals are dropped.
- **Searches added from the page are the one deliberate exception to "every source lives in sources.yaml"** (approved 2026-10-22): they live in follows.json in KV, show in Admin with a remove button and their own health rows, and their ids are hashes and their errors withheld, so the public build log never shows what he searched for.
- More/less subjects feed ranking and suggestions (threads.taste). Notes for Claude wait in Settings › Admin with "Copy all" for a session.

## Israel section (built 2026-10-21)
- **News › Israel** is its own segment: the election box (key dates from the standing thread; the latest poll from each pollster as a government / opposition / Arab-lists bar with the 61 line; seats by list per pollster), Israel's standing threads, top stories as units, then every report under a heading — Election, Politics and government, Society and daily life, Culture/food/sport, Security, More from Israel, Jewish world. Headings come from `events.itopic_of` (headline words; a source's own `itopic`); stories set abroad drop out unless they're Jewish-world.
- **Polls**: `pipeline/israel_polls.py` reads Wikipedia's poll table through Wikimedia's REST API every 3 hours (honest User-Agent with the repo URL); nothing averaged; range shown; health row "Israel polls".
- **Standing threads** (group israel, beat-limited so US stories can't join): the election and coalition (with key dates), the Haredi draft, cost of living.
- **Sources**: Ynetnews (via Bing), JPost Israel and culture, N12 (Hebrew), Haaretz Israel, Arutz Sheva, Israel Hayom and +972 (via Bing), Globes English economy, topic watches (election polls, Haredi draft, cost of living, Israeli TV), the Forward and JTA as Jewish world. Holy Land Speaks' Substack; Eitan Levine and both YouTube channels wait for the YouTube Data API key (YouTube's robots.txt closes channel feeds).
- **Editorial**: Israel chair widened to daily life and to naming each outlet's politics; a guest election chair (Nahum Barnea) until Dec 15.

## People (built 2026-10-18)
- `people.yaml`: 93 reporters, writers, podcasters and forecasters (Joe's list plus a researched, balanced set), each with feeds, byline names, or a headline search; opinion voices carry a perspective tag. Their work shows in "From people you follow" on Today (rotated across perspectives), a Following category in Brief me, and a Range of views section on story pages. Unreachable for now (V8 home fetcher candidates): *.substack.com writers (Substack blocks cloud servers), Hudson Valley Weather (bot check), UnHerd, The Economist's acast feed.

## Efficiency pass (built 2026-10-17)
- The page asks "anything new?" (ETag) and gets an empty 304 between builds; quiet items outside stories aren't shipped (about a third smaller); same-outlet duplicate headlines fold; stories with a large-model write-up skip the small-model summary; brief.json and alerts.json are written to KV only when changed (or every two hours); world and quiet feeds poll every 30 minutes from midnight to 6 AM; source health shows problems first in plain words, full list grouped by desk.

## V7 — World expansion
- **Built 2026-10-17 (source round 2):** 30 more outlets as quiet, corroborating sources (they count toward grouping, ranking and the briefing but don't add lone rows to the desks); event-level grouping (same foreign place + same kind of event within 30 hours) with volume and a "Developing" flag in ranking; Brief me by category (All, Local, State, National, World, Paris, Israel).
- **Built 2026-10-17 (round 3):** Bing News search feeds (Google News RSS is disallowed by its robots.txt): WSJ, AP, Reuters, Politico (Congress and New York), Times Union, Spectrum News, Poughkeepsie Journal, Times Herald-Record and Times of Israel as quiet sources; topic watches on the Law desk for PFAS in New York, NYS DEC, Indian Point, Hudson River PCBs, NY bankruptcy filings, NYC commercial real estate, FinCEN and beneficial ownership.
- **Built 2026-10-17 (city desks):** French (Le Parisien Paris, Le Monde, franceinfo, 20 Minutes Paris) and Hebrew (Ynet, Walla, Globes) headlines machine-translated with Workers AI m2m100, labeled, original kept; they join English stories and feed the Paris and Israel briefings. Untranslated headlines are held back until translated.
- Still to do: translated descriptions (budget), Haaretz Hebrew (volume), Paris open-data events and roadworks.
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
