# QUIZZES.md — how The Wire builds questionnaires (standard v1, 2026-10-25)

The questionnaires (the election check, the Israel match, Where you stand, the starting
questionnaire, the pulse, the meme map, Ballot Match) follow one standard so they can be extended
to other people and other electorates without reinventing them. The standard follows professional
voting-advice tools (Wahl-O-Mat, StemWijzer, Kieskompas, Vote Compass, smartvote, EU&I) and the
research on them; sources are listed at the end.

## 1. Kinds of instrument

| Kind | Purpose | Examples here | Scored against |
|---|---|---|---|
| `match` | Which candidates or lists you agree with | Election check, Israel match, Ballot Match | Coded positions of actors |
| `scale` | Where you sit on value dimensions | Where you stand | Nothing: placement only |
| `interest` | What you want to follow | Starting questionnaire, pulse | Feeds ranking, not a score |
| `play` | For fun, labeled as such | Meme map | A toy map, never presented as measurement |

A `match` instrument is the serious one; the rules below apply to it in full. `scale` follows
sections 3–5 and 8. `interest` and `play` follow 3, 8 and 9.

## 2. One file per instrument

Each instrument is a YAML file (or a block in `elections.yaml` for a ballot) with:

```yaml
id: il_2026                 # stable; answers are stored under it
kind: match
title: Israel match
electorate: Israel, Knesset  # who it's for
election: 2026-10-27         # or null for standing instruments
audience: private            # private | shareable (Ballot Match rules apply)
version: 2026-10-25.1        # bump on any wording or coding change; shown on results
scale: agree5                # agree5 = Strongly agree … Strongly disagree, plus Skip
weights: [1, 2, 3]           # "matters a little / matters / matters a lot"
dimensions:                  # fitted to this electorate (rule 17)
  - {id: security, label: Security and diplomacy, left: Dovish, right: Hawkish}
items:
  - {id: il01, dim: security, dir: -1, text: "...", topic: palestinian_state, added: 2026-10-24}
actors:                      # candidates or lists
  - {id: likud, name: Likud, bloc: gov, ...}
positions:                   # actor -> item -> coded position
  likud:
    il01: {v: -2, source: URL, coder: A, verified: B, note: "..."}
method: {distance: cityblock, min_shared: 3, ties: shown_as_tied}
```

Explainers live in `explain.yaml` under the item id; learning resources in `learn.yaml` under the
item's `topic` (section 9).

## 3. Writing statements (items)

1. Draft long, keep short: draft about three times as many statements as you'll use and keep the
   ones that separate the actors and cover the issues of this election. Record why each stayed.
2. One concrete, forward-looking proposition per statement. No "and" joining two policies, no
   conditions ("even if", "until", "unless") unless the trade-off *is* the issue, no numbers
   unless the number is the issue, no negations ("not", "never").
3. Neutral wording: the same words a supporter and an opponent would both accept as a fair
   description of the proposal.
4. Balance direction: within each dimension, about half the statements are worded so agreeing is
   the left/progressive/dovish side, half the reverse (counters the tendency to agree).
5. Balance coverage: set a target number of statements per dimension before writing; more items on
   one dimension favors the actors at its ends.
6. Drop near-consensus statements (every actor answers the same way): they inflate everyone's match.
7. Every statement gets an explainer: where things stand (dated), the case for agreeing, the case
   for disagreeing (equal length, naming who makes each), sources.
8. Lint before publishing: `python pipeline/quiz_lint.py` flags joined clauses, conditions,
   negations, numbers, keying imbalance per dimension, missing explainers and unsourced positions.

## 4. Coding positions

9. Source hierarchy: (1) platform or official program, (2) votes and signed legislation, (3) the
   leader's or candidate's own statements, (4) reliable reporting of the party's position. Never
   from bloc, party or ideology alone.
10. Two coders: one codes with a citation for each cell; a second, working independently from
    the same sources, checks every cell. Disagreements are settled with evidence and noted.
11. A proxy (a related vote standing in for the exact question) is coded at most ±1 with a note.
12. A missing position stays missing: it's left out of that actor's score and shown as "no stated
    position", never filled in.
