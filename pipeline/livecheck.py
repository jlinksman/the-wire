"""Which Live channels are on the air right now, and with which video (2026-10-23).

YouTube's "live_stream?channel=" embed, which the player used, stopped finding the current
stream for most channels: a check on Oct 23 found 19 channels live, and only 11 of them played
through it (Bloomberg, NASA, Euronews, the UN, i24NEWS, ABC, LiveNOW and Sky showed "video
unavailable"). Every one of those streams played when embedded by its own video id.

So the build looks up each channel's /channel/<id>/live page (allowed by YouTube's robots.txt),
notes whether it's live and the video id, and the page embeds that video. Still an official
embed of the channel's own stream; nothing is downloaded or rehosted. When a channel isn't live
the row says so, and the player falls back to the channel embed.

Polite: one request per channel every CHECK_MIN minutes, an honest User-Agent, and on a 403 or
429 the whole check stops for BACKOFF_H hours.
"""

from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

CHECK_MIN = 20
BACKOFF_H = 2
VIDEO_ID = re.compile(r'"currentVideoEndpoint":\{.{0,300}?"videoId":"([\w-]{11})"', re.S)
TITLE = re.compile(r'"videoPrimaryInfoRenderer":\{"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"')
LIVE = re.compile(r'\{"text":" watching(?: now)?"\}\]\},"isLive":true')


def parse(html: str) -> dict:
    vid = VIDEO_ID.search(html)
    live = bool(vid) and bool(LIVE.search(html))
    title = TITLE.search(html)
    try:
        t = json.loads('"' + title.group(1) + '"') if title else ""
    except ValueError:
        t = ""
    return {"live": live, "video_id": vid.group(1) if live else None, "title": t[:120] if live else None}


def run(state: dict, data: dict, session, log) -> dict:
    rec = state.setdefault("live_check", {"channels": {}})
    now = datetime.now(timezone.utc)
    chans = [v for v in data.get("video") or [] if v.get("channel_id")]
    hold = rec.get("hold_until")
    due = (not rec.get("at") or now - datetime.fromisoformat(rec["at"]) >= timedelta(minutes=CHECK_MIN))
    if due and not (hold and now < datetime.fromisoformat(hold)):
        rec["at"] = now.isoformat()

        def one(cid):
            try:
                r = session.get(f"https://www.youtube.com/channel/{cid}/live", timeout=20,
                                headers={"Accept-Language": "en-US,en"})
                if r.status_code in (403, 429):
                    return cid, {"blocked": r.status_code}
                if r.status_code != 200:
                    return cid, {"error": f"HTTP {r.status_code}"}
                return cid, parse(r.text)
            except Exception as exc:
                return cid, {"error": type(exc).__name__}

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = dict(pool.map(one, sorted({v["channel_id"] for v in chans})))
        blocked = [r["blocked"] for r in results.values() if r.get("blocked")]
        if blocked:
            rec["hold_until"] = (now + timedelta(hours=BACKOFF_H)).isoformat()
            rec["error"] = f"YouTube answered HTTP {blocked[0]}; backing off {BACKOFF_H}h"
        else:
            errs = [r["error"] for r in results.values() if r.get("error")]
            rec["error"] = f"{len(errs)} channels unreadable ({errs[0]})" if len(errs) > len(results) // 3 else None
        for cid, r in results.items():
            if "live" in r:
                rec["channels"][cid] = {**r, "at": now.isoformat()}
        rec["ok_at"] = now.isoformat() if not blocked else rec.get("ok_at")
        n_live = sum(1 for r in results.values() if r.get("live"))
        log(f"[live] {n_live} of {len(results)} channels live{'; ' + rec['error'] if rec.get('error') else ''}")
    # Annotate the lineup with the last known state (a check older than an hour isn't trusted).
    fresh = rec.get("ok_at") and now - datetime.fromisoformat(rec["ok_at"]) < timedelta(hours=1)
    for v in chans:
        r = rec["channels"].get(v["channel_id"]) if fresh else None
        if r:
            v["live"] = r["live"]
            if r["live"]:
                v["live_id"], v["live_title"] = r["video_id"], r["title"]
    return {"id": "live_check", "name": "Live channels: who's on the air (YouTube channel pages)", "short": "Live check",
            "desk": "SYSTEM", "poll": CHECK_MIN, "last_success": rec.get("ok_at"), "last_attempt": rec.get("at"),
            "last_error": rec.get("error"), "last_status": None, "robots": "honored",
            "items": sum(1 for v in chans if v.get("live"))}
