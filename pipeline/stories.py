"""Story grouping, open-text quotes, and machine summaries (V5).

Grouping is rule-based: headlines that share enough distinctive words, within a
48-hour window, are treated as one story. Quotes are pulled only from text the
build actually fetched, and each one is checked against that text before it is
kept (the quote integrity rule). Summaries come from Cloudflare Workers AI on the
free plan, under a daily budget, and are dropped unless they trace back to the
source text.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from collections import Counter
from datetime import datetime, timedelta, timezone

WINDOW_H = 48
SIM_MIN = 0.42          # cosine on IDF-weighted headline words
SIM_LEAD_MIN = 0.28     # a joiner must also resemble the story's lead (stops chaining)
SHARED_MIN = 2

STOP = set("""
a an the and or but of to in on at for from by with as is are was were be been being it its this that these those
into over after before amid about against between during under up down out off than then so not no yes his her
their they them he she we you i our your my who whom whose what when where why how which while will would can could
should may might must has have had do does did done says said say tells told new news report reports reported live
watch video photos update updates latest breaking just more most all any some one two first last year years week
day today tonight now here there also us u.s via per amid nearly least back get gets got make makes made take takes
""".split())

WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'’.-]*")


def norm_word(w: str) -> str | None:
    w = w.lower().strip(".'’-")
    w = re.sub(r"['’]s$", "", w)
    if w in STOP or len(w) < 3 and not w.isdigit():
        return None
    if len(w) > 4 and w.endswith("s") and not w.endswith("ss"):
        w = w[:-1]
    return w


def words(title: str) -> set[str]:
    return {n for n in (norm_word(w) for w in WORD.findall(title)) if n}


def ms(it: dict) -> datetime:
    return datetime.fromisoformat(it["t"].replace("Z", "+00:00"))


def eligible(it: dict) -> bool:
    return not it.get("alert") and it.get("kind") != "BLOTTER"


def group(items: list[dict], now: datetime | None = None) -> list[dict]:
    """Return stories with two or more sources: {id, lead, members, sources, desk, first, last}."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=WINDOW_H)
    pool = [it for it in items if eligible(it) and ms(it) >= cutoff]
    toks = {it["id"]: words(it["title"]) for it in pool}
    df = Counter(w for s in toks.values() for w in s)
    n = max(len(pool), 1)
    idf = {w: math.log((n + 1) / (c + 0.5)) for w, c in df.items()}

    def weight(s):
        return sum(idf[w] for w in s)

    def sim(a, b):
        sa, sb = toks[a], toks[b]
        shared = sa & sb
        if len(shared) < SHARED_MIN:
            return 0.0
        wa, wb = weight(sa), weight(sb)
        return weight(shared) / math.sqrt(wa * wb) if wa and wb else 0.0

    clusters: list[list[dict]] = []
    for it in sorted(pool, key=ms):           # oldest first: the first report leads
        best, best_s = None, 0.0
        for c in clusters:
            if (it["desk"] == "SPORTS") != (c[0]["desk"] == "SPORTS"):
                continue      # sports never merges with news
            s = max(sim(it["id"], m["id"]) for m in c)
            if s > best_s and sim(it["id"], c[0]["id"]) >= SIM_LEAD_MIN:
                best, best_s = c, s
        if best is not None and best_s >= SIM_MIN:
            best.append(it)
        else:
            clusters.append([it])

    out = []
    for c in clusters:
        sources = {m["source_id"] for m in c}
        if len(sources) < 2:
            continue
        desk = Counter(m["desk"] for m in c).most_common(1)[0][0]
        out.append({
            "id": c[0]["id"],
            "lead": c[0]["id"],
            "members": [m["id"] for m in sorted(c, key=ms, reverse=True)],
            "sources": len(sources),
            "desk": desk,
            "first": c[0]["t"],
            "last": max(m["t"] for m in c),
        })
    out.sort(key=lambda s: (s["sources"], s["last"]), reverse=True)
    return out


# ---------------------------------------------------------------- ranking

DESK_WEIGHT = {"BEACON": 3.0, "GOV": 2.0, "LAW": 2.0, "WORLD": 1.5, "SPORTS": 0.6}


def rank(stories: list[dict], now: datetime) -> None:
    for s in stories:
        age_h = (now - datetime.fromisoformat(s["last"].replace("Z", "+00:00"))).total_seconds() / 3600
        s["score"] = round(DESK_WEIGHT.get(s["desk"], 1.0) * (1 + 0.6 * (s["sources"] - 1)) * math.exp(-age_h / 12), 3)
    stories.sort(key=lambda s: s["score"], reverse=True)


# ---------------------------------------------------------------- open article text

