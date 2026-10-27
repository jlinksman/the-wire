# GAMES.md — The Wire's Puzzle Page (final plan, 2026-10-27)

Status: **APPROVED** by the writers room, round 2 (puzzle editor, constructor, news editor, the
player, engineer, learning designer: all "approve with edits", edits applied below). Joe
approved building it all on 2026-10-27. History: v1 → room round 1 → v2 → research on every game →
v3 → room round 2 → this.

## What it is

A daily Puzzle Page inside The Wire: a break from reading that pushes Joe's brain and rebuilds
itself from what The Wire is covering. Built around Joe's day (2-minute gaps between job sites,
lunch, 20 minutes at night, the car). Separate from the political Quizzes.

## Ground rules

1. **Four a day, ~10 minutes, any skipped.** Slots 1–2 finish in a 2-minute gap; slots 3–4 are
   built for night. A fixed set of four; on a thin day the slots fill from logic/chess, never
   fewer than four. The home card says "4 today". No streaks, no leaderboards; Joe is compared only with his own median
   ("faster than your usual"), and a quiet "played 4 of the last 7".
2. **Correct by construction.** Generated from structured data or public records; no AI-written
   clues, questions or law. Every puzzle is checked by a solver (exactly one solution, solvable
   by deduction, no guessing), hashed and never reused within 90 days. Failures are dropped and
   logged on the Games health rows (hash log in the Actions cache: hashes only, never results).
   Every generator has a CI fixture test with known-bad boards that must be rejected.
3. **The reveal is the prize.** Reveal card: what it was, one line of why, **the fact to keep**,
   outlet + timestamp, primary document (roll call, opinion, agenda, statute) when there is one,
   "back in 3 days" if it's a review item, and **Open the thread** / Follow it. Corrections void
   the puzzle and its review item; the card says what changed.
4. **Generation over recognition.** Typing beats picking; matching is first exposure only. Typed
   answers: filler words ignored, surname-only accepted, alias table (nicknames, other names),
   accents folded, no autocomplete, autocorrect off, the input stays above the keyboard.
5. **Difficulty from reasoning, not obscurity.** The build generates candidates from all stories;
   a Pages Function narrows them to threads Joe follows and stories he opened (what he opened stays
   in KV; the build never sees it). No staffer trivia, no filler names. Each game has a difficulty
   ladder (up after three clean solves, down after a miss: settles near 80%) and a monthly ramp (week 1 easiest, week 4 hardest). Chess
   uses Lichess ratings.
