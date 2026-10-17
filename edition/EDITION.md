# EDITION.md — how to write The Wire's edition

The edition is a front page for one reader: Joe, in Beacon, NY. He owns an environmental remediation and spill-response company (Optima Environmental Services), is an admitted NY attorney with a background in bankruptcy, AML compliance, commercial real estate and land use, and follows the Rangers, NYCFC, Tottenham, the USMNT, the USWNT and Gotham FC. Priorities, in order: Beacon local government, then courts/Congress/Albany, then law developments in his areas, then world news, then sports. BRIEF.md has the full picture.

## Steps (run by the scheduled task, in a fresh session)
1. `git clone https://github.com/jlinksman/the-wire && cd the-wire && pip install --break-system-packages -q -r requirements.txt`
2. `python pipeline/build.py` (fetches the sources fresh; writes `dist/data.json` and `.state/state.json`). Cloudflare credentials are not needed and not available here.
3. `python edition/digest.py > /tmp/digest.txt` and read it: the grouped stories, Beacon, government and law items, with item ids and article text excerpts.
4. Write `/tmp/edition.json` (schema below) from that material only.
5. `python edition/render.py /tmp/edition.json dist/data.json .state/state.json /tmp/edition.html` — it verifies citations and quotes and drops anything that fails.
6. Publish `/tmp/edition.html` to the existing artifact URL given in the task prompt (Artifact tool, publish with `url`). Never create a new artifact.
7. Never commit anything from this run to the repository. It is public.

## Writing rules
- **Reporting comes only from the sources.** The `report` field states what happened, in two to four plain sentences, using only facts in the cited items. No outside knowledge, no guessing.
- **Analysis is labeled and separate.** The `why` field is the only place for interpretation: what this means for Joe, Optima, Beacon or his practice areas. One or two sentences. Skip it when there is no real connection; never force one.
- **Quotes are verbatim.** Copy each quote exactly from the digest's article text for that item, and give its `item` id. render.py drops any quote it can't find word for word.
- **Cite every story** with the item ids it draws on (`sources`).
- **Selection:** 8 to 14 stories. Lead with Beacon and Dutchess when there is real news there, then government and law, then the biggest world stories (stories with more outlets weigh more), then one sports line if a followed team played or plays today. Skip celebrity and filler.
- **Lede:** two or three sentences on the shape of the day. It is analysis and is labeled as such on the page.
- **Ahead:** meetings, hearings, floor sessions and games today, from the digest’s TODAY section and the cited items (the next few days).
- Plain, direct sentences. Never begin a sentence with "And". No hype words.

## edition.json schema
```json
{
  "edition": "Morning",
  "generated_at": "2026-10-17T10:45:00Z",
  "lede": "…",
  "ahead": [{"when": "7:00 PM", "what": "City Council workshop", "link": "https://…"}],
  "sections": [
    {"desk": "BEACON", "title": "Around town", "stories": [
      {"headline": "…", "report": "…", "why": "…",
       "quotes": [{"text": "…", "by": "…", "item": "<item id>"}],
       "sources": ["<item id>", "<item id>"]}
    ]}
  ]
}
```
Desks: BEACON, GOV, LAW, WORLD, SPORTS.
