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
REVIVE_SIM = 0.5                   # a dormant thread revives only on a clearly similar new cluster
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


def update(state: dict, data: dict, follows: dict, now: datetime, log, standing: list | None = None) -> None:
    """Match clusters to threads, open new ones, log developments. Writes data['threads']
    and a thread id onto each story; the full thread records stay in state['threads'].
    `standing` are the area-of-law threads from threads.yaml: named threads that exist
    whether or not they are followed and never go dormant."""
    threads: dict = state.setdefault("threads", {})
    signals = {sg["id"]: sg["value"] for sg in (follows or {}).get("signals", []) if sg.get("id") and sg.get("value") in ("more", "less")}
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
    opened = matched = devs = revivals = 0

    claimed: set[str] = set()      # one thread per cluster per build; the biggest cluster wins
    for s in sorted(stories, key=lambda x: len(x["members"]), reverse=True):
        members = [by_id[m] for m in s["members"] if m in by_id]
        if not members:
            continue
        # 1) a living thread already holding one of these reports
        hits = Counter(member_thread[m["id"]] for m in members if m["id"] in member_thread and member_thread[m["id"]] not in claimed)
        tid = hits.most_common(1)[0][0] if hits else None
        # 2) else, a recent thread with a similar headline vocabulary
        if tid is None:
            tw = words(" ".join(m["title"] for m in members[:6]))
            best = max(((similar(tw, k), k) for k, t in threads.items()
                        if t["status"] == "active" and k not in claimed and datetime.fromisoformat(t["last"].replace("Z", "+00:00")) >= cutoff_match
                        and t.get("desk") == s["desk"]), default=(0.0, None))
            if best[0] >= MATCH_SIM:
                tid = best[1]
            else:
                # Revival (stage 4): a dormant thread comes back when a new cluster on its desk
                # reads clearly like it. The bar is higher than for a living thread.
                old = max(((similar(tw, k), k) for k, t in threads.items()
                           if t["status"] == "dormant" and k not in claimed and not t.get("named") and t.get("desk") == s["desk"]), default=(0.0, None))
                if old[0] >= REVIVE_SIM:
                    tid = old[1]
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
        claimed.add(tid)
        s["thread"] = tid
        revived = t["status"] == "dormant"
        if revived:
            t["revived_at"] = stamp
            revivals += 1
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
        if revived and new_members:
            reason = "revived"
        elif new_docs:
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

    # Reports Joe added to a followed thread by hand ("Add to a thread" on the page).
    added = 0
    for entry in (follows or {}).get("threads", []):
        items = [by_id[i] for i in entry.get("items", []) if i in by_id]
        if not items:
            continue
        t = threads.get(entry["id"])
        if not t:
            # The thread it belonged to is gone (forgotten) or was never one: rebuild it around his reports.
            t = {"id": entry["id"], "kind": "subject", "desk": items[0]["desk"], "opened": entry.get("since") or stamp, "last": entry.get("since") or stamp,
                 "members": [], "titles": [], "developments": [], "docs": [], "status": "active", "outlets": 0, "figsig": [], "named": False,
                 "title": entry.get("title") or items[0]["title"]}
            threads[entry["id"]] = t
        added += _add_by_hand(t, items)
    if added:
        log(f"[threads] {added} reports added by hand")

    # Named topic threads Joe follows, and the standing area-of-law threads from threads.yaml:
    # attach matching reports, whatever cluster they're in. A topic with no watch terms is a
    # hand-built thread: only the reports Joe adds belong to it.
    standing_ids = {x["id"] for x in (standing or [])}
    followed_topic_ids = {tp["id"] for tp in (follows or {}).get("topics", [])}
    for topic in list((follows or {}).get("topics", [])) + [dict(x, standing=True) for x in (standing or [])]:
        tid = topic["id"]
        pat = topic_pattern(topic) if (topic.get("pattern") or topic.get("standing")) else None
        if not pat and not topic.get("items"):
            continue
        t = threads.get(tid) or {"id": tid, "kind": topic.get("kind") or "subject", "desk": topic.get("desk") or "GOV", "opened": topic.get("since") or stamp,
                                "last": topic.get("since") or stamp, "members": [], "titles": [], "developments": [], "docs": [], "status": "active",
                                "outlets": 0, "figsig": [], "named": True}
        threads[tid] = t
        t["named"] = True
        t["standing"] = bool(topic.get("standing"))
        if topic.get("group"):
            t["group"] = topic["group"]
        if topic.get("dates"):
            t["dates"] = topic["dates"]
        t["kind"] = topic.get("kind") or t.get("kind") or "subject"
        t["title"] = topic["title"]
        if pat:
            t["pattern"] = topic.get("pattern") or topic["title"]
        else:
            t.pop("pattern", None)
            t["manual"] = True
        _add_by_hand(t, [by_id[i] for i in topic.get("items", []) if i in by_id])
        beat = topic.get("beat")
        new = [it for it in data["items"] if pat and it["id"] not in set(t["members"]) and pat.search(it["title"] + " " + (it.get("summary") or "")[:300])
               and (not beat or beat in (it.get("beats") or []))
               and ms(it) >= datetime.fromisoformat(t["opened"].replace("Z", "+00:00")) - timedelta(days=30 if topic.get("standing") else 7)]
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
        if tid in standing_ids:
            t["status"] = "active"
        elif t.get("standing") and tid not in followed_topic_ids:
            del threads[tid]               # removed from threads.yaml and not a topic Joe follows: gone
        elif t.get("standing"):
            t["standing"] = False          # removed from threads.yaml but followed: an ordinary topic now
        elif age_h > FORGET_AFTER_H and not t.get("named"):
            del threads[tid]
        elif age_h > DORMANT_AFTER_H:
            t["status"] = "dormant"

    followed = {f["id"] for f in (follows or {}).get("threads", [])} | {tp["id"] for tp in (follows or {}).get("topics", [])}
    for tid, t in threads.items():
        t["followed"] = tid in followed
        if tid in signals:
            t["signal"] = signals[tid]
        else:
            t.pop("signal", None)

    # Ship: active threads with their live members (the page needs ids it has), newest first.
    live = {it["id"] for it in data["items"]}
    out = []
    for t in threads.values():
        if t["status"] != "active":
            continue
        mem = [m for m in t["members"] if m in live]
        if not mem and not t.get("named"):
            continue
        rec = {k: t[k] for k in ("id", "kind", "desk", "title", "opened", "last", "status", "followed", "named", "standing", "manual", "group", "dates", "developing", "outlets", "signal", "revived_at", "added") if k in t}
        rec |= {"members": mem[-200:], "developments": t["developments"][-MAX_DEVELOPMENTS:], "docs": t["docs"],
                "n_reports": len(t["members"]), **({"pattern": t["pattern"]} if t.get("pattern") else {})}
        if rec.get("revived_at") and (now - datetime.fromisoformat(rec["revived_at"].replace("Z", "+00:00"))) > timedelta(hours=48):
            rec.pop("revived_at")      # the "back after a quiet spell" label lasts two days
        out.append(rec)
    out.sort(key=lambda t: (t.get("followed", False), t["last"]), reverse=True)
    data["threads"] = out
    data["suggest"] = suggest(out, follows or {}, now)
    log(f"[threads] {len(out)} active ({sum(1 for t in out if t['followed'])} followed, {sum(1 for t in out if t.get('standing'))} standing), "
        f"matched {matched}, opened {opened}, revived {revivals}, developments logged {devs}, "
        f"dormant {sum(1 for t in threads.values() if t['status'] == 'dormant')}, suggested {len(data['suggest'])}")


