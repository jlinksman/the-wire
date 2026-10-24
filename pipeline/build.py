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
from urllib.parse import parse_qs, urlencode, urljoin, urlparse

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
import brief  # noqa: E402
import events  # noqa: E402
import translate  # noqa: E402
import pulse  # noqa: E402
import livecheck  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "sources.yaml"
SITE = ROOT / "site"
DIST = ROOT / "dist"
STATE_DIR = ROOT / ".state"
STATE_FILE = STATE_DIR / "state.json"

CONTACT = os.environ.get("WIRE_CONTACT", "")
USER_AGENT = "TheWire/1.0 (private personal news reader; polite polling; +https://github.com/jlinksman/the-wire" + (f"; {CONTACT}" if CONTACT else "") + ")"
TIMEOUT = 25
KEEP_DAYS = 7
# Courts and city offices publish in batches, so every source keeps its newest few
# items for longer than the 7-day window.
MIN_PER_SOURCE = 5
MIN_KEEP_DAYS = 45
MAX_ITEMS = 1500
QUIET_KEEP_HOURS = 48   # corroborating (quiet) sources only matter for grouping recent stories
MAX_QUIET_ITEMS = 1500
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

PEOPLE = ROOT / "people.yaml"
BYLINES: list = []          # (person id, pattern), set in main()
PERSON_MAX_ITEMS = 8        # newest entries per person feed (podcast feeds carry years of episodes)
PERSON_MAX_AGE_DAYS = 21


def load_people_cfg() -> list[dict]:
    try:
        return [p for p in (yaml.safe_load(PEOPLE.read_text()) or {}).get("people", []) if p.get("enabled", True)]
    except FileNotFoundError:
        return []


def load_people() -> list[dict]:
    """One source per person feed or search, in sources.yaml's shape (people.yaml)."""
    out = []
    for p in load_people_cfg():
        chans = [dict(f) for f in p.get("feeds") or []]
        if p.get("search"):
            chans.append({"type": "search", "url": "https://www.bing.com/news/search?" + urlencode({"q": p["search"], "format": "rss"})})
        for i, f in enumerate(chans):
            kind = f["type"]
            out.append({
                "id": f"p_{p['id']}_{i}", "name": f"{p['name']} · {KIND_LABEL.get(kind, kind)}", "short": p["name"],
                "type": "api" if kind == "nws_afd" else "rss", "feed_kind": kind, "url": f["url"], "status": "OK",
                "enabled": True, "desk": p.get("desk", "WORLD"), "person": p["id"], "person_feed": True,
                "poll": 180 if kind == "search" else 60, "max_items": PERSON_MAX_ITEMS, "max_age_days": PERSON_MAX_AGE_DAYS,
                "only_byline": bool(p.get("only_byline")), "byline": p.get("byline") or [],
                # A search of the person's own site shows under their name; a name search shows the publisher.
                **({"site_feed": True} if kind == "search" and p["search"].startswith("site:") else {}),
                **({"no_ai": True} if p.get("no_ai") else {}),
                **({"beats": p["beats"]} if p.get("beats") else {}),
                # The NWS API is a public government API offered for exactly this (as with the alerts feed).
                **({"robots": "subscription"} if kind == "nws_afd" else {}),
                "scope": p.get("scope") or {"BEACON": "local", "GOV": "national", "LAW": "national", "SPORTS": "sports"}.get(p.get("desk"), "mixed"),
                "_section": "people",
            })
    return out


def people_bylines() -> list[tuple[str, re.Pattern]]:
    return [(p["id"], re.compile(r"\b(?:" + "|".join(re.escape(b) for b in p["byline"]) + r")\b", re.IGNORECASE))
            for p in load_people_cfg() if p.get("byline")]


