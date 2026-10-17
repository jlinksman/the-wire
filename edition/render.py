"""Render a Wire edition (written by Claude from edition.json) into one HTML page.

Usage: python edition/render.py edition.json dist/data.json .state/state.json out.html

Before rendering, every claim is checked against what the build actually fetched:
  - each story must cite at least one item id that exists in data.json;
  - each quote must appear word for word in that cited item's stored article text,
    headline or description (the quote integrity rule); quotes that fail are dropped;
  - stories with no valid citation are dropped.
What was dropped is printed and listed at the foot of the page, so nothing fails silently.
"""

from __future__ import annotations

import html
import json
import re
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
DESK_COLOR = {"BEACON": "beacon", "GOV": "gov", "LAW": "law", "WORLD": "world", "SPORTS": "sports"}


def norm(s: str) -> str:
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", s).strip().lower()


def esc(s) -> str:
    return html.escape(str(s or ""), quote=True)


def main(ed_path, data_path, state_path, out_path):
    ed = json.load(open(ed_path))
    data = json.load(open(data_path))
    texts = json.load(open(state_path)).get("texts", {})
    items = {it["id"]: it for it in data["items"]}
    dropped = []

    def corpus(iid):
        it = items[iid]
        return norm(" ".join([it.get("title", ""), it.get("summary", ""), (texts.get(iid) or {}).get("text", "")]))

    sections_html = []
    n_stories = 0
    for sec in ed.get("sections", []):
        cards = []
        for st in sec.get("stories", []):
            cited = [i for i in st.get("sources", []) if i in items]
            if not cited:
                dropped.append(f"story “{st.get('headline', '')[:60]}”: no valid source")
                continue
            quotes = []
            for q in st.get("quotes", []):
                src = q.get("item") if q.get("item") in items else None
                if not src or norm(q.get("text", "")) not in corpus(src):
                    dropped.append(f"quote “{q.get('text', '')[:50]}…”: not found word for word in its source")
                    continue
                quotes.append((q, items[src]))
            n_stories += 1
            src_links = " ".join(
                f'<a href="{esc(items[i]["link"])}" target="_blank" rel="noopener">{esc(items[i]["source"])}</a>' for i in cited)
            qhtml = "".join(
                f'<blockquote><p>“{esc(q["text"])}”</p><cite>{esc(q["by"])} · '
                f'<a href="{esc(it["link"])}" target="_blank" rel="noopener">{esc(it["source"])}</a></cite></blockquote>'
                for q, it in quotes)
            why = (f'<div class="why"><span class="label">Why it matters to you · analysis</span><p>{esc(st["why"])}</p></div>'
                   if st.get("why") else "")
            cards.append(
                f'<article class="story"><h3>{esc(st["headline"])}</h3>'
                f'<p class="report">{esc(st.get("report", ""))}</p>{qhtml}{why}'
                f'<p class="srcs"><span class="label">Sources</span> {src_links}</p></article>')
        if cards:
            color = DESK_COLOR.get(sec.get("desk", ""), "text")
            sections_html.append(
                f'<section class="desk" style="--desk: var(--{color})"><h2><span>{esc(sec.get("desk", "")).title()}</span> {esc(sec.get("title", ""))}</h2>'
                + "".join(cards) + "</section>")

    ahead = "".join(
        f'<li><span class="when">{esc(a.get("when"))}</span><span class="what">'
        + (f'<a href="{esc(a["link"])}" target="_blank" rel="noopener">{esc(a.get("what"))}</a>' if a.get("link") else esc(a.get("what")))
        + "</span></li>" for a in ed.get("ahead", []))

    gen = datetime.fromisoformat(ed["generated_at"].replace("Z", "+00:00")).astimezone(NY)
    data_at = datetime.fromisoformat(data["generated_at"].replace("Z", "+00:00")).astimezone(NY)
    stamp = gen.strftime("%a %b %-d, %Y · %-I:%M %p ET")
    foot_drop = ("<p>Dropped before publishing: " + "; ".join(esc(d) for d in dropped) + "</p>") if dropped else \
        "<p>Every quote on this page was checked word for word against its source.</p>"

    page = TEMPLATE.format(
        title=f"The Wire Edition",
        edition=esc(ed.get("edition", "Morning")),
        stamp=esc(stamp),
        data_at=esc(data_at.strftime("%-I:%M %p ET")),
        lede=esc(ed.get("lede", "")),
        ahead=(f'<section class="ahead"><h2>Ahead</h2><ul>{ahead}</ul></section>' if ahead else ""),
        sections="".join(sections_html),
        foot=foot_drop,
        n=n_stories,
    )
    open(out_path, "w").write(page)
    print(f"rendered {n_stories} stories; dropped {len(dropped)}")
    for d in dropped:
        print("  dropped:", d)