def _add_by_hand(t: dict, items: list[dict]) -> int:
    """Put Joe's hand-picked reports on a thread, logging each as a development."""
    n = 0
    have = set(t["members"])
    for it in sorted(items, key=ms):
        if it["id"] in have:
            continue
        t["members"].append(it["id"])
        have.add(it["id"])
        t.setdefault("added", []).append(it["id"])
        t["added"] = t["added"][-100:]
        if is_document(it) and not any(d["id"] == it["id"] for d in t["docs"]):
            t["docs"].append({"id": it["id"], "t": it["t"], "title": it["title"], "source": it["source"], "link": it["link"]})
        t["developments"].append({"t": it["t"], "text": it["title"], "source": it["source"], "link": it["link"], "id": it["id"],
                                  "reason": "added", "outlets": 1, "also": []})
        t["developments"] = sorted(t["developments"], key=lambda d: d["t"])[-MAX_DEVELOPMENTS:]
        t["last"] = max(t["last"], it["t"])
        t["status"] = "active"
        n += 1
    return n


def topic_pattern(topic: dict) -> re.Pattern | None:
    """Whole-word match on the topic's terms (comma-separated; a trailing * matches a prefix)."""
    terms = [x.strip() for x in str(topic.get("pattern") or topic.get("title") or "").split(",") if x.strip()]
    if not terms:
        return None
    parts = [re.escape(w[:-1]) + r"\w*" if w.endswith("*") else re.escape(w) for w in terms]
    return re.compile(r"(?<!\w)(?:" + "|".join(parts) + r")(?!\w)", re.IGNORECASE)


# ---------------------------------------------------------------- learning (stage 4)

SUGGEST_DESK = {"BEACON": 2.0, "LAW": 1.6, "GOV": 1.2, "WORLD": 1.0, "SPORTS": 0.6}


