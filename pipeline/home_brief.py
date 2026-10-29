"""Home brief (2026-10-28): a tiny JSON file Home Assistant reads aloud in the kitchen.

GET /home-brief.json (functions/home-brief.json.js) serves dist/home-brief.json from Workers KV:
3 to 5 of the briefing's signal items in Joe's order (Beacon first, then by the briefing score),
each with the headline, a section, and one or two plain sentences written to be heard.

News only. Items come from the briefing's signal list, which is built from the news feeds; nothing
from the private parts of The Wire (views, questionnaires, the voter's guide scoring, debate notes,
campaign material) is read here, and opinion pieces, podcasts and anything from a campaign or
party source are left out. The "why" field (watchlist and followed-thread matches) is not copied.
"""
from __future__ import annotations

import json
import re

MAX_WORDS = 40
CAMPAIGN = re.compile(r"\b(campaign|for (senate|congress|governor|assembly|mayor)|committee to elect|friends of|democrats?|republicans?|gop|working families party|conservative party)\b", re.I)

# Spoken English: what a voice would otherwise mangle.
SAY = [
    (r"\bN\.Y\.C\.|\bNYC\b", "New York City"), (r"\bN\.Y\.S\.|\bNYS\b", "New York State"), (r"\bN\.Y\.|\bNY\b", "New York"),
    (r"\bU\.S\.A?\.?(?=\W|$)", "US"), (r"\bU\.K\.(?=\W|$)", "UK"), (r"\bD\.C\.(?=\W|$)", "DC"),
    (r"\bGov\.", "Governor"), (r"\bSen\.", "Senator"), (r"\bSens\.", "Senators"), (r"\bRep\.", "Representative"), (r"\bReps\.", "Representatives"),
    (r"\bAsm\.", "Assemblymember"), (r"\bLt\.", "Lieutenant"), (r"\bSgt\.", "Sergeant"), (r"\bDept\.", "Department"), (r"\bGen\.", "General"),
    (r"\bAtty\.", "Attorney"), (r"\bSt\.(?= [A-Z])", "Saint"), (r"(?<=\w) St\.", " Street"), (r"\bAve\.", "Avenue"), (r"\bRd\.", "Road"),
    (r"\bMt\.", "Mount"), (r"\bNo\.\s?(?=\d)", "number "), (r"\bvs?\.(?=\s)", "versus"), (r"\bapprox\.", "about"), (r"\betc\.", "and so on"),
    (r"\bSCOTUS\b", "the Supreme Court"), (r"\bPOTUS\b", "the President"), (r"\bDEC\b", "the state environmental department"),
    (r"\bDOJ\b", "the Justice Department"), (r"\bDHS\b", "Homeland Security"), (r"\bICE\b", "ICE"), (r"\bGOP\b", "Republican"),
    (r"\bMTA\b", "the MTA"), (r"\bPSC\b", "the Public Service Commission"), (r"\bZBA\b", "the Zoning Board"),
]


def _money(m):
    n, unit = m.group(1), (m.group(2) or "").lower()
    unit = {"k": " thousand", "m": " million", "mn": " million", "million": " million", "b": " billion", "bn": " billion", "billion": " billion"}.get(unit, "")
    return f"{n}{unit} dollars"


def spoken(text: str) -> str:
    t = re.sub(r"https?://[^\s)]+|www\.[^\s)]+", "", text or "")
    t = re.sub(r"\[[^\]]*\]|\([^)]*\)", "", t)                       # citations and asides
    t = re.sub(r"[*_#`>|~]", "", t)
    t = re.sub(r"[\U0001F000-\U0001FAFF☀-➿️]", "", t)  # emoji and symbols
    t = re.sub(r"\$\s?(\d[\d,.]*)\s?(k|m|mn|million|b|bn|billion)?\b", _money, t, flags=re.I)
    t = re.sub(r"(\d)\s?%", r"\1 percent", t)
    t = re.sub(r"\b(\d{1,3})\s?-\s?(\d{1,3})\b(?!-)", r"\1 to \2", t)          # votes and scores: 40-22
    t = t.replace("&", " and ").replace("—", ", ").replace("–", " to ").replace("…", ".").replace("/", " and ")
    t = re.sub(r"[\"“”]", "", t).replace("‘", "'").replace("’", "'")
    for pat, rep in SAY:
        t = re.sub(pat, rep, t)
    t = re.sub(r"\s+([,.;:!?])", r"\1", re.sub(r"\s+", " ", t)).strip(" ,;:-")
    return t


