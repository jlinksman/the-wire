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
    # Person feeds (columns, podcasts, posts) never count as outlets in a story; opinion
    # pieces join a story as a "view" instead (views()).
    return not it.get("alert") and it.get("kind") not in ("BLOTTER", "POST", "PODCAST") and not it.get("person_feed")


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

    from events import places as place_names
    pl = {it["id"]: place_names(it["title"]) for it in pool}
    clusters: list[list[dict]] = []
    cplace: list[Counter] = []                # places named across each cluster's headlines
    for it in sorted(pool, key=ms):           # oldest first: the first report leads
        best, best_s = None, 0.0
        for ci, c in enumerate(clusters):
            if (it["desk"] == "SPORTS") != (c[0]["desk"] == "SPORTS"):
                continue      # sports never merges with news
            # A report that names a place must share it with the cluster's main place
            # (a Sydney protest doesn't join French protests on "protester violence").
            main = {p for p, k in cplace[ci].items() if k * 2 >= len(c)}
            if pl[it["id"]] and main and not (pl[it["id"]] & main):
                continue
            s = max(sim(it["id"], m["id"]) for m in c)
            if s > best_s and sim(it["id"], c[0]["id"]) >= SIM_LEAD_MIN:
                best, best_s = c, s
        if best is not None and best_s >= SIM_MIN:
            best.append(it)
            cplace[clusters.index(best)].update(pl[it["id"]])
        else:
            clusters.append([it])
            cplace.append(Counter(pl[it["id"]]))

    # Second pass: fragments of one big event (same foreign place, same kind of event).
    from events import merge_events
    clusters = merge_events(clusters, ms)

    out = []
    for c in clusters:
        outlets = {m["source"] for m in c}       # outlets, not feeds: NYT World and NYT U.S. count once
        if len(outlets) < 2:
            continue
        desk = Counter(m["desk"] for m in c).most_common(1)[0][0]
        last = max(ms(m) for m in c)
        recent = sum(1 for m in c if ms(m) >= now - timedelta(hours=6))
        out.append({
            "id": c[0]["id"],
            # Lead: the newest plain headline (English, not a live blog, not WSJ).
            "lead": max(c, key=lambda m: (not m.get("no_ai"), not m.get("translated"),
                                          not re.match(r"\W*(live|watch)\b", m["title"], re.IGNORECASE), ms(m), not m.get("quiet")))["id"],   # newest headline leads; id stays the first report
            "members": [m["id"] for m in sorted(c, key=ms, reverse=True)],
            "sources": len(outlets),
            "reports": len(c),
            "recent": recent,
            # Developing: a burst of reports from several outlets in the last six hours.
            "developing": recent >= 6 and len({m["source"] for m in c if ms(m) >= now - timedelta(hours=6)}) >= 3,
            "desk": desk,
            "first": c[0]["t"],
            "last": max(m["t"] for m in c),
        })
    out.sort(key=lambda s: (s["sources"], s["last"]), reverse=True)
    return out


# ---------------------------------------------------------------- range of views

VIEW_BUCKET = {"left": "left", "center-left": "left", "center": "center", "heterodox": "center", "cross": "center",
               "center-right": "right", "right": "right", "libertarian": "libertarian", "international": "international"}
VIEW_WINDOW_H = 72
VIEW_MIN_SHARED = 3
VIEW_MIN_SCORE = 0.15
VIEWS_PER_STORY = 4


