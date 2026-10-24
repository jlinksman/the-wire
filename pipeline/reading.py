"""Worth reading (2026-10-23): books being talked about, essays worth the time, and what
political writers are arguing about, with our own key takeaways.

Joe: "make sure I'm staying current with literature and other ideas/opinions… highlight a
couple items I should be reading or what people are talking about. Don't be afraid to offer
summaries."

Sources are the `reading:` section of sources.yaml (quiet: they never fill the news desks).

- Books. Every 6 hours, one call to the large model reads the last three weeks of book-world
  headlines and descriptions and names the specific books being talked about (reviewed, prized,
  debated). A book is kept only if its title appears in an item it cites, so the model can't
  invent one. For the top few, the open text of their reviews (robots honored; paywalled
  sources never read) is the only input to the takeaways: what the book is or argues, 3 to 5
  key points, and how reviewers received it, naming outlets. The page says plainly that these
  come from reviews, not from the book.
- Essays. Recent long-form pieces, spread across publications and perspectives and rotated by
  day; for the ones whose text is open, takeaways from the essay itself.
- Talk. Memeorandum's top political stories by volume of commentary, as headlines and links.

Text read here lives only in the Actions cache (state) and is never shipped or committed.
Budget: at most READING_DAILY_NEURONS of Workers AI a day, inside the build's overall cap.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone

from stories import AI_DAILY_NEURONS, SYNTH_IN, SYNTH_MODEL, SYNTH_OUT, _cf_run, ms

PICK_EVERY_H = 6
READING_DAILY_NEURONS = 1500
BOOKS_KEEP = 4
TAKEAWAY_TTL_D = 7
TEXT_CHARS = 6000

BOOKS_SYSTEM = (
    "You read a list of recent headlines and descriptions from book reviews and book news. "
    "Name the specific, recently published books the list shows people talking about: reviewed, "
    "praised, panned, given prizes, or debated. Most-discussed first. Use only the list; no outside knowledge. "
    "Skip classics being revisited, lists, obituaries and publishing-industry news unless a specific new book is the subject. "
    "Reply with JSON only: {\"books\": [{\"title\": \"exact title as written in the items\", \"author\": \"author as written, or empty\", "
    "\"items\": [item numbers that discuss it], \"hook\": \"one sentence, under 25 words, on what the book is, from the items\"}]} "
    "with at most 6 books.")

BOOK_TAKEAWAY_SYSTEM = (
    "You write key takeaways about one book for one busy reader, using only the reviews and articles given. "
    "You have not read the book; never claim to. No outside knowledge. Plain, short sentences. "
    "Reply with JSON only: {\"line\": \"one sentence, under 30 words: what the book is or argues\", "
    "\"takeaways\": [\"3 to 5 short points about its content or argument, as the reviews describe it\"], "
    "\"reception\": \"one or two sentences on how reviewers received it, naming the outlets\"}")

ESSAY_SYSTEM = (
    "You write key takeaways from one essay for one busy reader, using only the essay's text. "
    "Report the author's argument as theirs (\"argues\", \"says\"); don't endorse or rebut it. No outside knowledge. "
    "Reply with JSON only: {\"line\": \"one sentence, under 30 words: the essay's argument\", "
    "\"takeaways\": [\"3 to 5 short points: the main claims and the evidence or examples given\"]}")


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", s.lower().replace("’", "'")).strip()


def _read_text(state, st, it, src, session, robots_allows, timeout) -> str:
    """Open text of one item, cached in state; '' when not allowed or not open."""
    texts = st.setdefault("texts", {})
    rec = texts.get(it["id"])
    if rec is not None:
        return rec.get("text", "")
    text = ""
    if src.get("fulltext") and robots_allows(it["link"], state, session):
        try:
            import trafilatura
            r = session.get(it["link"], timeout=timeout)
            if r.status_code == 200:
                text = (trafilatura.extract(r.text, include_comments=False, include_tables=False, favor_precision=True) or "")[:TEXT_CHARS]
        except Exception:
            text = ""
    texts[it["id"]] = {"at": datetime.now(timezone.utc).isoformat(), "text": text}
    return text


def _budget_ok(ai: dict, st: dict) -> bool:
    return st.get("neurons", 0) < READING_DAILY_NEURONS and ai.get("neurons", 0) < AI_DAILY_NEURONS


def _spend(ai: dict, st: dict, n: float) -> None:
    ai["neurons"] = ai.get("neurons", 0) + n
    st["neurons"] = st.get("neurons", 0) + n


def run(state: dict, data: dict, pool: list[dict], src_by_id: dict, session, robots_allows, timeout, log) -> dict:
    """pool: every stored item from a reading source, with "t" set (quiet items can fall out of data["items"])."""
    now = datetime.now(timezone.utc)
    today = now.date().isoformat()
    ai = state.setdefault("ai", {})
    if ai.get("day") != today:
        ai.update({"day": today, "neurons": 0.0})
    st = state.setdefault("reading", {})
    if st.get("day") != today:
        st.update({"day": today, "neurons": 0.0})
    # Texts older than two weeks go.
    st["texts"] = {k: v for k, v in (st.get("texts") or {}).items()
                   if now - datetime.fromisoformat(v["at"]) < timedelta(days=14)}

    kind = lambda it: (src_by_id.get(it["source_id"]) or {}).get("reading")
    items = [it for it in pool if kind(it)]
    books_pool = sorted([it for it in items if kind(it) == "books" and now - ms(it) < timedelta(days=21)], key=ms, reverse=True)[:90]
    essays_pool = sorted([it for it in items if kind(it) == "essays" and now - ms(it) < timedelta(days=14)], key=ms, reverse=True)
    talk_pool = sorted([it for it in items if kind(it) == "talk"], key=ms, reverse=True)
    by_id = {it["id"]: it for it in items}
    err = None

    # 1. Which books are being talked about (every PICK_EVERY_H hours).
    due = not st.get("books_at") or now - datetime.fromisoformat(st["books_at"]) >= timedelta(hours=PICK_EVERY_H)
    if due and books_pool and _budget_ok(ai, st):
        listing = "\n".join(f"{i}. [{it['source']}] {it['title']} — {re.sub(r'<[^>]+>', ' ', it.get('summary') or '')[:220]}"
                            for i, it in enumerate(books_pool, 1))
        try:
            out, cost = _cf_run(session, SYNTH_MODEL, BOOKS_SYSTEM, listing, 900, (SYNTH_IN, SYNTH_OUT))
            _spend(ai, st, cost)
            found = []
            for b in (out or {}).get("books") or []:
                title = str(b.get("title") or "").strip()
                nums = [n for n in b.get("items") or [] if isinstance(n, int) and 1 <= n <= len(books_pool)]
                cited = [books_pool[n - 1] for n in nums]
                # Grounding: the title must appear in at least one item it cites.
                if not title or len(title) < 3 or not any(_norm(title) in _norm(c["title"] + " " + (c.get("summary") or "")) for c in cited):
                    continue
                found.append({"key": hashlib.sha1(_norm(title).encode()).hexdigest()[:10], "title": title,
                              "author": str(b.get("author") or "")[:80], "hook": str(b.get("hook") or "")[:200],
                              "items": [c["id"] for c in cited][:6]})
            st["books"] = found[:BOOKS_KEEP]
            st["books_at"] = now.isoformat()
        except Exception as exc:
            err = f"books: {type(exc).__name__}: {exc}"[:200]
            st["books_at"] = now.isoformat()      # don't retry every build

    # Keep the cited items' records (they can age out of the feed).
    rec_items = st.setdefault("items", {})
    for b in st.get("books") or []:
        for iid in b["items"]:
            if iid in by_id:
                it = by_id[iid]
                rec_items[iid] = {k: it.get(k) for k in ("id", "source_id", "source", "title", "link", "summary", "t")}
    keep = {i for b in st.get("books") or [] for i in b["items"]}
    st["items"] = {k: v for k, v in rec_items.items() if k in keep}

    # 2. Takeaways for each book, from its reviews' open text.
    cache = st.setdefault("takeaways", {})
    cache = {k: v for k, v in cache.items() if now - datetime.fromisoformat(v["at"]) < timedelta(days=TAKEAWAY_TTL_D)}
    st["takeaways"] = cache
    for b in st.get("books") or []:
        if b["key"] in cache or not _budget_ok(ai, st):
            continue
        blocks = []
        for iid in b["items"]:
            it = st["items"].get(iid)
            if not it:
                continue
            body = _read_text(state, st, it, src_by_id.get(it["source_id"]) or {}, session, robots_allows, timeout)
            blocks.append(f"[{it['source']}] {it['title']}\n{re.sub(r'<[^>]+>', ' ', it.get('summary') or '')[:400]}\n{body[:2500]}")
        if not blocks or sum(len(x) for x in blocks) < 600:
            continue          # too little to say anything grounded
        try:
            out, cost = _cf_run(session, SYNTH_MODEL, BOOK_TAKEAWAY_SYSTEM,
                                f"Book: {b['title']}{' by ' + b['author'] if b['author'] else ''}\n\n" + "\n\n".join(blocks), 600, (SYNTH_IN, SYNTH_OUT))
            _spend(ai, st, cost)
            if out and out.get("takeaways"):
                cache[b["key"]] = {"at": now.isoformat(), "line": str(out.get("line") or "")[:300],
                                   "takeaways": [str(x)[:240] for x in out["takeaways"]][:5],
                                   "reception": str(out.get("reception") or "")[:400]}
        except Exception as exc:
            err = f"book takeaways: {type(exc).__name__}: {exc}"[:200]
            break

    # 3. Essays: a daily rotation spread across publications, then takeaways for open ones.
    day_seed = today
    seen_src, essays = set(), []
    for it in sorted(essays_pool, key=lambda it: hashlib.md5((day_seed + it["id"]).encode()).hexdigest()):
        if it["source_id"] in seen_src:
            continue
        seen_src.add(it["source_id"])
        essays.append(it)
        if len(essays) >= 4:
            break
    ecache = st.setdefault("essay_takeaways", {})
    st["essay_takeaways"] = ecache = {k: v for k, v in ecache.items() if now - datetime.fromisoformat(v["at"]) < timedelta(days=14)}
    for it in essays:
        if it["id"] in ecache or not _budget_ok(ai, st):
            continue
        src = src_by_id.get(it["source_id"]) or {}
        body = _read_text(state, st, it, src, session, robots_allows, timeout)
        if len(body) < 1500:
            continue
        try:
            out, cost = _cf_run(session, SYNTH_MODEL, ESSAY_SYSTEM, f"{it['title']} ({it['source']})\n\n{body}", 500, (SYNTH_IN, SYNTH_OUT))
            _spend(ai, st, cost)
            if out and out.get("takeaways"):
                ecache[it["id"]] = {"at": now.isoformat(), "line": str(out.get("line") or "")[:300],
                                    "takeaways": [str(x)[:240] for x in out["takeaways"]][:5]}
        except Exception as exc:
            err = f"essay takeaways: {type(exc).__name__}: {exc}"[:200]
            break

    clean = lambda s: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).strip()
    books_out = []
    for b in st.get("books") or []:
        t = cache.get(b["key"]) or {}
        reviews = [st["items"][i] for i in b["items"] if i in st["items"]]
        books_out.append({"title": b["title"], "author": b["author"], "hook": b["hook"], "line": t.get("line"),
                          "takeaways": t.get("takeaways") or [], "reception": t.get("reception"),
                          "reviews": [{"source": r["source"], "title": r["title"], "link": r["link"]} for r in reviews]})
    essays_out = []
    for it in essays:
        src = src_by_id.get(it["source_id"]) or {}
        t = ecache.get(it["id"]) or {}
        essays_out.append({"title": it["title"], "source": it["source"], "link": it["link"], "perspective": src.get("perspective"),
                           "desc": clean(it.get("summary"))[:300], "author": it.get("author"), "t": it.get("t"),
                           "line": t.get("line"), "takeaways": t.get("takeaways") or [],
                           "open": bool(src.get("fulltext"))})
    talk_out = []
    for it in talk_pool[:6]:
        m = re.match(r"^(.*?)\s*\(([^()]*)\)\s*$", it["title"])
        talk_out.append({"title": m.group(1) if m else it["title"], "by": m.group(2) if m else "", "link": it["link"], "t": it.get("t")})
    data["reading"] = {"at": now.isoformat(), "books": books_out, "essays": essays_out, "talk": talk_out,
                       "recent": [{"title": it["title"], "source": it["source"], "link": it["link"], "t": it.get("t")} for it in books_pool[:8]]}
    log(f"[reading] {len(books_out)} books ({sum(1 for b in books_out if b['takeaways'])} with takeaways), "
        f"{len(essays_out)} essays ({sum(1 for e in essays_out if e['takeaways'])} with takeaways), {len(talk_out)} talk; "
        f"neurons today≈{st.get('neurons', 0):.0f}{'; ' + err if err else ''}")
    for b in books_out:      # public titles only, so the log shows what was picked
        log(f"[reading] book: {b['title']}{' by ' + b['author'] if b['author'] else ''} · {len(b['reviews'])} reviews{' · takeaways' if b['takeaways'] else ''}")
    for e in essays_out:
        log(f"[reading] essay: {e['title']} ({e['source']}){' · takeaways' if e['takeaways'] else ''}")
    st["error"] = err
    return {"id": "reading", "name": "Worth reading (books, essays, what people are discussing)", "short": "Reading", "desk": "SYSTEM",
            "poll": PICK_EVERY_H * 60, "last_success": st.get("books_at"), "last_attempt": now.isoformat(), "last_error": err,
            "last_status": None, "robots": "honored", "items": len(books_out) + len(essays_out)}
