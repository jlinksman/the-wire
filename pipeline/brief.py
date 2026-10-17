"""Signal for the on-demand "Brief me" briefing.

The build chooses what is worth hearing; the page's Brief me button (functions/brief.js)
writes the briefing from this short list only when tapped. Signal, in Joe's order:
alerts, Beacon and Dutchess, government and law, the world, his teams. An item makes the
list if it is official or primary (city, county, courts, rules), matched his watchlist,
or was reported by two or more outlets. Single-outlet national items, regional items,
opinion and features stay out.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")

SECTION = {"BEACON": "Beacon", "GOV": "Government", "LAW": "Law", "WORLD": "World", "SPORTS": "Sports"}
WEIGHT = {"BEACON": 3.0, "GOV": 2.0, "LAW": 2.0, "WORLD": 1.5, "SPORTS": 0.6}
WINDOW_H = 30


def _t(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def build(data: dict, cfg: dict, dist, log, texts: dict | None = None) -> None:
    now = datetime.now(timezone.utc)
    noise = re.compile(cfg.get("noise_title", "$^"), re.IGNORECASE)
    primary = set(cfg.get("primary_sources", []))
    local = re.compile(cfg["local_pattern"], re.IGNORECASE) if cfg.get("local_pattern") else None
    items = {it["id"]: it for it in data["items"]}
    stories = {s["lead"]: s for s in data.get("stories", [])}
    folded = {m for s in data.get("stories", []) for m in s["members"] if m != s["lead"]}

    picked = []
    for it in data["items"]:
        if it["id"] in folded or it.get("regional") or it.get("kind") == "BLOTTER":
            continue
        t = _t(it["t"])
        if now - t > timedelta(hours=WINDOW_H) or noise.search(it["title"]):
            continue
        st = stories.get(it["id"])
        outlets = st["sources"] if st else 1
        why = []
        if it.get("alert"):
            why.append("weather alert")
        if it.get("watch_terms"):
            why.append("matches your watchlist: " + ", ".join(it["watch_terms"]))
        official = it["source_id"] in primary
        local_hit = it["desk"] == "BEACON" and local and local.search(f"{it['title']} {it.get('summary', '')}")
        if not (it.get("alert") or why or official or local_hit or outlets >= 2):
            continue
        age_h = (now - t).total_seconds() / 3600
        score = WEIGHT.get(it["desk"], 1) * (1 + 0.5 * (outlets - 1)) * (2 if why else 1) * math.exp(-age_h / 10)
        if it.get("alert"):
            score += 100
        summary = (st or {}).get("summary") or it.get("machine_summary") or it.get("summary") or ""
        # Open article text (kept in the build cache, never shown) gives the writer facts
        # beyond a one-line description. Only the briefing's own sentences are displayed.
        body = ((texts or {}).get(it["id"]) or {}).get("text", "")
        if body:
            summary = (summary + " " + body[:900]).strip()
        picked.append({
            "id": it["id"], "section": "Alert" if it.get("alert") else SECTION.get(it["desk"], it["desk"]),
            "t": it["t"], "title": it["title"], "summary": re.sub(r"\s+", " ", summary)[:1100],
            "source": it["source"], "outlets": outlets, "why": "; ".join(why),
            "quote": next(({"text": q["text"], "by": q["by"]} for m in ((st or {}).get("members") or [it["id"]])
                           for q in (items.get(m) or {}).get("quotes", [])), None),
            "link": it["link"], "score": round(score, 3),
        })
    picked.sort(key=lambda x: x["score"], reverse=True)
    caps, used, kept = cfg.get("per_section", {}), {}, []
    for x in picked:
        used[x["section"]] = used.get(x["section"], 0) + 1
        if used[x["section"]] <= caps.get(x["section"], 99):
            kept.append(x)
    picked = kept[: cfg.get("max_items", 32)]

    sports = []
    for tm in data.get("teams", []):
        if tm.get("live"):
            g = tm["live"]
            sports.append(f"{tm['short']} are playing now, {g.get('us')} to {g.get('them')} {'against' if g.get('home') else 'at'} {g.get('opp')}.")
        elif tm.get("last") and now - _t(tm["last"]["at"]) < timedelta(hours=20):
            g = tm["last"]
            res = {True: "beat", False: "lost to"}.get(g.get("winner"), "drew with")
            sports.append(f"{tm['short']} {res} {g.get('opp')}, {g.get('us')} to {g.get('them')}.")
        if tm.get("next") and timedelta(0) < _t(tm["next"]["at"]) - now < timedelta(hours=14):
            g = tm["next"]
            sports.append(f"{tm['short']} play {'' if g.get('home') else 'at '}{g.get('opp')} at {_t(g['at']).astimezone(NY).strftime('%-I:%M %p')}.")

    ahead = []
    for it in data["items"]:
        if it.get("event_at"):
            ev = _t(it["event_at"])
            if timedelta(hours=-1) < ev - now < timedelta(hours=30):
                ahead.append({"t": it["event_at"], "what": it["title"].split(" - ")[0]})

    (dist / "brief.json").write_text(json.dumps({
        "generated_at": data["generated_at"], "target_words": cfg.get("target_words", 260),
        "items": picked, "sports": sports, "ahead": ahead,
    }, separators=(",", ":")))
    log(f"[brief] {len(picked)} signal items, {len(sports)} sports lines, {len(ahead)} ahead")
