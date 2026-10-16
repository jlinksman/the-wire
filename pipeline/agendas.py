"""Beacon meeting agendas: item lists and running items.

The Granicus agenda feed links each meeting to an agenda PDF. Joe approved treating
those linked agenda documents like the feed itself (a subscription: one fetch per
agenda, refreshed only while the meeting is upcoming). Each agenda becomes a list of
items, and items that name a street address are tracked across meetings so an
application's history shows up next to it.
"""

from __future__ import annotations

import io
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from pypdf import PdfReader

MAX_NEW_PER_RUN = 10          # backfill older agendas gradually
REFRESH_UPCOMING_H = 6        # agendas get amended before the meeting
TRACK_WINDOW_DAYS = 120       # history shown for an address
SHOW_IF_SEEN_WITHIN_DAYS = 60

TITLE = re.compile(r"^(?P<body>.+?)\s+-\s+(?P<date>[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})")
NUMBERED = re.compile(r"^(\d{1,2})\.\s*(.*)$")
BOILER = re.compile(
    r"^(courtroom|1 municipal plaza|beacon, ny|and live via zoom|call to order|pledge of allegiance|roll call|"
    r"public comment|adjournment|adjourn|approval of .*minutes|reports?:|.*\bagenda$|\d{1,2}:\d{2}\s*[AP]M|"
    r"[A-Z][a-z]+ \d{1,2}, \d{4}$|mayor |councilmember |city administrator |chair |the [\w ]{0,40} will meet)",
    re.IGNORECASE)
HEADINGS = {
    "public hearings", "public hearing", "workshop", "regular meeting", "miscellaneous business", "old business",
    "new business", "resolutions", "local laws", "consent agenda", "presentations", "executive session",
    "work session", "communications", "unfinished business",
}
STREET = (r"(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Place|Lane|Ln\.?|Drive|Dr\.?|Boulevard|Blvd\.?|Terrace|"
          r"Court|Ct\.?|Way|Plaza|Parkway|Hill|Circle|Alley)")
ADDRESS = re.compile(r"\b(\d{1,5}(?:-\d{1,5})?)\s+((?:[A-Z][A-Za-z']+\s){1,3}" + STREET + r")")
NAMED_SITE = re.compile(r"\b(Edgewater Place|Beacon Falls|Tioronda Estates|Dutchess Mall|Long Dock|Main Street Linkage)\b")


def fetch_pdf(session, url: str, timeout: int) -> bytes:
    """Follow Granicus's redirect to its S3 bucket. The bucket name contains underscores,
    which breaks TLS on virtual-hosted S3 names, so use S3's path-style address for the
    same object (same file, certificate still fully verified)."""
    r = session.get(url, timeout=timeout, allow_redirects=False)
    loc = r.headers.get("location") if r.is_redirect else None
    if loc:
        p = urlparse(loc)
        m = re.match(r"^(.+)\.s3\.amazonaws\.com$", p.netloc)
        if m and "_" in m.group(1):
            loc = f"https://s3.amazonaws.com/{m.group(1)}{p.path}"
        r = session.get(loc, timeout=timeout)
    r.raise_for_status()
    if not r.content.startswith(b"%PDF"):
        raise ValueError("agenda link did not return a PDF")
    return r.content


def parse_agenda(pdf: bytes) -> list[dict]:
    text = "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(pdf)).pages)
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in text.splitlines()]
    items, section, cur = [], "", None

    def flush():
        nonlocal cur
        if cur and cur["text"]:
            cur["text"] = cur["text"].strip(" .")
            items.append(cur)
        cur = None

    for ln in lines:
        if not ln:
            continue
        if ln.lower().rstrip(":") in HEADINGS:
            flush()
            section = ln.rstrip(":").title()
            continue
        m = NUMBERED.match(ln)
        if m:
            flush()
            cur = {"n": int(m.group(1)), "text": m.group(2), "section": section}
            continue
        if BOILER.match(ln):
            flush()
            continue
        continuation = (ln[:1].islower() or bool(re.match(r"^\d+-\d", ln))
                        or bool(cur and re.search(r"(,|-|\band|\bor|\bof|\bthe)$", cur["text"])))
        if cur is not None and (continuation or (cur["n"] is not None and not cur["text"].endswith("."))):
            cur["text"] += (" " if cur["text"] else "") + ln   # wrapped line
            continue
        if continuation:
            if items and items[-1]["n"] is not None and not cur:
                items[-1]["text"] += " " + ln   # PDF text order split an item
            continue
        flush()
        words = [w for w in re.findall(r"[A-Za-z][A-Za-z.']*", ln)]
        names_only = words and all(w[0].isupper() for w in words) and not re.search(r"\d", ln)
        fragment = bool(re.match(r"^(?:[A-Z]\.,|\d+\s+[A-Z]\.,|center courtroom)", ln, re.IGNORECASE)
                        or re.search(r"\b(?:Attachment \d|setback|Section \d{2,}|located at)\b", ln))
        if len(ln) > 12 and not ln.isupper() and not names_only and not fragment:
            cur = {"n": None, "text": ln, "section": section}
    flush()

    # Drop exact repeats (City Council agendas list workshop topics, then resolutions).
    seen, out = set(), []
    for it in items:
        key = it["text"].lower()
        if key in seen or len(it["text"]) < 6:
            continue
        seen.add(key)
        it["addr"] = address_key(it["text"])
        it["flags"] = flags(it["text"])
        out.append(it)
    return out[:60]


