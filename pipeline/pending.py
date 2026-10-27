"""Pending docket (GAMES.md): one optional prediction per newly argued Supreme Court case, scored
automatically when the Court decides it.

Two public sources, each fetched politely:
- Oyez (api.oyez.org, CC BY-NC; crawl delay 10 s): the term's case list, once a day, for which cases
  have been argued and the question presented. Joe's use is private and non-commercial; the
  question is shown short and credited.
- supremecourt.gov (crawl delay 20 min): when a pending case shows up in the slip-opinion list
  (scotus.py), the hourly docket-check workflow reads that opinion's syllabus, one PDF per run, for
  the judgment line ("Reversed and remanded.", "Affirmed."). Oyez's own decision field is often
  empty months later, so it isn't used for scoring.

The build publishes the pending cases and the dispositions. Joe's predictions live only in his
private games.json (functions/games.js); this program never sees them (CLAUDE.md rule 10).
"""
from __future__ import annotations

import html
import io
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

OYEZ = "https://api.oyez.org/cases?per_page=0&filter=term:{year}"


def fetch_oyez(cache: Path, session, ua: str, now: datetime) -> dict:
    cache.mkdir(parents=True, exist_ok=True)
    meta_p = cache / "oyez_meta.json"
    meta = json.loads(meta_p.read_text()) if meta_p.exists() else {}
    if meta.get("blocked_until", "") > now.isoformat():
        return {"error": "backing off after a refusal"}
    if meta.get("last", "") > (now - timedelta(hours=20)).isoformat():
        return {"error": None}
    year = now.year if now.month >= 10 else now.year - 1
    # The previous term once (its argued-but-undecided cases still matter until June), then the current.
    term = year if (cache / f"oyez_{year - 1}.json").exists() else year - 1
    headers = {"User-Agent": ua}
    if meta.get(f"etag_{term}"):
        headers["If-None-Match"] = meta[f"etag_{term}"]
    r = session.get(OYEZ.format(year=term), headers=headers, timeout=60)
    meta["last"] = now.isoformat()
    if r.status_code in (403, 429):
        meta["blocked_until"] = (now + timedelta(days=2)).isoformat()
    elif r.status_code == 200:
        try:
            data = r.json()
        except ValueError:
            data = None
        if isinstance(data, list):
            (cache / f"oyez_{term}.json").write_text(json.dumps(data))
            if r.headers.get("ETag"):
                meta[f"etag_{term}"] = r.headers["ETag"]
    meta_p.write_text(json.dumps(meta))
    return {"error": None if r.status_code in (200, 304) else f"HTTP {r.status_code}"}


def _text(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def pending(cache: Path, slip_rows: list[dict], court_ok, now: datetime) -> list[dict]:
    """Argued, not yet in the Court's slip-opinion list. Newest argument first."""
    decided = {r["docket"] for r in slip_rows}
    out = []
    for f in sorted(cache.glob("oyez_[0-9]*.json")):
        for c in json.loads(f.read_text()):
            dk = (c.get("docket_number") or "").strip()
            argued = [d for ev in (c.get("timeline") or []) if ev.get("event") == "Argued" for d in (ev.get("dates") or [])]
            if not dk or not argued or dk in decided:
                continue
            if any(ev.get("event") == "Decided" for ev in (c.get("timeline") or [])):
                continue
            when = datetime.fromtimestamp(min(argued), tz=timezone.utc)
            if when > now:
                continue
            name = _text(c.get("name"))
            q = _text(c.get("question"))
            if not q or " v. " not in name:
                continue
            if court_ok({"name": name, "holding": q}):
                continue
            pet, resp = name.split(" v. ", 1)
            out.append({"docket": dk, "name": name, "petitioner": pet.strip(), "respondent": resp.strip(),
                        "argued": when.date().isoformat(), "question": q[:420] + ("…" if len(q) > 420 else ""),
                        "term": c.get("term"), "link": (c.get("justia_url") or c.get("href") or "").replace(" ", "")})
    out.sort(key=lambda x: x["argued"], reverse=True)
    return out


# ------------------------------------------------------------------ dispositions (hourly workflow)
JUDGMENT = re.compile(r"\b((?:Reversed|Affirmed|Vacated)(?: in part)?(?:,? (?:and|or) (?:reversed|affirmed|vacated)(?: in part)?)*(?:,? and remanded)?|Dismissed as improvidently granted)\.", re.I)


def disposition(text: str) -> tuple[str, str] | None:
    """From a slip opinion's syllabus: (side, judgment line). side is petitioner, respondent or mixed."""
    syl = text.split("delivered the opinion of the Court")[0] if "delivered the opinion of the Court" in text else text[:20000]
    hits = JUDGMENT.findall(syl)
    if not hits:
        return None
    line = hits[-1].strip()
    low = line.lower()
    if "in part" in low or "dismissed" in low:
        return "mixed", line
    if low.startswith("affirmed"):
        return "respondent", line
    return "petitioner", line                          # reversed or vacated: the petitioner won


def check_one(disp_path: Path, slip_rows: list[dict], pend_path: Path, session, ua: str, now: datetime) -> str:
    """Read at most ONE syllabus: the oldest decided case that was pending and has no disposition yet."""
    disp = json.loads(disp_path.read_text()) if disp_path.exists() else {}
    if disp.get("_blocked_until", "") > now.isoformat():
        return "backing off after a refusal"
    if disp.get("_last", "") > (now - timedelta(minutes=21)).isoformat():
        return "waiting out the Court's 20-minute crawl delay"
    seen = set(json.loads(pend_path.read_text())) if pend_path.exists() else set()
    todo = sorted((r for r in slip_rows if r["docket"] in seen and r["docket"] not in disp and r.get("pdf")), key=lambda r: r["date"])
    if not todo:
        return "nothing to check"
    r = todo[0]
    resp = session.get(r["pdf"], headers={"User-Agent": ua}, timeout=60)
    disp["_last"] = now.isoformat()
    if resp.status_code in (403, 429):
        disp["_blocked_until"] = (now + timedelta(days=1)).isoformat()
        disp_path.write_text(json.dumps(disp))
        return f"HTTP {resp.status_code}; backing off a day"
    if resp.status_code != 200:
        disp_path.write_text(json.dumps(disp))
        return f"HTTP {resp.status_code}"
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(resp.content))
    text = " ".join((p.extract_text() or "") for p in reader.pages[:8])
    got = disposition(re.sub(r"\s+", " ", text))
    disp[r["docket"]] = {"side": got[0], "line": got[1], "date": r["date"], "name": r["name"]} if got else {"side": "unknown", "date": r["date"], "name": r["name"]}
    disp_path.write_text(json.dumps(disp))
    return f"{r['docket']}: {disp[r['docket']]['side']}"
