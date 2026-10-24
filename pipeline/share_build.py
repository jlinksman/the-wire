"""Build the public ballot quiz's data (2026-10-24): share/ballot-data.json.

Joe: "share the application with a friend, family member or neighbor who could take the quiz …
and be directed on their own ballot."

Only public information goes in: the active election's dates and official links, the races and
candidates (names, lines, bios, positions with sources), the election check's statements, the
candidates' sourced stances, the ballot-line descriptions, and the statements' explainers. Never
Joe's scorecard, his answers, his notes, the "why it touches you" lines written for him, or
anything else personal. The share site's function serves this only while Joe's toggle is on.

Run: python pipeline/share_build.py (the share deploy workflow runs it too).
"""
import json
import re
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

ROOT = Path(__file__).resolve().parent.parent
PERSONAL = re.compile(r"\s*\((?:nearest|your)[^)]*\)", re.IGNORECASE)
# Sentences written for Joe's business (spill cost recovery, the Oil Spill Fund) stay out.
FOR_JOE = re.compile(r"[^.]*(?:Navigation Law|Oil Spill Fund)[^.]*\.(?:[^ ]*)?\s*", re.IGNORECASE)


def main():
    cfg = yaml.safe_load((ROOT / "elections.yaml").read_text())
    today = datetime.now(ZoneInfo("America/New_York")).date()
    els = sorted(cfg.get("elections") or [], key=lambda e: str(e["date"]))
    e = next((x for x in els if date.fromisoformat(str(x["date"])) >= today), els[-1] if els else None)
    explain = yaml.safe_load((ROOT / "explain.yaml").read_text()) or {}
    if not e:
        raise SystemExit("no election")
    races = []
    for r in e.get("races") or []:
        races.append({k: r.get(k) for k in ("id", "office", "district", "level", "job", "ratings", "polls") if r.get(k)} | {
            "note": FOR_JOE.sub("", PERSONAL.sub("", r["note"])).strip() or None if r.get("note") and "your district's candidate" not in r["note"].lower() else None,
            "local": r["id"] not in ("governor", "attorney_general", "comptroller"),
            "candidates": [{k: c.get(k) for k in ("name", "lines", "incumbent", "bio", "positions", "site", "running_mate") if c.get(k)} for c in r.get("candidates") or []]})
    q = e.get("quiz") or {}
    items = [{k: it[k] for k in ("id", "text", "axis", "dir") if k in it} for it in q.get("items") or []]
    out = {
        "id": e["id"], "title": e["title"], "date": str(e["date"]), "jurisdiction": e.get("jurisdiction"),
        "dates": [{"date": str(d.get("date") or ""), "label": PERSONAL.sub("", d["label"]), "note": d.get("note"), "source": d.get("source")} for d in e.get("dates") or []],
        "links": [l for l in e.get("links") or [] if "scorecard" not in l.get("label", "").lower()],
        "fusion": e.get("fusion"), "fusion_sources": e.get("fusion_sources"), "line_info": e.get("line_info"),
        "races": races, "items": items, "stances": q.get("stances") or {},
        "explain": {it["id"]: {k: explain[it["id"]].get(k) for k in ("now", "case_for", "case_against", "sources")} for it in items if it["id"] in explain},
        "built": datetime.now(ZoneInfo("America/New_York")).isoformat(timespec="minutes"),
    }
    (ROOT / "share" / "ballot-data.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"ballot-data.json: {len(races)} races, {len(items)} statements, {sum(len(v) for v in out['stances'].values())} stances")


if __name__ == "__main__":
    main()
