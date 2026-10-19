"""Test candidate feeds from where the build actually runs (GitHub's servers).

Usage: python pipeline/probe.py probe-candidates.txt
One polite request per feed: robots.txt checked first, honest User-Agent, no retries.
Prints status, item count and age of the newest item. Nothing is stored.
"""
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import feedparser
import requests
from protego import Protego

UA = "TheWire/1.0 (private personal news reader; polite polling; https://github.com/jlinksman/the-wire)"
s = requests.Session()
s.headers["User-Agent"] = UA
robots = {}

for line in open(sys.argv[1]):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    label, url = [x.strip() for x in line.split("|", 1)]
    host = "{0.scheme}://{0.netloc}".format(urlparse(url))
    if host not in robots:
        try:
            r = s.get(host + "/robots.txt", timeout=15)
            robots[host] = Protego.parse(r.text if r.status_code == 200 else "")
        except Exception:
            robots[host] = Protego.parse("")
    if not robots[host].can_fetch(url, "TheWire"):
        print(f"ROBOTS-NO  | {label:<34} | {url}")
        continue
    try:
        r = s.get(url, timeout=20)
        f = feedparser.parse(r.content)
        n = len(f.entries)
        newest = None
        for e in f.entries:
            t = e.get("published_parsed") or e.get("updated_parsed")
            if t:
                dt = datetime(*t[:6], tzinfo=timezone.utc)
                newest = dt if newest is None or dt > newest else newest
        age = f"{(datetime.now(timezone.utc) - newest).total_seconds() / 3600:.1f}h" if newest else "-"
        kind = "OK" if r.status_code == 200 and n else ("NOT-A-FEED" if r.status_code == 200 else f"HTTP{r.status_code}")
        if kind == "NOT-A-FEED":
            # An HTML page: list the feeds it advertises, so the next probe can try them.
            alts = re.findall(r'<link[^>]+type="application/(?:rss|atom)\+xml"[^>]*href="([^"]+)"', r.text, re.IGNORECASE)
            alts += re.findall(r'href="([^"]*(?:/feed/?|/rss[^"]*|\.xml))"', r.text, re.IGNORECASE)[:5]
            if alts:
                print(f"           | advertised feeds: {', '.join(dict.fromkeys(alts))[:300]}")
        print(f"{kind:<10} | {label:<34} | items {n:>3} | newest {age:>7} | {url}")
    except Exception as exc:
        print(f"ERROR      | {label:<34} | {type(exc).__name__} | {url}")
    time.sleep(1)
