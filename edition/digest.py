"""Print a compact digest of the latest build for the edition writer.

Usage: python edition/digest.py [hours]   (default 24)
Reads dist/data.json and .state/state.json; prints stories, then desk items, with
item ids and article text excerpts. Output stays in the session; never commit it.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
hours = float(sys.argv[1]) if len(sys.argv) > 1 else 24
data = json.load(open("dist/data.json"))
texts = json.load(open(".state/state.json")).get("texts", {})
items = {it["id"]: it for it in data["items"]}
now = datetime.now(timezone.utc)
cut = now - timedelta(hours=hours)


def t(it):
    return datetime.fromisoformat(it["t"].replace("Z", "+00:00"))


def show(it, excerpt=1200):
    when = t(it).astimezone(NY).strftime("%a %-I:%M %p")
    print(f"  [{it['id']}] {when} · {it['desk']} · {it['source']} · {it['title']}")
    if it.get("summary"):
        print(f"      desc: {it['summary'][:400]}")
    body = (texts.get(it["id"]) or {}).get("text", "")
    if body:
        print(f"      text: {body[:excerpt]}")
    for q in it.get("quotes", []):
        print(f"      quote ({q['by']}): {q['text']}")
    for a in (it.get("agenda") or [])[:25]:
        print(f"      agenda {a.get('n') or '-'}: {a['text'][:200]}")


print(f"DIGEST · feed as of {data['generated_at']} · window {hours:g}h\n")
print("TODAY (meetings, games):")
for it in data["items"]:
    if it.get("event_at"):
        ev = datetime.fromisoformat(it["event_at"].replace("Z", "+00:00"))
        if now - timedelta(hours=2) <= ev <= now + timedelta(hours=30):
            print(f"  {ev.astimezone(NY).strftime('%a %-I:%M %p')} · {it['title']} · {it['link']}")
for tm in data.get("teams", []):
    if tm.get("next"):
        print(f"  {tm['short']} next: {tm['next'].get('at')} {'v' if tm['next'].get('home') else '@'} {tm['next'].get('opp')}")
    if tm.get("last"):
        L = tm["last"]
        print(f"  {tm['short']} last: {L.get('at')} {L.get('us')}-{L.get('them')} vs {L.get('opp')}")

print("\nSTORIES (same story across outlets, ranked):")
seen = set()
for s in data.get("stories", [])[:20]:
    print(f"- {s['sources']} sources · {s['desk']} · score {s.get('score')}")
    for m in s["members"][:5]:
        if m in items:
            show(items[m], 900)
            seen.add(m)

for desk in ("BEACON", "GOV", "LAW", "WORLD"):
    print(f"\n{desk}:")
    for it in data["items"]:
        if it["desk"] == desk and it["id"] not in seen and t(it) >= cut and not it.get("alert"):
            show(it, 1000 if desk in ("BEACON", "GOV", "LAW") else 300)
for it in data["items"]:
    if it.get("alert"):
        print(f"\nWEATHER ALERT: {it['title']} · {it.get('summary', '')[:300]}")