13. Where possible, ask the actor (for shareable ballots: send the coding to campaigns and record
    replies). Keep a change log and re-check positions during the campaign.

## 5. Answering

14. Five-point agree/disagree plus Skip. Neutral counts as a midpoint; Skip is excluded.
15. Importance per statement (1–3), set before answering.
16. "What's this about?" is available on every statement before answering.
17. Statements are shuffled and unlabeled; what each measures is shown only on the results page.
18. Answers are saved in batches (KV write limits), private by default, client-side only on
    shareable instruments.

## 6. Scoring

19. Agreement with an actor = 1 − (weighted city-block distance ÷ weighted maximum distance), over
    the statements where both you and the actor have a position. Not Euclidean (it rewards
    moderate answers).
20. An actor is ranked only with at least `min_shared` statements in common (3 for match; 2 for
    two-candidate races); fewer is shown as "too few statements in common".
21. Ties are shown as ties, never broken alphabetically.
22. Warn when more than a third of answers are Skip or Neutral, or when an actor's score rests on
    few statements.

## 7. Showing results

23. Every actor in a ranked list, never a single "winner", each with a per-statement comparison
    (you, them, their source).
24. Maps only from multi-item dimensions (at least four statements each), fitted to the electorate
    (Israel: security first; religion and state, the courts and economics separate). Label maps as
    approximate.
25. State the limits on every results page: it measures agreement on these statements only, it is
    not advice, positions can shift, and the method and version are linked.

## 8. Extending

- **Another electorate:** copy an instrument file, set `electorate`, write dimensions for that
  system first (find the expert-survey dimensions, e.g. CHES for Europe and Israel), then
  statements, then coding (section 4). Lint, then publish.
- **Other people:** set `audience: shareable`. Shareable instruments carry public information
  only, keep answers in the visitor's browser, show the method page, and are opened and closed by
  Joe's toggle (Ballot Match pattern: a separate public project, never The Wire itself).
- **Identity and values:** use established instruments as published (ANES 7-point self-placement
  with its "haven't thought much" option; MFQ-2 and PVQ-RR only within their licenses), or link
  to the official tool (Pew's Political Typology quiz) and record the result, instead of inventing
  scales.

## 9. Learning (the "Get up to speed" layer)

- Each statement has a `topic`. `learn.yaml` holds, per topic: a short explainer (ours), and
  curated resources in four formats (a short video, an article or backgrounder, a podcast episode,
  a deep dive), each with source, length and perspective, at least one from each side where sides
  exist.
- Topics surface when Joe answers Neutral or Skip, opens the explainer, or spends long on a
  statement; the order of formats follows what he actually opens and finishes (the engagement
  log), compared with what he says he prefers.

## 10. Privacy

Every instrument's statements, explainers and public figures' sourced positions are public and
live in the repo. Everything about Joe is private and lives only in Workers KV behind Access:
answers, importance weights, results, matches, map positions, which statements inform his
scorecard's criteria, the scorecard itself, the engagement log and his proposals. Processing of
his data happens in Cloudflare (Pages Functions, Workers AI), never in GitHub Actions; the build
sees only reading taste. Results never appear in build logs, commit messages, code comments or
Ballot Match. `pipeline/privacy_check.py` enforces the checkable parts on every push.

## Sources

Wahl-O-Mat FAQ (bpb); VG Köln 2019 (via jura-online); StemWijzer (ProDemos); Krouwel & Elfrinkhof
2014; Vote Compass methodology v2026.1 (Vox Pop Labs); smartvote methodology and FAQ; Berdoz et al.
(ETH Zurich, arXiv 2505.13329); Walgrave, Nuytemans & Pepermans 2009; Lefevere & Walgrave 2014;
Louwerse & Rosema 2014; Rosema & Louwerse 2016; Germann & Mendez 2016; Otjes & Louwerse 2014;
Van Camp et al.; Holleman et al. 2016; Saris, Krosnick & Shaeffer 2005; Kamoen & Holleman 2025;
Gemenis 2015; Zur & Bakker 2023 (CHES-Israel); Pew Research Center Political Typology 2026;
Atari et al. 2023 (MFQ-2); Stockinger et al. 2024. Full notes and links: the research report kept
with this session (2026-10-25).
