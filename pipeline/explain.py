"""Explainers for questionnaire statements (2026-10-23).

Joe: "an explainer button that could let me know the current state of a topic if I wanna
learn more before answering the question."

explain.yaml holds, for each statement in the election check and "Where you stand", a short
background written in a Claude session from official sources and established outlets: where
things stand, the strongest case on each side and who makes it, and the sources. It is neutral
by rule: both cases get equal space, and nothing hints at how an answer is counted.

The build adds the newest coverage: up to three recent items (last 14 days) whose headline or
description contains one of the statement's terms, so "where things stand" is never only as
fresh as the last time the file was written.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


def load() -> dict:
    f = ROOT / "explain.yaml"
    return (yaml.safe_load(f.read_text()) or {}) if f.exists() else {}


def run(data: dict, log) -> None:
    cfg = load()
    if not cfg:
        return
    now = datetime.now(timezone.utc)
    cut = now - timedelta(days=14)
    recent = []
    for it in data.get("items") or []:
        try:
            t = datetime.fromisoformat(it["t"].replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        if t >= cut and it.get("kind") != "POST":
            recent.append((t, it))
    recent.sort(key=lambda x: x[0], reverse=True)
    out, with_news = {}, 0
    for qid, e in cfg.items():
        if not isinstance(e, dict):
            continue
        pats = [re.compile(r"\b" + re.escape(term) + r"\b", re.IGNORECASE) for term in e.get("terms") or [] if len(str(term)) > 2]
        hits = []
        for t, it in recent:
            head = it["title"]
            text = head + " " + (it.get("summary") or "")
            score = sum(2 if p.search(head) else 1 for p in pats if p.search(text))
            if score >= 2:
                hits.append((score, t, it))
            if len(hits) >= 40:
                break
        hits.sort(key=lambda x: (x[0], x[1]), reverse=True)
        seen, latest = set(), []
        for _, t, it in hits:
            key = re.sub(r"\W+", "", it["title"].lower())[:60]
            if key in seen:
                continue
            seen.add(key)
            latest.append({"title": it["title"], "source": it.get("source"), "link": it["link"], "t": it["t"]})
            if len(latest) >= 3:
                break
        with_news += bool(latest)
        out[qid] = {k: e.get(k) for k in ("now", "case_for", "case_against", "sources")} | {"latest": latest}
    data["explain"] = out
    log(f"[explain] {len(out)} explainers, {with_news} with recent coverage")
