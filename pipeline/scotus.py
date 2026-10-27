"""Supreme Court opinions for The Docket (GAMES.md). Public records from supremecourt.gov.

The Court's robots.txt asks for 20 minutes between requests, so the daily games job makes at most
ONE request a run: the slip-opinion list for the current term (or, on alternate days while the new
term has no opinions yet, the previous term). Rows are cached in the games cache (Actions cache,
never git). Each row carries the Court's own one-sentence holding, the date, docket number, case
name and author.
"""
from __future__ import annotations

import html
import json
import re
from datetime import datetime, timedelta
from pathlib import Path

LIST = "https://www.supremecourt.gov/opinions/slipopinion/{term}"
AUTHORS = {"R": "John Roberts", "T": "Clarence Thomas", "A": "Samuel Alito", "SS": "Sonia Sotomayor",
           "EK": "Elena Kagan", "NG": "Neil Gorsuch", "BK": "Brett Kavanaugh", "AB": "Amy Coney Barrett",
           "KJ": "Ketanji Brown Jackson", "PC": "Per curiam (unsigned)"}


def term_for(now: datetime) -> int:
    """October Term year, two digits (OT2026 runs from October 2026)."""
    y = now.year if now.month >= 10 else now.year - 1
    return y % 100


def fetch(cache: Path, session, ua: str, now: datetime) -> dict:
    cache.mkdir(parents=True, exist_ok=True)
    meta_p = cache / "scotus_meta.json"
    meta = json.loads(meta_p.read_text()) if meta_p.exists() else {}
    if meta.get("blocked_until", "") > now.isoformat():
        return {"fetched": None, "error": "backing off after a refusal"}
    if meta.get("last", "") > (now - timedelta(hours=20)).isoformat():
        return {"fetched": None, "error": None}                     # one request a day at most
    cur = term_for(now)
    # The previous term is final once cached, so: fetch it once, then refresh only the current term.
    term = cur if (cache / f"scotus_{cur - 1}.html").exists() else cur - 1
    r = session.get(LIST.format(term=term), headers={"User-Agent": ua}, timeout=30)
    meta["last"] = now.isoformat()
    if r.status_code in (403, 429):
        meta["blocked_until"] = (now + timedelta(days=2)).isoformat()
        meta_p.write_text(json.dumps(meta))
        return {"fetched": term, "error": f"HTTP {r.status_code}"}
    if r.status_code == 200:
        n = len(parse_html(r.text, term))
        meta[f"rows_{term}"] = n
        if n:
            (cache / f"scotus_{term}.html").write_bytes(r.content)
    meta_p.write_text(json.dumps(meta))
    return {"fetched": term, "error": None if r.status_code == 200 else f"HTTP {r.status_code}"}


def parse_html(text: str, term: int) -> list[dict]:
    rows = []
    for tr in re.findall(r"<tr.*?</tr>", text, re.S):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        if len(tds) < 5:
            continue
        a = re.search(r"href='([^']+\.pdf)'[^>]*title=\"([^\"]*)\"[^>]*>(.*?)</a>", tds[3], re.S)
        if not a:
            continue
        try:
            d = datetime.strptime(re.sub("<.*?>", "", tds[1]).strip(), "%m/%d/%y").date().isoformat()
        except ValueError:
            continue
        code = re.sub("<.*?>", "", tds[4]).strip()
        rows.append({"term": term, "date": d, "docket": re.sub("<.*?>", "", tds[2]).strip(),
                     "name": html.unescape(re.sub("<.*?>", "", a.group(3))).strip(),
                     "holding": html.unescape(a.group(2)).strip(), "author_code": code, "author": AUTHORS.get(code),
                     "pdf": "https://www.supremecourt.gov" + a.group(1),
                     "emergency": bool(re.match(r"\d+A\d+", re.sub("<.*?>", "", tds[2]).strip()))})
    return rows


def rows(cache: Path) -> list[dict]:
    out = []
    for f in sorted(cache.glob("scotus_*.html")):
        term = int(re.search(r"scotus_(\d+)", f.name).group(1))
        out += parse_html(f.read_text(errors="ignore"), term)
    return out
