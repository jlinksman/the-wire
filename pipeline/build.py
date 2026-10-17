"""The Wire — V1 build.

Reads sources.yaml, fetches every enabled source politely, merges new items
into a rolling 7-day store, and writes dist/ (the static site plus data.json).

One failing source never fails the build: its error is recorded and shown in
source health on the page.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import shutil
import sys
import time
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from urllib.parse import urljoin, urlparse

import feedparser
import requests
import yaml
import io
from bs4 import BeautifulSoup
from pypdf import PdfReader
from protego import Protego

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agendas  # noqa: E402
import stories  # noqa: E402
import alerts  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "sources.yaml"
SITE = ROOT / "site"
DIST = ROOT / "dist"
STATE_DIR = ROOT / ".state"
STATE_FILE = STATE_DIR / "state.json"

CONTACT = os.environ.get("WIRE_CONTACT", "")
USER_AGENT = "TheWire/1.0 (private personal news reader; polite polling" + (f"; {CONTACT}" if CONTACT else "") + ")"
TIMEOUT = 25
KEEP_DAYS = 7
# Courts and city offices publish in batches, so every source keeps its newest few
# items for longer than the 7-day window.
MIN_PER_SOURCE = 5
MIN_KEEP_DAYS = 45
MAX_ITEMS = 1500
SUMMARY_CHARS = 300
ROBOTS_TTL_HOURS = 24
BLOCKED_BACKOFF_MIN = 60

# Desk used when a source does not name one, by sources.yaml section.
SECTION_DESK = {
    "beacon": "BEACON", "regional": "BEACON",
    "dutchess": "GOV", "new_york": "GOV", "courts": "GOV", "federal": "GOV",
    "law": "LAW",
    "national_world": "WORLD", "paris": "WORLD", "tel_aviv": "WORLD", "osint": "WORLD",
    "sports": "SPORTS",
}

NY = ZoneInfo("America/New_York")
BEACON_WEATHER_PAGE = "https://forecast.weather.gov/MapClick.php?lat=41.5048&lon=-73.9696"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------- config

def load_config():
    cfg = yaml.safe_load(CONFIG.read_text())
    sources = []
    for section, entries in cfg.items():
        if not isinstance(entries, list):
            continue
        for s in entries:
            if not isinstance(s, dict) or not s.get("enabled"):
                continue
            if not s.get("url"):
                log(f"[config] {s.get('id')}: enabled but has no url; skipped")
                continue
            s = dict(s)
            s.setdefault("desk", SECTION_DESK.get(section, "WORLD"))
            s.setdefault("poll", 15)
            sources.append(s)

    # Live player lineup, grouped into rows (US, World, France, Israel...).
    video = []
    for group, chans in (cfg.get("live_lineup") or {}).items():
        for v in chans or []:
            if v.get("channel_id") or v.get("link"):
                video.append({
                    "id": re.sub(r"[^a-z0-9]+", "-", v["name"].lower()).strip("-"),
                    "group": group, "name": v["name"],
                    "channel_id": v.get("channel_id"), "link": v.get("link"), "note": v.get("note"),
                    "meetings": bool(v.get("meetings")),
                })

    teams = [t for t in (cfg.get("teams") or []) if t.get("schedules")]

    watch = []
    for group, spec in (cfg.get("watchlist") or {}).items():
        # A group is either a plain list of terms or
        # {terms: [...], skip_desks: [...], case_sensitive: true}.
        if isinstance(spec, dict):
            terms, skip = spec.get("terms") or [], set(spec.get("skip_desks") or [])
            flags = 0 if spec.get("case_sensitive") else re.IGNORECASE
        else:
            terms, skip, flags = spec or [], set(), re.IGNORECASE
        for term in terms:
            term = str(term).strip()
            if not term:
                continue
            if term.endswith("*"):
                pat = r"\b" + re.escape(term[:-1])
            else:
                pat = r"\b" + re.escape(term) + r"\b"
            watch.append((group, re.compile(pat, flags), skip))
    return sources, video, watch, teams


# ---------------------------------------------------------------- state

def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError) as exc:
            log(f"[state] unreadable, starting fresh: {exc}")
    return {"items": {}, "sources": {}, "robots": {}}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    tmp.replace(STATE_FILE)


# ---------------------------------------------------------------- politeness

def robots_allows(url: str, state: dict, session: requests.Session) -> bool:
    parts = urlparse(url)
    host = f"{parts.scheme}://{parts.netloc}"
    cached = state["robots"].get(host)
    fresh = cached and (now_utc() - parse_iso(cached["checked"])) < timedelta(hours=ROBOTS_TTL_HOURS)
    if not fresh:
        body = ""
        try:
            r = session.get(host + "/robots.txt", timeout=TIMEOUT)
            if r.status_code == 200:
                body = r.text
        except requests.RequestException:
            body = ""  # unreachable robots.txt: treat as no restrictions
        cached = {"checked": iso(now_utc()), "body": body}
        state["robots"][host] = cached
    return Protego.parse(cached["body"]).can_fetch(url, "TheWire")


FORCE = os.environ.get("WIRE_FORCE", "").lower() == "true"


def is_due(src: dict, st: dict) -> bool:
    nxt = parse_iso(st.get("next_allowed"))
    if nxt and now_utc() < nxt:
        return False
    if FORCE:  # a manual run fetches everything that isn't backing off
        return True
    last = parse_iso(st.get("last_attempt"))
    if not last:
        return True
    # Two minutes of slack so a 15-minute source isn't skipped by a slightly early run.
    return now_utc() - last >= timedelta(minutes=src["poll"]) - timedelta(minutes=2)


# ---------------------------------------------------------------- parsing

def clean_text(raw: str | None, limit: int = SUMMARY_CHARS) -> str:
    if not raw:
        return ""
    text = BeautifulSoup(raw, "html.parser").get_text(" ")
    text = html.unescape(re.sub(r"\s+", " ", text)).strip()
    text = re.sub(r"\s*The post .+? (first )?appeared (first )?on .+?\.?$", "", text)
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0] + "…"
    return text


def struct_to_dt(st) -> datetime | None:
    if not st:
        return None
    try:
        return datetime(*st[:6], tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def parse_rss(src: dict, content: bytes) -> list[dict]:
    feed = feedparser.parse(content)
    if not feed.entries:
        head = content[:600].decode("utf-8", "replace").lower()
        if "<rss" not in head and "<feed" not in head and "<rdf" not in head:
            # A block or challenge page comes back as HTML with a 200; never count it as "ok".
            raise ValueError("got a web page instead of a feed (likely blocked or moved)")
        if feed.bozo:
            raise ValueError(f"unparseable feed: {feed.bozo_exception}")
    exclude = {d.lower() for d in src.get("exclude_domains", [])}
    is_gnews = "news.google.com" in src["url"]
    items = []
    for e in feed.entries:
        link = e.get("link")
        title = clean_text(e.get("title"), 400)
        if not link or not title:
            continue
        if is_gnews:
            src_href = (e.get("source") or {}).get("href", "") if isinstance(e.get("source"), dict) else getattr(e.get("source"), "href", "")
            domain = urlparse(src_href or "").netloc.lower().removeprefix("www.")
            if any(domain == d or domain.endswith("." + d) for d in exclude):
                continue
        published = struct_to_dt(e.get("published_parsed") or e.get("updated_parsed"))
        items.append({
            "title": title,
            "link": link,
            "summary": "" if is_gnews else clean_text(e.get("summary")),
            "published": iso(published),
        })
    return items


DOC_KINDS = [  # first match wins; labels city uploads by what they are
    (r"\bresolution\b", "Resolution"), (r"\blocal law\b|\bLL\b", "Local law"),
    (r"public hearing", "Public hearing"), (r"\bRFP\b|\bRFQ\b|\bbid\b|addendum", "Bid/RFP"),
    (r"\bagenda\b", "Agenda"), (r"\bminutes\b", "Minutes"), (r"budget", "Budget"),
    (r"schedule", "Schedule"), (r"notice", "Notice"),
]
BLOTTER_TITLE = re.compile(r"(\d{2})\.(\d{2})\.(\d{4})")
BLOTTER_ROW = re.compile(r"^(\d{1,2}:?\d{2})\s+(.*)$")
OFFICER = re.compile(r"\s((?:(?:PO|SGT|LT|DET|DET SGT|CAPT|CHIEF|DISPATCHER)\b[\w .'\-]*,?\s*)+)$")
DISPOSITIONS = sorted([
    "BLOTTER ONLY", "ADVISED", "CIVIL / ADVISED", "WARNING", "ISSUED", "ENTERED", "ACCIDENT REPORT", "UNFOUNDED",
    "COMPLETE", "ARREST MADE", "REPORT ON FILE", "CHECKED", "SECURE", "APPEARS SECURE", "NEGATIVE RESULTS",
    "NEGATIVE PROBLEM", "DOMESTIC INC REP", "INTERVIEWED", "ACCIDENTAL", "TRANSPORTED", "RESOLVED",
    "GONE ON ARRIVAL", "LOCATED", "UNABLE TO LOCATE", "CANCELED", "CANCELLED", "REMOVED", "TOT EMS", "TOT BVAC",
    "TOT OTHER PD", "IMPOUND", "FOLLOW UP", "DPW NOTIFIED", "COVERED", "ASSISTED", "AIDED TRANSPORTED",
    "NEGATIVE", "REFUSED", "SERVED", "RECOVERED", "PARKING TICKET", "SUMMONS ISSUED",
], key=len, reverse=True)


def parse_blotter_pdf(pdf: bytes) -> list[dict]:
    """Rows of time, call type, disposition, officer from a daily blotter PDF."""
    text = "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(pdf)).pages)
    rows, cur = [], None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("Time Occurred") or "DAILY POLICE BLOTTER" in line or line == "CITY OF BEACON":
            continue
        m = BLOTTER_ROW.match(line)
        if m:
            if cur:
                rows.append(cur)
            cur = [m.group(1), m.group(2)]
        elif cur and not BLOTTER_TITLE.fullmatch(line):
            cur[1] += " " + line  # wrapped onto the next line in the PDF
    if cur:
        rows.append(cur)
    out = []
    for time_, rest in rows:
        rest = re.sub(r"\s+", " ", rest).strip()
        officer = ""
        m = OFFICER.search(" " + rest)
        if m:
            officer = m.group(1).strip()
            rest = rest[: len(rest) - len(m.group(1))].strip()
        disposition = ""
        for d in DISPOSITIONS:
            if rest.endswith(" " + d) or rest == d:
                disposition, rest = d, rest[: -len(d)].strip()
                break
        if ":" not in time_:
            time_ = time_[:-2] + ":" + time_[-2:]
        out.append({"time": time_, "call": rest.title(), "disposition": disposition.title(), "officer": officer})
    return out


def blotter_batch(src: dict, media: list[dict], state: dict, session: requests.Session) -> list[dict]:
    """The city uploads blotters in batches; each upload day becomes one feed item."""
    cache = state.setdefault("blotters", {})
    by_upload: dict[str, list] = {}
    for m in media:
        title = html.unescape((m.get("title") or {}).get("rendered", "")).strip()
        bm = BLOTTER_TITLE.fullmatch(title)
        if not bm or not m.get("source_url"):
            continue
        url = m["source_url"]
        if url not in cache:
            try:
                r = session.get(url, timeout=TIMEOUT)
                r.raise_for_status()
                cache[url] = parse_blotter_pdf(r.content)
            except Exception as exc:
                log(f"[blotter] {url}: {type(exc).__name__}: {exc}")
                cache[url] = None
        day = f"{bm.group(3)}-{bm.group(1)}-{bm.group(2)}"
        uploaded = (m.get("date") or "")[:10]
        by_upload.setdefault(uploaded, []).append({"day": day, "url": url, "rows": cache[url] or []})
    listed = {m.get("source_url") for m in media}
    for url in [u for u in cache if u not in listed]:
        del cache[url]
    items = []
    for uploaded, days in by_upload.items():
        days.sort(key=lambda d: d["day"])
        calls = [r for d in days for r in d["rows"]]
        counts: dict[str, int] = {}
        for r in calls:
            counts[r["call"]] = counts.get(r["call"], 0) + 1
        top = ", ".join(f"{c} {n}" for c, n in sorted(counts.items(), key=lambda x: -x[1])[:5])
        first, last = days[0]["day"], days[-1]["day"]
        span = _short_date(first) if first == last else f"{_short_date(first)}–{_short_date(last)}"
        lag = (datetime.fromisoformat(uploaded) - datetime.fromisoformat(last)).days if uploaded else 0
        n_days = len(days)
        items.append({
            "title": f"Police blotter, {span}: {len(calls)} calls" + (f" over {n_days} days" if n_days > 1 else ""),
            "link": days[-1]["url"],
            "summary": (top + ". " if top else "") + (f"Posted {lag} day{'s' if lag != 1 else ''} after the last day covered." if lag > 0 else ""),
            "published": iso(parse_iso(uploaded + "T16:00:00Z")) if uploaded else None,
            # Officer names are left out: not useful here.
            "blotter": [{"day": d["day"], "url": d["url"],
                         "rows": [{k: r[k] for k in ("time", "call", "disposition")} for r in d["rows"]]} for d in days],
            "kind": "BLOTTER",
        })
    return items


def _short_date(day: str) -> str:
    d = datetime.fromisoformat(day)
    return f"{d.month}/{d.day}"


def parse_wp_media(src: dict, content: bytes, state: dict | None = None, session: requests.Session | None = None) -> list[dict]:
    media = json.loads(content)
    items = blotter_batch(src, media, state, session) if state is not None else []
    for m in media:
        title = html.unescape((m.get("title") or {}).get("rendered", "")).strip()
        url = m.get("source_url")
        if not url or BLOTTER_TITLE.fullmatch(title):
            continue
        label = title or url.rsplit("/", 1)[-1]
        kind = next((name for pat, name in DOC_KINDS if re.search(pat, label + " " + url, re.IGNORECASE)), "City document")
        items.append({
            "title": f"{kind}: {label}",
            "link": url,
            "summary": "Posted to beaconny.gov" + (" (PDF)" if url.lower().endswith(".pdf") else ""),
            "published": iso(parse_iso(m.get("date_gmt", "") + "Z") if m.get("date_gmt") else parse_iso(m.get("date"))),
        })
    return items


def parse_wp_posts(src: dict, content: bytes) -> list[dict]:
    items = []
    for p in json.loads(content):
        link = p.get("link")
        if not link:
            continue
        items.append({
            "title": clean_text((p.get("title") or {}).get("rendered"), 400),
            "link": link,
            "summary": clean_text((p.get("excerpt") or {}).get("rendered")),
            "published": iso(parse_iso(p.get("date_gmt", "") + "Z") if p.get("date_gmt") else parse_iso(p.get("date"))),
        })
    return items


def parse_nws(src: dict, content: bytes) -> list[dict]:
    items = []
    for f in json.loads(content).get("features", []):
        p = f.get("properties", {})
        items.append({
            "title": p.get("headline") or p.get("event") or "Weather alert",
            "link": BEACON_WEATHER_PAGE,
            "summary": clean_text(p.get("description")),
            "published": iso(parse_iso(p.get("effective") or p.get("sent"))),
            "alert": {
                "event": p.get("event"),
                "severity": p.get("severity"),
                "expires": iso(parse_iso(p.get("ends") or p.get("expires"))),
                "key": f.get("id") or p.get("id"),
            },
        })
    return items


ENB_LINK = re.compile(r"^/news/environmental-notice-bulletin/(\d{4}-\d{2}-\d{2})/([^/]+)/")


def parse_dec_enb(src: dict, content: bytes) -> list[dict]:
    soup = BeautifulSoup(content, "html.parser")
    seen, items = set(), []
    for a in soup.find_all("a", href=True):
        href = a["href"].split("#")[0]
        path = urlparse(href).path
        m = ENB_LINK.match(path)
        if not m or path in seen:
            continue
        seen.add(path)
        date, category = m.groups()
        text = re.sub(r"\s+", " ", a.get_text(" ")).strip()
        if not text:
            continue
        items.append({
            "title": f"ENB {category.upper()}: {text}",
            "link": urljoin("https://dec.ny.gov", path),
            "summary": f"NYSDEC Environmental Notice Bulletin, {date}",
            # Bulletin dates are New York dates; noon Eastern keeps them on the right day.
            "published": f"{date}T16:00:00Z",
        })
    return items


# ---------------------------------------------------------------- V3 parsers

DATE_IN_TEXT = [
    (re.compile(r"\b([A-Z][a-z]+ \d{1,2}, \d{4})\b"), "%B %d, %Y"),
    (re.compile(r"\b(\d{4}-\d{2}-\d{2})\b"), "%Y-%m-%d"),
]


def date_from_text(text: str) -> str | None:
    for pat, fmt in DATE_IN_TEXT:
        m = pat.search(text)
        if m:
            try:
                return iso(datetime.strptime(m.group(1), fmt).replace(hour=12, tzinfo=NY))
            except ValueError:
                continue
    return None


def parse_links(src: dict, content: bytes) -> list[dict]:
    """Generic link list: every link whose href matches link_pattern (and text matches
    text_pattern, if given) becomes an item. Dates come from the link text when present."""
    soup = BeautifulSoup(content, "html.parser")
    href_pat = re.compile(src.get("link_pattern", "."), re.IGNORECASE)
    text_pat = re.compile(src["text_pattern"], re.IGNORECASE) if src.get("text_pattern") else None
    skip_pat = re.compile(src["exclude_text"], re.IGNORECASE) if src.get("exclude_text") else None
    seen, items = set(), []
    for a in soup.find_all("a", href=True):
        href = urljoin(src["url"], a["href"].strip())
        text = re.sub(r"\s+", " ", a.get_text(" ")).strip()
        if not text or href in seen or not href_pat.search(href) or (text_pat and not text_pat.search(text)) \
                or (skip_pat and skip_pat.search(text)):
            continue
        seen.add(href)
        items.append({
            "title": (src.get("title_prefix", "") + text)[:300],
            "link": href,
            "summary": src.get("summary", ""),
            "published": date_from_text(text + " " + href),
        })
    return items[: src.get("max_items", 40)]


def parse_cl_search(src: dict, content: bytes) -> list[dict]:
    items = []
    for x in json.loads(content).get("results", []):
        url = x.get("absolute_url")
        if not url:
            continue
        snippet = " ".join(o.get("snippet", "") for o in (x.get("opinions") or [])[:1])
        court = x.get("court_citation_string") or x.get("court") or ""
        items.append({
            "title": (x.get("caseName") or "Opinion") + (f" ({court})" if court else ""),
            "link": "https://www.courtlistener.com" + url,
            "summary": clean_text(snippet),
            "published": iso(datetime.strptime(x["dateFiled"][:10], "%Y-%m-%d").replace(hour=12, tzinfo=NY)) if x.get("dateFiled") else None,
        })
    return items


def parse_federal_register(src: dict, content: bytes) -> list[dict]:
    items = []
    for d in json.loads(content).get("results", []):
        agencies = ", ".join(a.get("name", "") for a in d.get("agencies", []) if a.get("name"))
        kind = {"Rule": "Final rule", "Proposed Rule": "Proposed rule"}.get(d.get("type"), d.get("type") or "")
        items.append({
            "title": f"{kind}: {d.get('title', '')}" if kind else d.get("title", ""),
            "link": d.get("html_url"),
            "summary": clean_text((agencies + ". " if agencies else "") + (d.get("abstract") or "")),
            "published": iso(datetime.strptime(d["publication_date"], "%Y-%m-%d").replace(hour=9, tzinfo=NY)) if d.get("publication_date") else None,
        })
    return [i for i in items if i["link"]]


SENATE_DAY = re.compile(r"(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ([A-Z][a-z]+ \d{1,2}, \d{4})")


def parse_senate_floor(src: dict, content: bytes) -> list[dict]:
    text = re.sub(r"\s+", " ", BeautifulSoup(content, "html.parser").get_text(" "))
    parts = SENATE_DAY.split(text)
    items = []
    # split() gives [pre, weekday, date, body, weekday, date, body, ...]
    for i in range(1, len(parts) - 2, 3):
        day, body = parts[i + 1], parts[i + 2].strip()
        when = datetime.strptime(day, "%B %d, %Y").replace(hour=18, tzinfo=NY)
        items.append({
            "title": f"Senate floor, {parts[i][:3]} {when.month}/{when.day}: " + (body.split(". ")[1][:120] if ". " in body else body[:120]),
            "link": src["url"] + "#" + day.replace(" ", "-").replace(",", ""),
            "summary": clean_text(body, 500),
            "published": iso(when),
        })
        if len(items) >= 3:
            break
    return items


def pick_parser(src: dict):
    url = src["url"]
    if "wp-json/wp/v2/media" in url:
        return parse_wp_media
    if "wp-json/wp/v2/posts" in url:
        return parse_wp_posts
    if "api.weather.gov/alerts" in url:
        return parse_nws
    if "environmental-notice-bulletin" in url:
        return parse_dec_enb
    if "courtlistener.com/api/rest/v4/search" in url:
        return parse_cl_search
    if "federalregister.gov/api" in url:
        return parse_federal_register
    if "floor_activity" in url:
        return parse_senate_floor
    if src.get("type") == "links":
        return parse_links
    if src.get("type") == "rss":
        return parse_rss
    raise ValueError(f"no parser for type={src.get('type')} url={url}")


# ---------------------------------------------------------------- fetch

def fetch_source(src: dict, state: dict, session: requests.Session) -> tuple[str, list[dict] | None]:
    """Returns (outcome, items). items is None when nothing new was fetched."""
    st = state["sources"].setdefault(src["id"], {})
    if not is_due(src, st):
        return "skipped", None
    st["last_attempt"] = iso(now_utc())
    try:
        # robots: subscription marks a feed or API the publisher offers for subscription,
        # fetched one URL at a time like any feed reader. Everything else honors robots.txt.
        if src.get("robots") != "subscription" and not robots_allows(src["url"], state, session):
            raise PermissionError("disallowed by robots.txt")
        headers = {}
        if st.get("etag"):
            headers["If-None-Match"] = st["etag"]
        if st.get("last_modified"):
            headers["If-Modified-Since"] = st["last_modified"]
        r = session.get(src["url"], headers=headers, timeout=TIMEOUT)
        st["last_status"] = r.status_code
        if r.status_code == 304:
            st["last_success"] = iso(now_utc())
            st["last_error"] = None
            return "not-modified", None
        if r.status_code in (403, 429):
            st["next_allowed"] = iso(now_utc() + timedelta(minutes=max(src["poll"], BLOCKED_BACKOFF_MIN)))
            raise RuntimeError(f"HTTP {r.status_code} (backing off)")
        r.raise_for_status()
        parser = pick_parser(src)
        items = parser(src, r.content, state, session) if parser is parse_wp_media else parser(src, r.content)
        st["etag"] = r.headers.get("ETag")
        st["last_modified"] = r.headers.get("Last-Modified")
        st["last_success"] = iso(now_utc())
        st["last_error"] = None
        st["next_allowed"] = None
        st["last_fetch_count"] = len(items)
        return "ok", items
    except Exception as exc:  # recorded and shown on the page, never swallowed
        st["last_error"] = f"{type(exc).__name__}: {exc}"[:300]
        return "error", None



# ---------------------------------------------------------------- item hints

# A quoted phrase in the headline: "…" / “…”, or ‘…’ / '…' that opens after a space
# and closes before a space or punctuation (so apostrophes in "Trump's" don't count).
QUOTE = re.compile(r"[\"“][^\"“”]{8,}[\"”]|(?:^|[\s:(])[‘'][^‘’']{8,}[’'](?=[\s,.:;!?)]|$)")
MEETING = re.compile(
    r"(?:on\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+"
    r"([A-Z][a-z]+\s+\d{1,2},\s+\d{4}),?\s+at\s+(\d{1,2}:\d{2}\s*[AP]\.?M\.?)", re.IGNORECASE)


def item_kind(src: dict, it: dict) -> str | None:
    """A small type mark for the row: VIDEO, DOC, or QUOTE (Joe's preferred story forms)."""
    link = it["link"].lower()
    if "youtube.com" in link or "youtu.be" in link:
        return "VIDEO"
    if (link.endswith(".pdf") or "courtlistener.com/opinion" in link or "agendaviewer" in link
            or "ethics opinion" in it["title"].lower()):
        return "DOC"
    title = it["title"].strip()
    # A headline wrapped entirely in quotes is a quoted article title, not someone speaking.
    if title[:1] not in "\"“‘'" and QUOTE.search(title):
        return "QUOTE"
    return None


def meeting_time(it: dict) -> str | None:
    """Beacon agendas say 'will meet on Tuesday, October 20, 2026, at 7:00 PM'."""
    m = MEETING.search(it.get("summary") or "")
    if not m:
        return None
    try:
        clock = m.group(2).upper().replace(".", "").replace(" ", "")
        local = datetime.strptime(f"{m.group(1)} {clock}", "%B %d, %Y %I:%M%p").replace(tzinfo=NY)
        return iso(local)
    except ValueError:
        return None


# ---------------------------------------------------------------- sports

COMP_SHORT = {"STD": "", "Premier League": "PL", "Concacaf Nations League": "Nations League",
              "Concacaf W Championship": "W Championship", "Women's International Friendly": "Friendly",
              "International Friendly": "Friendly", "Men's International Friendly": "Friendly"}


def comp_name(e: dict, comp: dict) -> str:
    raw = (e.get("league") or {}).get("abbreviation") or (comp.get("type") or {}).get("abbreviation") or ""
    return COMP_SHORT.get(raw, raw)


def fetch_team(team: dict, state: dict, session: requests.Session) -> dict:
    """Last result and next game from ESPN's public schedule JSON (unofficial, no key)."""
    st = state.setdefault("teams", {}).setdefault(team["id"], {})
    last_ok = parse_iso(st.get("fetched"))
    poll = team.get("poll", 30)
    if last_ok and not FORCE and now_utc() - last_ok < timedelta(minutes=poll) - timedelta(minutes=2) and st.get("summary"):
        return st["summary"]
    events = {}
    errors = []
    for url in team["schedules"]:
        for attempt in (1, 2):  # ESPN is occasionally slow; one retry
            try:
                r = session.get(url, timeout=TIMEOUT)
                r.raise_for_status()
                for e in r.json().get("events", []):
                    events[e["id"]] = e
                break
            except Exception as exc:
                if attempt == 2:
                    errors.append(f"{type(exc).__name__}: {exc}"[:160])
    games = []
    for e in events.values():
        try:
            comp = e["competitions"][0]
            me = next(c for c in comp["competitors"] if str(c["team"]["id"]) == str(team["espn_id"]))
            opp = next(c for c in comp["competitors"] if c is not me)
            status = comp.get("status", e.get("status", {})).get("type", {})
            def score(c):
                s = c.get("score")
                return (s.get("displayValue") if isinstance(s, dict) else s) or ""
            games.append({
                "at": e["date"].replace("Z", ":00Z") if len(e["date"]) == 17 else e["date"],
                "opp": opp["team"].get("shortDisplayName") or opp["team"].get("abbreviation"),
                "home": me.get("homeAway") == "home",
                "comp": comp_name(e, comp),
                "state": status.get("state"),  # pre / in / post
                "detail": status.get("shortDetail") or "",
                "us": score(me), "them": score(opp),
                "winner": me.get("winner"),
            })
        except (StopIteration, KeyError, IndexError, TypeError):
            continue
    games.sort(key=lambda g: g["at"])
    done = [g for g in games if g["state"] == "post"]
    live = [g for g in games if g["state"] == "in"]
    upcoming = [g for g in games if g["state"] == "pre"]
    summary = {
        "id": team["id"], "name": team["name"], "short": team.get("short", team["name"]),
        "last": done[-1] if done else None, "live": live[0] if live else None,
        "next": upcoming[0] if upcoming else None,
        "error": "; ".join(errors) if errors and not games else None,
    }
    if games or not st.get("summary"):
        st["summary"] = summary
        st["fetched"] = iso(now_utc())
    else:
        st["summary"]["error"] = summary["error"]
    return st["summary"]


# ---------------------------------------------------------------- merge

def item_id(link: str) -> str:
    return hashlib.sha1(link.encode()).hexdigest()[:16]


def sort_time(it: dict) -> datetime:
    pub = parse_iso(it.get("published"))
    first = parse_iso(it["first_seen"])
    # Future-dated items (scheduled meetings, clock skew) sort by when we first saw them.
    if pub and pub <= now_utc() + timedelta(minutes=5):
        return pub
    return first


def merge(state: dict, src: dict, items: list[dict], watch) -> None:
    store = state["items"]
    stamp = iso(now_utc())
    if src["url"].startswith("https://api.weather.gov/alerts"):
        # Alerts are only as current as the latest response: drop ones that ended.
        for k in [k for k, v in store.items() if v["source_id"] == src["id"]]:
            del store[k]
    if src.get("max_items"):
        items = items[: src["max_items"]]
    if src.get("exclude_title"):
        pat = re.compile(src["exclude_title"], re.IGNORECASE)
        items = [it for it in items if not pat.search(it["title"])]
    if src.get("type") == "links":
        # Undated link lists: the first fetch only records what's already there, so
        # existing entries don't flood the feed as "new"; later additions show up.
        seen = state.setdefault("links_seen", {})
        first = src["id"] not in seen
        known = set(seen.get(src["id"], []))
        kept = [it for it in items if it.get("published") or (not first and it["link"] not in known)]
        seen[src["id"]] = list((known | {it["link"] for it in items}))[-500:]
        items = kept
    for it in items:
        key = item_id(it["link"] + ("|" + it["alert"]["key"] if it.get("alert") else ""))
        text = f"{it['title']} {it.get('summary', '')}"
        groups, terms = set(), []
        for g, pat, skip in watch:
            if src["desk"] in skip:
                continue
            m = pat.search(text)
            if m:
                groups.add(g)
                if m.group(0).lower() not in (x.lower() for x in terms):
                    terms.append(m.group(0))
        if src.get("require_watch") and not groups:
            continue  # this source only shows watchlist matches
        existing = store.get(key)
        store[key] = {
            "id": key,
            "source_id": src["id"],
            "source": src.get("short") or src["name"],
            "desk": src["desk"],
            "fast": bool(src.get("fast")),
            "title": it["title"],
            "link": it["link"],
            "summary": it.get("summary", ""),
            "published": it.get("published"),
            "first_seen": existing["first_seen"] if existing else stamp,
            "watch": sorted(groups),
            "watch_terms": terms[:3],
            "kind": it.get("kind") or item_kind(src, it),
            **({"blotter": it["blotter"]} if it.get("blotter") else {}),
            "event_at": meeting_time(it),
            **({"alert": it["alert"]} if it.get("alert") else {}),
        }


def prune(state: dict, sources: list[dict] | None = None) -> None:
    cutoff = now_utc() - timedelta(days=KEEP_DAYS)
    # Rare-event sources (a spill-law case search) keep items longer.
    long_keep = {s["id"]: now_utc() - timedelta(days=s["keep_days"]) for s in (sources or []) if s.get("keep_days")}
    floor = now_utc() - timedelta(days=MIN_KEEP_DAYS)
    store = state["items"]
    newest: dict[str, list[tuple[datetime, str]]] = {}
    for k, v in store.items():
        newest.setdefault(v["source_id"], []).append((sort_time(v), k))
    protected = set()
    for rows in newest.values():
        rows.sort(reverse=True)
        protected.update(k for t, k in rows[:MIN_PER_SOURCE] if t >= floor)
    for k in [k for k, v in store.items()
              if sort_time(v) < long_keep.get(v["source_id"], cutoff) and k not in protected]:
        del store[k]
    for k, v in list(store.items()):
        exp = parse_iso((v.get("alert") or {}).get("expires"))
        if exp and exp < now_utc():
            del store[k]


# ---------------------------------------------------------------- output

def gov_panel(items: list[dict]) -> list[dict]:
    """The GOV desk's "Today in government" lines, from sources.yaml's gov_panel."""
    rows = []
    for g in yaml.safe_load(CONFIG.read_text()).get("gov_panel") or []:
        latest = next((it for it in items if it["source_id"] in g.get("sources", [])), None)
        rows.append({"label": g["label"], "watch": g.get("watch"),
                     "item": {k: latest[k] for k in ("id", "title", "link", "t")} if latest else None})
    return rows


def write_dist(state: dict, sources: list[dict], video: list[dict], teams: list[dict]) -> dict:
    items = sorted(state["items"].values(), key=sort_time, reverse=True)[:MAX_ITEMS]
    for it in items:
        it["t"] = iso(sort_time(it))
    counts: dict[str, int] = {}
    for it in items:
        counts[it["source_id"]] = counts.get(it["source_id"], 0) + 1
    health = []
    for s in sources:
        st = state["sources"].get(s["id"], {})
        health.append({
            "id": s["id"], "name": s["name"], "short": s.get("short") or s["name"], "desk": s["desk"], "poll": s["poll"],
            "last_success": st.get("last_success"), "last_attempt": st.get("last_attempt"),
            "last_error": st.get("last_error"), "last_status": st.get("last_status"),
            "robots": src_robots(s),
            "items": counts.get(s["id"], 0),
        })
    data = {
        "generated_at": iso(now_utc()),
        "items": items,
        "alerts": [it for it in items if it.get("alert")],
        "sources": health,
        "video": video,
        "teams": teams,
    }
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(SITE, DIST)
    (DIST / "data.json").write_text(json.dumps(data, separators=(",", ":")))
    return data


def attach_agendas(state: dict, track: dict, watch) -> None:
    """Give each agenda feed item its parsed item list, history counts and watch hits."""
    cache = state.get("agendas") or {}
    for it in state["items"].values():
        rec = cache.get(it["link"])
        if not rec or not rec.get("items"):
            continue
        rows = []
        for a in rec["items"]:
            hist = track.get(a.get("addr") or "", [])
            rows.append({"n": a["n"], "text": a["text"], "section": a.get("section", ""),
                         "addr": a.get("addr"), "flags": a.get("flags", []),
                         "seen": len([h for h in hist if h["link"] != it["link"]])})
        it["agenda"] = rows
        text = " ".join(r["text"] for r in rows)
        terms = list(it.get("watch_terms") or [])
        groups = set(it.get("watch") or [])
        for g, pat, skip in watch:
            if it["desk"] in skip:
                continue
            m = pat.search(text)
            if m:
                groups.add(g)
                if m.group(0).lower() not in (x.lower() for x in terms):
                    terms.append(m.group(0))
        it["watch"], it["watch_terms"] = sorted(groups), terms[:3]


def src_robots(s: dict) -> str:
    return "subscription" if s.get("robots") == "subscription" else "honored"


def main() -> int:
    started = time.time()
    sources, video, watch, team_cfg = load_config()
    state = load_state()
    state.setdefault("robots", {})
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda s: (s, *fetch_source(s, state, session)), sources))

    for src, outcome, items in results:
        if items is not None:
            merge(state, src, items, watch)
            if src.get("agendas"):
                state["granicus_entries"] = [{"title": i["title"], "link": i["link"]} for i in items]
        err = state["sources"][src["id"]].get("last_error")
        log(f"[{outcome:>12}] {src['id']:<26} {len(items) if items is not None else '-':>4}  {err or ''}")

    # Forget sources removed from config so health doesn't show ghosts.
    live = {s["id"] for s in sources}
    state["sources"] = {k: v for k, v in state["sources"].items() if k in live}
    state["items"] = {k: v for k, v in state["items"].items() if v["source_id"] in live}

    with ThreadPoolExecutor(max_workers=6) as pool:
        teams = list(pool.map(lambda tm: fetch_team(tm, state, session), team_cfg))
    for tm in teams:
        log(f"[team] {tm['id']:<10} last={bool(tm['last'])} next={bool(tm['next'])} {tm['error'] or ''}")

    # Agenda PDFs linked from the Granicus feed (approved as part of that subscription).
    entries = state.get("granicus_entries") or []
    if entries:
        agendas.update(state, entries, session, TIMEOUT, log)
        keep = {e["link"] for e in entries}
        state["agendas"] = {k: v for k, v in state.get("agendas", {}).items() if k in keep}
    track = agendas.tracker(state)
    attach_agendas(state, track, watch)

    prune(state, sources)
    data = write_dist(state, sources, video, teams)
    data_tracker = {a: track[a] for a in {x["addr"] for it in data["items"] for x in it.get("agenda") or [] if x.get("addr")} if a in track}
    data["tracker"] = data_tracker
    data["gov_panel"] = gov_panel(data["items"])
    data["front_page_url"] = yaml.safe_load(CONFIG.read_text()).get("front_page_url")
    # V5: story grouping, open-text quotes, machine summaries. A failure here is
    # recorded in source health and never stops the feed from publishing.
    try:
        stories.run(state, data, {s["id"]: s for s in sources}, session, robots_allows, TIMEOUT, log)
    except Exception as exc:
        log(f"[v5] failed: {type(exc).__name__}: {exc}")
        data["sources"].append({"id": "v5", "name": "Story grouping and summaries", "short": "Stories", "desk": "SYSTEM",
                                "poll": 15, "last_success": None, "last_attempt": iso(now_utc()),
                                "last_error": f"{type(exc).__name__}: {exc}"[:300], "last_status": None,
                                "robots": "n/a", "items": 0})
    # V6: push-alert candidates for the Cloudflare Worker, and its health.
    try:
        alerts.run(data, yaml.safe_load(CONFIG.read_text()).get("push_alerts") or {}, DIST, log)
    except Exception as exc:
        log(f"[alerts] failed: {type(exc).__name__}: {exc}")
    (DIST / "data.json").write_text(json.dumps(data, separators=(",", ":")))
    save_state(state)
    failing = sum(1 for h in data["sources"] if h["last_error"])
    log(f"built {len(data['items'])} items from {len(sources)} sources "
        f"({failing} failing) in {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