def attach_views(data: dict, stories: list[dict], now: datetime) -> int:
    """Match followed opinion voices (people.yaml perspective) to the stories they're about,
    by distinctive shared words, and pick up to four per story spread across perspectives:
    never two from one side while another side has something to say."""
    cut = now - timedelta(hours=VIEW_WINDOW_H)
    recent = [it for it in data["items"] if ms(it) >= cut]
    cands = [it for it in recent if it.get("perspective") and it.get("kind") != "POST"]
    top = [s for s in stories if s["desk"] != "SPORTS"][:30]
    if not cands or not top:
        return 0
    by_id = {it["id"]: it for it in data["items"]}
    text = lambda it, n: words(it["title"] + " " + (it.get("summary") or "")[:n])
    df = Counter(w for it in recent for w in text(it, 200))
    n = max(len(recent), 1)
    idf = {w: math.log((n + 1) / (c + 0.5)) for w, c in df.items()}
    swords = {s["id"]: set().union(*(text(by_id[m], 200) for m in s["members"] if m in by_id)) for s in top}
    found: dict[str, list] = {}
    # A story's vocabulary: words used by at least two of its reports (or all, for small
    # stories), so a 50-report event doesn't match everything.
    for s in top:
        cnt = Counter(x for m in s["members"] if m in by_id for x in text(by_id[m], 200))
        k = 2 if len(s["members"]) >= 4 else 1
        swords[s["id"]] = {x for x, c in cnt.items() if c >= k}
    wt = lambda ws: sum(idf.get(x, 1.0) for x in ws)
    for it in cands:
        w = text(it, 300)
        best = None
        for s in top:
            shared = w & swords[s["id"]]
            if len(shared) < VIEW_MIN_SHARED:
                continue
            score = wt(shared) / math.sqrt((wt(w) or 1.0) * (wt(swords[s["id"]]) or 1.0))
            if score >= VIEW_MIN_SCORE and (best is None or score > best[0]):
                best = (score, s)
        if best:
            found.setdefault(best[1]["id"], []).append((best[0], it))
    attached = 0
    for s in top:
        cand = sorted(found.get(s["id"], []), key=lambda x: -x[0])
        buckets: dict[str, list] = {}
        for sc, it in cand:
            buckets.setdefault(VIEW_BUCKET.get(it["perspective"], "center"), []).append(it)
        picks = []
        while len(picks) < VIEWS_PER_STORY and any(buckets.values()):
            for b in list(buckets):
                if buckets[b] and len(picks) < VIEWS_PER_STORY:
                    picks.append(buckets[b].pop(0))
        if picks:
            s["views"] = [{"id": it["id"], "perspective": it["perspective"]} for it in picks]
            attached += len(picks)
    return attached


# ---------------------------------------------------------------- ranking

DESK_WEIGHT = {"BEACON": 3.0, "GOV": 2.0, "LAW": 2.0, "WORLD": 1.5, "SPORTS": 0.6}


def diverse(s: dict, by_id: dict, n: int = 4) -> list[str]:
    """Up to n members, one per outlet first (newest first), for summaries and text fetches."""
    seen, first, rest = set(), [], []
    for m in s["members"]:
        if (by_id.get(m) or {}).get("no_ai"):
            continue      # never sent to a model (WSJ terms)
        src = (by_id.get(m) or {}).get("source")
        (rest if src in seen else first).append(m)
        seen.add(src)
    return (first + rest)[:n]


def rank(stories: list[dict], now: datetime) -> None:
    for s in stories:
        age_h = (now - datetime.fromisoformat(s["last"].replace("Z", "+00:00"))).total_seconds() / 3600
        # Outlets count most; volume and a recent burst add to it (a big event gets many reports).
        volume = 1 + 0.35 * math.log2(max(s.get("reports", s["sources"]), 1))
        burst = 1.4 if s.get("developing") else 1.0
        s["score"] = round(DESK_WEIGHT.get(s["desk"], 1.0) * (1 + 0.6 * (s["sources"] - 1)) * volume * burst * math.exp(-age_h / 12), 3)
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
        wanted += [by_id[m] for m in diverse(s, by_id)]
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
            quote, name = quote.strip(), name.strip().rstrip(".,")
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


def _ai_call(session, prompt: str, log, system: str = SYSTEM_PROMPT) -> tuple[str, float]:
    acct, token = os.environ.get("CLOUDFLARE_ACCOUNT_ID"), os.environ.get("CLOUDFLARE_API_TOKEN")
    if not acct or not token:
        raise RuntimeError("Cloudflare account ID or API token not set")
    r = session.post(
        f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/{AI_MODEL}",
        headers={"Authorization": f"Bearer {token}"},
        json={"messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
              "max_tokens": 140, "temperature": 0.2},
        timeout=60)
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200 or not body.get("success"):
        errs = "; ".join(e.get("message", "") for e in body.get("errors", [])) or f"HTTP {r.status_code}"
        raise RuntimeError(errs[:200])
    res = body.get("result") or {}
    usage = res.get("usage") or {}
    tin = usage.get("prompt_tokens") or len(system + prompt) / 4
    tout = usage.get("completion_tokens") or len(res.get("response", "")) / 4
    return (res.get("response") or "").strip(), tin / 1e6 * NEURONS_PER_M_IN + tout / 1e6 * NEURONS_PER_M_OUT


