"""The editorial room (editorial.yaml): working rules the machine writer follows, chosen per
story by desk, scope, city beat and headline patterns. Backstage only; the page never names
a chair."""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

PATH = Path(__file__).resolve().parent.parent / "editorial.yaml"
NY = ZoneInfo("America/New_York")
MAX_BEAT_CHAIRS = 3


def load() -> dict:
    try:
        return yaml.safe_load(PATH.read_text()) or {}
    except FileNotFoundError:
        return {}


def _active(chair: dict, today: str) -> bool:
    until = chair.get("active_until")
    return not until or today <= str(until)


def chairs_for(cfg: dict, items: list[dict]) -> list[str]:
    """Chair ids whose beat this story (or item) is on, best match first."""
    if not cfg or not items:
        return []
    today = datetime.now(NY).date().isoformat()
    heads = " ".join(it["title"] for it in items)
    # Desk and scope by majority, so one GOV-desk outlet doesn't put a world story on the documents chair.
    from collections import Counter
    desks = {Counter(it.get("desk") for it in items).most_common(1)[0][0]}
    scopes = {Counter(it.get("scope") for it in items).most_common(1)[0][0]}
    beats = {b for it in items for b in it.get("beats", [])}
    regional = any(it.get("regional") for it in items)
    scored = []
    pool = {**(cfg.get("chairs") or {}), **{k: v for k, v in (cfg.get("guests") or {}).items()}}
    for cid, ch in pool.items():
        if not _active(ch, today):
            continue
        if "regional" in ch and ch["regional"] != regional and not (ch.get("pattern") and re.search(ch["pattern"], heads, re.IGNORECASE)):
            continue
        score = 0
        if set(ch.get("beats") or []) & beats:
            score = 3
        elif ch.get("pattern") and re.search(ch["pattern"], heads, re.IGNORECASE):
            score = 2
        elif set(ch.get("desks") or []) & desks or set(ch.get("scopes") or []) & scopes:
            score = 1
        elif ch.get("regional") and regional:
            score = 1
        if score:
            scored.append((score + (0.5 if cid in (cfg.get("guests") or {}) else 0), cid))
    scored.sort(reverse=True)
    return [cid for _, cid in scored[:MAX_BEAT_CHAIRS]]


def rules_text(cfg: dict, chair_ids: list[str], roles: tuple[str, ...] = ()) -> str:
    """House rules for a prompt: always-on chairs, any desk roles asked for, then beat chairs."""
    if not cfg:
        return ""
    pool = {**(cfg.get("chairs") or {}), **(cfg.get("guests") or {})}
    lines = []
    for ch in (cfg.get("always") or {}).values():
        lines += ch.get("rules", [])
    for r in roles:
        lines += ((cfg.get("desk_roles") or {}).get(r) or {}).get("rules", [])
    for cid in chair_ids:
        lines += (pool.get(cid) or {}).get("rules", [])
    seen, out = set(), []
    for line in lines:
        if line not in seen:
            seen.add(line)
            out.append("- " + line)
    return "House rules:\n" + "\n".join(out) if out else ""