6. **Learning engine, invisible.** Every answer becomes an item (a senator's state, an element of a
   claim, a quote's speaker): id, fact, source story/thread, type, prior, interval, due, and a
   history (answer, certainty, hint, latency, date). Intervals: first 1 day (obscure items
   re-asked later the same session); hit when sure ×2.5, hit when thinking ×1.5, hit on a guess or
   with a hint unchanged; miss → 1 day; cap 120 days; retired after two sure hits at ≥60 days.
   Due items appear as callbacks inside the day's games through one interface, **capped at 3 a
   day** (legal included); overdue items spread over the following days, and lateness never
   counts against the interval. Some items resolve later (pending docket, what happens next).
   **Sure / think / guess** only on single-answer recall (news slot, legal refreshers, the Friday
   wager), with certainty-based marking (+3/−6, +2/−2, +1/0); confident misses return tomorrow; a
   quiet weekly line "when sure, right 91%". Hints shrink the cue and cost points.
7. **Editorial guardrails** (hard exclusion list in the generator). Never a puzzle: death,
   casualty or injury counts; victims, hostages, the bereaved; disasters while ongoing;
   suicides; fires, deadly outbreaks, riots and unrest while they're news; private individuals
   (blotter, minors, defendants who aren't officials, agenda applicants who are people);
   anyone speaking of their own loss; Joe's own business or litigation. War / attack / disaster
   threads (flag in editorial.yaml) get games only on their institutional side; a story with no
   thread is judged on its own title and summary. Who said it: quotes for substance; hints never
   give party (party comes only from the congress roster, else none); one quote per speaker a
   week; no context line that names the speaker; no quote in more than two games; no side over
   60% of a week's speakers (counted in KV only). Defectors alternate between the parties across each month (share checked in KV).
   Fictional fact patterns never resemble an Optima job. Geography never draws from tragedy stories; disputed borders follow Natural
   Earth's de facto view, said on the reveal. Games performance never feeds relevance.
8. **Privacy.** Results only in KV (`games.json`, in privacy_check). The build never receives
   results; review selection happens in a Pages Function or the page. Defectors, Who said it and
   Docket predictions count as political engagement under rule 10: KV only, no counts in logs.
   Two-player sharing outside Access needs Joe's approval first; Kelly's answers are kept only
   for the session, nothing about her in KV.
9. **Mobile feel.** Terminal style, high contrast, tap-to-place (no dragging), two-step tap
   (highlight, confirm) for small targets, taps during a pinch ignored, a mark/pencil toggle where
   desktop would right-click, undo, partial progress saved, clocks start on the first keystroke
   and pause.
10. **$0.** Only new AI use: TTS for the audio quiz (~60 neurons/day, in the same daily ledger as
    Listen and capped with it). KV: ~35 more writes a day (~170 of 1,000 in all). One free API key Joe
    registers (NY Senate Open Legislation) for the legal refreshers.

## The day and the week

Four slots, every day:

| Slot | Mon | Tue | Wed | Thu | Fri | Sat | Sun |
|---|---|---|---|---|---|---|---|
| 1 Grid | Connections | Connections | Connections | Connections | Connections | Connections | Connections |
| 2 News | Who said it | Defectors | The Docket | The Ledger | Friday quiz | Timeline | Beacon Agenda |
| 3 Cipher / law | Cryptoquote | Legal refresher | Cryptoquote | Legal refresher | Cryptoquote (keyed) | Saturday meta | Patristocrat |
| 4 Brain break | Joe's pick (defaults to last pick, one tap to change): Tatham logic · chess · tactics; on Sunday the case-file logic grid takes this slot |

Legal refreshers also ride as 1–2 callback items on other days when due. The audio quiz is in the
Listen queue every day.

## The games

### 1. Connections — the Wire grid (daily)
- Sixteen items from the week, **mixed types** (people, places, bills, agencies, figures, terms).
  One group per difficulty color. Category names are facts ("Voted no on cloture, H.R. 1234")
  and double as the reveal. No board word inside a category name.
- Generator: enumerate every predicate ≥4 of the 16 satisfy, including every purple wordplay
  test run against all 16; predicates only from complete sources (a full roll call, a full
  roster), never a category the data can't fully decide; require exactly one partition into
  four groups; plant a decoy that looks real (≥2 items fitting a 3–5-member false category), each
  decoy item with exactly one true home.
- Purple = **one clean trick**, stated exactly: hidden words, surnames that are nouns, state
  abbreviations, procedural posture (VACATED, REMANDED…), words that are both accounting and plain
  English (ACCRUAL, BASIS, LEDGER).
- Play: 4 mistakes, "one away", repeat guesses free, shuffle, deselect. Private skill note for
  solving purple/blue first. **Your herring** card: the decoy that caught Joe and why.
- No item in more than two grids a week; a thin pool drops the grid for a logic/chess filler.
- **Ships in shadow mode**: generated daily and logged for 14 days (Joe can preview in Admin);
  turns on after 10 of 14 days without a drop.

### 2. News slot
- **Who said it (Mon).** The quote with its surrounding sentence shown up front (fair cold).
  Three tries; hints role → where (level or country) → initials. Local, state and followed
  speakers first. Win at 2-of-3 on a three-quote day. Joe's own hit rate,
  never an invented crowd. Library variant: **Lightning** (60 s fill-the-blank on quotes).
- **Defectors (Tue).** Crossover roll calls only (passage, cloture, amendments), defections
  alternating between the parties across the month, with a mandatory
  plain-words "Yea meant…". Easy tier: a Yea/Nay grid (NY delegation always in); hard tier: name
  who broke ranks. **Count the whip** first (guess the margin). Scored per vote. Reveal: tally by
  party, roll-call link, CRS summary. Senate LIS + House Clerk XML, cached forever.
- **The Docket (Wed).** A decided case (SCOTUS, 2nd Circuit panel, NY Court of Appeals). Score per
  judge (10 points each), author as bonus; dismissed/vacated-only cases dropped. Shows Joe's score
  against each court's own reversal baseline, computed from its decided cases and cited (SCOTUS
  reverses ~70%; the 2nd Circuit and Court of Appeals affirm far more). Reveal quotes the holding
  verbatim. **Pending docket**: the Docket card offers one optional prediction per newly argued
  case, locked on opinion days and scored automatically when decided (no standing list).
- **The Ledger (Thu).** Estimation on sourced figures. Joe gives a range; Estimathon scoring
  (ceil(high/low) − 1 if it contains the answer, otherwise doubled); 90%-range calibration line.
  Each figure carries outlet, time and document; figures outlets disagree on are excluded; no
  contested-issue figure framed as "people get this wrong"; picks spread across subjects. Ranges
  never pre-rounded. Also "which is bigger" pairs that differ by at least 2× (Beacon budget vs a
  county line item) and per-capita conversions; never a part against its whole (a ward against
  the city, a winner against the race's total). Puzzle ids are the figure itself.
- **Friday quiz.** Ten templated questions from the week's data, each linked to a thread; Beacon
  capped at ~2; at most two "who said it"; three or four typed answers; the law odd-one-out a near
  miss from a card of the same area and family; two hardest from followed threads; a final
  **wager** (sure/think/guess). ("Spot the
  altered detail" was cut: The Wire never writes something false in its own voice.)
- **Timeline (Sat).** One card at a time, tap the gap, three lives, every card links out. Dates
  are event dates from primary documents. Difficulty from close dates within one thread. Includes
  **Since you last looked** (a followed thread's new developments) and **Procedure order** (order
  the steps of a bill or case).
- **Beacon Agenda (Sun).** What council/planning/ZBA did with item X, and **What happens next?**:
  Joe predicts the next required step for an application; it resolves when the next agenda posts.
  Never a private person (person-applicants, appointments, private homes); one entry per
  application; meetings from the last three weeks; board-giveaway words taken out of the question;
  the reveal carries the agenda's status line.

### 3. Ciphers
- **Cryptoquote.** Verified quotes ranked by distinctiveness, 60+ letters. ACA conventions: no
  letter maps to itself, a header (type, length), asterisks on capitalized words. Difficulty
  graded by features and a quadgram solver (short words, apostrophes, doubled letters,
  few letters used only once, pattern words); quotes are chosen, never edited. Hint ladder: a
  letter → a crib (a plaintext word and its position) → the speaker. Phone: cursor auto-advances, one entry
  fills every instance, reassigning moves the letter, used-letter strip, counts on long-press,
  optional error check (costs points).
- **Keyed Aristocrat (Fri).** K1 keying (the plaintext alphabet is keyed): the worksheet shows
  ciphertext A–Z with the recovered plaintext beneath, and the keyword emerges as Joe fills that
  row; keyword has no repeated letters and leaves no self-maps. It feeds the meta. The keyword echoes Thursday's purple category.
- **Patristocrat (Sun).** ~80 letters in five-letter groups, crib from the week's top headline.
- **Saturday meta.** Answer chosen first: a real, thematic word; instruction is the answer category
  only ("a Hudson Valley town"). 7–9 feeders (no two alike, from at least three games) from the week's answers (keyed Aristocrat keyword,
  Connections purple, Docket split, Defectors margin…), visible from Monday on the Puzzle Page as
  a shell that fills in (never on the home card); solvable at ~75% of feeders; skipped feeders
  unlock Saturday. Sunday night the build picks the answer and a feeder plan; each daily
  generator produces its feeder or a pre-chosen backup. Before publishing, the build masks every
  25% subset of feeders and confirms exactly one word in the category list still fits. Extraction mirrors how the
  feeders worked, every element used, order meaningful. Normalized checking, "keep going" on
  partials, staged hints. No plain acrostics.

### 4. Legal refreshers (added by Joe)
- One element per card, each with its own schedule; 3 cards a session, ~3 minutes, never opens on
  a type-in, ends on a reveal; partial credit per element.
- Formats (launch with type the elements and statute cloze only): **type the elements** (graded per element against keyword sets), **spot the missing
  element** (short fictional facts, one tap), **statute cloze** (from official text), **rule ↔ test
  / case**, **number drills** (limitations periods, deadlines), weekly **issue spotting**.
- Syllabus, in order (build past environmental and torts only after a month of use): NY spill and environmental (Navigation Law §§172, 181; CERCLA §107 PRPs and
  defenses, §113; RCRA; CWA §§301, 311) → torts (negligence, nuisance, trespass, abnormally
  dangerous, defamation, CPLR 1411) → NY limitations and practice (CPLR 213, 214, 214-c, 3211,
  3212; GOL 5-701, 5-1401) → contracts/UCC 2 → civil procedure → evidence → constitutional tests →
  corporations (veil piercing) → bankruptcy.
- Correct by construction: elements stated in our own words from statute text and controlling
  cases, cited, labeled NY / federal / majority rule, second-checked, "verified as of" dated.
  Statute text from NY Open Legislation (its weekly updates mark a card "may be stale"), US Code,
  uscourts.gov rules, CourtListener / nycourts opinions. No PJI, Restatement or bar-prep text.
  Overruled law gets a "superseded" flag (Chevron → Loper Bright). Refreshers, never advice.
- News tie-in: cards tagged with The Wire's law areas; a matching story features its card ("From
  today: …"); an opinion features the test it applied.

### 5. Brain breaks (Joe's daily pick)
- **Tatham logic** (MIT, official web build, one puzzle loaded per day, ~250–680 KB): Loopy, Keen,
  Towers, Galaxies, Signpost, Dominosa, Unequal, Slant, Range, Pattern, each at its top tier that
  needs no guessing (Loopy Hard; Keen, Towers Hard/Extreme; Unequal Tricky/Extreme; Dominosa
  Hard/Extreme; Slant Hard; Galaxies Normal; Pattern, Range, Signpost scale by size); never
  Unreasonable, Recursive or Ambiguous. The puzzle is fixed by a game ID seeded from the date. Patched
  to report "solved"; dark palette via the canvas background and colour variables; a **mark**
  toggle for the right-click marks iPhone can't do.
- **Chess** (Lichess CC0): monthly workflow keeps ~3,000 puzzles (popularity ≥80, ≥1,000 plays,
  low deviation, stratified by rating and theme). The opponent's first move animates, then Joe
  solves; only-move lines, any mate-in-1 accepted. Themes rotate.
  chess.js (BSD) with the Cburnett piece set from Wikimedia Commons (CC BY-SA 3.0, via cm-chessboard); drag or tap-tap moves.
- **Tactics** (Into the Breach-style, one turn): 6×6 board, 2–3 units, telegraphed enemy attacks,
  hazards, pushes. Generator brute-forces every action order and keeps boards with 1–3 winning
  lines (after merging move orders that reach the same outcome) where the greedy line loses.
  Moves shown in coordinates beside the other winning lines. Built late (it's its own project).
- **Case-file logic grid (Sun)**: fictional entities; minimal clue set with one solution; clues
  must tie people to projects and projects to times (at most two before/after clues); graded by a
  human-style solver's highest technique tier (1 direct facts, elimination and cross-grid; 2
  either/or, "of these two" and order clues read against what's open; 3 a short contradiction
  chain), never anything that needs a guess; target tier follows the monthly ramp; hints come
  from that solver's trace with a reason.

### Library (anytime)
- **Name them all**, local first (Beacon council, Dutchess Legislature, Joe's state legislators,
  NY statewide), then NY delegation, SCOTUS, Cabinet, governors, senators, world leaders, forms of
  government, capitals. Sporcle conventions: give-up shows misses in another color (they become
  review items), hidden third column until answered, ordered grids for chronology and seniority,
  **minefield** variants (a wrong answer ends it; mirror lists alternate days). Featured list
  follows the news; **Who left the list** after a turnover.
- **Match**: first exposure for any list.
- **Maps**: tap the place and type the highlighted place; zoom-to-region; minefield variant.
  States, countries, NY congressional and state senate districts, Dutchess towns. Beacon wards
  wait for a shape source (see Open items).
- **Geography**: outline guess and border-to-border hot/cold, fixed rotation or neutral stories.
- **Rosters**: NYCFC 2021 MLS Cup team, current NYCFC squad, Israel national team, 1994 Rangers,
  1986 Mets, US World Cup squads; hand-checked; featured when the team is in the news.
- **Thread cast**: people to roles in one followed thread; a revived thread opens "previously on".

### Off the page
- **Audio Wire Quiz** in the Listen queue: listen-only (no voice or taps while driving), one-sentence
  questions read twice, ~5 s pause, answer in a full sentence plus why, numbers rounded; formats:
  three quotes, lightning, "name five".
- **Pass the phone** (with Kelly): handoff screen hides answers, separate rows, shared reveal; co-op
  (one score) and asymmetric (one reads, one answers) modes for Connections and the Friday quiz.
- **UFCB trivia pack**: ten questions off news topics entirely (sports, geography, general) as
  text to paste into the captains chat.

## Data sources
- congress-legislators (CC0, JSON with ETag; bioguide IDs; check term end dates).
- Senate LIS and House Clerk roll-call XML (immutable; cache forever).
- Wikidata for world leaders and forms of government: base layer only. A hand-checked override
  file and a diff alert; **never auto-published** (today's query lists the wrong UK head of
  government, has stale duplicates and gaps).
- Natural Earth / world-atlas / us-atlas and Census 2024 cartographic boundaries (public domain),
  simplified to SVG paths at deploy time, not in git.
- Lichess puzzle database (CC0), sampled monthly into KV.
- NY Open Legislation API (free key), US Code, uscourts.gov rules, CourtListener, nycourts reporter.
- The Wire's own data: verified quotes, thread developments with dates, stories, local agendas.

## Architecture
- A separate daily `games.yml` workflow (~4 AM ET, date-seeded so reruns match, 20-minute
  timeout; not inside build.yml) writes a candidate pool to KV `games-today.json`;
  `functions/games.js` assembles the four slots and due callbacks from it. Also
  `games-lib.json` (weekly, written only on change), `chess.json` (monthly), `legal.json` (from
  the cards file plus statute-change flags). None republished on the 2-hour rule.
- `functions/games.js` serves them and records results (one write per finished puzzle, capped
  30/day; buffered on the page, sent on reveal). 90 days raw, then aggregates.
- `site/games.js` lazy-loaded; `site/vendor/` for Tatham (patched, built at deploy), chess.js,
  cm-chessboard; licence files kept. Offline play for today's set via the service worker.
- Games health rows on the page: each generator ran, made, dropped and why.
- Legal cards: `legal.yaml` in git (our wording + citations only, no bulk statute text).

## Build order (merged from the room)
1. **Engine**: games.yml workflow, pool → assemble split in functions/games.js, item records and
   scheduling, callback interface with the daily cap, certainty tap, typed-answer normalizer
   and alias table, tap-to-place, two-step tap, partial-progress save, correction voiding by
   story id, reveal cards, Games health rows, CI fixture tests, privacy_check entry, 30/day write
   cap, Puzzle Page and home card. **Games live**: Who said it, Cryptoquote, chess and Tatham (the
   fillers). **Connections in shadow mode** from day one.
2. **Defectors** and **legal refreshers** (environmental and torts; type the elements, statute
   cloze; Joe's Open Legislation key).
3. **Audio Wire Quiz** in the Listen queue.
4. **News slot**: the Docket (+ pending docket), the Ledger, Timeline, Friday quiz, Beacon Agenda.
   Connections turns on when its shadow run passes.
5. **Library**: Name them all, Match, rosters (local lists first), Who left the list.
6. **Maps and geography.**
7. **Weekend**: keyed Aristocrat, Patristocrat, Saturday meta, case-file grid.
8. **Later**: tactics; pass the phone and the UFCB pack after a month of use; variants (Lightning,
   minefield, Refute the move, Proof mode, Ledger logic, Escalation week, zero-hint gauntlet)
   only when Joe asks.

## Build status (2026-10-27)
Steps 1–7 are built, tested and deployed; step 8's tactics is built. What differs from the plan:
- **Connections** runs in shadow mode and turns itself on after 10 of 14 days produce a clean board
  (the log is in the Actions cache; Admin shows the record).
- **Saturday meta v1** is assembled on Saturday from the week's items rather than seeded from Monday.
- **Defectors** use House roll calls only: the Senate's site refuses automated requests (HTTP 403),
  so the build backs off and never works around it.
- **Pending docket** (2026-10-27): argued cases come from Oyez (one request a day); judgments come
  from each decided case's syllabus on supremecourt.gov, read by an hourly workflow at one PDF per
  run (Oyez's decision field is often empty). Calls lock when made; split judgments don't count.
- **Statute-change flags** (pipeline/openleg.py) are built; they switch on when the OPENLEG_KEY
  secret is set. A card is held if a watched section changes after its `verified` date or its quote
  stops matching.
- **Beacon wards and County Legislature districts** come from Dutchess County GIS (the Board of
  Elections' wards; the county's legislative districts), rebuilt monthly at deploy.
- **Library rosters**: five hand-checked team lists (rosters.yaml). The current NYCFC roster is held
  as unverified until it's checked against the club's page.
- **Tactics** (pipeline/tactics.py): 6×6, two units, three enemies; boards with one to three winning
  outcomes where the greedy line loses; tiered by how many outcomes win. The page engine is
  cross-checked against the generator in CI.
- **Generator fixes (2026-10-27, after the design review)**: guardrails widened (fires, outbreaks,
  riots, unrest; no-thread items held to the institutional-only rule); Who said it varied (one quote
  per speaker a week, local first, roster party only, hints role → where → initials, no leaking
  context, no quote in more than two games); Beacon Agenda never names a private person, dedupes
  applications and drops stale meetings; the case file rebuilt with cross clues and a human-style
  grader (60 Sundays' worth: tiers 1/2/3 = 14/28/18, where it was 0/5/55 with order clues only);
  Ledger figures widened and part-vs-whole pairs refused; Friday quiz ten questions with typed
  answers; legal tie-ins match the card's own statute (`news_not`); Connections draws people,
  countries, places and agencies with no committee trivia and a near-miss decoy; the pending docket
  drops last term's cases and emergency applications; only what is published for a game served
  that day is burned, so thin days carry over; health rows for every weekend game and a loud row
  when the word list is missing.
- Not built (by plan): pass the phone and the UFCB pack (after a month of use), variants (on request).

## Open items for Joe
- Register a free NY Open Legislation API key (walkthrough when we reach step 3).
- Any public, news-free share for two-player play outside Access (like Ballot Match).

## Parked
- Wire Brackets (AI-written clues). Exotic ciphers (Vigenère, Playfair) except as a library
  curiosity with a worksheet. Pretest hook before stories.

## Sources (research, 2026-10-27)
Puzzles and games: Nieman Lab on The Atlantic's games; journalism.co.uk on WaPo's On the Record and
Keyword; Political Wire's Yea or Nay and Whip Count; Adrian Hon on Puzzmo; Sixcolors interview with
Zach Gage; Bracket City coverage and Show HN; Wikitrivia (Wikipedia, Inverse); NYT Connections
coverage (AOL, Vineyard Gazette, Engadget on Connections Bot); ACA cipher samples
(cryptogram.org); NPL constructing guide (puzzlers.org); Dan Wilson on puzzle writing (MIT);
Puzzlvaria on metas; fortenforge's puzzlehunt guide; WSJ meta coverage (Crossword Fiend);
FantasySCOTUS rules (Blackman); Katz–Bommarito–Blackman (arXiv 1612.03473); Estimathon rules;
Clearer Thinking calibration; Gapminder Upgrader; Wait Wait…; iCivics; Sporcle FAQ; JetPunk and
Seterra mobile complaints; Duolingo half-life regression (ACL P16-1174); certainty-based marking
(Moodle); AAA/Strayer distraction research; Nikoli (Atlas Obscura); Simon Tatham's Puzzles
(source tarball, MIT); Lichess database (CC0); chess.js (BSD-2); cm-chessboard (MIT);
logic-grid generation and grading (arXiv 1910.06636); Into the Breach (Wikipedia, Vice); Hoplite.
Data: congress-legislators (CC0); Wikidata SPARQL (queried live); Natural Earth; us-atlas;
Census cartographic boundaries; Dutchess GIS; NY Senate Open Legislation docs; CourtListener;
Caselaw Access Project (LawNext); uscourts.gov; Georgia v. Public.Resource.Org (SCOTUSblog).