def address_key(text: str) -> str | None:
    m = ADDRESS.search(text)
    if m:
        street = re.sub(r"\bSt\.?$", "Street", m.group(2))
        street = re.sub(r"\bAve\.?$", "Avenue", street)
        return f"{m.group(1)} {street}".strip()
    m = NAMED_SITE.search(text)
    return m.group(1) if m else None


def flags(text: str) -> list[str]:
    t = text.lower()
    out = []
    if "adjourned" in t:
        out.append("ADJOURNED")
    if "public hearing" in t:
        out.append("HEARING")
    if re.search(r"\b(local law)\b", t):
        out.append("LOCAL LAW")
    if re.search(r"\bresolution no\b", t):
        out.append("RESOLUTION")
    return out


def meeting_date(title: str) -> str | None:
    m = TITLE.match(title)
    if not m:
        return None
    try:
        return datetime.strptime(m.group("date"), "%b %d, %Y").date().isoformat()
    except ValueError:
        return None


def meeting_body(title: str) -> str:
    m = TITLE.match(title)
    return m.group("body") if m else title


def update(state: dict, entries: list[dict], session, timeout: int, log) -> None:
    """Fetch new or upcoming agendas for the Granicus feed entries (newest first)."""
    cache = state.setdefault("agendas", {})
    now = datetime.now(timezone.utc)
    new_fetches = 0
    for e in entries:
        link, title = e["link"], e["title"]
        day = meeting_date(title)
        rec = cache.get(link)
        upcoming = day is not None and day >= (now - timedelta(days=1)).date().isoformat()
        stale = rec and upcoming and (now - datetime.fromisoformat(rec["fetched"])) > timedelta(hours=REFRESH_UPCOMING_H)
        if rec and not stale and rec.get("items") is not None:
            continue
        if not rec and new_fetches >= MAX_NEW_PER_RUN:
            continue
        try:
            items = parse_agenda(fetch_pdf(session, link, timeout))
            err = None
        except Exception as exc:
            items, err = (rec or {}).get("items"), f"{type(exc).__name__}: {exc}"[:200]
            log(f"[agenda] {title}: {err}")
        cache[link] = {"title": title, "body": meeting_body(title), "date": day,
                       "fetched": now.isoformat(), "items": items, "error": err}
        if not rec:
            new_fetches += 1


def tracker(state: dict) -> dict[str, list[dict]]:
    """address -> meetings it appeared on, newest first, within the window."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=TRACK_WINDOW_DAYS)).date().isoformat()
    hist: dict[str, list[dict]] = {}
    for link, rec in (state.get("agendas") or {}).items():
        if not rec.get("items") or not rec.get("date") or rec["date"] < cutoff:
            continue
        for it in rec["items"]:
            if it.get("addr"):
                hist.setdefault(it["addr"], []).append({
                    "date": rec["date"], "body": rec["body"], "link": link,
                    "text": it["text"][:160], "flags": it.get("flags", []),
                })
    recent = (datetime.now(timezone.utc) - timedelta(days=SHOW_IF_SEEN_WITHIN_DAYS)).date().isoformat()
    out = {}
    for addr, rows in hist.items():
        rows.sort(key=lambda r: r["date"], reverse=True)
        # one row per meeting
        uniq, seen = [], set()
        for r in rows:
            k = (r["date"], r["body"])
            if k not in seen:
                seen.add(k)
                uniq.append(r)
        if uniq[0]["date"] >= recent:
            out[addr] = uniq
    return out
