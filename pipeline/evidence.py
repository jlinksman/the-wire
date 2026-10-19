"""evidence.json: what a thread's answer may be written from (BRIEF.md, stage 3).

For each thread that matters (followed, standing, then the liveliest), the numbered sources a
question can be answered from: each report's headline, outlet, time, link, the feed's own
description, verified quotes, and, where the build has read an open article or a public
document, an opening excerpt of its text for the model's eyes only. The page never shows
article excerpts; public-document excerpts are shown on the thread page separately
(threads.attach_doc_excerpts). Written to Workers KV, never to git. WSJ and other no_ai
sources contribute headline and link only.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from threads import is_document, is_public_document

MAX_THREADS = 40
MAX_SOURCES = 16
ARTICLE_EXCERPT = 1200
DOC_EXCERPT = 2500


def _excerpt(text: str, n: int) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    if len(t) <= n:
        return t
    cut = t[:n]
    end = cut.rfind(". ")
    return cut[:end + 1] if end > n // 2 else cut


def build(state: dict, data: dict, src_by_id: dict, dist, log) -> dict:
    texts = state.get("texts", {})
    by_id = {it["id"]: it for it in data["items"]}
    threads = data.get("threads", [])
    chosen = [t for t in threads if (t.get("followed") or t.get("standing")) and t.get("members")]
    rest = sorted((t for t in threads if t not in chosen), key=lambda t: (t.get("outlets", 0), t["last"]), reverse=True)
    chosen = (chosen + rest)[:MAX_THREADS]

    out = {"generated_at": data["generated_at"], "threads": {}}
    n_excerpts = 0
    for t in chosen:
        members = [by_id[m] for m in t.get("members", []) if m in by_id]
        members.sort(key=lambda m: m["t"], reverse=True)
        # Documents first, then one report per outlet, newest first, then the rest.
        docs = [m for m in members if is_document(m)]
        seen_outlet, diverse, later = set(), [], []
        for m in members:
            if m in docs:
                continue
            (diverse if m["source"] not in seen_outlet else later).append(m)
            seen_outlet.add(m["source"])
        picked = (docs + diverse + later)[:MAX_SOURCES]
        sources = []
        for i, m in enumerate(picked, 1):
            src = src_by_id.get(m["source_id"]) or {}
            rec = {"n": i, "id": m["id"], "title": m["title"], "source": m["source"], "t": m["t"], "link": m["link"],
                   "kind": "document" if is_document(m) else "report"}
            if m.get("no_ai"):
                rec["note"] = "headline only"
                sources.append(rec)
                continue
            if m.get("summary"):
                rec["summary"] = m["summary"][:400]
            if m.get("quotes"):
                rec["quotes"] = [{"text": q["text"], "by": q.get("by")} for q in m["quotes"][:2]]
            body = (texts.get(m["id"]) or {}).get("text") or m.get("doc_text")
            if body and (src.get("fulltext") or is_public_document(m["link"])):
                rec["excerpt"] = _excerpt(body, DOC_EXCERPT if is_public_document(m["link"]) else ARTICLE_EXCERPT)
                n_excerpts += 1
            sources.append(rec)
        out["threads"][t["id"]] = {
            "title": t["title"], "kind": t.get("kind"), "desk": t["desk"], "opened": t.get("opened"), "last": t["last"],
            "what": t.get("what") or t.get("card"), "latest": t.get("latest"),
            "developments": [{"t": d["t"], "text": d["text"], "source": d["source"], "reason": d.get("reason")} for d in t.get("developments", [])[-10:]],
            "sources": sources,
        }
    (dist / "evidence.json").write_text(json.dumps(out, separators=(",", ":")))
    size = (dist / "evidence.json").stat().st_size
    log(f"[evidence] {len(out['threads'])} threads, {sum(len(v['sources']) for v in out['threads'].values())} sources, "
        f"{n_excerpts} excerpts, {size // 1024} KB")
    return out