TEMPLATE = """<title>{title}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* Layout: one reading column. Same design rules as The Wire: serif for reading, sans for
   labels, sentence case, one color per meaning (amber = new, coral = live), analysis set
   apart on its own surface. Follows the phone's light or dark setting. */
:root {{
  --bg: #f5f3ee; --surface: #ffffff; --raised: #ebe8e2; --hair: rgba(0,0,0,.08);
  --text: #1d1f22; --text2: #575b60; --text3: #82868a; --new: #9a6510; --link: #2f7a52;
  --beacon: #2f7a52; --gov: #3a66a0; --law: #7553a3; --world: #86682e; --sports: #2a7a77;
  --serif: ui-serif, "New York", "Iowan Old Style", Charter, Georgia, serif;
  --sans: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --bg: #141619; --surface: #1c1f23; --raised: #252a2f; --hair: rgba(255,255,255,.075);
    --text: #e8e5df; --text2: #aaaba7; --text3: #7b7f82; --new: #e2b66a; --link: #93cfa8;
    --beacon: #93cfa8; --gov: #9db9de; --law: #c4abd9; --world: #cdbd99; --sports: #88c6c3; color-scheme: dark;
  }}
}}
:root[data-theme="dark"] {{
  --bg: #141619; --surface: #1c1f23; --raised: #252a2f; --hair: rgba(255,255,255,.075);
  --text: #e8e5df; --text2: #aaaba7; --text3: #7b7f82; --new: #e2b66a; --link: #93cfa8;
  --beacon: #93cfa8; --gov: #9db9de; --law: #c4abd9; --world: #cdbd99; --sports: #88c6c3; color-scheme: dark;
}}
* {{ box-sizing: border-box; }}
body {{ background: var(--bg); color: var(--text); font: 17px/1.5 var(--sans); -webkit-font-smoothing: antialiased;
  padding-left: max(18px, env(safe-area-inset-left, 0px)); padding-right: max(18px, env(safe-area-inset-right, 0px)); padding-block: 16px 48px; }}
main {{ max-width: 660px; margin: 0 auto; }}
a {{ color: var(--link); }}
:focus-visible {{ outline: 2px solid var(--link); outline-offset: 2px; }}
header {{ display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }}
.brand {{ font: 600 14px var(--mono); letter-spacing: .08em; color: var(--link); }}
.asof {{ color: var(--text3); font-size: 13px; font-variant-numeric: tabular-nums; }}
h1 {{ font: 600 30px/1.15 var(--serif); letter-spacing: -.015em; margin: 14px 0 0; text-wrap: balance; }}
.lede-label, .label {{ display: block; font-size: 13px; color: var(--text3); }}
.lede {{ margin: 16px 0 0; padding: 16px 18px; border-radius: 16px; background: var(--surface); }}
.lede p {{ margin: 4px 0 0; font: 18px/1.5 var(--serif); }}
.ahead {{ margin: 12px 0 0; padding: 14px 18px 10px; border-radius: 16px; background: var(--surface); }}
.ahead h2 {{ margin: 0 0 4px; font-size: 13px; font-weight: 500; color: var(--text3); }}
.ahead ul {{ list-style: none; margin: 0; padding: 0; }}
.ahead li {{ display: grid; grid-template-columns: 8em 1fr; gap: 12px; padding: 6px 0; font-size: 15px; }}
.ahead .when {{ white-space: nowrap; color: var(--text2); font-variant-numeric: tabular-nums; }}
.ahead .what {{ min-width: 0; }}
.ahead a {{ color: var(--text); }}
.desk {{ margin-top: 34px; }}
.desk h2 {{ display: flex; align-items: center; gap: 8px; margin: 0 0 2px; font: 650 21px var(--sans); letter-spacing: -.01em; }}
.desk h2 span {{ display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: var(--text3); order: 2; }}
.desk h2 span::before {{ content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--desk); }}
.story {{ padding: 18px 0; border-bottom: 1px solid var(--hair); display: grid; gap: 10px; }}
.story:last-child {{ border-bottom: 0; }}
.story h3 {{ margin: 0; font: 600 21px/1.25 var(--serif); letter-spacing: -.01em; text-wrap: balance; }}
.report {{ margin: 0; color: var(--text); max-width: 65ch; }}
blockquote {{ margin: 0; padding-left: 14px; border-left: 2px solid var(--raised); }}
blockquote p {{ margin: 0; font: italic 17px/1.45 var(--serif); }}
cite {{ display: block; font-style: normal; font-size: 13px; color: var(--text3); margin-top: 4px; }}
cite a {{ color: var(--text2); }}
.why {{ padding: 12px 14px; border-radius: 12px; background: var(--surface); }}
.why p {{ margin: 3px 0 0; font-size: 16px; color: var(--text); }}
.srcs {{ margin: 0; font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; color: var(--text3); }}
.srcs a {{ color: var(--text2); }}
footer {{ margin-top: 36px; font-size: 13px; color: var(--text3); line-height: 1.55; }}
</style>
<main>
<header><span class="brand">THE WIRE</span><span class="asof">{stamp} · feed as of {data_at}</span></header>
<h1>{edition} Edition</h1>
<div class="lede"><span class="lede-label">The day so far · analysis</span><p>{lede}</p></div>
{ahead}
{sections}
<footer>{n} stories. Written by Claude from The Wire's sources. Reporting comes from the cited outlets; text marked analysis is Claude's reading of it. {foot}</footer>
</main>
"""

if __name__ == "__main__":
    main(*sys.argv[1:5])