def earlier_records(it: dict, tracker: dict, limit: int = 4) -> list[str]:
    """The Wire's own memory: other meetings where this item's addresses came up."""
    out = []
    for a in it.get("agenda") or []:
        addr = a.get("addr")
        for h in (tracker.get(addr) or []):
            if h.get("link") == it.get("link"):
                continue
            line = f"{h['date']}: {h['body']} — {h.get('text', '')[:160]}"
            if line not in out:
                out.append(line)
    return out[:limit]


def summarize(state, data, session, log, room: dict | None = None) -> dict:
    ai = state.setdefault("ai", {})
    today = datetime.now(timezone.utc).date().isoformat()
    if ai.get("day") != today:
        ai.update({"day": today, "neurons": 0.0})
    cache = ai.setdefault("summaries", {})
    texts = state.get("texts", {})
    by_id = {it["id"]: it for it in data["items"]}
    now = datetime.now(timezone.utc)
    stats = {"calls": 0, "kept": 0, "dropped": 0, "error": None}

    # Stories with a large-model write-up don't also get a small-model summary.
    synth = ai.get("synth", {})
    jobs = [("story", s["id"], diverse(s, by_id)) for s in data["stories"][:15]
            if not ((synth.get(skey(s)) or {}).get("card") or (synth.get(skey(s)) or {}).get("what"))]
    day_ago = now - timedelta(hours=24)
    jobs += [("item", it["id"], [it["id"]]) for it in data["items"]
             if it["desk"] in ("BEACON", "GOV", "LAW") and ms(it) >= day_ago and not it.get("no_ai")
             and ((texts.get(it["id"]) or {}).get("text") or it.get("agenda"))][:12]
    tracker = data.get("tracker") or {}

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
            if not body and it.get("agenda"):
                body = "Agenda items:\n" + "\n".join("- " + a["text"][:200] for a in it["agenda"][:25])
            block = f"Report {i} ({it['source']}): {it['title']}\n{it.get('summary', '')}\n{body}".strip()
            if kind == "item":
                prior = earlier_records(it, tracker)
                if prior:
                    block += "\nEarlier on The Wire (meetings where these addresses came up):\n" + "\n".join("- " + p for p in prior)
            parts.append(block)
            corpus.append(block)
        prompt = "\n\n".join(parts)
        from editorial import chairs_for, rules_text
        house = rules_text(room or {}, chairs_for(room or {}, [by_id[m] for m in members]))
        system = SYSTEM_PROMPT + ("\n\n" + house if house else "")
        if len(prompt) < 120:
            continue          # too little source text to summarize honestly
        try:
            text, neurons = _ai_call(session, prompt, log, system)
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


# ---------------------------------------------------------------- story pages: synthesis, figures, timeline

SYNTH_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
SYNTH_IN, SYNTH_OUT = 26668, 204805          # neurons per million tokens (Workers AI pricing)
SYNTH_TOP = 12                               # stories written per build, by rank
SYNTH_DAILY_NEURONS = 4000                   # of the build's AI_DAILY_NEURONS
SYNTH_MAX_CALLS = 6                          # per build
SYNTH_REFRESH_MIN = {True: 45, False: 120}   # developing stories refresh sooner
SYNTH_SYSTEM = (
    "You write a short synthesis of one news story for one reader, from several outlets' reports. "
    "Use only facts stated in the reports. No outside knowledge, no opinion, no speculation, no quotes. "
    "When reports disagree on a fact or a figure, say so and name the outlets. Prefer the newest figures and say they are the latest. "
    "Plain, short sentences, present tense where natural.\n"
    "Reply with JSON only: {\"card\": \"two sentences, under 45 words: what happened and the most important detail\", "
    "\"what\": \"one paragraph, under 120 words: what happened, where, who is involved, what officials say, what happens next if reported\", "
    "\"latest\": \"one sentence on the newest development, only from reports marked NEW; empty string if none\", "
    "\"why\": \"one sentence on why it matters to the reader, only if a Reader line is given and the reports support it; otherwise empty string\"}")


def _parse_json(text: str) -> dict:
    m = re.search(r"\{[\s\S]*\}", text or "")
    if not m:
        return {}
    try:
        j = json.loads(m.group(0))
        return j if isinstance(j, dict) else {}
    except ValueError:
        return {}


