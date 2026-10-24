"""Voter guide (2026-10-23): the elections Joe votes in, from elections.yaml.

elections.yaml holds, for each election: the date, the official deadlines (each with its
source), the races on a Beacon ballot (office, what the job does, candidates with their party
lines, positions as they state them, each with a source), ballot proposals (what Yes and No
do, the arguments on each side and who makes them), and a news search per race. It is written
in a Claude session from official sources and established outlets, and checked by a scheduled
task before every election. Nothing in it recommends a vote.

The build:
- ships the active guide (from `show_days` before the date to a week after) as data["voter_guide"]
- turns each race into a standing thread (group "election") whose watch terms are the
  candidates' names and the office, so news, Ask and the brief all work per race
- turns each race's `search` into a news-search source (config, not code: it's in the yaml)
- computes the next upcoming election from `recurring` rules, so the page always says what's next,
  and adds a health row when an election is near but its guide hasn't been written.
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import yaml

ROOT = Path(__file__).resolve().parent.parent
NY = ZoneInfo("America/New_York")
EXCLUDE = "kalkine|insider monkey|ainvest|motley fool|benzinga|marketbeat|simply wall"


def load() -> dict:
    f = ROOT / "elections.yaml"
    return (yaml.safe_load(f.read_text()) or {}) if f.exists() else {}


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    days = [d for d in calendar.Calendar().itermonthdates(year, month) if d.month == month and d.weekday() == weekday]
    return days[n - 1] if n > 0 else days[n]


def rule_date(rule: str, year: int) -> date | None:
    """'general' (Tuesday after the first Monday in November), 'primary' (fourth Tuesday in June),
    'school' (third Tuesday in May)."""
    if rule == "general":
        first_monday = _nth_weekday(year, 11, 0, 1)
        return first_monday + timedelta(days=1)
    if rule == "primary":
        return _nth_weekday(year, 6, 1, 4)
    if rule == "school":
        return _nth_weekday(year, 5, 1, 3)
    return None


def active(cfg: dict, today: date) -> dict | None:
    for e in sorted(cfg.get("elections") or [], key=lambda e: str(e["date"])):
        d = date.fromisoformat(str(e["date"]))
        if d - timedelta(days=int(e.get("show_days", 60))) <= today <= d + timedelta(days=7):
            return e
    return None


def upcoming(cfg: dict, today: date, n: int = 4) -> list[dict]:
    """Next elections from the written guides and the recurring rules, soonest first."""
    out = {}
    for e in cfg.get("elections") or []:
        d = date.fromisoformat(str(e["date"]))
        if d >= today:
            out[d.isoformat() + e.get("kind", "")] = {"date": d.isoformat(), "title": e["title"], "guide": True, "id": e["id"]}
    for r in cfg.get("recurring") or []:
        for y in (today.year, today.year + 1):
            if r.get("years") == "odd" and y % 2 == 0 or r.get("years") == "even" and y % 2 == 1:
                continue
            d = rule_date(r["rule"], y)
            if d and d >= today:
                key = d.isoformat() + r.get("kind", "")
                if not any(k.startswith(d.isoformat()) for k in out):
                    out[key] = {"date": d.isoformat(), "title": r["title"], "guide": False, "note": r.get("note")}
    return sorted(out.values(), key=lambda x: x["date"])[:n]


def race_threads(e: dict) -> list[dict]:
    """Each race as a standing thread: its candidates' full names and the office as watch terms."""
    out = []
    for r in e.get("races") or []:
        names = [c["name"] for c in r.get("candidates") or [] if c.get("name")]
        terms = names + list(r.get("watch") or [])
        if not terms:
            continue
        out.append({"id": f"race_{e['id']}_{r['id']}", "group": "election", "title": f"{r['office']}{(' · ' + r['district']) if r.get('district') else ''}",
                    "kind": "process", "desk": r.get("desk") or "GOV", "pattern": ", ".join(terms)})
    for p in e.get("proposals") or []:
        if p.get("watch"):
            out.append({"id": f"prop_{e['id']}_{p['id']}", "group": "election", "title": p["title"], "kind": "process",
                        "desk": "GOV", "pattern": ", ".join(p["watch"])})
    return out


def sources(cfg: dict, today: date) -> list[dict]:
    """News searches for the active election's races, in sources.yaml's shape."""
    e = active(cfg, today)
    if not e:
        return []
    out = []
    for r in (e.get("races") or []) + (e.get("proposals") or []):
        if not r.get("search"):
            continue
        out.append({"id": f"el_{r['id']}", "short": "Election search", "name": f"Election · {r.get('office') or r.get('title')} (via Bing News)",
                    "enabled": True, "quiet": True, "desk": r.get("desk") or "GOV", "scope": r.get("scope") or "state",
                    "type": "rss", "url": "https://www.bing.com/news/search?" + urlencode({"q": r["search"], "format": "rss"}),
                    "status": "OK", "poll": 120, "robots": "honored", "max_age_days": 21, "max_items": 10,
                    "exclude_outlets": EXCLUDE, "_section": "elections"})
    return out


def run(data: dict, log) -> dict:
    """Ship the guide and what's next; return a health row."""
    cfg = load()
    today = datetime.now(NY).date()
    e = active(cfg, today)
    nxt = upcoming(cfg, today)
    data["elections_next"] = nxt
    missing = [x for x in nxt if not x["guide"] and (date.fromisoformat(x["date"]) - today).days <= 45]
    # The private scorecard (fetched from KV by the workflow into ballot.json, gitignored): only
    # whether it's there and for which election is used here; its contents reach the page via /ballot.
    sc = {}
    f = ROOT / "ballot.json"
    if f.exists():
        try:
            import json
            sc = json.loads(f.read_text()) or {}
        except ValueError:
            sc = {}
    if e:
        g = {k: v for k, v in e.items() if k not in ("show_days",)}
        g["scorecard"] = {"imported": sc.get("imported"), "races": len(sc.get("races") or {})} if sc.get("election") == e["id"] else None
        g["days_until"] = (date.fromisoformat(str(e["date"])) - today).days
        g["date"] = str(e["date"])
        for r in g.get("races") or []:
            r["thread"] = f"race_{e['id']}_{r['id']}"
        for p in g.get("proposals") or []:
            if p.get("watch"):
                p["thread"] = f"prop_{e['id']}_{p['id']}"
        data["voter_guide"] = g
        log(f"[elections] guide: {e['id']} in {g['days_until']} days, {len(g.get('races') or [])} races, {len(g.get('proposals') or [])} proposals")
    scorecard_row = {"id": "scorecard", "name": "Your voter-guide scorecard (private, Workers KV)", "short": "Scorecard", "desk": "SYSTEM", "poll": 15,
                     "last_success": sc.get("imported"), "last_attempt": datetime.now(NY).isoformat(),
                     "last_error": None if not e or sc.get("election") == e["id"] else "Not imported for this election yet: Settings › Admin › Your scorecard",
                     "last_status": None, "robots": "n/a", "items": len(sc.get("races") or {})}
    data.setdefault("sources", []).append(scorecard_row)
    return {"id": "voter_guide", "name": "Voter guide (elections.yaml)", "short": "Voter guide", "desk": "SYSTEM", "poll": 15,
            "last_success": datetime.now(NY).isoformat(), "last_attempt": datetime.now(NY).isoformat(),
            "last_error": ("No guide written yet for " + ", ".join(f"{x['title']} ({x['date']})" for x in missing)) if missing else None,
            "last_status": None, "robots": "n/a", "items": len((e or {}).get("races") or [])}
