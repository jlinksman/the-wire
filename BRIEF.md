# BRIEF.md — What The Wire is

Second brief, adopted 2026-10-18 after two days of use. The first brief (below, under "Origin") described a feed; this one describes the product the feed turned out to be reaching for. Every session starts here.

## One sentence
The Wire is a newsroom with one reader. It reads everything so Joe reads less, and what it hands him is already read, weighed, written and sourced.

## The problem it solves
The world's reporting arrives as thousands of headlines a day, each outlet retelling the same event. Choosing among them is work, and the work is why Joe doesn't feel current. The Wire does that work: it decides what matters to a Beacon homeowner, New York attorney and remediation-company owner, tells him what happened and what changed, lets him go as deep as he wants, and puts the original source one tap away. The measure of success is a reader who feels current after five minutes and could defend any claim he read by pointing to its source.

## The unit is the thread, not the headline
A thread is anything worth following over time:
- an **event** (protests in France),
- a **process** (an application moving through Beacon's boards, a bill, a case),
- a **subject** (PFAS regulation in New York),
- an **entity** (Indian Point, the Rangers' goaltending),
- an **area of law** (Navigation Law decisions).

A thread keeps its identity for as long as it is alive. It holds a current "where it stands," a dated log of developments, the figures as each outlet reported them, verbatim quotes from the people involved, the primary documents, the range of views from followed voices, and every report that fed it. Headlines are raw material for threads; they are never the thing Joe reads.

## Depth is a dial, not a requirement
Four levels, each complete in itself:
1. **The brief:** what matters and what changed, spoken or read, about 90 seconds.
2. **The unit:** one story told in a paragraph with a quote or two, readable in place, no tap needed.
3. **The thread:** the whole arc: developments, evidence, views, documents.
4. **The sources:** the agenda, the opinion, the rule, the article.

Nothing at any level is a teaser for the next. The page is a reading surface, not a menu.

## Evidence over assertion
- Quotes are verbatim and checked against the text they came from.
- Numbers carry their outlet and time. Where outlets disagree, the disagreement is shown, not smoothed.
- The document beats the press release. When a council agenda, court opinion, bill or Federal Register rule exists, The Wire quotes the document and links it.
- Every sentence the machine writes must trace to a cited source or it is cut, and what was cut is counted, never hidden.

## Say what changed
The reader has been here before. Every surface answers "since you last looked": a thread's new developments, a unit's latest, the brief's opening. Nothing that hasn't moved pretends to be new.

## Relevance is explicit
Beacon and Dutchess first; Albany, Washington and the courts next; law in Joe's fields; then the world; then his teams. A story's place on the page comes with a one-line reason ("three Beacon boards touch this parcel"; "17 outlets in six hours"). Relevance is edited by Joe through follows, watch terms, people, and "more like this / less like this." By default The Wire decides what matters and Joe corrects it; he does not configure it up front.

## Range, not a side
Reporting and opinion never blend. Opinion is attributed by name and labeled by perspective, and a story's views are drawn from across the spectrum. The Wire has no opinions of its own; the only interpretation it offers is labeled "analysis" and kept apart from the reporting.

## Calm by design
The page is finite: an edition Joe can finish, with a "that's The Wire" state. No infinite scroll, no engagement tricks, no pushes beyond real alerts. Dark, dense, readable; iPhone first.

## Honest about itself
Broken sources, blocked sites, skipped quotes and model failures are visible on the page. Paywalled and no-AI sources are headlines and links only, by rule. Nothing scrapes around a block.

## Constraints
Private. $0 running cost. No machine of Joe's running 24/7. Config, not code, for sources (`sources.yaml`), people (`people.yaml`) and the editorial room (`editorial.yaml`).

## The next iteration, in four stages
1. **Threads.** Persistent, typed threads with stable identity across builds; a development logged only on material change; follows and named topic threads stored on Cloudflare so they work across devices and reach the build; followed threads get first claim on the writing budget; primary documents attach to threads as the evidence layer.
2. **Your Wire.** Today becomes a page to read: the day so far, your threads with what's new, top stories as complete units (local first) with a Follow button, ahead, then everything else collapsed. Every tab adopts units over lists. The brief and the editions draw from threads.
3. **Depth.** Ask a thread a question and get an answer written only from its sources, with citations. Area-of-law threads track decisions and rules as they accrue. Document excerpts appear inline, verbatim.
4. **Learning.** More/less like this; suggested threads; dormancy and revival. Held until two weeks of use.

---

## Origin (the first brief, 2026-10-05)

### The problem
I'm a New York attorney and a business owner in Beacon, NY, and I don't feel current. I have a digital WSJ subscription I don't open, no cable, and I get news from social feeds and podcasts. I want one place that shows me what's happening now: in my city, in government, in the law, and in the world.

### Desks
Every item gets one desk tag.
- **BEACON:** city government and meetings, local news, weather alerts.
- **GOV:** courts, Congress, and Albany as news.
- **LAW:** legal developments, for me as a New York attorney. See below.
- **WORLD:** national and international news.
- **SPORTS:** Rangers, NYCFC, Tottenham, USMNT, USWNT, Gotham FC, with a scoreboard.

### The LAW desk: what counts as signal
I'm admitted in New York and not currently practicing. My background is AML compliance, commercial real estate finance, and bankruptcy, and I run an environmental remediation and spill response company. Signal, in this order:
1. **New York baseline:** Court of Appeals decisions; NYSBA's CasePrepPlus (weekly appellate summaries), State Law Digest, and ethics opinions.
2. **My business:** environmental and spill law. NYSDEC's weekly Environmental Notice Bulletin, environmental law alerts, and anything on Navigation Law Article 12 and the Oil Spill Fund, petroleum bulk storage (6 NYCRR Part 613), brownfields and remediation, CERCLA and RCRA, and contractual indemnity for contractors.
3. **My background:** bankruptcy, AML and beneficial ownership (FinCEN), commercial real estate, and land use and zoning.
4. **Federal appellate:** the Supreme Court and the Second Circuit, plus a little legal commentary (How Appealing).

**Watchlist highlighting:** any item whose headline or description matches a term in the `watchlist` section of `sources.yaml` stands out. Nothing is filtered out. I tune the list myself.

### Preferences from the first interview
- **Interest order:** Beacon council, planning, and zoning first; then Beacon development, schools, and business; Supreme Court emergency orders; Congress and Albany; Beacon events; police blotter; geopolitics last.
- **Story form, in order:** quotes from the people involved, video, the primary document, then a short summary.
- **Push alerts** only for Beacon emergencies and major military or geopolitical events. No email digest until I ask.
