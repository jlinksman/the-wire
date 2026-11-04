"""Home brief (2026-10-28): a tiny JSON file Home Assistant reads aloud in the kitchen.

GET /home-brief.json (functions/home-brief.json.js) serves dist/home-brief.json from Workers KV:
3 to 5 of the briefing's signal items in Joe's order (Beacon first, then by the briefing score),
each with the headline, a section, and one or two plain sentences written to be heard.

Editions (2026-11-03): before 3 PM Eastern it's the Morning brief (the last day, what's ahead today);
from 3 PM it's the Evening brief (what happened since morning first, what's still developing, and
meetings and hearings tonight and tomorrow morning). "ahead" carries those as spoken lines.
"listen_for" gives Home Assistant words to match podcast episodes against: the topics, threads
and searches Joe follows (reading taste, which the build may see) and today's lead story words.
It is never logged.

News only. Items come from the briefing's signal list, which is built from the news feeds; nothing
from the private parts of The Wire (views, questionnaires, the voter's guide scoring, debate notes,
campaign material) is read here, and opinion pieces, podcasts and anything from a campaign or
party source are left out. The "why" field (watchlist and followed-thread matches) is not copied.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")

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
    t = re.sub(r"\band\s*/\s*or\b", "or", t, flags=re.I)
    t = re.sub(r"\b(\d{1,2})(?::00)?(?::(\d\d))?\s?([ap])\.?m\.?(?=\W|$)", lambda m: m.group(1) + (":" + m.group(2) if m.group(2) else "") + (" AM" if m.group(3).lower() == "a" else " PM"), t, flags=re.I)
    t = t.replace("&", " and ").replace("—", ", ").replace("–", " to ").replace("…", ".").replace("/", " and ")
    t = re.sub(r"[\"“”]", "", t).replace("‘", "'").replace("’", "'")
    for pat, rep in SAY:
        t = re.sub(pat, rep, t)
    t = re.sub(r"\s+([,.;:!?])", r"\1", re.sub(r"\s+", " ", t)).strip(" ,;:-")
    return t


def _sentences(t: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", t) if s.strip()]


FILLER = re.compile(r"\b(screenshots?|file photo|photo by|courtesy of|a (poll|polling) site in|pictured|has (this|the|a) (report|story|details)|has more|reports?:$|read more|continue reading|click here|subscribe|appeared first on|is available)\b", re.I)


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
        if FILLER.search(s) or len(s.split()) < 4 or len({w.lower().strip(".,") for w in s.split()}) == 1:
            continue                     # captions, datelines ("Nov."), repeated alt text
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


def section(x: dict, local=None) -> str:
    sec = x.get("section")
    if sec == "Alert":
        return "Alert"
    if sec == "Beacon":
        local_src = re.search(r"\b(Beacon|City of Beacon)\b", x.get("source", ""))
        return "Beacon" if local_src or re.search(r"\bBeacon\b", x["title"] + " " + x.get("summary", "")) else "Hudson Valley"
    if sec == "Law":
        return "Courts"
    if sec == "Government":
        if x.get("scope") == "state":
            return "Albany" if re.search(r"\b(Albany|Hochul|Legislature|Assembly|state Senate|state budget|Comptroller|Attorney General)\b", x["title"] + " " + x.get("summary", "")) else "New York"
        return "Congress" if re.search(r"\b(Congress|House|Senate|Speaker|lawmakers)\b", x["title"]) else "Washington"
    return sec or "News"


STOP = set("""the a an and or of to in on for at by with from about into over after before new news
this that these those is are was were be been will would could should has have had its it's their
his her they them you your our we not but as than more most says said say week today year years
day days what who why how when where which while just also amid against first last make makes can may now out all one two off get set per its man men big top""".split())


def edition_of(now: datetime) -> str:
    return "Morning" if now.astimezone(NY).hour < 15 else "Evening"


def _words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z][a-z'-]{2,}", (text or "").lower()) if w not in STOP][:4]


def listen_for(data: dict, out: list[dict]) -> list[dict]:
    """[{"w": [words], "n": weight}]: one entry per followed topic, thread or search (weight 3),
    then one per story in this brief (weight 1). HA scores an episode +n once per entry that any
    of its words matches."""
    f = data.get("follows") or {}
    seen, terms = set(), []
    for kind in ("topics", "threads", "searches"):
        for x in f.get(kind) or []:
            title = str(x.get("title") or x.get("query") or "")
            w = _words(title)
            if w and title.lower() not in seen:
                seen.add(title.lower())
                terms.append({"w": w, "n": 3})
    for x in out:
        w = _words(x["headline"])
        if w:
            terms.append({"w": w, "n": 1})
    return terms[:40]


def _ahead(data: dict, now: datetime, edition: str) -> list[str]:
    """Meetings, hearings and sessions with a start time: the rest of today in the morning;
    tonight and tomorrow until 1 PM in the evening. Spoken as "At 7 PM, City Council workshop."""
    local = now.astimezone(NY)
    end = (local + timedelta(days=1)).replace(hour=13, minute=0) if edition == "Evening" else local.replace(hour=23, minute=59)
    rows, seen = [], set()
    for it in data.get("items", []):
        if not it.get("event_at") or it.get("desk") == "SPORTS":
            continue
        try:
            ev = datetime.fromisoformat(it["event_at"].replace("Z", "+00:00")).astimezone(NY)
        except ValueError:
            continue
        what = spoken(re.split(r"\s[-–—|]\s", it["title"])[0]).rstrip(".")
        if not (local - timedelta(minutes=30) < ev <= end) or what.lower() in seen:
            continue
        seen.add(what.lower())
        day = "" if ev.date() == local.date() else "Tomorrow "
        when = ev.strftime("%-I PM" if ev.minute == 0 else "%-I:%M PM") if ev.hour >= 12 else ev.strftime("%-I AM" if ev.minute == 0 else "%-I:%M AM")
        rows.append((ev, it.get("desk") != "BEACON", f"{day}{'at' if day else 'At'} {when}, {what}."))
    rows.sort(key=lambda r: (r[1], r[0]))
    return [r[2] for r in sorted(rows[:3])]


