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
                f'<section class="desk" style="--desk: var(--{color})"><h2><span>{esc(sec.get("desk", ""))}</span> {esc(sec.get("title", ""))}</h2>'
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
        edition=esc(ed.get("edition", "Morning")).upper(),
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
/* Layout: one reading column; desk sections in The Wire's colors; reporting in plain type, analysis set apart in a dashed box. */
:root {{
  --bg: #0b0d10; --panel: #12161b; --line: #20262d; --text: #e6e6e6; --meta: #8a9099; --faint: #5c636b;
  --amber: #ffb000; --green: #5be38f;
  --beacon: #7fd1a0; --gov: #8fb6e8; --law: #c9a2e0; --world: #b8a98a; --sports: #6fc7c7;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color-scheme: dark;
}}
* {{ box-sizing: border-box; }}
body {{ background: var(--bg); color: var(--text); font: 16px/1.45 var(--sans);
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 14px 40px; }}
main {{ max-width: 680px; margin: 0 auto; }}
a {{ color: var(--green); }}
:focus-visible {{ outline: 2px solid var(--amber); outline-offset: 2px; }}
header {{ display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap;
  font-family: var(--mono); border-bottom: 1px solid var(--line); padding-bottom: 10px; }}
.brand {{ color: var(--green); font-weight: 700; letter-spacing: 0.12em; font-size: 15px; }}
.asof {{ color: var(--meta); font-size: 12.5px; font-variant-numeric: tabular-nums; }}
h1 {{ font-size: 28px; line-height: 1.15; margin: 18px 0 6px; text-wrap: balance; letter-spacing: -0.01em; }}
.lede {{ font-size: 17px; color: #d5d8dc; margin: 0 0 6px; max-width: 65ch; }}
.lede-label, .label {{ font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }}
.ahead {{ margin: 18px 0 8px; border: 1px solid var(--line); padding: 10px 12px; font-family: var(--mono); }}
.ahead h2, .desk h2 {{ font-family: var(--mono); font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--meta); margin: 0 0 6px; font-weight: 600; }}
.ahead ul {{ list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }}
.ahead li {{ display: grid; grid-template-columns: 8.4em 1fr; gap: 10px; font-size: 13px; }}
.ahead .when {{ white-space: nowrap; color: var(--amber); font-variant-numeric: tabular-nums; }}
.ahead .what {{ min-width: 0; }}
.ahead a {{ color: var(--text); }}
.desk {{ margin-top: 26px; }}
.desk h2 span {{ color: var(--desk); font-weight: 700; margin-right: 6px; }}
.desk h2 {{ border-bottom: 1px solid var(--line); padding-bottom: 6px; }}
.story {{ padding: 14px 0 12px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }}
.story h3 {{ font-size: 19px; line-height: 1.25; margin: 0; text-wrap: balance; }}
.report {{ margin: 0; color: #d0d3d7; max-width: 65ch; }}
blockquote {{ margin: 0; padding-left: 12px; border-left: 2px solid var(--meta); }}
blockquote p {{ margin: 0; font-size: 16px; }}
cite {{ display: block; font-style: normal; font-family: var(--mono); font-size: 12px; color: var(--meta); margin-top: 3px; }}
.why {{ border: 1px dashed var(--line); padding: 8px 10px; background: var(--panel); }}
.why p {{ margin: 3px 0 0; font-size: 15px; color: #c5c9ce; }}
.srcs {{ margin: 0; font-family: var(--mono); font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }}
footer {{ margin-top: 28px; font-family: var(--mono); font-size: 11.5px; color: var(--faint); line-height: 1.5; }}
</style>
<main>
<header><span class="brand">THE WIRE · {edition} EDITION</span><span class="asof">{stamp} · feed as of {data_at}</span></header>
<span class="lede-label">The day so far · analysis</span>
<p class="lede">{lede}</p>
{ahead}
{sections}
<footer>{n} stories. Written by Claude from The Wire's sources; reporting is drawn from the cited outlets, and boxed text marked analysis is Claude's reading of it. {foot}</footer>
</main>
"""

if __name__ == "__main__":
    main(*sys.argv[1:5])
