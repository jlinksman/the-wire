"""V6 push alerts: decide what deserves a phone push.

The build writes dist/alerts.json (the rules from sources.yaml plus a short list of
candidates); the Cloudflare Worker (worker/index.js) reads it from KV every 3 minutes,
adds live NWS warnings it fetches itself, enforces the daily cap and dedupe, and sends
through ntfy.sh. The Worker's state comes back here as a source-health row, so a broken
alert path is visible on the page like any broken source.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone

import requests


def _t(it: dict) -> datetime:
    return datetime.fromisoformat(it["t"].replace("Z", "+00:00"))


def _pattern(words: list[str]) -> re.Pattern:
    # Whole words; a trailing * makes a prefix ("evacuat*" matches evacuate, evacuation).
    parts = [re.escape(w[:-1]) + r"\w*" if w.endswith("*") else re.escape(w) + r"\b" for w in words]
    return re.compile(r"\b(?:" + "|".join(parts) + ")", re.IGNORECASE)


def candidates(data: dict, cfg: dict, now: datetime | None = None) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    items = {it["id"]: it for it in data["items"]}
    out: list[dict] = []

    b = cfg.get("beacon_official") or {}
    if b:
        pat = _pattern(b.get("keywords", []))
        for it in data["items"]:
            if it["source_id"] in b.get("sources", []) and now - _t(it) < timedelta(hours=6):
                m = pat.search(f"{it['title']} {it.get('summary', '')}")
                if m:
                    out.append({
                        "key": "item:" + it["id"], "kind": "beacon", "priority": 4, "tags": ["rotating_light"],
                        "title": "Beacon: " + it["title"][:120],
                        "message": (it.get("summary") or "")[:280] or "Posted by the City of Beacon.",
                        "click": it["link"],
                    })

    g = cfg.get("geopolitical") or {}
    if g:
        pat = _pattern(g.get("keywords", []))
        for s in data.get("stories", []):
            if s.get("desk") not in g.get("desks", []):
                continue
            members = [items[m] for m in s["members"] if m in items]
            first_by_outlet: dict[str, datetime] = {}
            for it in members:
                t = _t(it)
                if it["source"] not in first_by_outlet or t < first_by_outlet[it["source"]]:
                    first_by_outlet[it["source"]] = t
            times = sorted(first_by_outlet.values())
            if len(times) < g.get("min_outlets", 3):
                continue
            third = times[g.get("min_outlets", 3) - 1]
            if third - times[0] > timedelta(minutes=g.get("window_minutes", 30)):
                continue
            if now - third > timedelta(minutes=g.get("max_age_minutes", 90)):
                continue
            if not any(pat.search(it["title"]) for it in members):
                continue
            lead = items.get(s["lead"]) or members[0]
            outlets = sorted({it["source"] for it in members})
            msg = s.get("summary") or lead.get("summary") or ""
            out.append({
                "key": "story:" + s["id"], "kind": "geo", "priority": 4, "tags": ["globe_with_meridians"],
                "title": lead["title"][:140],
                "message": (f"{len(outlets)} outlets: {', '.join(outlets)}. " + msg)[:300],
                "click": lead["link"],
            })
    return out


def _kv_get(key: str):
    acct, token, ns = (os.environ.get(k) for k in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "WIRE_KV_ID"))
    if not (acct and token and ns):
        return None, "not configured here"
    try:
        r = requests.get(f"https://api.cloudflare.com/client/v4/accounts/{acct}/storage/kv/namespaces/{ns}/values/{key}",
                         headers={"Authorization": f"Bearer {token}"}, timeout=15)
        if r.status_code == 404:
            return None, None
        r.raise_for_status()
        return r.json(), None
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"[:200]


def run(data: dict, cfg: dict, dist, log) -> None:
    if not cfg:
        return
    now = datetime.now(timezone.utc)
    cands = candidates(data, cfg, now)
    public_cfg = {k: v for k, v in cfg.items() if k in ("daily_cap", "nws")}
    (dist / "alerts.json").write_text(json.dumps({
        "generated_at": now.isoformat().replace("+00:00", "Z"), "config": public_cfg, "candidates": cands,
    }, separators=(",", ":")))
    log(f"[alerts] {len(cands)} candidates: " + "; ".join(c["title"][:60] for c in cands[:3]))

    state, err = _kv_get("alerts_state")
    if err == "not configured here":
        return
    beat = state.get("last_ok") if state else None
    stale = not beat or now - datetime.fromisoformat(beat.replace("Z", "+00:00")) > timedelta(minutes=90)
    problem = err or (state or {}).get("last_error") or ("alert checker hasn't reported yet" if not state else
                                                          ("alert checker silent for 90+ minutes" if stale else None))
    data["sources"].append({
        "id": "push_alerts", "name": "Push alerts (Cloudflare Worker → ntfy.sh)", "short": "Push alerts",
        "desk": "SYSTEM", "poll": 3, "last_success": beat, "last_attempt": now.isoformat().replace("+00:00", "Z"),
        "last_error": problem, "last_status": None, "robots": "n/a",
        "items": (state or {}).get("count", 0),
    })
