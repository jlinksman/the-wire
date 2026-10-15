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
from urllib.parse import urljoin, urlparse

import feedparser
import requests
import yaml
from bs4 import BeautifulSoup
from protego import Protego

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
}

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

def load_config() -> tuple[list[dict], list[dict], list[tuple[str, re.Pattern]]]:
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

    video = []
    groups = cfg.get("video_youtube") or {}
    # 24/7 breaking channels first, so the default preset is always live.
    for name in ["breaking"] + [g for g in groups if g != "breaking"]:
        for v in groups.get(name) or []:
            if v.get("enabled") and v.get("channel_id"):
                video.append({"id": v["id"], "name": v["name"], "channel_id": v["channel_id"]})

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
    return sources, video, watch


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


def parse_wp_media(src: dict, content: bytes) -> list[dict]:
    items = []
    for m in json.loads(content):
        title = html.unescape((m.get("title") or {}).get("rendered", "")).strip()
        url = m.get("source_url")
        if not url:
            continue
        if re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", title):
            label = f"Police blotter: {title}"
        else:
            label = f"City document: {title or url.rsplit('/', 1)[-1]}"
        items.append({
            "title": label,
            "link": url,
            "summary": "PDF posted to beaconny.gov",
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
        items = pick_parser(src)(src, r.content)
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
    for it in items:
        key = item_id(it["link"] + ("|" + it["alert"]["key"] if it.get("alert") else ""))
        text = f"{it['title']} {it.get('summary', '')}"
        groups = sorted({g for g, pat, skip in watch if src["desk"] not in skip and pat.search(text)})
        existing = store.get(key)
        store[key] = {
            "id": key,
            "source_id": src["id"],
            "source": src["name"],
            "desk": src["desk"],
            "fast": bool(src.get("fast")),
            "title": it["title"],
            "link": it["link"],
            "summary": it.get("summary", ""),
            "published": it.get("published"),
            "first_seen": existing["first_seen"] if existing else stamp,
            "watch": groups,
            **({"alert": it["alert"]} if it.get("alert") else {}),
        }


def prune(state: dict) -> None:
    cutoff = now_utc() - timedelta(days=KEEP_DAYS)
    floor = now_utc() - timedelta(days=MIN_KEEP_DAYS)
    store = state["items"]
    newest: dict[str, list[tuple[datetime, str]]] = {}
    for k, v in store.items():
        newest.setdefault(v["source_id"], []).append((sort_time(v), k))
    protected = set()
    for rows in newest.values():
        rows.sort(reverse=True)
        protected.update(k for t, k in rows[:MIN_PER_SOURCE] if t >= floor)
    for k in [k for k, v in store.items() if sort_time(v) < cutoff and k not in protected]:
        del store[k]
    for k, v in list(store.items()):
        exp = parse_iso((v.get("alert") or {}).get("expires"))
        if exp and exp < now_utc():
            del store[k]


# ---------------------------------------------------------------- output

def write_dist(state: dict, sources: list[dict], video: list[dict]) -> dict:
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
            "id": s["id"], "name": s["name"], "desk": s["desk"], "poll": s["poll"],
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
    }
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(SITE, DIST)
    (DIST / "data.json").write_text(json.dumps(data, separators=(",", ":")))
    return data


def src_robots(s: dict) -> str:
    return "subscription" if s.get("robots") == "subscription" else "honored"


def main() -> int:
    started = time.time()
    sources, video, watch = load_config()
    state = load_state()
    state.setdefault("robots", {})
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda s: (s, *fetch_source(s, state, session)), sources))

    for src, outcome, items in results:
        if items is not None:
            merge(state, src, items, watch)
        err = state["sources"][src["id"]].get("last_error")
        log(f"[{outcome:>12}] {src['id']:<26} {len(items) if items is not None else '-':>4}  {err or ''}")

    # Forget sources removed from config so health doesn't show ghosts.
    live = {s["id"] for s in sources}
    state["sources"] = {k: v for k, v in state["sources"].items() if k in live}
    state["items"] = {k: v for k, v in state["items"].items() if v["source_id"] in live}

    prune(state)
    data = write_dist(state, sources, video)
    save_state(state)
    failing = sum(1 for h in data["sources"] if h["last_error"])
    log(f"built {len(data['items'])} items from {len(sources)} sources "
        f"({failing} failing) in {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
