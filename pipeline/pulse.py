"""The pulse and the values questionnaire, on the build side (2026-10-23).

Joe's answers live only in Workers KV (quiz.json). The workflow copies that key into a
gitignored quiz.json before the build; this module reads it and never writes it, and the build
log only ever says how many answers there are.

The pulse is five quick questions drawn from live threads: two of them paired ("which would you
rather read about"), and some "how much do you care how this turns out". Its answers become
taste, the same more/less vocabulary that following a thread or "Tell The Wire" feeds, so
stories and suggestions lean toward what he picked and away from what he said he doesn't care
about. Older answers fade: only the last PULSE_DAYS count, and for a subject asked about more
than once the latest answer wins.

The values questionnaire's statements (values.yaml) ship to the page; his answers are read
there, through /quiz, and never pass through the build.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
PULSE_DAYS = 120
PULSE_LAST = 60          # only the most recent answers steer, so answering a lot doesn't flatten taste


def load_answers() -> dict:
    f = ROOT / "quiz.json"
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text()) or {}
    except ValueError:
        return {}


def taste(q: dict, now: datetime | None = None) -> dict:
    """Pulse answers -> {"more": [titles], "less": [titles], "n": count}."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=PULSE_DAYS)
    latest: dict[str, int] = {}          # title -> score (latest answer wins)
    titles: dict[str, str] = {}
    n = 0
    for a in (q.get("pulse") or [])[-PULSE_LAST:]:
        try:
            at = datetime.fromisoformat(str(a.get("at", "")).replace("Z", "+00:00"))
        except ValueError:
            continue
        if at < cutoff:
            continue
        n += 1
        if a.get("t") == "pair":
            sides = {"a": a.get("a") or {}, "b": a.get("b") or {}}
            pick = a.get("pick")
            for k, s in sides.items():
                t = str(s.get("title") or "")[:160]
                if not t:
                    continue
                key = s.get("id") or t
                titles[key] = t
                if pick == k or pick == "both":
                    latest[key] = 1
                elif pick == "neither":
                    latest[key] = -1
                # The side not picked says nothing on its own.
        elif a.get("t") == "care":
            t = str(a.get("title") or "")[:160]
            if t:
                key = a.get("id") or t
                titles[key] = t
                v = int(a.get("v") or 0)
                latest[key] = 1 if v >= 1 else -1 if v <= -1 else 0
    more = [titles[k] for k, v in latest.items() if v > 0]
    less = [titles[k] for k, v in latest.items() if v < 0]
    # The starting questionnaire (baseline.yaml): standing preferences by subject; they don't fade.
    bank = {it["id"]: it for it in (baseline_bank() or {}).get("items", []) if it.get("terms")}
    nb = 0
    for qid, a in ((q.get("baseline") or {}).get("answers") or {}).items():
        it = bank.get(qid)
        if not it or a.get("skip") or a.get("v") is None:
            continue
        nb += 1
        if a["v"] >= 1:
            more += it["terms"]
        elif a["v"] <= -1:
            less += it["terms"]
    return {"more": more, "less": less, "n": n, "baseline_n": nb}


def baseline_bank() -> dict | None:
    f = ROOT / "baseline.yaml"
    return yaml.safe_load(f.read_text()) if f.exists() else None


def values_bank() -> dict | None:
    f = ROOT / "values.yaml"
    return yaml.safe_load(f.read_text()) if f.exists() else None


def run(data: dict, follows: dict, log) -> None:
    q = load_answers()
    t = taste(q)
    follows["pulse"] = t
    data.setdefault("follows", {})["pulse_n"] = t["n"]
    bank = values_bank()
    if bank:
        data["values_bank"] = bank
    lf = ROOT / "learn.yaml"
    if lf.exists():
        data["learn"] = yaml.safe_load(lf.read_text())
    f = ROOT / "israel_quiz.yaml"
    if f.exists():
        data["il_quiz"] = yaml.safe_load(f.read_text())
    bb = baseline_bank()
    if bb:
        data["baseline_bank"] = bb
    # Counts only: the build log is public.
    log(f"[pulse] {t['n']} answers in the last {PULSE_DAYS} days (newest {PULSE_LAST} count); starting questionnaire {t['baseline_n']} answers; values questionnaire "
        f"{'done' if (q.get('values') or {}).get('done_at') else 'not done'}")