def _cf_run(session, model: str, system: str, prompt: str, max_tokens: int, rates: tuple[float, float]):
    acct, token = os.environ.get("CLOUDFLARE_ACCOUNT_ID"), os.environ.get("CLOUDFLARE_API_TOKEN")
    if not acct or not token:
        raise RuntimeError("Cloudflare account ID or API token not set")
    r = session.post(f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/{model}",
                     headers={"Authorization": f"Bearer {token}"},
                     json={"messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
                           "max_tokens": max_tokens, "temperature": 0.2}, timeout=90)
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200 or not body.get("success"):
        raise RuntimeError(("; ".join(e.get("message", "") for e in body.get("errors", [])) or f"HTTP {r.status_code}")[:200])
    res = body.get("result") or {}
    usage = res.get("usage") or {}
    out = res.get("response")
    out_text = json.dumps(out) if isinstance(out, dict) else (out or "")
    tin = usage.get("prompt_tokens") or len(system + prompt) / 4
    tout = usage.get("completion_tokens") or len(out_text) / 4
    return (out if isinstance(out, dict) else _parse_json(out_text)), tin / 1e6 * rates[0] + tout / 1e6 * rates[1]


def skey(s: dict) -> str:
    """Writing is cached by thread when the story has one, so it survives re-clustering."""
    return s.get("thread") or s["id"]


RED_PEN_TOP = 3
RED_PEN_SYSTEM = (
    "You are the standards editor. You get news reports and a draft written from them. "
    "List every sentence of the draft that says anything the reports do not directly state: inference, speculation, "
    "characterization, motive, significance, or a fact from outside the reports. Copy each such sentence exactly. "
    "Reply with JSON only: {\"cut\": [\"exact sentence\", ...]} (an empty list if every sentence is supported).")


