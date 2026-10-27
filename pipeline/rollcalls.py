"""Roll-call votes for Defectors (GAMES.md). House Clerk and Senate LIS XML, public records.

Votes never change once published, so each one is fetched once and kept in the games cache
(.games/votes/, Actions cache, never git). Polite: an honest User-Agent, a pause between requests,
at most MAX_NEW new votes a run, and a full day's back-off after a 403 or 429 (CLAUDE.md rule 5).
"""
from __future__ import annotations

import json
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

MAX_NEW = 40
PAUSE = 0.6
HOUSE = "https://clerk.house.gov/evs/{year}/roll{num:03d}.xml"
SENATE_MENU = "https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_{congress}_{session}.xml"
SENATE_VOTE = "https://www.senate.gov/legislative/LIS/roll_call_votes/vote{congress}{session}/vote_{congress}_{session}_{num:05d}.xml"


def congress_session(day: datetime) -> tuple[int, int]:
    congress = (day.year - 1789) // 2 + 1
    return congress, 1 if day.year % 2 == 1 else 2


def _get(session, url, ua):
    r = session.get(url, headers={"User-Agent": ua}, timeout=30)
    return r.status_code, r.content


def _vote_exists(code, body) -> bool:
    # The Clerk answers a roll that doesn't exist yet with HTTP 200 and an "<xml>Error…" body.
    return code == 200 and body.lstrip().startswith(b"<?xml")


