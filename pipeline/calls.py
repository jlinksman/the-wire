"""Call it (2026-11-04): election predictions for the Puzzle Page.

Every contested race on a Beacon ballot (elections.yaml `elections[].races`, plus ballot proposals)
and the curated national and international hot races (`hot_races`) open for a call: the winner,
a margin bucket (under 5, 5 to 15, 15+ points; single-seat races only) and a confidence. Calls lock
when voting starts (`closes`, default 6 AM Eastern on election day, when New York polls open).

Results are recorded in the same file, per race, from official counts or established outlets once a
race is called: `result: {winner: [names], margin: points, called: "who, when", source: url}`. A
race with no recorded call is never scored. Joe's calls live only in Workers KV (functions/games.js);
the build publishes races and results, never calls (CLAUDE.md rule 10).
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

ROOT = Path(__file__).resolve().parent.parent
NY = ZoneInfo("America/New_York")
SHOW_AFTER_DAYS = 45            # a scored race stays on the page this long
OPEN_BEFORE_DAYS = 120          # races open for calls this far ahead (if candidates are set)


def _closes(e_date: date, given: str | None) -> datetime:
    if given:
        return datetime.fromisoformat(str(given))
    return datetime.combine(e_date, time(6, 0), NY)


def _result(r: dict, names: set[str]) -> tuple[dict | None, str | None]:
    res = r.get("result")
    if not res:
        return None, None
    win = res.get("winner") or []
    win = [win] if isinstance(win, str) else list(win)
    if not res.get("called") or not res.get("source"):
        return None, "result recorded without who called it or a source"
    if not win or any(w not in names for w in win):
        return None, f"result winner {win!r} isn't one of the candidates"
    m = res.get("margin")
    if m is not None and not isinstance(m, (int, float)):
        return None, "margin is not a number"
    return {"winner": win, "margin": m, "called": str(res["called"]), "source": str(res["source"]),
            **({"note": str(res["note"])} if res.get("note") else {})}, None


def _race(eid, e_title, e_date, closes, r, where, scope, drops) -> dict | None:
    kind = r.get("kind") or "candidate"
    cands = [{"name": "Yes"}, {"name": "No"}] if kind == "proposal" else \
        [{"name": c["name"], "lines": c.get("lines") or ([c["party"]] if c.get("party") else [])} for c in r.get("candidates") or [] if c.get("name")]
    seats = int(r.get("seats") or 1)
    if len(cands) <= seats or r.get("contested") is False:
        return None                                      # uncontested: nothing to call
    res, bad = _result(r, {c["name"] for c in cands})
    if bad:
        drops.append(("calls", f"{eid}:{r.get('id')}: {bad}"))
    title = r.get("office") or r.get("title") or r.get("id")
    if r.get("district"):
        title += " · " + str(r["district"])
    return {"id": f"{eid}:{r['id']}", "election": e_title, "title": title, "where": where, "scope": scope,
            "level": r.get("level") or scope, "date": e_date.isoformat(), "closes": closes.isoformat(), "seats": seats,
            "kind": kind, "candidates": cands, "margin": seats == 1, "system": r.get("system"),
            **({"why": r["why_hot"]} if r.get("why_hot") else {}), **({"result": res} if res else {})}


def races(now: datetime, cfg: dict | None = None, drops: list | None = None) -> list[dict]:
    cfg = cfg if cfg is not None else (yaml.safe_load((ROOT / "elections.yaml").read_text()) or {})
    drops = drops if drops is not None else []
    today = now.astimezone(NY).date()
    out = []

    def window(d: date) -> bool:
        return today - timedelta(days=SHOW_AFTER_DAYS) <= d <= today + timedelta(days=OPEN_BEFORE_DAYS)

    for e in cfg.get("elections") or []:
        d = date.fromisoformat(str(e["date"]))
        if not window(d):
            continue
        closes = _closes(d, e.get("closes"))
        where = e.get("jurisdiction") or "Beacon"
        for r in e.get("races") or []:
            x = _race(e["id"], e.get("title"), d, closes, r, where, "local", drops)
            if x:
                out.append(x)
        for p in e.get("proposals") or []:
            x = _race(e["id"], e.get("title"), d, closes, dict(p, kind="proposal", office=p.get("title") or p.get("id")), where, "local", drops)
            if x:
                out.append(x)
    for h in cfg.get("hot_races") or []:
        d = date.fromisoformat(str(h["date"]))
        if not window(d):
            continue
        x = _race("hot", h.get("title"), d, _closes(d, h.get("closes")), dict(h, office=h.get("title"), why_hot=h.get("why")), h.get("where"), h.get("scope") or "national", drops)
        if x:
            out.append(x)
        elif not h.get("candidates"):
            drops.append(("calls", f"hot race {h.get('id')}: candidates not set yet"))
    out.sort(key=lambda x: (x["date"], x["scope"] != "local", x["id"]))
    return out


def upcoming_hot(now: datetime, cfg: dict | None = None) -> list[dict]:
    """Hot races further out or still without candidates: listed on the page as 'coming up'."""
    cfg = cfg if cfg is not None else (yaml.safe_load((ROOT / "elections.yaml").read_text()) or {})
    today = now.astimezone(NY).date()
    out = []
    for h in cfg.get("hot_races") or []:
        d = date.fromisoformat(str(h["date"]))
        if d >= today and (d > today + timedelta(days=OPEN_BEFORE_DAYS) or len(h.get("candidates") or []) < 2):
            out.append({"title": h.get("title"), "date": d.isoformat(), "where": h.get("where"), "note": h.get("note")})
    return sorted(out, key=lambda x: x["date"])
