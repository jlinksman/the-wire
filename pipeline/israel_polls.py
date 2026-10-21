"""Israel's election: the latest seat polls, by pollster (Israel section, 2026-10-21).

Source: Wikipedia's "Opinion polling for the 2026 Israeli legislative election" page, read
through Wikimedia's REST API (rendered HTML; a polite request every few hours with an honest
User-Agent). Each poll there links its publisher's report; we show the pollster, the channel
that published it, the fieldwork date, seats per list and the government bloc, and link the page.

Nothing is averaged. Pollsters differ a lot (Channel 14's polls run well above the others for
the government bloc), so the page shows each pollster's latest poll and the range across them.
Cells reading "(2.5%)" are lists polling under the 3.25% threshold: 0 seats. "N/a" means the
pollster didn't poll that list.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from bs4 import BeautifulSoup

PAGE = "Opinion_polling_for_the_2026_Israeli_legislative_election"
URL = f"https://en.wikipedia.org/api/rest_v1/page/html/{PAGE}"
LINK = f"https://en.wikipedia.org/wiki/{PAGE}"
EVERY_H = 3
KEEP_DAYS = 10            # polls older than this don't count as "latest"
ELECTION = "2026-10-27"
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
ARAB_LISTS = re.compile(r"Ra'?am|Joint List|Hadash|Balad|Ta'?al", re.IGNORECASE)


def _text(cell) -> str:
    for sup in cell.find_all("sup"):
        sup.decompose()
    return re.sub(r"\s+", " ", cell.get_text(" ", strip=True)).strip()


def _expand(cells) -> list[str]:
    out = []
    for c in cells:
        m = re.match(r"\d+", str(c.get("colspan") or "1"))
        out += [_text(c)] * (int(m.group(0)) if m else 1)
    return out


def _date(s: str, year: int, today: datetime) -> datetime | None:
    """'20 Oct' or '3– 4 Sep' (a range: the last day counts)."""
    m = re.findall(r"(\d{1,2})\s*([A-Za-z]{3})", s)
    if not m:
        m2 = re.search(r"(\d{1,2})\s*[–-]\s*(\d{1,2})\s*([A-Za-z]{3})", s)
        if not m2:
            return None
        m = [(m2.group(2), m2.group(3))]
    day, mon = m[-1]
    mon_i = MONTHS.get(mon.lower())
    if not mon_i:
        return None
    d = datetime(year, mon_i, int(day), 12, tzinfo=timezone.utc)
    if d > today + timedelta(days=2):          # a December poll read in January, say
        d = d.replace(year=year - 1)
    return d


def _seats(v: str):
    v = v.replace("—", "").strip()
    if re.fullmatch(r"\d{1,2}", v):
        return int(v)
    if re.match(r"\(?\d+(\.\d+)?%\)?", v):
        return 0                                # under the threshold
    return None                                 # N/a, blank


def parse(html: str, now: datetime) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    polls = []
    for table in soup.find_all("table", class_="wikitable"):
        rows = table.find_all("tr")
        if not rows:
            continue
        head = _expand(rows[0].find_all(["th", "td"]))
        if not head or "Polling firm" not in head or not any(h.startswith("Gov") for h in head):
            continue
        h2 = table.find_previous(["h2", "h3"])
        year = int(m.group(0)) if h2 and (m := re.search(r"20\d\d", h2.get_text())) else now.year
        try:
            i_date, i_firm, i_pub = head.index("Fieldwork date"), head.index("Polling firm"), head.index("Publisher")
        except ValueError:
            continue
        i_gov = next(i for i, h in enumerate(head) if h.startswith("Gov"))
        i_sample = head.index("Sample size") if "Sample size" in head else None
        party_cols = []
        for i, h in enumerate(head):
            if i in (i_date, i_firm, i_pub, i_gov, i_sample) or h in ("Others", "Lead", ""):
                continue
            if not party_cols or party_cols[-1][1] != h:      # colspan-expanded duplicates
                party_cols.append((i, h))
        for r in rows[1:]:
            vals = _expand(r.find_all(["th", "td"]))
            if len(vals) < len(head) - 1 or not any(re.fullmatch(r"\d{1,2}", v) for v in vals[i_gov:i_gov + 1]):
                continue                                       # an event row or the color row
            d = _date(vals[i_date], year, now)
            if not d:
                continue
            seats = {}
            for i, name in party_cols:
                n = _seats(vals[i]) if i < len(vals) else None
                if n is not None:
                    seats[re.sub(r"\s*-\s*", "–", name)] = n
            total = sum(seats.values())
            if not 100 <= total <= 120:                        # a mis-read row
                continue
            gov = int(vals[i_gov])
            arab = sum(n for k, n in seats.items() if ARAB_LISTS.search(k))
            polls.append({"date": d.date().isoformat(), "firm": vals[i_firm], "publisher": re.sub(r"\s*\[.*?\]", "", vals[i_pub]).strip(),
                          "sample": vals[i_sample] if i_sample is not None else None, "seats": seats, "gov": gov,
                          "opp": 120 - gov - arab, "arab": arab})
    return polls


def run(state: dict, data: dict, session, log) -> dict:
    """Refresh every EVERY_H hours; always ship the last good result. Returns a health row."""
    rec = state.setdefault("il_polls", {})
    now = datetime.now(timezone.utc)
    last = rec.get("fetched")
    err = None
    if not last or now - datetime.fromisoformat(last) >= timedelta(hours=EVERY_H):
        try:
            r = session.get(URL, timeout=40, headers={"Accept": "text/html"})
            if r.status_code in (403, 429):
                raise RuntimeError(f"HTTP {r.status_code}")
            r.raise_for_status()
            polls = parse(r.text, now)
            if not polls:
                raise ValueError("no poll rows found (the table layout may have changed)")
            rec.update({"fetched": now.isoformat(), "polls": polls[:80], "error": None})
            log(f"[il_polls] {len(polls)} polls read; newest {polls[0]['date']} {polls[0]['firm']} ({polls[0]['publisher']}) gov={polls[0]['gov']}")
        except Exception as exc:
            err = f"{type(exc).__name__}: {exc}"[:200]
            rec["error"] = err
            rec["fetched_try"] = now.isoformat()
            log(f"[il_polls] {err}")
    polls = rec.get("polls") or []
    if polls:
        cutoff = (now - timedelta(days=KEEP_DAYS)).date().isoformat()
        latest, seen = [], set()
        for p in sorted(polls, key=lambda p: p["date"], reverse=True):
            key = p["publisher"] or p["firm"]
            if key in seen or p["date"] < cutoff:
                continue
            seen.add(key)
            latest.append(p)
        govs = sorted(p["gov"] for p in latest)
        data["il_polls"] = {
            "as_of": rec.get("fetched"), "source": LINK, "election": ELECTION, "latest": latest[:8],
            "gov_range": [govs[0], govs[-1]] if govs else None, "gov_median": govs[len(govs) // 2] if govs else None,
            "majority": 61, "threshold": "3.25%",
        }
    return {"id": "il_polls", "name": "Israel election polls (Wikipedia's poll table)", "short": "Israel polls", "desk": "SYSTEM",
            "poll": EVERY_H * 60, "last_success": rec.get("fetched"), "last_attempt": rec.get("fetched_try") or rec.get("fetched"),
            "last_error": rec.get("error"), "last_status": None, "robots": "honored", "items": len(polls)}
