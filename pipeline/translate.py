"""Machine translation of French and Hebrew headlines for the city desks.

Sources with `language: fr` or `language: he` get their headlines translated to English
with Cloudflare Workers AI's m2m100 model (free plan), under a daily budget. The English
headline is what the page shows and what story grouping uses, so French and Israeli
outlets join the same stories as English coverage; the original headline is kept and the
item is labeled machine-translated. Translations are cached in the build state (Actions
cache), never in git. A failure is recorded in source health, never silent.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

MODEL = "@cf/meta/m2m100-1.2b"
NEURONS_PER_M = 31050            # input and output (Workers AI pricing)
DAILY_NEURONS = 900              # of the build's daily AI allowance
MAX_PER_RUN = 60
KEEP_DAYS = 4
LANG_NAME = {"fr": "French", "he": "Hebrew"}


def _call(session, text: str, lang: str) -> tuple[str, float]:
    acct, token = os.environ.get("CLOUDFLARE_ACCOUNT_ID"), os.environ.get("CLOUDFLARE_API_TOKEN")
    if not acct or not token:
        raise RuntimeError("Cloudflare account ID or API token not set")
    r = session.post(f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/{MODEL}",
                     headers={"Authorization": f"Bearer {token}"},
                     json={"text": text, "source_lang": lang, "target_lang": "en"}, timeout=30)
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200 or not body.get("success"):
        raise RuntimeError(("; ".join(e.get("message", "") for e in body.get("errors", [])) or f"HTTP {r.status_code}")[:200])
    out = ((body.get("result") or {}).get("translated_text") or "").strip()
    # Token counts aren't returned; estimate four characters per token, in and out.
    return out, (len(text) + len(out)) / 4 / 1e6 * NEURONS_PER_M


def run(state: dict, items: list[dict], src_by_id: dict, session, log) -> dict:
    """Translate new non-English headlines; return health info."""
    tr = state.setdefault("tr", {})
    ai = state.setdefault("ai", {})
    today = datetime.now(timezone.utc).date().isoformat()
    if ai.get("tr_day") != today:
        ai.update({"tr_day": today, "tr_neurons": 0.0})
    cutoff = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).isoformat()
    for k in [k for k, v in tr.items() if v.get("at", "") < cutoff]:
        del tr[k]
    todo = []
    for it in items:
        lang = (src_by_id.get(it["source_id"]) or {}).get("language")
        if lang not in LANG_NAME:
            continue
        rec = tr.get(it["id"])
        if rec and rec.get("orig") == it["title"]:
            continue
        todo.append((it, lang))
    stats = {"done": 0, "pending": len(todo), "error": None}
    todo = todo[:MAX_PER_RUN]
    if todo and ai.get("tr_neurons", 0) < DAILY_NEURONS:
        def one(pair):
            it, lang = pair
            try:
                return it, lang, *_call(session, it["title"], lang), None
            except Exception as exc:
                return it, lang, "", 0.0, f"{type(exc).__name__}: {exc}"[:200]
        with ThreadPoolExecutor(max_workers=6) as pool:
            for it, lang, en, n, err in pool.map(one, todo):
                ai["tr_neurons"] = ai.get("tr_neurons", 0) + n
                ai["neurons"] = ai.get("neurons", 0) + n
                if err:
                    stats["error"] = err
                    continue
                if en:
                    tr[it["id"]] = {"orig": it["title"], "en": en, "lang": lang, "at": datetime.now(timezone.utc).isoformat()}
                    stats["done"] += 1
    stats["pending"] -= stats["done"]
    log(f"[translate] {stats['done']} headlines translated, {stats['pending']} waiting, "
        f"neurons today≈{ai.get('tr_neurons', 0):.0f}{' error=' + stats['error'] if stats['error'] else ''}")
    return stats


def apply(items: list[dict], state: dict, src_by_id: dict) -> list[dict]:
    """English headlines on copies of the items (the build state keeps the originals).
    A foreign headline not yet translated is held back: kept out of stories, briefings and
    the page until its translation arrives (usually the next build)."""
    tr = state.get("tr", {})
    out = []
    for it in items:
        lang = (src_by_id.get(it["source_id"]) or {}).get("language")
        rec = tr.get(it["id"])
        if rec and rec.get("orig") == it["title"]:
            it = dict(it, title=rec["en"], orig_title=rec["orig"], lang=rec["lang"], translated=True)
        elif lang in LANG_NAME:
            continue
        out.append(it)
    return out
