"""Israel's election night: the count, from Oct 27 at poll close (Israel section, 2026-10-22).

Primary source: the Central Elections Committee's results site. In 2022 it was
votes25.bechirot.gov.il; the 26th Knesset's is expected at votes26.bechirot.gov.il with the
same layout (checked 2026-10-22: the 2022 site is up and reachable from the cloud; the 2026
one isn't live yet). Its /nationalresults page has two tables: totals (eligible voters, votes
entered, "סופי" once final, turnout) and the lists (name, ballot letters, seats, %, votes).

Fallback: the results table on Wikipedia's 2026 election page, labeled as crowd-edited.

The page shows seats by list and by bloc, the share of votes counted so far, and says plainly
which source it is and whether the count is final. Exit polls are not numbers we parse; they
arrive as headlines from the outlets.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from bs4 import BeautifulSoup

POLLS_CLOSE = datetime(2026, 10, 27, 20, 0, tzinfo=timezone.utc)   # 10 PM Israel time (UTC+2 after DST ends Oct 25)
STOP_AFTER = datetime(2026, 11, 20, tzinfo=timezone.utc)
CEC_URLS = ["https://votes26.bechirot.gov.il/nationalresults"]
CEC_HOME = "https://votes26.bechirot.gov.il/"
WIKI_PAGE = "2026_Israeli_legislative_election"
WIKI_URL = f"https://en.wikipedia.org/api/rest_v1/page/html/{WIKI_PAGE}"
WIKI_LINK = f"https://en.wikipedia.org/wiki/{WIKI_PAGE}"

# Hebrew and English list names -> (English name, bloc). Bloc: gov, opp, arab. Order matters.
W = r"(?<![\w\u0590-\u05FF])"     # a word start, Hebrew letters included
E = r"(?![\w\u0590-\u05FF])"
LISTS = [
    (W + r"הליכוד|Likud", "Likud", "gov"),
    (r'ש"ס|התאחדות הספרדים שומרי תורה|Shas', "Shas", "gov"),
    (r"יהדות התורה|United Torah|UTJ", "United Torah Judaism", "gov"),
    (r"הציונות הדתית|Religious Zionis|RZP", "Religious Zionism", "gov"),
    (r"עוצמה יהודית|Otzma", "Otzma Yehudit", "gov"),
    (W + r"נעם" + E + r"|Noam", "Noam", "gov"),
    (r'רע"מ|הרשימה הערבית המאוחדת|Ra.?am|United Arab List', "Ra'am", "arab"),
    (r'הרשימה המשותפת|חד"ש|תע"ל|בל"ד|Joint List|Hadash|Balad|Ta.?al', "Joint List", "arab"),
    (r"ישראל ביתנו|Yisrael Beiteinu", "Yisrael Beiteinu", "opp"),
    (W + r"ישר" + E + r"|Yashar", "Yashar (Eisenkot)", "opp"),
    (W + r"ב?יחד" + E + r"|Together|Bennett|בנט", "Together (Bennett–Lapid)", "opp"),
    (r"יש עתיד|Yesh Atid", "Yesh Atid", "opp"),
    (r"הדמוקרטים|העבודה|מרצ|Democrats|Labor|Meretz", "The Democrats", "opp"),
    (r"כחול לבן|Blue and White|Blue & White", "Blue and White", "opp"),
    (r"המחנה הממלכתי|National Unity", "National Unity", "opp"),
    (r"מילואימניקים|Reservists", "Reservists", "opp"),
]


def name_bloc(name: str) -> tuple[str, str]:
    for pat, en, bloc in LISTS:
        if re.search(pat, name, re.IGNORECASE):
            return en, bloc
    return name.strip()[:40], "opp"


def _num(s: str) -> float | None:
    s = s.replace(",", "").replace("%", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def parse_cec(html: str) -> dict | None:
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    totals, lists = {}, []
    for t in tables:
        rows = [[c.get_text(" ", strip=True) for c in r.find_all(["th", "td"])] for r in t.find_all("tr")]
        if not rows:
            continue
        head = " ".join(rows[0])
        if "בעלי זכות" in head and len(rows) > 1:
            h, v = rows[0], rows[1]
            for k, val in zip(h, v):
                if "בעלי זכות" in k:
                    totals["eligible"] = _num(val)
                elif "שהוזנו" in k and "כשרים" not in k and "פסולים" not in k:
                    totals["entered"] = _num(val)
                    totals["final"] = "סופי" in k
                elif "שיעור" in k:
                    totals["turnout"] = _num(val)
        if "שם הרשימה" in head and "מנדטים" in head:
            idx = {k: i for i, k in enumerate(rows[0])}
            i_name = 0
            i_letters = next((i for k, i in idx.items() if "אותיות" in k), 1)
            i_seats = next(i for k, i in idx.items() if "מנדטים" in k)
            i_pct = next((i for k, i in idx.items() if k.startswith("אחוז")), None)
            i_votes = next((i for k, i in idx.items() if k.startswith("מספר הקולות")), None)
            for r in rows[1:]:
                if len(r) <= i_seats:
                    continue
                seats = _num(r[i_seats])
                if seats is None:
                    continue
                en, bloc = name_bloc(r[i_name])
                lists.append({"name": en, "name_he": r[i_name][:80], "letters": r[i_letters] if i_letters < len(r) else "",
                              "seats": int(seats), "pct": _num(r[i_pct]) if i_pct is not None else None,
                              "votes": int(_num(r[i_votes]) or 0) if i_votes is not None else None, "bloc": bloc})
    if not lists or not any(x["seats"] or x["votes"] for x in lists):
        return None
    return {"totals": totals, "lists": lists}


def parse_wiki(html: str) -> dict | None:
    """The results table: Party | Votes | % | Seats (+/–). Best effort, with sanity checks."""
    soup = BeautifulSoup(html, "html.parser")
    for t in soup.find_all("table", class_="wikitable"):
        rows = [[c.get_text(" ", strip=True) for c in r.find_all(["th", "td"])] for r in t.find_all("tr")]
        if not rows:
            continue
        head = [h.lower() for h in rows[0]]
        if not ("party" in " ".join(head) and "votes" in " ".join(head) and "seats" in " ".join(head)):
            continue
        i_party = next(i for i, h in enumerate(head) if "party" in h)
        i_votes = next(i for i, h in enumerate(head) if h.startswith("votes"))
        i_seats = next(i for i, h in enumerate(head) if h.startswith("seats"))
        lists = []
        for r in rows[1:]:
            # Rows often carry a color cell first; align from the right when the row is longer.
            off = len(r) - len(rows[0])
            if off < 0 or len(r) <= i_seats + off:
                continue
            name = r[i_party + off] or r[i_party]
            if re.search(r"^(total|valid|invalid|blank|registered|turnout|source)", name, re.IGNORECASE):
                continue
            seats, votes = _num(re.sub(r"[^\d.]", "", r[i_seats + off]) or "x"), _num(re.sub(r"[^\d.]", "", r[i_votes + off]) or "x")
            if seats is None or votes is None:
                continue
            en, bloc = name_bloc(name)
            lists.append({"name": en, "seats": int(seats), "votes": int(votes), "pct": None, "bloc": bloc})
        total = sum(x["seats"] for x in lists)
        if lists and 100 <= total <= 120 and any(x["votes"] for x in lists):
            vt = sum(x["votes"] for x in lists)
            for x in lists:
                x["pct"] = round(100 * x["votes"] / vt, 2) if vt else None
            return {"totals": {}, "lists": lists}
    return None


def run(state: dict, data: dict, session, log) -> dict | None:
    now = datetime.now(timezone.utc)
    if now < POLLS_CLOSE - timedelta(minutes=30) or now > STOP_AFTER:
        return None
    rec = state.setdefault("il_results", {})
    err, got, src = None, None, None
    # Every build for the first day, hourly after that.
    every = timedelta(minutes=14) if now < POLLS_CLOSE + timedelta(days=1) else timedelta(minutes=55)
    last = rec.get("tried")
    if not last or now - datetime.fromisoformat(last) >= every:
        rec["tried"] = now.isoformat()
        for url in CEC_URLS:
            try:
                r = session.get(url, timeout=30)
                if r.status_code == 200:
                    got = parse_cec(r.text)
                    if got:
                        src = {"name": "Central Elections Committee", "link": CEC_HOME, "official": True}
                        break
                err = f"CEC HTTP {r.status_code}" if r.status_code != 200 else "CEC page had no results yet"
            except Exception as exc:
                err = f"CEC {type(exc).__name__}"
        if not got:
            try:
                r = session.get(WIKI_URL, timeout=40, headers={"Accept": "text/html"})
                if r.status_code == 200:
                    got = parse_wiki(r.text)
                    if got:
                        src = {"name": "Wikipedia (crowd-edited, from the committee's count)", "link": WIKI_LINK, "official": False}
                else:
                    err = (err + "; " if err else "") + f"Wikipedia HTTP {r.status_code}"
            except Exception as exc:
                err = (err + "; " if err else "") + f"Wikipedia {type(exc).__name__}"
        if got:
            lists = sorted(got["lists"], key=lambda x: (-x["seats"], -(x["votes"] or 0)))
            blocs = {b: sum(x["seats"] for x in lists if x["bloc"] == b) for b in ("gov", "opp", "arab")}
            tot = got["totals"]
            counted = None
            if tot.get("entered") and tot.get("eligible") and tot.get("turnout"):
                expected = tot["eligible"] * tot["turnout"] / 100
                counted = round(min(100, 100 * tot["entered"] / expected), 1) if expected else None
            rec.update({"at": now.isoformat(), "source": src, "lists": lists, "blocs": blocs, "totals": tot,
                        "final": bool(tot.get("final")), "counted_pct": counted, "error": None})
            log(f"[il_results] {src['name']}: gov {blocs['gov']} · opp {blocs['opp']} · arab {blocs['arab']}"
                f"{' · final' if tot.get('final') else ''}")
        else:
            rec["error"] = err or "no results yet"
            log(f"[il_results] {rec['error']}")
    if rec.get("lists"):
        data["il_results"] = {k: rec.get(k) for k in ("at", "source", "lists", "blocs", "totals", "final", "counted_pct")}
    return {"id": "il_results", "name": "Israel election results (elections committee, Wikipedia fallback)", "short": "Israel results",
            "desk": "SYSTEM", "poll": 15, "last_success": rec.get("at"), "last_attempt": rec.get("tried"),
            "last_error": rec.get("error") if not rec.get("lists") or rec.get("error") else None,
            "last_status": None, "robots": "honored", "items": len(rec.get("lists") or [])}