def synthesize(state, data, session, log, room: dict | None = None) -> dict:
    """Write the story pages' text for the top stories with the large model, under budget.
    Every sentence must trace to the cited reports (grounded); untraceable sentences are dropped."""
    ai = state.setdefault("ai", {})
    today = datetime.now(timezone.utc).date().isoformat()
    if ai.get("day") != today:
        ai.update({"day": today, "neurons": 0.0})
    ai.setdefault("synth_neurons_day", today)
    if ai.get("synth_neurons_day") != today:
        ai.update({"synth_neurons_day": today, "synth_neurons": 0.0})
    cache = ai.setdefault("synth", {})
    texts = state.get("texts", {})
    by_id = {it["id"]: it for it in data["items"]}
    now = datetime.now(timezone.utc)
    stats = {"calls": 0, "kept": 0, "dropped": 0, "error": None, "cut": 0, "chairs": Counter()}
    from editorial import chairs_for, rules_text
    tracker = data.get("tracker") or {}
    # Followed threads get first claim on the writing budget, then the ranked top.
    top = [s for s in data["stories"] if s.get("followed") and s["desk"] != "SPORTS"][:8]
    # Followed named topics have no cluster of their own: write them from their members.
    with_story = {s.get("thread") for s in data["stories"]}
    for t in data.get("threads", []):
        if t.get("followed") and t["id"] not in with_story and t.get("members"):
            mem = [m for m in t["members"] if m in by_id][-10:]
            if mem:
                top.append({"id": t["id"], "thread": t["id"], "members": list(reversed(mem)), "desk": t["desk"],
                            "sources": len({by_id[m]["source"] for m in mem}), "developing": False, "last": t["last"], "named": True})
    top += [s for s in data["stories"] if s["desk"] != "SPORTS" and s not in top][:SYNTH_TOP]
    # Each desk tab leads with its own written stories, so the top two Beacon, Gov and Law
    # stories get the full write-up too, even when world news fills the overall top 12.
    for desk in ("BEACON", "GOV", "LAW"):
        top += [s for s in data["stories"] if s["desk"] == desk and s not in top][:2]
    live = {skey(s) for s in data["stories"][:40]} | {skey(s) for s in top}
    for k in [k for k in cache if k not in live]:
        del cache[k]
    for s in top:
        members = diverse(s, by_id, 6)
        if len(members) < 2 and not s.get("named"):
            continue
        sig = hashlib.sha1(json.dumps(sorted(m for m in s["members"] if not by_id[m].get("no_ai"))).encode()).hexdigest()[:12]
        rules_sig = hashlib.sha1(json.dumps(room or {}, sort_keys=True, default=str).encode()).hexdigest()[:8]
        rec = cache.get(skey(s))
        if rec and rec.get("rules") != rules_sig:
            rec = None        # the room's rules changed: rewrite under the new rules
        if rec and (rec["sig"] == sig or now - datetime.fromisoformat(rec["at"]) < timedelta(minutes=SYNTH_REFRESH_MIN[bool(s.get("developing"))])):
            continue
        if stats["calls"] >= SYNTH_MAX_CALLS or ai.get("synth_neurons", 0) >= SYNTH_DAILY_NEURONS or ai["neurons"] >= AI_DAILY_NEURONS:
            break
        recent_cut = now - timedelta(hours=3)
        blocks = []
        for i, m in enumerate(sorted(members, key=lambda x: ms(by_id[x])), 1):
            it = by_id[m]
            body = (texts.get(m) or {}).get("text", "")[:1500]
            new = " · NEW" if ms(it) >= recent_cut else ""
            block = f"Report {i} · {it['source']} · {ms(it).strftime('%b %d %H:%M UTC')}{new}\n{it['title']}\n{it.get('summary', '')}\n{body}".strip()
            prior = earlier_records(it, tracker)
            if prior:
                block += "\nEarlier on The Wire:\n" + "\n".join("- " + p for p in prior)
            blocks.append(block)
        corpus = "\n\n".join(blocks)
        chairs = chairs_for(room or {}, [by_id[m] for m in s["members"]])
        stats["chairs"].update(chairs)
        system = SYNTH_SYSTEM + ("\n\n" + rules_text(room or {}, chairs) if room else "")
        watch = sorted({t for m in s["members"] for t in by_id[m].get("watch_terms", [])})
        reader = ("Reader: lives in Beacon, NY; this story matched his watchlist: " + ", ".join(watch) + ".\n\n") if watch else ""
        prompt = reader + corpus
        try:
            j, neurons = _cf_run(session, SYNTH_MODEL, system, prompt, 420, (SYNTH_IN, SYNTH_OUT))
        except Exception as exc:
            stats["error"] = f"{type(exc).__name__}: {exc}"[:240]
            log(f"[synth] {stats['error']}")
            break
        ai["neurons"] += neurons
        ai["synth_neurons"] = ai.get("synth_neurons", 0) + neurons
        stats["calls"] += 1
        allowed = corpus + " Beacon New York"
        kept = {k: grounded(str(j.get(k) or ""), allowed) for k in ("card", "what", "latest", "why")}
        if not watch:
            kept["why"] = ""
        # Red pen: a second read of the top stories by the standards editor; flagged
        # sentences are cut. Skipped (not fatal) if the budget or the model says no.
        if s in top[:RED_PEN_TOP] and any(kept.values()) and ai.get("synth_neurons", 0) < SYNTH_DAILY_NEURONS:
            draft = " ".join(kept[k] for k in ("card", "what", "latest", "why") if kept[k])
            try:
                rp, n2 = _cf_run(session, SYNTH_MODEL, RED_PEN_SYSTEM, corpus + "\n\nDRAFT:\n" + draft, 300, (SYNTH_IN, SYNTH_OUT))
                ai["neurons"] += n2
                ai["synth_neurons"] = ai.get("synth_neurons", 0) + n2
                cuts = [c.strip() for c in (rp.get("cut") or []) if isinstance(c, str) and len(c.strip()) > 12]
                for k in kept:
                    for c in cuts:
                        if c in kept[k]:
                            kept[k] = re.sub(r"\s+", " ", kept[k].replace(c, "")).strip()
                            stats["cut"] += 1
            except Exception as exc:
                log(f"[redpen] {type(exc).__name__}: {str(exc)[:120]}")
        if kept["card"] or kept["what"]:
            stats["kept"] += 1
        else:
            stats["dropped"] += 1
        cache[skey(s)] = {"sig": sig, "rules": rules_sig, "at": now.isoformat(), **kept,
                          "latest_at": max((by_id[m]["t"] for m in members), default=None),
                          "n": len(members), "dropped": sum(1 for k in ("card", "what", "latest", "why") if (j.get(k) or "") and not kept[k])}
    return stats