KIND_LABEL = {"podcast": "podcast", "youtube": "videos", "rss": "writing", "bluesky": "Bluesky posts", "search": "headlines via search", "nws_afd": "forecast discussion"}


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
            s["_section"] = section
            s.setdefault("poll", 15)
            sources.append(s)

    # Live player lineup, grouped into rows (US, World, France, Israel...).
    video = []
    for group, chans in (cfg.get("live_lineup") or {}).items():
        for v in chans or []:
            if v.get("channel_id") or v.get("link") or v.get("audio") or v.get("embed"):
                video.append({
                    "id": re.sub(r"[^a-z0-9]+", "-", v["name"].lower()).strip("-"),
                    "group": group, "name": v["name"],
                    "channel_id": v.get("channel_id"), "link": v.get("link"), "note": v.get("note"),
                    "audio": v.get("audio"), "embed": v.get("embed"), "site": v.get("site"),
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
    sources += load_people()
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
    poll = src["poll"]
    # Overnight (midnight to 6 AM New York), national and world feeds and quiet sources slow
    # to every 30 minutes. Beacon, weather alerts and government stay on schedule.
    if 0 <= datetime.now(NY).hour < 6 and (src.get("desk") == "WORLD" or src.get("quiet")):
        poll = max(poll, 30)
    # Two minutes of slack so a 15-minute source isn't skipped by a slightly early run.
    return now_utc() - last >= timedelta(minutes=poll) - timedelta(minutes=2)


# ---------------------------------------------------------------- parsing

DOC_TEXT_CHARS = 1500


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


# Publisher names as Bing reports them -> the short names The Wire already uses, so the
# same outlet arriving two ways counts once in a story.
OUTLET_ALIASES = {
    "the wall street journal": "WSJ", "wsj": "WSJ", "associated press": "AP", "associated press news": "AP", "ap news": "AP",
    "reuters": "Reuters", "the new york times": "NYT", "new york times": "NYT", "the guardian": "Guardian", "bbc": "BBC",
    "bbc news": "BBC", "npr": "NPR", "cbs news": "CBS", "abc news": "ABC", "nbc news": "NBC", "fox news": "Fox News",
    "al jazeera": "Al Jazeera", "france 24": "France 24", "mid hudson news": "Mid-Hudson News", "times union": "Times Union",
    "spectrum news": "Spectrum News", "spectrumlocalnews": "Spectrum News", "poughkeepsie journal": "Poughkeepsie Journal",
    "the poughkeepsie journal": "Poughkeepsie Journal", "times herald-record": "Times Herald-Record", "recordonline": "Times Herald-Record",
    "politico": "Politico", "the times of israel": "Times of Israel", "the hill": "The Hill", "city & state": "City & State",
    "gothamist": "Gothamist", "pbs newshour": "PBS NewsHour", "the independent": "Independent", "sky news": "Sky News",
}


def canonical_outlet(name: str) -> str:
    n = re.sub(r"\s+on msn$", "", name.strip(), flags=re.IGNORECASE)
    return OUTLET_ALIASES.get(n.lower(), n)


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
    is_bing = "bing.com/news" in src["url"]
    items = []
    for e in feed.entries:
        link = e.get("link")
        if not link:
            # Podcast episodes without a page link: the publisher's own audio file.
            enc = [x.get("href") for x in e.get("enclosures", []) if x.get("href")]
            link = enc[0] if enc else None
        title = clean_text(e.get("title"), 400)
        if not title and src.get("feed_kind") == "bluesky":
            title = clean_text(e.get("summary") or e.get("description"), 160)   # posts have no title
        if not link or not title:
            continue
        author = e.get("author") or ", ".join(a.get("name", "") for a in e.get("authors", []) if isinstance(a, dict))
        author = re.sub(r"^\s*by\s+", "", clean_text(author, 200), flags=re.IGNORECASE)
        outlet = None
        if is_bing:
            # Bing News search feed: the publisher's own URL is in the url= parameter, and
            # the publisher's name in <News:Source>. Each publisher counts as its own outlet.
            real = parse_qs(urlparse(link).query).get("url")
            if real:
                link = real[0]
            outlet = canonical_outlet(e.get("news_source") or "")
            if not outlet or re.search(src.get("exclude_outlets", "$^"), e.get("news_source") or "", re.IGNORECASE):
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
            # Public documents (court opinions, rules): the feed carries the document's own opening
            # text, kept longer for the verbatim excerpt on the thread page (stage 3).
            **({"doc_text": clean_text(e.get("summary"), DOC_TEXT_CHARS)} if src.get("public_doc") else {}),
            **({"outlet": outlet} if outlet and not src.get("site_feed") else {}),
            **({"author": author} if author else {}),
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


def parse_dec_spills(src: dict, content: bytes) -> list[dict]:
    """NYSDEC spill incidents (data.ny.gov, dataset u44d-k5fk): one record per reported spill in
    the counties the query asks for. The record itself is the primary source; the link opens it.
    Quantity is as reported to DEC and often zero or blank at first report."""
    items = []
    for x in json.loads(content):
        num = x.get("spill_number")
        if not num:
            continue
        material = (x.get("material_name") or "unknown material").strip()
        qty = x.get("quantity")
        try:
            qty_s = f"{float(qty):g} {x.get('units') or 'gal'}" if qty and float(qty) > 0 else "quantity not reported"
        except ValueError:
            qty_s = "quantity not reported"
        place = ", ".join(p for p in [(x.get("locality") or "").title(), x.get("county")] if p)
        received = x.get("received_date") or x.get("spill_date")
        try:
            when = datetime.strptime(received[:10], "%Y-%m-%d").replace(hour=12, tzinfo=NY) if received else None
        except ValueError:
            when = None
        facts = [f"Spill #{num}", (x.get("program_facility_name") or "").title() or None, (x.get("street_1") or "").title() or None,
                 x.get("source") and f"Source: {x['source']}", x.get("contributing_factor") and f"Cause: {x['contributing_factor']}",
                 x.get("recovered") not in (None, "", "0.00", "0") and f"Recovered: {x['recovered']} {x.get('units') or ''}".strip(),
                 x.get("close_date") and "Closed " + x["close_date"][:10], x.get("dec_region") and f"DEC Region {x['dec_region']}"]
        items.append({
            "title": f"DEC spill report: {material}, {qty_s}, {place}",
            "link": f"https://data.ny.gov/resource/u44d-k5fk.json?spill_number={num}",
            "summary": " · ".join(str(f) for f in facts if f),
            "published": iso(when) if when else None,
            "kind": "RECORD",
        })
    return items


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
            **({"doc_text": clean_text(snippet, DOC_TEXT_CHARS)} if src.get("public_doc") else {}),
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
            **({"doc_text": clean_text(d.get("abstract") or "", DOC_TEXT_CHARS)} if src.get("public_doc") else {}),
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


def parse_senate_gallery(src: dict, content: bytes) -> list[dict]:
    """The Senate Press Gallery's daily floor log (dailypress.senate.gov, a WordPress feed),
    which replaced senate.gov's floor-activity page when that began answering 403 to cloud
    servers (2026-10-23). One post per session day."""
    items = []
    for e in feedparser.parse(content).entries[:4]:
        body = clean_text(e.get("summary") or "", 600)
        try:
            when = datetime.strptime(re.sub(r"^\w+,\s*", "", e.title).strip(), "%B %d, %Y").replace(hour=18, tzinfo=NY)
        except ValueError:
            continue
        first = re.sub(r"^\d{1,2}:\d\d\s*[ap]\.m\.\s*", "", body)
        items.append({
            "title": f"Senate floor, {when.strftime('%a')} {when.month}/{when.day}: " + (first.split(". ")[0][:120] if first else "floor log"),
            "link": e.link, "summary": body, "published": iso(when),
        })
    return items


def parse_nws_afd(src: dict, content: bytes) -> list[dict]:
    """NWS Area Forecast Discussion (forecasters' own reasoning), latest issue only."""
    data = json.loads(content)
    graph = data.get("@graph") or []
    if not graph:
        return []
    p = graph[0]
    office = (p.get("issuingOffice") or "ALY")[-3:]
    return [{
        "title": "Forecast discussion from the NWS Albany forecasters",
        "link": f"https://forecast.weather.gov/product.php?site={office}&issuedby={office}&product=AFD&format=txt&version=1&glossary=1",
        "summary": "The forecasters' own explanation of the forecast, updated several times a day.",
        "published": p.get("issuanceTime"),
    }]


def pick_parser(src: dict):
    url = src["url"]
    if src.get("feed_kind") == "nws_afd":
        return parse_nws_afd
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
    if "data.ny.gov/resource/u44d-k5fk" in url:
        return parse_dec_spills
    if "floor_activity" in url:
        return parse_senate_floor
    if "dailypress.senate.gov" in url:
        return parse_senate_gallery
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
    if src.get("only_byline"):
        # A site-wide feed followed for one writer: keep only that writer's pieces.
        pat = re.compile("|".join(re.escape(b) for b in src.get("byline") or ["$^"]), re.IGNORECASE)
        items = [it for it in items if pat.search(it.get("author", ""))]
    if src.get("max_age_days"):
        # Search feeds sort by relevance, not date: keep only recent items.
        floor_t = now_utc() - timedelta(days=src["max_age_days"])
        items = [it for it in items if (parse_iso(it.get("published")) or now_utc()) >= floor_t]
    if src.get("max_items"):
        items = items[: src["max_items"]]
    if src.get("exclude_title"):
        pat = re.compile(src["exclude_title"], re.IGNORECASE)
        items = [it for it in items if not pat.search(it["title"])]
        # A tightened rule also clears matching items already in the store.
        for k in [k for k, v in store.items() if v["source_id"] == src["id"] and pat.search(v["title"])]:
            del store[k]
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
        people = set((existing or {}).get("people", []))
        if src.get("person"):
            people.add(src["person"])
        for pid, pat in BYLINES:
            if it.get("author") and pat.search(it["author"]):
                people.add(pid)
        if existing and src.get("person_feed") and existing["source_id"] != src["id"]:
            # Already in the store from an outlet's own feed: just tag the person.
            existing["people"] = sorted(people)
            continue
        store[key] = {
            "id": key,
            "source_id": src["id"],
            "source": it.get("outlet") or src.get("short") or src["name"],
            "desk": src["desk"],
            "fast": bool(src.get("fast")),
            **({"regional": True} if src.get("regional") else {}),
            "title": it["title"],
            "link": it["link"],
            "summary": it.get("summary", ""),
            "published": it.get("published"),
            "first_seen": existing["first_seen"] if existing else stamp,
            "watch": sorted(groups),
            "watch_terms": terms[:3],
            "kind": it.get("kind") or ("PODCAST" if src.get("feed_kind") == "podcast" else "POST" if src.get("feed_kind") == "bluesky" else None) or item_kind(src, it),
            **({"author": it["author"]} if it.get("author") else {}),
            **({"doc_text": it["doc_text"]} if it.get("doc_text") else {}),
            **({"people": sorted(people)} if people else {}),
            **({"person_feed": True} if src.get("person_feed") else {}),
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
    # Rules in sources.yaml apply to stored items too, even when the source wasn't
    # fetched this run: tightened title filters, and the regional label.
    for s in sources or []:
        pat = re.compile(s["exclude_title"], re.IGNORECASE) if s.get("exclude_title") else None
        for k in [k for k, v in store.items() if v["source_id"] == s["id"]]:
            if pat and pat.search(store[k]["title"]):
                del store[k]
            elif s.get("regional"):
                store[k]["regional"] = True
    newest: dict[str, list[tuple[datetime, str]]] = {}
    for k, v in store.items():
        newest.setdefault(v["source_id"], []).append((sort_time(v), k))
    protected = set()
    quiet = {s["id"] for s in sources or [] if s.get("quiet") and not s.get("keep_days")}   # keep_days wins over the quiet cutoff
    quiet_cut = now_utc() - timedelta(hours=QUIET_KEEP_HOURS)
    for k in [k for k, v in store.items() if v["source_id"] in quiet and sort_time(v) < quiet_cut]:
        del store[k]
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
    quiet_ids = {s["id"] for s in sources if s.get("quiet")}
    ordered = sorted(state["items"].values(), key=sort_time, reverse=True)
    # Quiet items have their own cap, so they can never push Beacon or court items out.
    items = sorted([it for it in ordered if it["source_id"] not in quiet_ids][:MAX_ITEMS]
                   + [it for it in ordered if it["source_id"] in quiet_ids][:MAX_QUIET_ITEMS], key=sort_time, reverse=True)
    # One outlet posting the same headline twice (two feeds, or a repost) shows once.
    seen_heads, deduped = set(), []
    for it in items:
        key = (it["source"], re.sub(r"\W+", " ", it["title"]).strip().lower())
        if key in seen_heads and not it.get("alert"):
            continue
        seen_heads.add(key)
        deduped.append(it)
    items = deduped
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


USER_EXCLUDE_OUTLETS = "kalkine|insider monkey|ainvest|motley fool|benzinga|marketbeat|simply wall"


def load_user_searches() -> list[dict]:
    """News searches Joe added from the page ("Tell The Wire", 2026-10-22): a deliberate,
    named exception to "every source lives in sources.yaml". They live in follows.json in KV,
    show in Admin with a remove button and their own health rows, and are never committed.
    Their ids are hashes and their errors are logged without detail, so the public build log
    never shows what he searched for."""
    f = ROOT / "follows.json"
    if not f.exists():
        return []
    try:
        searches = (json.loads(f.read_text()) or {}).get("searches", [])
    except ValueError:
        return []
    out = []
    for sr in searches[:30]:
        q = str(sr.get("query") or "").strip()[:120]
        if not q or not sr.get("id"):
            continue
        desk = sr.get("desk") if sr.get("desk") in ("BEACON", "GOV", "LAW", "WORLD", "SPORTS") else "GOV"
        out.append({"id": sr["id"], "short": "Your search", "name": "Your search · " + str(sr.get("title") or q)[:80], "enabled": True,
                    "desk": desk, "scope": {"BEACON": "local", "WORLD": "world", "SPORTS": "sports"}.get(desk, "national"),
                    "type": "rss", "url": "https://www.bing.com/news/search?" + urlencode({"q": q, "format": "rss"}),
                    "status": "OK", "poll": 120, "robots": "honored", "max_age_days": 10, "max_items": 10,
                    "exclude_outlets": USER_EXCLUDE_OUTLETS, "user": True, "_section": "user"})
    return out


def load_standing() -> list:
    """Standing area-of-law threads from threads.yaml (BRIEF.md stage 3)."""
    f = ROOT / "threads.yaml"
    if not f.exists():
        return []
    try:
        return [x for x in (yaml.safe_load(f.read_text()) or {}).get("standing", []) if x.get("id") and x.get("title")]
    except yaml.YAMLError as exc:
        log(f"[threads] threads.yaml unreadable: {exc}")
        return []


def mark_changed(state: dict) -> None:
    """Write dist/publish.txt: which KV keys changed since the last publish (ignoring their
    timestamps), so quiet hours don't spend Cloudflare writes on identical content. Every
    key is republished at least every two hours regardless."""
    pub = state.setdefault("published", {})
    lines = []
    for name in ("brief.json", "alerts.json", "evidence.json"):
        f = DIST / name
        if not f.exists():
            continue
        try:
            body = json.loads(f.read_text())
            body.pop("generated_at", None)
            body.pop("as_of", None)
            for it in body.get("items", []):
                it.pop("score", None)     # recency decay changes every run; content doesn't
            digest = hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()
        except ValueError:
            digest = hashlib.sha1(f.read_bytes()).hexdigest()
        rec = pub.get(name) or {}
        old = parse_iso(rec.get("at"))
        changed = rec.get("hash") != digest or not old or now_utc() - old > timedelta(hours=2)
        if changed:
            pub[name] = {"hash": digest, "at": iso(now_utc())}
        lines.append(f"{name}={'1' if changed else '0'}")
    (DIST / "publish.txt").write_text("\n".join(lines) + "\n")
    log("[publish] " + " ".join(lines))


def main() -> int:
    started = time.time()
    sources, video, watch, team_cfg = load_config()
    global BYLINES
    BYLINES = people_bylines()
    state = load_state()
    state.setdefault("robots", {})
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    user_searches = load_user_searches()
    import elections
    election_sources = elections.sources(elections.load(), datetime.now(NY).date())
    sources = sources + user_searches + election_sources
    if user_searches:
        log(f"[follows] {len(user_searches)} searches added from the page")

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda s: (s, *fetch_source(s, state, session)), sources))

    for src, outcome, items in results:
        if items is not None:
            merge(state, src, items, watch)
            if src.get("agendas"):
                state["granicus_entries"] = [{"title": i["title"], "link": i["link"]} for i in items]
        err = state["sources"][src["id"]].get("last_error")
        if err and src.get("user"):
            err = err.split(":")[0] + " (detail withheld from the public log)"
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
    try:
        data["sources"].append(livecheck.run(state, data, session, log))
    except Exception as exc:
        log(f"[live] skipped: {type(exc).__name__}: {exc}")
    # City desks: French and Hebrew headlines in English (machine-translated, labeled).
    try:
        tstats = translate.run(state, data["items"], {s["id"]: s for s in sources}, session, log)
        data["items"] = translate.apply(data["items"], state, {s["id"]: s for s in sources})
        if tstats["error"] or tstats["done"] or not state.get("tr_ok"):
            state["tr_error"] = tstats["error"]
            if tstats["done"]:
                state["tr_ok"] = iso(now_utc())
    except Exception as exc:
        state["tr_error"] = f"{type(exc).__name__}: {exc}"[:240]
        log(f"[translate] failed: {state['tr_error']}")
    data["sources"].append({"id": "translation", "name": "Headline translation, French and Hebrew (Workers AI)", "short": "Translation",
                            "desk": "SYSTEM", "poll": 15, "last_success": state.get("tr_ok"), "last_attempt": iso(now_utc()),
                            "last_error": state.get("tr_error"), "last_status": None, "robots": "n/a",
                            "items": sum(1 for it in data["items"] if it.get("translated"))})
    data_tracker = {a: track[a] for a in {x["addr"] for it in data["items"] for x in it.get("agenda") or [] if x.get("addr")} if a in track}
    data["tracker"] = data_tracker
    data["gov_panel"] = gov_panel(data["items"])
    data["front_page_url"] = yaml.safe_load(CONFIG.read_text()).get("front_page_url")
    # Follows (threads and named topics) come from Cloudflare KV, fetched by the workflow
    # into follows.json before the build; never committed.
    follows = {}
    fpath = ROOT / "follows.json"
    if fpath.exists():
        try:
            follows = json.loads(fpath.read_text()) or {}
        except ValueError as exc:
            log(f"[follows] unreadable: {exc}")
    data["follows"] = {k: follows.get(k, []) for k in ("threads", "topics", "signals", "searches")} | {"taste": follows.get("taste") or {}}
    # The pulse (quiz.json from KV, gitignored): its answers join taste; only counts are logged.
    try:
        pulse.run(data, follows, log)
    except Exception as exc:
        log(f"[pulse] skipped: {type(exc).__name__}")
    # The people directory (people.yaml) for the page: names, roles, perspective, reachability.
    data["people"] = [{k: p[k] for k in ("id", "name", "role", "desk", "perspective", "unreachable") if p.get(k)}
                      for p in load_people_cfg()]
    # Scope (local, state, national, world), city beats, and the quiet flag for each item.
    events.PEOPLE_INFO["beats"] = {p["id"]: p.get("beats") for p in load_people_cfg() if p.get("beats")}
    events.tag(data, {s["id"]: s for s in sources}, (yaml.safe_load(CONFIG.read_text()).get("briefing") or {}).get("beats"))
    # V5: story grouping, open-text quotes, machine summaries. A failure here is
    # recorded in source health and never stops the feed from publishing.
    try:
        ecfg = elections.load()
        e_active = elections.active(ecfg, datetime.now(NY).date())
        stories.run(state, data, {s["id"]: s for s in sources}, session, robots_allows, TIMEOUT, log, follows,
                    load_standing() + (elections.race_threads(e_active) if e_active else []))
    except Exception as exc:
        log(f"[v5] failed: {type(exc).__name__}: {exc}")
        data["sources"].append({"id": "v5", "name": "Story grouping and summaries", "short": "Stories", "desk": "SYSTEM",
                                "poll": 15, "last_success": None, "last_attempt": iso(now_utc()),
                                "last_error": f"{type(exc).__name__}: {exc}"[:300], "last_status": None,
                                "robots": "n/a", "items": 0})
    # Voter guide: the active election from elections.yaml, and what's next.
    try:
        data["sources"].append(elections.run(data, log))
    except Exception as exc:
        log(f"[elections] failed: {type(exc).__name__}: {exc}")
    # Israel section: the latest seat polls by pollster, ahead of the Oct 27 election.
    try:
        import israel_polls
        data["sources"].append(israel_polls.run(state, data, session, log))
        import israel_results
        row = israel_results.run(state, data, session, log)
        if row:
            data["sources"].append(row)
    except Exception as exc:
        log(f"[il_polls] failed: {type(exc).__name__}: {exc}")
    # V6: push-alert candidates for the Cloudflare Worker, and its health.
    try:
        alerts.run(data, yaml.safe_load(CONFIG.read_text()).get("push_alerts") or {}, DIST, log)
    except Exception as exc:
        log(f"[alerts] failed: {type(exc).__name__}: {exc}")
    try:
        brief.build(data, yaml.safe_load(CONFIG.read_text()).get("briefing") or {}, DIST, log, state.get("texts"))
    except Exception as exc:
        log(f"[brief] failed: {type(exc).__name__}: {exc}")
    # Stage 3: the sources a thread question is answered from (functions/ask.js reads it from KV).
    try:
        import evidence
        evidence.build(state, data, {s["id"]: s for s in sources}, DIST, log)
    except Exception as exc:
        log(f"[evidence] failed: {type(exc).__name__}: {exc}")
    # Quiet items that aren't part of any story never appear on the page; they were only
    # needed for grouping and the briefing, so the phone doesn't download them.
    in_story = {m for s in data.get("stories", []) for m in s["members"]} | {m for t in data.get("threads", []) for m in t.get("members", [])}
    before = len(data["items"])
    # Israel and Jewish-world items ship too: the Israel segment lists them under its headings.
    seg_cut = now_utc() - timedelta(hours=36)
    data["items"] = [it for it in data["items"] if not it.get("quiet") or it["id"] in in_story or it.get("people")
                     or (it.get("itopic") and parse_iso(it.get("t")) and parse_iso(it["t"]) >= seg_cut)]
    # Thread docs carry the document excerpt; items don't ship it (the stored records keep it).
    data["items"] = [{k: v for k, v in it.items() if k != "doc_text"} for it in data["items"]]
    log(f"[slim] shipped {len(data['items'])} of {before} items (quiet items outside stories stay in the build)")
    (DIST / "data.json").write_text(json.dumps(data, separators=(",", ":")))
    (DIST / "version.txt").write_text(data["generated_at"])
    mark_changed(state)
    save_state(state)
    failing = sum(1 for h in data["sources"] if h["last_error"])
    for h in data["sources"]:
        if h["last_error"]:
            # Your own searches (u_…) stay anonymous in the public log.
            log(f"[failing] {h['id']}: " + ("(your search)" if str(h["id"]).startswith("u_") else str(h["last_error"])[:160]))
    log(f"built {len(data['items'])} items from {len(sources)} sources "
        f"({failing} failing) in {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