def _sentences(t: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", t) if s.strip()]


FILLER = re.compile(r"\b(file photo|photo by|courtesy of|has (this|the|a) (report|story|details)|reports?:$|read more|continue reading|click here|subscribe|appeared first on|is available)\b", re.I)


def _cap(text: str) -> str:
    w = text.split()
    if len(w) <= MAX_WORDS:
        return text
    cut = " ".join(w[:MAX_WORDS])
    cut = cut[: max(cut.rfind(","), cut.rfind(";"))] if max(cut.rfind(","), cut.rfind(";")) > len(cut) // 2 else cut
    return cut.rstrip(",;: ") + "."


def say_for(title: str, summary: str) -> str:
    """One or two sentences under 40 words: our summary when it fits, else the headline. A very
    short summary gets the headline in front of it, so it makes sense heard cold."""
    head = spoken(re.split(r";\s", title)[0]).rstrip(".!?:") + "."
    out, n = [], 0
    for s in _sentences(spoken(summary)):
        if FILLER.search(s):
            continue
        w = len(s.split())
        if n + w > MAX_WORDS or len(out) == 2:
            break
        out.append(s if s[-1] in ".!?" else s + ".")
        n += w
    said = " ".join(out)
    if not out:
        return _cap(head)
    if n < 12 and len(head.split()) + n <= MAX_WORDS and head.lower()[:30] not in said.lower():
        said = head + " " + said
    return _cap(said)


def section(x: dict, local) -> str:
    sec = x.get("section")
    if sec == "Alert":
        return "Alert"
    if sec == "Beacon":
        return "Beacon" if re.search(r"\bBeacon\b", x["title"] + " " + x.get("summary", "")) else "Hudson Valley"
    if sec == "Law":
        return "Courts"
    if sec == "Government":
        return "Albany" if x.get("scope") == "state" else "Congress" if re.search(r"\b(Congress|House|Senate|Speaker|lawmakers)\b", x["title"]) else "Washington"
    return sec or "News"


def build(picked: list[dict], extras: list[dict], data: dict, dist, log) -> None:
    items = {it["id"]: it for it in data.get("items", [])}
    stories = {s["lead"]: s for s in data.get("stories", [])}

    def ok(x):
        it = items.get(x["id"]) or {}
        return not (x.get("podcast") or x.get("perspective") or x.get("by") or it.get("opinion") or it.get("kind") in ("OPINION", "PODCAST", "POST", "BLOTTER")
                    or CAMPAIGN.search(x.get("source", "")) or x.get("section") == "Sports")

    pool = sorted([x for x in picked if ok(x)], key=lambda x: x.get("score", 0), reverse=True)
    if len(pool) < 3:                    # a thin morning: the best extras, local and state first
        more = sorted([x for x in extras if ok(x) and x not in pool], key=lambda x: (x.get("scope") not in ("local", "state"), -x.get("score", 0)))
        pool += more[: 5 - len(pool)]
    beacon = [x for x in pool if x.get("section") == "Beacon"]
    order = [x for x in pool if x.get("section") == "Alert"] + beacon[:2]
    order += [x for x in pool if x not in order]
    out, seen = [], set()
    for x in order:
        st = stories.get(x["id"]) or {}
        it = items.get(x["id"]) or {}
        # Our checked story text first, then the briefing's summary, never the article body.
        summary = st.get("what") or st.get("card") or st.get("summary") or it.get("machine_summary") or it.get("summary") or ""
        key = re.sub(r"\W+", " ", x["title"].lower())[:50]
        if key in seen:
            continue
        seen.add(key)
        out.append({"headline": spoken(re.split(r";\s", x["title"])[0]), "spoken": say_for(x["title"], summary), "section": section(x, None)})
        if len(out) == 5:
            break
    body = {"updated": data.get("generated_at"), "items": out}
    (dist / "home-brief.json").write_text(json.dumps(body, ensure_ascii=False, separators=(",", ":")))
    log(f"[home_brief] {len(out)} items")