EDITOR_EVERY_MIN = 60
EDITOR_TOP = 8
EDITOR_SYSTEM = (
    "You are the editor of a one-reader news site for a reader in Beacon, New York. For each numbered story, write one "
    "short line (under 20 words) on why it is on the front page now, using only facts in that story's text: what changed, "
    "how big, who is affected. No hype, no opinion. Reply with JSON only: {\"notes\": [{\"n\": 1, \"why\": \"...\"}]}.")


def editor_notes(state, data, session, log, room: dict | None = None) -> None:
    """Once an hour: one line per front-page story on why it leads (shown as analysis)."""
    from editorial import rules_text
    ai = state.setdefault("ai", {})
    ed = ai.setdefault("editor", {})
    now = datetime.now(timezone.utc)
    top = [s for s in data["stories"] if s["desk"] != "SPORTS" and (s.get("card") or s.get("summary"))][:EDITOR_TOP]
    if not top:
        return
    if ed.get("at") and now - datetime.fromisoformat(ed["at"]) < timedelta(minutes=EDITOR_EVERY_MIN):
        pass
    elif ai.get("neurons", 0) < AI_DAILY_NEURONS:
        blocks = [f"[{i}] {s['sources']} outlets, {s.get('reports', s['sources'])} reports{', developing' if s.get('developing') else ''}\n"
                  f"{(data_by_id(data).get(s['lead']) or {}).get('title', '')}\n{s.get('what') or s.get('card') or s.get('summary')}"
                  for i, s in enumerate(top, 1)]
        system = EDITOR_SYSTEM + ("\n\n" + rules_text(room, [], ("editor",)) if room else "")
        try:
            j, n = _cf_run(session, SYNTH_MODEL, system, "\n\n".join(blocks), 400, (SYNTH_IN, SYNTH_OUT))
            ai["neurons"] += n
            notes = {}
            for x in j.get("notes") or []:
                try:
                    st = top[int(x.get("n")) - 1]
                except (ValueError, TypeError, IndexError):
                    continue
                corpus = " ".join([str(st.get(k) or "") for k in ("what", "card", "summary")] + [blocks[top.index(st)]])
                why = grounded(str(x.get("why") or ""), corpus)
                if why:
                    notes[st["id"]] = why
            ed.update({"at": now.isoformat(), "notes": notes})
            log(f"[editor] front-page notes for {len(notes)} of {len(top)} stories")
        except Exception as exc:
            log(f"[editor] {type(exc).__name__}: {str(exc)[:120]}")
    for s in data["stories"]:
        note = (ed.get("notes") or {}).get(s["id"])
        if note:
            s["lead_note"] = note


DAY_EVERY_MIN = 60
DAY_SYSTEM = (
    "You write 'the day so far' for one reader in Beacon, New York: three or four plain sentences on the shape of the day, "
    "from the numbered stories only. Open with the biggest development. Put Beacon and New York before the world when they have real news. "
    "Say what changed, not what a story is about. Use only facts in the stories; no opinion, no outside knowledge, no hype. "
    "Reply with JSON only: {\"text\": \"...\"}.")


def day_so_far(state, data, session, log, room=None) -> None:
    """Once an hour: the day in three or four sentences, from the top stories and followed threads."""
    from editorial import rules_text
    ai = state.setdefault("ai", {})
    rec = ai.setdefault("day_so_far", {})
    now = datetime.now(timezone.utc)
    by_id = data_by_id(data)
    threads = {t["id"]: t for t in data.get("threads", [])}
    picks = [s for s in data["stories"] if s.get("followed")][:4]
    picks += [s for s in data["stories"] if s["desk"] in ("BEACON", "GOV", "LAW") and s not in picks and (s.get("card") or s.get("summary"))][:3]
    picks += [s for s in data["stories"] if s not in picks and s["desk"] != "SPORTS" and (s.get("card") or s.get("summary"))][:8]
    picks = picks[:9]
    if not picks:
        return
    fresh = rec.get("at") and now - datetime.fromisoformat(rec["at"]) < timedelta(minutes=DAY_EVERY_MIN)
    if not fresh and ai.get("neurons", 0) < AI_DAILY_NEURONS:
        blocks = []
        for i, s in enumerate(picks, 1):
            t = threads.get(s.get("thread")) or {}
            lead = by_id.get(s["lead"]) or {}
            blocks.append(f"[{i}] {s['desk']} · {s['sources']} outlets{' · you follow this' if s.get('followed') else ''}\n{lead.get('title', '')}\n"
                          f"{s.get('what') or s.get('card') or s.get('summary') or ''}\n{('Latest: ' + s['latest']) if s.get('latest') else ''}".strip())
        corpus = "\n\n".join(blocks)
        system = DAY_SYSTEM + ("\n\n" + rules_text(room, [], ("editor",)) if room else "")
        try:
            j, n = _cf_run(session, SYNTH_MODEL, system, corpus, 260, (SYNTH_IN, SYNTH_OUT))
            ai["neurons"] += n
            text = grounded(str(j.get("text") or ""), corpus + " Beacon New York Dutchess Albany")
            if text:
                rec.update({"at": now.isoformat(), "text": text, "refs": [s["id"] for s in picks]})
                log(f"[day] written: {len(text.split())} words")
            else:
                log("[day] dropped: nothing traceable")
        except Exception as exc:
            log(f"[day] {type(exc).__name__}: {str(exc)[:120]}")
    if rec.get("text"):
        data["day_so_far"] = {"text": rec["text"], "at": rec["at"], "refs": rec.get("refs", [])}


