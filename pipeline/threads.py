"""Threads: the unit of The Wire (BRIEF.md, second brief).

A thread is a story followed over time: an event, a process (an application before a
board, a bill, a case), a subject, an entity, or an area of law. Unlike the story clusters
that stories.group() recomputes every build, a thread keeps its identity for as long as it
is alive. It lives in the build state (the Actions cache, never git) and accumulates:
members (report ids), a dated log of developments, the primary documents attached to it,
and whether Joe follows it.

Each build: match this build's clusters to living threads (shared members first, then
headline similarity), open threads for new clusters that deserve one, attach any named
topic threads Joe follows, log developments only on material change, and mark threads
dormant when nothing has arrived for two weeks.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from datetime import datetime, timedelta, timezone

from stories import ms, words

DORMANT_AFTER_H = 14 * 24          # no new reports for two weeks -> dormant (kept, not shown)
FORGET_AFTER_H = 60 * 24           # dormant two months -> dropped from state
MATCH_SIM = 0.35                   # headline similarity to join a living thread without a shared report
MATCH_WINDOW_H = 7 * 24
DEV_GAP_H = 4                      # a new batch of reports counts as a development after this long
MAX_DEVELOPMENTS = 40
DOC_SOURCES_RE = re.compile(r"agendaviewer|courtlistener\.com/opinion|federalregister\.gov|dos\.ny\.gov|dec\.ny\.gov|docs\.house\.gov|senate\.gov|dutchessny\.gov", re.IGNORECASE)
LIVE_RE = re.compile(r"^\W*(live|watch|replay)\b", re.IGNORECASE)


def _tid(seed: str) -> str:
    return "t_" + hashlib.sha1(seed.encode()).hexdigest()[:10]


def is_document(it: dict) -> bool:
    return it.get("kind") == "DOC" or bool(it.get("agenda")) or bool(DOC_SOURCES_RE.search(it.get("link", "")))


def infer_kind(members: list[dict], story: dict | None) -> str:
    if any(m.get("agenda") or m.get("event_at") for m in members):
        return "process"
    desks = Counter(m["desk"] for m in members)
    if desks.most_common(1)[0][0] == "LAW":
        return "law" if any(is_document(m) for m in members) else "subject"
    if story and (story.get("developing") or desks.most_common(1)[0][0] == "WORLD"):
        return "event"
    return "event"


def _plain_title(members: list[dict]) -> str:
    """The newest plain English headline: not a live blog, not translated, not WSJ."""
    ranked = sorted(members, key=lambda m: (not m.get("no_ai"), not m.get("translated"), not LIVE_RE.match(m["title"]), ms(m)), reverse=True)
    return ranked[0]["title"] if ranked else ""


def _figure_signature(story: dict) -> set[tuple]:
    return {(f["what"], r["source"], r["n"]) for f in story.get("figures", []) for r in f.get("reports", [])}


def update(state: dict, data: dict, follows: dict, now: datetime, log) -> None:
    """Match clusters to threads, open new ones, log developments. Writes data['threads']
    and a thread id onto each story; the full thread records stay in state['threads']."""
    threads: dict = state.setdefault("threads", {})
    by_id = {it["id"]: it for it in data["items"]}
    stories = data.get("stories", [])
    member_thread = {m: tid for tid, t in threads.items() for m in t["members"]}
    tvocab = {tid: words(" ".join(t.get("titles", [])[-6:])) for tid, t in threads.items()}

    def similar(title_words: set[str], tid: str) -> float:
        a, b = title_words, tvocab.get(tid, set())
        if not a or not b:
            return 0.0
        shared = a & b
        return len(shared) / math.sqrt(len(a) * len(b))

    stamp = now.isoformat().replace("+00:00", "Z")
    cutoff_match = now - timedelta(hours=MATCH_WINDOW_H)
    opened = matched = devs = 0

    for s in stories:
        members = [by_id[m] for m in s["members"] if m in by_id]
        if not members:
            continue
        # 1) a living thread already holding one of these reports
        hits = Counter(member_thread[m["id"]] for m in members if m["id"] in member_thread)
        tid = hits.most_common(1)[0][0] if hits else None
        # 2) else, a recent thread with a similar headline vocabulary
        if tid is None:
            tw = words(" ".join(m["title"] for m in members[:6]))
            best = max(((similar(tw, k), k) for k, t in threads.items()
                        if t["status"] == "active" and datetime.fromisoformat(t["last"].replace("Z", "+00:00")) >= cutoff_match
                        and t.get("desk") == s["desk"]), default=(0.0, None))
            if best[0] >= MATCH_SIM:
                tid = best[1]
        # 3) else, open a thread when the story has weight: 2+ outlets, a document, or a watch hit
        if tid is None:
            weight = s["sources"] >= 2 or any(is_document(m) for m in members) or any(m.get("watch") for m in members)
            if not weight:
                continue
            tid = _tid(s["id"])
            threads[tid] = {"id": tid, "kind": infer_kind(members, s), "desk": s["desk"], "opened": s["first"], "last": s["first"],
                            "members": [], "titles": [], "developments": [], "docs": [], "status": "active",
                            "outlets": 0, "figsig": [], "named": False}
            opened += 1
        else:
            matched += 1
        t = threads[tid]
        s["thread"] = tid
        new_members = [m for m in members if m["id"] not in set(t["members"])]
        for m in new_members:
            t["members"].append(m["id"])
            member_thread[m["id"]] = tid
        t["members"] = t["members"][-400:]
        t["title"] = _plain_title(members)
        if t["title"] and t["title"] not in t["titles"]:
            t["titles"] = (t["titles"] + [t["title"]])[-12:]
        t["desk"] = s["desk"]
        t["kind"] = t.get("kind") or infer_kind(members, s)
        t["last"] = max(t["last"], s["last"])
        t["status"] = "active"
        t["developing"] = bool(s.get("developing"))
        # documents attached to the thread (primary sources)
        for m in members:
            if is_document(m) and not any(d["id"] == m["id"] for d in t["docs"]):
                t["docs"].append({"id": m["id"], "t": m["t"], "title": m["title"], "source": m["source"], "link": m["link"]})
        t["docs"] = sorted(t["docs"], key=lambda d: d["t"])[-12:]
        # a development: outlets reached 2, grew by 3+, a figure changed, a document arrived,
        # or a fresh batch after a quiet spell
        outlets_now = s["sources"]
        figsig = _figure_signature(s)
        new_figs = figsig - set(tuple(x) for x in t.get("figsig", []))
        new_docs = [m for m in new_members if is_document(m)]
        last_dev = t["developments"][-1]["t"] if t["developments"] else None
        quiet = not last_dev or (now - datetime.fromisoformat(last_dev.replace("Z", "+00:00"))) >= timedelta(hours=DEV_GAP_H)
        reason = None
        if new_docs:
            reason = "document"
        elif t["outlets"] < 2 <= outlets_now:
            reason = "confirmed"
        elif outlets_now >= t["outlets"] + 3:
            reason = "spread"
        elif new_figs:
            reason = "figures"
        elif new_members and quiet and len(new_members) >= 2:
            reason = "update"
        if reason and new_members:
            batch = new_docs if reason == "document" else new_members
            lead = sorted(batch, key=lambda m: (not m.get("no_ai"), not m.get("translated"), not LIVE_RE.match(m["title"]), ms(m)), reverse=True)[0]
            t["developments"].append({
                "t": lead["t"], "text": lead["title"], "source": lead["source"], "link": lead["link"], "id": lead["id"],
                "reason": reason, "outlets": outlets_now,
                "also": sorted({m["source"] for m in batch if m["source"] != lead["source"]})[:5],
            })
            t["developments"] = t["developments"][-MAX_DEVELOPMENTS:]
            devs += 1
        t["outlets"] = max(t["outlets"], outlets_now)
        t["figsig"] = [list(x) for x in figsig][:60]

    # Named topic threads Joe follows: attach matching reports, whatever cluster they're in.
    for topic in (follows or {}).get("topics", []):
        tid = topic["id"]
        pat = topic_pattern(topic)
        if not pat:
            continue
        t = threads.get(tid) or {"id": tid, "kind": topic.get("kind") or "subject", "desk": topic.get("desk") or "GOV", "opened": topic.get("since") or stamp,
                                "last": topic.get("since") or stamp, "members": [], "titles": [], "developments": [], "docs": [], "status": "active",
                                "outlets": 0, "figsig": [], "named": True}
        threads[tid] = t
        t["named"] = True
        t["title"] = topic["title"]
        t["pattern"] = topic.get("pattern") or topic["title"]
        new = [it for it in data["items"] if it["id"] not in set(t["members"]) and pat.search(it["title"] + " " + (it.get("summary") or "")[:300])
               and ms(it) >= datetime.fromisoformat(t["opened"].replace("Z", "+00:00")) - timedelta(days=7)]
        for it in sorted(new, key=ms):
            t["members"].append(it["id"])
            if is_document(it) and not any(d["id"] == it["id"] for d in t["docs"]):
                t["docs"].append({"id": it["id"], "t": it["t"], "title": it["title"], "source": it["source"], "link": it["link"]})
            last_dev = t["developments"][-1]["t"] if t["developments"] else None
            if not last_dev or ms(it) - datetime.fromisoformat(last_dev.replace("Z", "+00:00")) >= timedelta(hours=DEV_GAP_H) or is_document(it):
                t["developments"].append({"t": it["t"], "text": it["title"], "source": it["source"], "link": it["link"], "id": it["id"],
                                          "reason": "document" if is_document(it) else "update", "outlets": 1, "also": []})
            t["last"] = max(t["last"], it["t"])
        t["members"] = t["members"][-400:]
        t["developments"] = t["developments"][-MAX_DEVELOPMENTS:]
        t["status"] = "active"

    # Dormancy and forgetting
    for tid, t in list(threads.items()):
        age_h = (now - datetime.fromisoformat(t["last"].replace("Z", "+00:00"))).total_seconds() / 3600
        if age_h > FORGET_AFTER_H and not t.get("named"):
            del threads[tid]
        elif age_h > DORMANT_AFTER_H:
            t["status"] = "dormant"

    followed = {f["id"] for f in (follows or {}).get("threads", [])} | {tp["id"] for tp in (follows or {}).get("topics", [])}
    for tid, t in threads.items():
        t["followed"] = tid in followed

    # Ship: active threads with their live members (the page needs ids it has), newest first.
    live = {it["id"] for it in data["items"]}
    out = []
    for t in threads.values():
        if t["status"] != "active":
            continue
        mem = [m for m in t["members"] if m in live]
        if not mem and not t.get("named"):
            continue
        out.append({k: t[k] for k in ("id", "kind", "desk", "title", "opened", "last", "status", "followed", "named", "developing", "outlets") if k in t}
                   | {"members": mem[-200:], "developments": t["developments"][-MAX_DEVELOPMENTS:], "docs": t["docs"],
                      "n_reports": len(t["members"]), **({"pattern": t["pattern"]} if t.get("pattern") else {})})
    out.sort(key=lambda t: (t.get("followed", False), t["last"]), reverse=True)
    data["threads"] = out
    log(f"[threads] {len(out)} active ({sum(1 for t in out if t['followed'])} followed), matched {matched}, opened {opened}, "
        f"developments logged {devs}, dormant {sum(1 for t in threads.values() if t['status'] == 'dormant')}")


def topic_pattern(topic: dict) -> re.Pattern | None:
    """Whole-word match on the topic's terms (comma-separated; a trailing * matches a prefix)."""
    terms = [x.strip() for x in str(topic.get("pattern") or topic.get("title") or "").split(",") if x.strip()]
    if not terms:
        return None
    parts = [re.escape(w[:-1]) + r"\w*" if w.endswith("*") else re.escape(w) for w in terms]
    return re.compile(r"(?<!\w)(?:" + "|".join(parts) + r")(?!\w)", re.IGNORECASE)