TEXT_KEEP_DAYS = 3
TEXT_MAX_CHARS = 9000
MAX_TEXT_FETCHES = 30


def fetch_texts(state, data, src_by_id, session, robots_allows, timeout, log) -> dict:
    """Read open article text for story members and recent local/gov/law items.
    The text is kept in the Actions cache (state) only; it is never written to data.json."""
    import trafilatura  # imported here so V1 builds don't depend on it at import time
    texts = state.setdefault("texts", {})
    now = datetime.now(timezone.utc)
    live_ids = {it["id"] for it in data["items"]}
    for k in [k for k, v in texts.items() if k not in live_ids or
              now - datetime.fromisoformat(v["fetched"]) > timedelta(days=TEXT_KEEP_DAYS)]:
        del texts[k]

    by_id = {it["id"]: it for it in data["items"]}
    wanted: list[dict] = []
    for s in data["stories"][:20]:
        wanted += [by_id[m] for m in s["members"][:4]]
    day_ago = now - timedelta(hours=24)
    wanted += [it for it in data["items"] if it["desk"] in ("BEACON", "GOV", "LAW") and ms(it) >= day_ago][:40]

    stats = {"attempts": 0, "ok": 0, "robots": 0, "errors": [], "kept": 0}
    blocked_hosts = set()
    for it in wanted:
        src = src_by_id.get(it["source_id"]) or {}
        if not src.get("fulltext") or it["id"] in texts or stats["attempts"] >= MAX_TEXT_FETCHES:
            continue
        host = re.sub(r"^https?://([^/]+).*$", r"\1", it["link"])
        if host in blocked_hosts:
            continue
        if not robots_allows(it["link"], state, session):
            stats["robots"] += 1
            texts[it["id"]] = {"fetched": now.isoformat(), "text": "", "note": "robots"}
            continue
        stats["attempts"] += 1
        try:
            r = session.get(it["link"], timeout=timeout)
            if r.status_code in (403, 429):
                blocked_hosts.add(host)      # back off from this host for the rest of the run
                raise RuntimeError(f"HTTP {r.status_code}")
            r.raise_for_status()
            body = trafilatura.extract(r.text, include_comments=False, include_tables=False, favor_precision=True) or ""
            texts[it["id"]] = {"fetched": now.isoformat(), "text": body[:TEXT_MAX_CHARS]}
            stats["ok"] += 1
        except Exception as exc:
            stats["errors"].append(f"{it['source_id']}: {type(exc).__name__}: {exc}"[:160])
            texts[it["id"]] = {"fetched": now.isoformat(), "text": "", "note": "error"}
    stats["kept"] = sum(1 for v in texts.values() if v.get("text"))
    if stats["errors"]:
        log(f"[text] {len(stats['errors'])} errors, e.g. {stats['errors'][0]}")
    return stats


# ---------------------------------------------------------------- quotes

QMARK = "\"“”"
VERB = r"(?:said|says|told|added|wrote|stated|recalled|warned|noted|explained|argued|insisted|declared|testified)"
NAME = r"((?:[A-Z][\w.'’-]+(?:\s+(?:de|van|von|al|bin|da|del|la|le))?\s+){0,3}[A-Z][\w.'’-]+)"
Q = r"[“\"]([^“”\"]{30,320}?)[,.?!]?[”\"]"
PATTERNS = [
    re.compile(Q + r",?\s+" + NAME + r",?(?:\s+[^.“”\"]{0,80}?,)?\s+" + VERB),   # "...," Smith, the mayor, said
    re.compile(Q + r",?\s+" + VERB + r"\s+" + NAME),                              # "...," said Smith
    re.compile(NAME + r",?(?:\s+[^.“”\"]{0,80}?,)?\s+" + VERB + r"[,:]?\s+" + Q),   # Smith said, "..."
]
NOT_NAMES = {"He", "She", "They", "It", "We", "I", "The", "This", "That", "But", "And", "In", "On", "A", "An", "Officials", "Police"}