def data_by_id(data):
    return {it["id"]: it for it in data["items"]}


COUNT_RE = re.compile(
    r"(?:\b(more than|over|at least|nearly|about|almost|around|some|roughly|up to)\s+)?\b(\d{1,3}(?:,\d{3})+|\d+)\s+"
    r"(?:(?:people|protesters|demonstrators|civilians|others|officers|police officers|children|students|migrants|soldiers|troops|residents|passengers|workers)\s+)?"
    r"(?:(?:were|have been|had been|are|was)\s+)?"
    r"(killed|dead|died|deaths|injured|wounded|hurt|arrested|detained|arrests|missing|evacuated|displaced)\b", re.IGNORECASE)
COUNT_CLASS = {"killed": "killed", "dead": "killed", "died": "killed", "deaths": "killed", "injured": "injured", "wounded": "injured",
               "hurt": "injured", "arrested": "arrested", "detained": "arrested", "arrests": "arrested", "missing": "missing",
               "evacuated": "displaced", "displaced": "displaced"}
COUNT_LABEL = {"killed": "Deaths", "injured": "Injured", "arrested": "Arrests", "missing": "Missing", "displaced": "Displaced or evacuated"}


def figures(s, by_id, texts) -> list[dict]:
    """Casualty and arrest counts as each outlet reported them, when outlets' numbers differ.
    Pure pattern matching; no model. Each figure shows its outlet, time and wording."""
    per: dict[str, dict[str, dict]] = {}
    for m in s["members"]:
        it = by_id[m]
        if it.get("no_ai"):
            continue
        text = " ".join([it["title"], it.get("summary", ""), (texts.get(m) or {}).get("text", "")[:700]])   # the lede, not background paragraphs
        for mt in COUNT_RE.finditer(text):
            n = int(mt.group(2).replace(",", ""))
            if n < 2 or 1900 <= n <= 2100:
                continue      # skip "1 killed" noise and years
            cls = COUNT_CLASS[mt.group(3).lower()]
            cur = per.setdefault(cls, {}).get(it["source"])
            if not cur or n > cur["n"] or (n == cur["n"] and it["t"] > cur["t"]):
                per[cls][it["source"]] = {"n": n, "text": mt.group(0).strip(), "source": it["source"], "t": it["t"], "link": it["link"]}
    out = []
    for cls, by_src in per.items():
        vals = sorted(by_src.values(), key=lambda x: x["t"])
        nums = {v["n"] for v in vals}
        if len(vals) >= 2 and len(nums) >= 2:
            out.append({"what": COUNT_LABEL[cls], "reports": vals[-6:]})
    return out


def timeline(s, by_id) -> list[dict]:
    """First report, then one headline per two-hour stretch, then the latest (max 6)."""
    mem = sorted((by_id[m] for m in s["members"]), key=ms)
    if len(mem) < 5 or (ms(mem[-1]) - ms(mem[0])) < timedelta(hours=4):
        return []
    picks, last_t = [], None
    for it in mem:
        if last_t is None or ms(it) - last_t >= timedelta(hours=2):
            picks.append(it)
            last_t = ms(it)
    if picks[-1] is not mem[-1]:
        picks.append(mem[-1])
    if len(picks) > 6:
        picks = picks[:1] + picks[-5:]
    return [{"t": it["t"], "title": it["title"], "source": it["source"], "link": it["link"]} for it in picks]