def fetch(cache: Path, session, ua: str, now: datetime, log=print) -> dict:
    """Update the vote cache; return {"house": n_new, "senate": n_new, "errors": {...}}."""
    cache.mkdir(parents=True, exist_ok=True)
    meta_p = cache / "meta.json"
    meta = json.loads(meta_p.read_text()) if meta_p.exists() else {}
    out = {"house": 0, "senate": 0, "errors": {}}
    year = now.year
    # ---- House: probe forward from the last roll we have.
    key = f"house_{year}"
    if meta.get(key + "_blocked_until", "") > now.isoformat():
        out["errors"]["house"] = "backing off after a refusal"
    else:
        last = meta.get(key, 0)
        if not last:                       # first run: find the newest roll by doubling, then step back
            n, hi = 1, None
            while n < 3000:
                code, body = _get(session, HOUSE.format(year=year, num=n), ua)
                time.sleep(PAUSE)
                if _vote_exists(code, body):
                    n *= 2
                else:
                    hi = n
                    break
            lo = max(1, (hi or n) // 2)
            while lo + 1 < (hi or n):
                mid = (lo + (hi or n)) // 2
                code, body = _get(session, HOUSE.format(year=year, num=mid), ua)
                time.sleep(PAUSE)
                if _vote_exists(code, body):
                    lo = mid
                else:
                    hi = mid
            last = max(0, lo - MAX_NEW)
        n = last + 1
        while out["house"] < MAX_NEW:
            code, body = _get(session, HOUSE.format(year=year, num=n), ua)
            time.sleep(PAUSE)
            if code in (403, 429):
                meta[key + "_blocked_until"] = (now + timedelta(days=1)).isoformat()
                out["errors"]["house"] = f"HTTP {code}"
                break
            if not _vote_exists(code, body):
                break
            (cache / f"h{year}-{n:04d}.xml").write_bytes(body)
            meta[key] = n
            out["house"] += 1
            n += 1
    # ---- Senate: the menu lists vote numbers.
    congress, sess = congress_session(now)
    skey = f"senate_{congress}_{sess}"
    if meta.get(skey + "_blocked_until", "") > now.isoformat():
        out["errors"]["senate"] = "backing off after a refusal"
    else:
        code, body = _get(session, SENATE_MENU.format(congress=congress, session=sess), ua)
        time.sleep(PAUSE)
        if code in (403, 429) or not body.lstrip().startswith(b"<?xml"):
            meta[skey + "_blocked_until"] = (now + timedelta(days=1)).isoformat()
            out["errors"]["senate"] = f"HTTP {code}" + ("" if code in (403, 429) else " (not XML)")
        else:
            nums = sorted({int(x) for x in re.findall(rb"<vote_number>(\d+)</vote_number>", body)}, reverse=True)
            for num in nums[: MAX_NEW * 2]:
                f = cache / f"s{congress}-{sess}-{num:05d}.xml"
                if f.exists():
                    continue
                if out["senate"] >= MAX_NEW:
                    break
                code, vb = _get(session, SENATE_VOTE.format(congress=congress, session=sess, num=num), ua)
                time.sleep(PAUSE)
                if code in (403, 429):
                    meta[skey + "_blocked_until"] = (now + timedelta(days=1)).isoformat()
                    out["errors"]["senate"] = f"HTTP {code}"
                    break
                if code == 200 and vb.lstrip().startswith(b"<?xml"):
                    f.write_bytes(vb)
                    out["senate"] += 1
    meta_p.write_text(json.dumps(meta))
    return out


def _t(el, path, default=""):
    x = el.find(path)
    return (x.text or "").strip() if x is not None and x.text else default


def parse(cache: Path, legislators: dict) -> list[dict]:
    """All cached votes as dicts. legislators: bioguide/lis id -> {name, last, party, state}."""
    votes = []
    for f in sorted(cache.glob("h*.xml")):
        try:
            root = ET.fromstring(f.read_bytes())
        except ET.ParseError:
            continue
        m = root.find("vote-metadata")
        date = datetime.strptime(_t(m, "action-date"), "%d-%b-%Y").date().isoformat()
        num = int(_t(m, "rollcall-num"))
        members = []
        for rv in root.iter("recorded-vote"):
            lg = rv.find("legislator")
            bid = lg.get("name-id")
            info = legislators.get(bid, {})
            members.append({"id": bid, "name": info.get("name") or lg.text, "last": info.get("last") or lg.get("unaccented-name"),
                            "party": lg.get("party"), "state": lg.get("state"), "vote": _norm_vote(_t(rv, "vote"))})
        votes.append({"chamber": "house", "num": num, "date": date, "question": _t(m, "vote-question"),
                      "bill": _t(m, "legis-num"), "desc": _t(m, "vote-desc"), "result": _t(m, "vote-result"),
                      "link": f"https://clerk.house.gov/Votes/{date[:4]}{num}", "members": members})
    for f in sorted(cache.glob("s*.xml")):
        try:
            root = ET.fromstring(f.read_bytes())
        except ET.ParseError:
            continue
        num = int(_t(root, "vote_number") or 0)
        date_s = _t(root, "vote_date")
        try:
            date = datetime.strptime(date_s.split(",")[0] + "," + date_s.split(",")[1], "%B %d, %Y").date().isoformat()
        except (ValueError, IndexError):
            date = ""
        doc = root.find("document")
        bill = " ".join(x for x in (_t(doc, "document_type"), _t(doc, "document_number")) if x) if doc is not None else ""
        members = []
        for mm in root.iter("member"):
            lis = _t(mm, "lis_member_id")
            info = legislators.get(lis, {})
            members.append({"id": info.get("bioguide") or lis, "name": info.get("name") or f"{_t(mm, 'first_name')} {_t(mm, 'last_name')}",
                            "last": _t(mm, "last_name"), "party": _t(mm, "party"), "state": _t(mm, "state"), "vote": _norm_vote(_t(mm, "vote_cast"))})
        congress, sess = _t(root, "congress"), _t(root, "session")
        votes.append({"chamber": "senate", "num": num, "date": date, "question": _t(root, "question") or _t(root, "vote_question_text"),
                      "bill": bill, "desc": _t(root, "vote_title") or _t(root, "vote_document_text"), "result": _t(root, "vote_result"),
                      "link": f"https://www.senate.gov/legislative/LIS/roll_call_votes/vote{congress}{sess}/vote_{congress}_{sess}_{num:05d}.htm",
                      "members": members})
    return votes


def _norm_vote(v: str) -> str:
    v = v.lower()
    if v in ("aye", "yea", "yes"):
        return "Yea"
    if v in ("no", "nay"):
        return "Nay"
    if v.startswith("present"):
        return "Present"
    return "Not voting"


# Plain words for what a Yea meant (mandatory on every Defectors card, GAMES.md).
YEA_MEANT = [
    (r"suspend the rules and pass", "Yea = pass it under a fast-track rule that needs two-thirds"),
    (r"suspend the rules and agree", "Yea = adopt it under a fast-track rule that needs two-thirds"),
    (r"cloture", "Yea = end debate and move to a final vote (needs 60 in most cases)"),
    (r"passage|^on passage|pass(ing)? the bill", "Yea = pass the bill"),
    (r"agreeing to the conference report|conference report", "Yea = approve the final House–Senate version"),
    (r"agreeing to the amendment|on the amendment", "Yea = add the amendment"),
    (r"joint resolution", "Yea = pass the joint resolution"),
    (r"concur", "Yea = accept the other chamber's changes"),
    (r"nomination|confirmation", "Yea = confirm the nominee"),
    (r"override", "Yea = override the veto"),
]
PROCEDURAL = re.compile(r"table|previous question|adjourn|journal|quorum|motion to proceed|recommit|instruct|reconsider|point of order|rule\b|providing for consideration|waive", re.I)


def yea_meant(question: str, desc: str) -> str | None:
    q = f"{question} {desc}".lower()
    if PROCEDURAL.search(question) or re.match(r"providing for consideration", desc or "", re.I):
        return None
    for pat, words in YEA_MEANT:
        if re.search(pat, q):
            return words
    return None