def extract_quotes(text: str, limit: int = 2) -> list[dict]:
    out, seen = [], set()
    for pat in PATTERNS:
        for m in pat.finditer(text):
            groups = m.groups()
            quote, name = (groups[1], groups[0]) if pat is PATTERNS[2] else (groups[0], groups[1])
            quote, name = quote.strip(), name.strip()
            name = re.sub(r"^(?:Mr|Mrs|Ms|Dr|Sen|Rep|Gov)\.\s+", "", name)
            first = name.split()[0]
            if first in NOT_NAMES:
                continue
            if len(name.split()) < 2:
                # A bare surname: attribute it only if the article names the person in full.
                full = re.findall(r"(?<![\w.])((?:[A-Z][\w'’-]+ ){1,3})" + re.escape(name) + r"\b", text)
                full = [re.sub(r"^(?:(?:Before|After|When|While|Then|As|If|Since|Meanwhile|Asked|Later|Earlier|Still|Yet|So|Now|Also|Both|Even|Only|For|With|Without|At|By|Of|To|From|Under|Over|Like|Unlike|Instead|Last|Next|This|That|These|Those|Today|Yesterday|On|In|And|But|Or|The|A|An)\s+)+", "", f).strip() for f in full]
                full = [f for f in full if f and f.split()[0] not in NOT_NAMES]
                full = [f.strip() for f in full if f.split()[0] not in NOT_NAMES and not re.search(r"[.]\s*$", f.split()[-1])]
                if full:
                    name = max(full, key=len) + " " + name
                elif name not in ("Trump", "Biden", "Hochul", "Zelensky", "Zelenskyy", "Netanyahu", "Macron", "Putin", "Musk"):
                    continue
            if quote[:1].islower() or re.search(r"['‘’]\s*[,.]|[,.?!]['‘’]", quote):
                continue      # a fragment, or a quote inside a quote
            # Quote integrity rule: the exact string must be in the source text.
            if quote not in text or quote.lower() in seen:
                continue
            seen.add(quote.lower())
            out.append({"text": quote, "by": name})
    return out[:limit]


# ---------------------------------------------------------------- summaries (Cloudflare Workers AI, free plan)

AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast"
AI_DAILY_NEURONS = 6000          # free plan gives 10,000/day; stay well under
NEURONS_PER_M_IN, NEURONS_PER_M_OUT = 4119, 34868
AI_MAX_CALLS = 25
SUMMARY_REFRESH_H = 3
SYSTEM_PROMPT = (
    "You condense news reports for one reader. Use only facts stated in the reports provided. "
    "No opinions, no outside knowledge, no speculation, no quotes. At most two sentences and under 60 words. "
    "If the reports disagree on a fact, say so. Output only the summary text.")


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s.strip()]


def grounded(summary: str, corpus: str) -> str:
    """Keep only sentences whose content words, numbers and names all trace to the sources."""
    vocab = {n for n in (norm_word(w) for w in WORD.findall(corpus)) if n}
    raw = corpus.lower()
    keep = []
    for s in _sentences(summary):
        content = [n for n in (norm_word(w) for w in WORD.findall(s)) if n]
        if not content:
            continue
        hit = sum(1 for w in content if w in vocab) / len(content)
        nums_ok = all(n in raw for n in re.findall(r"\d[\d,.]*\d|\d", s))
        names = [w for w in re.findall(r"(?<!^)(?<![.!?]\s)\b[A-Z][a-z]{2,}\b", s)]
        names_ok = all(n.lower() in raw for n in names)
        if hit >= 0.8 and nums_ok and names_ok:
            keep.append(s)
    return " ".join(keep)


def _ai_call(session, prompt: str, log) -> tuple[str, float]:
    acct, token = os.environ.get("CLOUDFLARE_ACCOUNT_ID"), os.environ.get("CLOUDFLARE_API_TOKEN")
    if not acct or not token:
        raise RuntimeError("Cloudflare account ID or API token not set")
    r = session.post(
        f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/{AI_MODEL}",
        headers={"Authorization": f"Bearer {token}"},
        json={"messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}],
              "max_tokens": 140, "temperature": 0.2},
        timeout=60)
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200 or not body.get("success"):
        errs = "; ".join(e.get("message", "") for e in body.get("errors", [])) or f"HTTP {r.status_code}"
        raise RuntimeError(errs[:200])
    res = body.get("result") or {}
    usage = res.get("usage") or {}
    tin = usage.get("prompt_tokens") or len(SYSTEM_PROMPT + prompt) / 4
    tout = usage.get("completion_tokens") or len(res.get("response", "")) / 4
    return (res.get("response") or "").strip(), tin / 1e6 * NEURONS_PER_M_IN + tout / 1e6 * NEURONS_PER_M_OUT