def _sim(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / math.sqrt(len(a) * len(b))


def taste(follows: dict) -> tuple[set[str], set[str]]:
    """Vocabulary of what Joe followed or asked for more of, and of what he asked for less of."""
    liked = set()
    for f in follows.get("threads", []) + follows.get("topics", []):
        liked |= words(f.get("title", ""))
    disliked = set()
    for sg in follows.get("signals", []):
        if sg.get("value") == "more":
            liked |= words(sg.get("title", ""))
        elif sg.get("value") == "less":
            disliked |= words(sg.get("title", ""))
    return liked, disliked - liked


def suggest(shipped: list[dict], follows: dict, now: datetime, limit: int = 3) -> list[str]:
    """Threads Joe might follow: unfollowed, with some life in them, close to what he follows
    and likes, local and law first, nothing he asked for less of."""
    liked, disliked = taste(follows)
    less = {sg["id"] for sg in follows.get("signals", []) if sg.get("value") == "less"}
    scored = []
    for t in shipped:
        if t.get("followed") or t.get("named") or t["id"] in less:
            continue
        alive = (t.get("outlets", 0) >= 2 or len(t.get("developments", [])) >= 2)
        if not alive:
            continue
        tw = words(t.get("title", ""))
        age_h = (now - datetime.fromisoformat(t["last"].replace("Z", "+00:00"))).total_seconds() / 3600
        score = SUGGEST_DESK.get(t["desk"], 1.0) * (1 + 2 * _sim(tw, liked) - 2 * _sim(tw, disliked)) * math.exp(-age_h / 48)
        score *= 1 + 0.1 * min(len(t.get("developments", [])), 6)
        scored.append((score, t["id"]))
    scored.sort(reverse=True)
    return [tid for _, tid in scored[:limit]]


def apply_signals(stories: list[dict], shipped: list[dict], follows: dict) -> int:
    """Re-rank stories by Joe's signals: a thread he wants more of rises, one he wants less of
    sinks, and stories that read like either move a little the same way. Returns how many moved."""
    if not follows:
        return 0
    liked, disliked = taste(follows)
    sig = {t["id"]: t.get("signal") for t in shipped if t.get("signal")}
    if not sig and not liked and not disliked:
        return 0
    moved = 0
    for s in stories:
        f = 1.0
        if sig.get(s.get("thread")) == "more":
            f *= 1.5
        elif sig.get(s.get("thread")) == "less":
            f *= 0.4
        else:
            tw = words(s.get("title", ""))
            f *= 1 + 0.4 * _sim(tw, liked) - 0.5 * _sim(tw, disliked)
        if abs(f - 1.0) > 0.01:
            s["score"] = round(s["score"] * f, 3)
            moved += 1
    stories.sort(key=lambda s: s["score"], reverse=True)
    return moved


# ---------------------------------------------------------------- document excerpts (stage 3)

EXCERPT_CHARS = 700
PUBLIC_DOC_RE = re.compile(r"courtlistener\.com/opinion|federalregister\.gov/documents|dec\.ny\.gov|dos\.ny\.gov|agendaviewer|docs\.house\.gov|congress\.gov|senate\.gov|nysenate\.gov|supremecourt\.gov|ca2\.uscourts\.gov|nycourts\.gov", re.IGNORECASE)


def is_public_document(link: str) -> bool:
    """Government works and court opinions: public documents whose text may be shown verbatim.
    News articles never qualify, whatever their license."""
    return bool(PUBLIC_DOC_RE.search(link or ""))


def excerpt_of(text: str) -> str:
    """The opening of a document, cleaned, cut at a sentence end near EXCERPT_CHARS."""
    t = re.sub(r"\s+", " ", text or "").strip()
    t = re.sub(r"^(?:(?:skip to (?:main )?content|share|print|download pdf|back to top)\W*)+", "", t, flags=re.IGNORECASE)
    if len(t) <= EXCERPT_CHARS:
        return t
    cut = t[:EXCERPT_CHARS]
    end = max(cut.rfind(". "), cut.rfind("; "), cut.rfind(".\u201d"))
    return (cut[:end + 1] if end > EXCERPT_CHARS // 2 else cut) + " …"


def attach_doc_excerpts(state: dict, data: dict) -> int:
    """Put a verbatim opening excerpt on each public document attached to a thread, from the
    document's fetched text or, failing that, the opening the feed itself carries (CourtListener
    feeds open with the opinion's first lines). Stored on the thread record and shipped."""
    texts = state.get("texts", {})
    threads = state.get("threads", {})
    by_id = {it["id"]: it for it in data["items"]}
    n = 0
    for t in threads.values():
        for d in t.get("docs", []):
            if d.get("excerpt") or not is_public_document(d.get("link", "")):
                continue
            body = (texts.get(d["id"]) or {}).get("text") or (by_id.get(d["id"]) or {}).get("doc_text") or ""
            if body and len(body) > 120:
                d["excerpt"] = excerpt_of(body)
                n += 1
    for t in data.get("threads", []):
        full = threads.get(t["id"])
        if full:
            t["docs"] = full.get("docs", [])
    return n