# ---------------------------------------------------------------- one entry point for build.py

def run(state, data, src_by_id, session, robots_allows, timeout, log, follows: dict | None = None) -> None:
    from editorial import load as load_room
    import threads as threads_mod
    room = load_room()
    now = datetime.now(timezone.utc)
    stories = group(data["items"], now)
    rank(stories, now)
    data["stories"] = stories
    nviews = attach_views(data, stories, now)
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

    by_id = {it["id"]: it for it in data["items"]}
    for s in stories:
        figs = figures(s, by_id, texts)
        if figs:
            s["figures"] = figs
        tl = timeline(s, by_id)
        if tl:
            s["timeline"] = tl
    # Threads: persistent identity, developments, documents, follows (BRIEF.md stage 1).
    try:
        threads_mod.update(state, data, follows or {}, now, log)
    except Exception as exc:
        log(f"[threads] failed: {type(exc).__name__}: {exc}")
        data.setdefault("threads", [])
    followed_threads = {t["id"] for t in data.get("threads", []) if t.get("followed")}
    for s in stories:
        s["followed"] = s.get("thread") in followed_threads

    st = state.setdefault("v5", {})
    if tstats["attempts"] and not tstats["ok"]:
        st["text_error"] = tstats["errors"][0] if tstats["errors"] else "all fetches failed"
    elif tstats["ok"]:
        st["text_error"], st["text_ok"] = None, stamp
    sstats = synthesize(state, data, session, log, room)
    astats = summarize(state, data, session, log, room)
    if sstats["error"] and not astats["error"] and "not set" not in sstats["error"]:
        astats["error"] = "story pages: " + sstats["error"]
    if astats["error"]:
        st["ai_error"] = astats["error"]
    elif astats["calls"] or not st.get("ai_ok"):
        st["ai_error"], st["ai_ok"] = None, stamp if astats["calls"] else st.get("ai_ok")

    summaries = state["ai"]["summaries"]
    synth = state["ai"].get("synth", {})
    for s in stories:
        rec = summaries.get(s["id"])
        if rec and rec["summary"]:
            s["summary"] = rec["summary"]
        sy = synth.get(skey(s))
        if sy:
            for k in ("card", "what", "latest", "why"):
                if sy.get(k):
                    s[k] = sy[k]
            s["written_at"] = sy["at"]
            if sy.get("latest"):
                s["latest_at"] = sy.get("latest_at")
    # Threads carry their current story's writing, figures, timeline and views.
    story_by_thread = {s["thread"]: s for s in stories if s.get("thread")}
    for t in data.get("threads", []):
        s = story_by_thread.get(t["id"])
        if s:
            for k in ("what", "card", "summary", "latest", "latest_at", "why", "written_at", "figures", "timeline", "views", "sources", "reports", "lead"):
                if s.get(k) is not None:
                    t[k] = s[k]
        else:
            sy = synth.get(t["id"])
            if sy:
                for k in ("card", "what", "latest", "why"):
                    if sy.get(k):
                        t[k] = sy[k]
                t["written_at"] = sy["at"]
                t["latest_at"] = sy.get("latest_at")
    try:
        editor_notes(state, data, session, log, room)
    except Exception as exc:
        log(f"[editor] {type(exc).__name__}: {exc}")
    try:
        day_so_far(state, data, session, log, room)
    except Exception as exc:
        log(f"[day] {type(exc).__name__}: {exc}")
    for it in data["items"]:
        rec = summaries.get(it["id"])
        if rec and rec["summary"] and rec["sources"] == [it["id"]]:
            it["machine_summary"] = rec["summary"]

    log(f"[views] {nviews} opinion pieces matched to stories")
    log(f"[v5] stories={len(stories)} texts kept={tstats['kept']} new={tstats['ok']} robots-skip={tstats['robots']} "
        f"quotes on {nq} items · ai calls={astats['calls']} kept={astats['kept']} dropped={astats['dropped']} "
        f"neurons today≈{state['ai']['neurons']:.0f} · story pages written={sstats['calls']} kept={sstats['kept']} "
        f"dropped={sstats['dropped']} red-pen cuts={sstats['cut']} chairs={dict(sstats['chairs'])}"
        f"{' error=' + sstats['error'] if sstats['error'] else ''}")
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