def summarize(state, data, session, log) -> dict:
    ai = state.setdefault("ai", {})
    today = datetime.now(timezone.utc).date().isoformat()
    if ai.get("day") != today:
        ai.update({"day": today, "neurons": 0.0})
    cache = ai.setdefault("summaries", {})
    texts = state.get("texts", {})
    by_id = {it["id"]: it for it in data["items"]}
    now = datetime.now(timezone.utc)
    stats = {"calls": 0, "kept": 0, "dropped": 0, "error": None}

    jobs = [("story", s["id"], s["members"][:4]) for s in data["stories"][:15]]
    day_ago = now - timedelta(hours=24)
    jobs += [("item", it["id"], [it["id"]]) for it in data["items"]
             if it["desk"] in ("BEACON", "GOV", "LAW") and ms(it) >= day_ago and (texts.get(it["id"]) or {}).get("text")][:10]

    live = {j[1] for j in jobs}
    for k in [k for k in cache if k not in live]:
        del cache[k]

    for kind, key, members in jobs:
        sig = hashlib.sha1(json.dumps(members).encode()).hexdigest()[:12]
        rec = cache.get(key)
        fresh = rec and (rec["sig"] == sig or now - datetime.fromisoformat(rec["at"]) < timedelta(hours=SUMMARY_REFRESH_H))
        if fresh:
            continue
        if stats["calls"] >= AI_MAX_CALLS or ai["neurons"] >= AI_DAILY_NEURONS:
            break
        parts, corpus = [], []
        for i, m in enumerate(members, 1):
            it = by_id[m]
            body = (texts.get(m) or {}).get("text", "")[:1800]
            block = f"Report {i} ({it['source']}): {it['title']}\n{it.get('summary', '')}\n{body}".strip()
            parts.append(block)
            corpus.append(block)
        prompt = "\n\n".join(parts)
        if len(prompt) < 120:
            continue          # too little source text to summarize honestly
        try:
            text, neurons = _ai_call(session, prompt, log)
        except Exception as exc:
            stats["error"] = f"{type(exc).__name__}: {exc}"[:240]
            log(f"[ai] {stats['error']}")
            break
        stats["calls"] += 1
        ai["neurons"] += neurons
        kept = grounded(text, "\n".join(corpus))
        if kept:
            stats["kept"] += 1
        else:
            stats["dropped"] += 1
        cache[key] = {"sig": sig, "at": now.isoformat(), "summary": kept, "sources": members}
    return stats


# ---------------------------------------------------------------- one entry point for build.py

def run(state, data, src_by_id, session, robots_allows, timeout, log) -> None:
    now = datetime.now(timezone.utc)
    stories = group(data["items"], now)
    rank(stories, now)
    data["stories"] = stories
    stamp = now.isoformat().replace("+00:00", "Z")

    tstats = fetch_texts(state, data, src_by_id, session, robots_allows, timeout, log)
    texts = state.get("texts", {})
    nq = 0
    for it in data["items"]:
        it.pop("quotes", None)
        body = (texts.get(it["id"]) or {}).get("text")
        if body:
            q = extract_quotes(body)
            if q:
                it["quotes"] = q
                nq += 1

    st = state.setdefault("v5", {})
    if tstats["attempts"] and not tstats["ok"]:
        st["text_error"] = tstats["errors"][0] if tstats["errors"] else "all fetches failed"
    elif tstats["ok"]:
        st["text_error"], st["text_ok"] = None, stamp
    astats = summarize(state, data, session, log)
    if astats["error"]:
        st["ai_error"] = astats["error"]
    elif astats["calls"] or not st.get("ai_ok"):
        st["ai_error"], st["ai_ok"] = None, stamp if astats["calls"] else st.get("ai_ok")

    summaries = state["ai"]["summaries"]
    for s in stories:
        rec = summaries.get(s["id"])
        if rec and rec["summary"]:
            s["summary"] = rec["summary"]
    for it in data["items"]:
        rec = summaries.get(it["id"])
        if rec and rec["summary"] and rec["sources"] == [it["id"]]:
            it["machine_summary"] = rec["summary"]

    log(f"[v5] stories={len(stories)} texts kept={tstats['kept']} new={tstats['ok']} robots-skip={tstats['robots']} "
        f"quotes on {nq} items · ai calls={astats['calls']} kept={astats['kept']} dropped={astats['dropped']} "
        f"neurons today≈{state['ai']['neurons']:.0f}")
    # Health rows: these steps fail visibly, like any source.
    data["sources"] += [
        {"id": "article_text", "name": "Open article text (for summaries and quotes)", "short": "Article text",
         "desk": "SYSTEM", "poll": 15, "last_success": st.get("text_ok"), "last_attempt": stamp,
         "last_error": st.get("text_error"), "last_status": None, "robots": "honored", "items": tstats["kept"]},
        {"id": "workers_ai", "name": "Machine summaries (Cloudflare Workers AI, free plan)", "short": "Summaries",
         "desk": "SYSTEM", "poll": 15, "last_success": st.get("ai_ok"), "last_attempt": stamp,
         "last_error": st.get("ai_error"), "last_status": None, "robots": "n/a",
         "items": sum(1 for v in summaries.values() if v["summary"])},
    ]