def build(picked: list[dict], extras: list[dict], data: dict, dist, log, now: datetime | None = None) -> None:
    now = now or datetime.now(timezone.utc)
    edition = edition_of(now)
    items = {it["id"]: it for it in data.get("items", [])}
    stories = {s["lead"]: s for s in data.get("stories", [])}

    def ok(x):
        it = items.get(x["id"]) or {}
        return not (x.get("podcast") or x.get("perspective") or x.get("by") or it.get("opinion") or it.get("kind") in ("OPINION", "PODCAST", "POST", "BLOTTER")
                    or CAMPAIGN.search(x.get("source", "")) or x.get("section") == "Sports")

    pool = sorted([x for x in picked if ok(x)], key=lambda x: x.get("score", 0), reverse=True)
    if edition == "Evening":             # since this morning first, then still developing, then the rest
        def fresh(x):
            try:
                return now - datetime.fromisoformat(x["t"].replace("Z", "+00:00")) < timedelta(hours=12)
            except (KeyError, ValueError):
                return False
        pool = [x for x in pool if fresh(x)] + [x for x in pool if not fresh(x) and x.get("developing")] + [x for x in pool if not fresh(x) and not x.get("developing")]
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
    body = {"updated": data.get("generated_at"), "edition": edition, "items": out,
            "ahead": _ahead(data, now, edition), "listen_for": listen_for(data, out)}
    (dist / "home-brief.json").write_text(json.dumps(body, ensure_ascii=False, separators=(",", ":")))
    log(f"[home_brief] {edition.lower()}: {len(out)} items")
