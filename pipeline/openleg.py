"""Statute-change flags for the legal refresher cards (GAMES.md), from the NY Senate's Open
Legislation API (free key, GitHub secret OPENLEG_KEY).

Each NY card watches the sections it cites (its `openleg` list, or the law/section in its
nysenate.gov source URL). Once a week the build fetches each watched section and records its
active date and a hash of its text in the Actions cache (never git; the text itself is not kept).
A card is held off the page when:
- a watched section's active date is later than the card's `verified` date (the law changed after
  we checked it), or
- the card's statute cloze, with its answer filled in, no longer appears in the section's text.
Its health row says which section changed and when, so the card gets re-checked by hand.

Open Legislation batches law updates weekly, so a weekly fetch loses nothing. The key is sent as a
query parameter and is never printed: errors report the section and status code only.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta
from pathlib import Path

API = "https://legislation.nysenate.gov/api/3/laws/{law}/{loc}"
SRC = re.compile(r"nysenate\.gov/legislation/laws/([A-Z]{3})/([0-9A-Za-z-]+)")


def watched(card: dict) -> list[str]:
    out = list(card.get("openleg") or [])
    for url in (card.get("source"), (card.get("cloze") or {}).get("source")):
        m = SRC.search(url or "")
        if m and f"{m.group(1)}/{m.group(2)}" not in out:
            out.append(f"{m.group(1)}/{m.group(2)}")
    return out


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def refresh(cards: list[dict], cache: Path, session, key: str, ua: str, now: datetime) -> dict:
    """Fetch every watched section at most once a week. Returns {"errors": [...]}."""
    state = json.loads(cache.read_text()) if cache.exists() else {}
    errors = []
    for sec in sorted({s for c in cards for s in watched(c)}):
        row = state.get(sec) or {}
        if row.get("checked", "") > (now - timedelta(days=6)).isoformat():
            continue
        law, loc = sec.split("/", 1)
        try:
            r = session.get(API.format(law=law, loc=loc), params={"key": key, "full": "true"}, headers={"User-Agent": ua}, timeout=30)
        except Exception as exc:                                   # the URL carries the key: never print it
            errors.append(f"{sec}: {type(exc).__name__}")
            continue
        if r.status_code in (401, 403):
            errors.append(f"{sec}: HTTP {r.status_code} (check the OPENLEG_KEY secret)")
            break
        if r.status_code == 429:
            errors.append(f"{sec}: HTTP 429; trying again next week")
            break
        try:
            j = r.json()
        except ValueError:
            errors.append(f"{sec}: HTTP {r.status_code}, not JSON")
            continue
        if not j.get("success"):
            errors.append(f"{sec}: {j.get('message') or 'not found'}")
            row["checked"] = now.isoformat()
            state[sec] = row
            continue
        res = j.get("result") or {}
        text = res.get("text") or ""
        row.update({"checked": now.isoformat(), "active": res.get("activeDate"), "title": res.get("title"),
                    "hash": hashlib.sha256(_norm(text).encode()).hexdigest()[:16]})
        # Keep only the normalized phrases the cards need to match, not the statute.
        row["phrases"] = {c["id"]: (_norm(fill(c)) in _norm(text)) for c in cards if c.get("cloze") and cloze_sec(c) == sec}
        row.setdefault("base", row["hash"])                       # the text as first seen; any later change flags
        state[sec] = row
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(state))
    return {"errors": errors}


def cloze_sec(card: dict) -> str | None:
    m = SRC.search((card.get("cloze") or {}).get("source") or "")
    return f"{m.group(1)}/{m.group(2)}" if m else None


def fill(card: dict) -> str:
    cz = card.get("cloze") or {}
    return (cz.get("text") or "").replace("___", cz.get("answer") or "")


def holds(cards: list[dict], cache: Path) -> dict:
    """card id -> reason, for cards whose statute changed after they were verified."""
    if not cache.exists():
        return {}
    state = json.loads(cache.read_text())
    out = {}
    for c in cards:
        for sec in watched(c):
            row = state.get(sec) or {}
            act = row.get("active")
            if act and c.get("verified") and str(act) > str(c["verified"]):
                out[c["id"]] = f"{sec.replace('/', ' § ')} changed {act} (after the card was checked {c['verified']})"
                break
            if row.get("base") and row.get("hash") != row["base"]:
                out[c["id"]] = f"the text of {sec.replace('/', ' § ')} changed since the Wire first read it"
                break
            if row.get("phrases", {}).get(c["id"]) is False:
                out[c["id"]] = f"the quoted text of {sec.replace('/', ' § ')} no longer matches the statute"
                break
    return out
