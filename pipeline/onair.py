"""On air later (2026-10-26): upcoming broadcasts in one list, for the Live tab and starred push alerts.

From: Beacon meetings (Granicus agendas' meeting times), House committee hearings (docs.house.gov
meeting feeds, quiet sources marked onair: house), your teams' next games, and on_air.yaml for the
rest (election nights, debates, arguments). Next 14 days, soonest first.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

ROOT = Path(__file__).resolve().parent.parent
NY = ZoneInfo("America/New_York")
DAYS = 14


def _id(*parts) -> str:
    return "oa_" + hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:10]


def run(data: dict, log) -> None:
    now = datetime.now(timezone.utc)
    end = now + timedelta(days=DAYS)
    out, seen = [], set()

    def add(at: datetime, title: str, kind: str, watch: str | None, note: str | None = None, ref: str | None = None, key=None):
        if not (now - timedelta(hours=2) <= at <= end):
            return
        k = key or _id(kind, title, at.isoformat())
        if k in seen:
            return
        seen.add(k)
        out.append({"id": k, "at": at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), "title": title[:160], "kind": kind,
                    **({"watch": watch} if watch else {}), **({"note": note} if note else {}), **({"item": ref} if ref else {})})

    for it in data.get("items", []):
        if not it.get("event_at"):
            continue
        try:
            at = datetime.fromisoformat(it["event_at"].replace("Z", "+00:00"))
        except ValueError:
            continue
        if it.get("onair") == "house":
            add(at, it["source"] + ": " + it["title"], "hearing", it["link"], "House committees stream on their own sites; the link has the details.", it["id"])
        elif it.get("source_id", "").startswith("beacon_granicus"):
            add(at, "Beacon " + it["title"].split(" - ")[0], "meeting", "beacon", "Streams on the City of Beacon's YouTube channel.", it["id"], key=_id("beacon", it["title"].split(" - ")[0], at.isoformat()))
    for t in data.get("teams") or []:
        nx = t.get("next") or {}
        if nx.get("at"):
            try:
                at = datetime.fromisoformat(str(nx["at"]).replace("Z", "+00:00"))
            except ValueError:
                continue
            opp = nx.get("opp") or nx.get("vs") or ""
            add(at, f"{t.get('short') or t.get('name')}" + (f" vs {opp}" if opp else "") , "game", None, nx.get("tv"))
    f = ROOT / "on_air.yaml"
    for e in (yaml.safe_load(f.read_text()) or {}).get("events", []) if f.exists() else []:
        try:
            at = datetime.strptime(str(e["at"]), "%Y-%m-%d %H:%M").replace(tzinfo=NY)
        except (KeyError, ValueError):
            continue
        add(at, e["title"], e.get("kind", "event"), e.get("watch"), e.get("note"), key="oa_" + str(e.get("id")))
    out.sort(key=lambda x: x["at"])
    data["on_air"] = out[:40]
    log(f"[onair] {len(out)} upcoming")
