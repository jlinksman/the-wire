"""Puzzle Page generators (GAMES.md, approved 2026-10-27).

Runs once a day in .github/workflows/games.yml (about 4 AM Eastern), separately from the
15-minute build. Reads the published data.json plus public rosters, writes a candidate pool to
dist/games-today.json, which goes to Workers KV. functions/games.js assembles Joe's four slots
from the pool. This program never sees Joe's results, opens or answers (CLAUDE.md rule 10).

Everything here is correct by construction: puzzles come from verified quotes and complete
public rosters, every generated puzzle is checked, and anything that fails is dropped and
reported on the Games health rows with a reason. Same date, same seed, same puzzles.

Usage: python pipeline/games.py DATA_JSON OUT_JSON [--rosters DIR] [--date YYYY-MM-DD] [--hashes FILE]
"""
from __future__ import annotations

import argparse
import os
import hashlib
import itertools
import json
import random
import re
import string
import sys
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

ROOT = Path(__file__).resolve().parent.parent
NY = ZoneInfo("America/New_York")
CFG = yaml.safe_load((ROOT / "games.yaml").read_text())
FORMAT = 1


# ------------------------------------------------------------------ text helpers
def fold(s: str) -> str:
    """Lowercase, accents removed, punctuation to spaces."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def pid(*parts) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:12]


def parse_t(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------ guardrails
EXCLUDE = re.compile("|".join(CFG["exclude_patterns"]), re.I)
INSTITUTIONAL = re.compile("|".join(CFG["institutional_only_threads"]), re.I)
NAMES_OUT = re.compile("|".join(re.escape(n) for n in CFG["exclude_names"]), re.I)


def blocked(*texts) -> str | None:
    """Why this can't be a puzzle (GAMES.md rule 7), or None."""
    t = " ".join(x for x in texts if x)
    if NAMES_OUT.search(t):
        return "names Joe's own business"
    m = EXCLUDE.search(t)
    return f"exclusion list: {m.group(0).lower()}" if m else None


def institutional_only(it: dict, thread_title: str | None) -> bool:
    """War / attack / disaster coverage gets games only on its institutional side (GAMES.md rule 7).
    The thread's title decides; an item with no thread is judged on its own title and summary."""
    if thread_title:
        return bool(INSTITUTIONAL.search(thread_title))
    return bool(INSTITUTIONAL.search(f"{it.get('title') or ''} {it.get('summary') or ''}"))


# ------------------------------------------------------------------ public-figure registry
US_STATES = dict(x.split(":") for x in """AL:Alabama AK:Alaska AZ:Arizona AR:Arkansas CA:California CO:Colorado CT:Connecticut DE:Delaware
FL:Florida GA:Georgia HI:Hawaii ID:Idaho IL:Illinois IN:Indiana IA:Iowa KS:Kansas KY:Kentucky LA:Louisiana ME:Maine MD:Maryland
MA:Massachusetts MI:Michigan MN:Minnesota MS:Mississippi MO:Missouri MT:Montana NE:Nebraska NV:Nevada NH:New_Hampshire NJ:New_Jersey
NM:New_Mexico NY:New_York NC:North_Carolina ND:North_Dakota OH:Ohio OK:Oklahoma OR:Oregon PA:Pennsylvania RI:Rhode_Island
SC:South_Carolina SD:South_Dakota TN:Tennessee TX:Texas UT:Utah VT:Vermont VA:Virginia WA:Washington WV:West_Virginia WI:Wisconsin
WY:Wyoming DC:District_of_Columbia PR:Puerto_Rico GU:Guam VI:Virgin_Islands AS:American_Samoa MP:Northern_Mariana_Islands""".split())
US_STATES = {k: v.replace("_", " ") for k, v in US_STATES.items()}
# Common short forms, so "Don Beyer" finds Donald S. Beyer, Jr. (accepted answers too).
NICK = {"donald": "don", "michael": "mike", "william": "bill", "robert": "bob", "richard": "rick", "james": "jim", "thomas": "tom",
        "charles": "chuck", "joseph": "joe", "christopher": "chris", "daniel": "dan", "edward": "ed", "stephen": "steve",
        "steven": "steve", "patrick": "pat", "timothy": "tim", "anthony": "tony", "kenneth": "ken", "gregory": "greg",
        "andrew": "andy", "nicholas": "nick", "jonathan": "jon", "benjamin": "ben", "matthew": "matt", "samuel": "sam",
        "elizabeth": "liz", "katherine": "kathy", "jennifer": "jen", "margaret": "maggie", "theodore": "ted", "gerald": "jerry"}
SUFFIX = re.compile(r",?\s+(Jr\.?|Sr\.?|II|III|IV)$", re.I)
LEVEL_RANK = {"local": 0, "state": 1, "national": 2, "world": 3}


def strip_suffix(name: str) -> str:
    return SUFFIX.sub("", (name or "").strip())


def _local_where(role: str) -> tuple[str, str] | None:
    r = role or ""
    if re.search(r"Beacon", r):
        return "local", "City of Beacon"
    if re.search(r"Dutchess|County Legislat|County Executive", r):
        return "local", "Dutchess County"
    if re.search(r"State Senat|Assembly|Governor|New York State|\bNYS\b", r):
        return "state", "New York State"
    return None


def load_registry(rosters: Path | None) -> dict:
    """name (folded) -> {name, role, party, aliases, kind, level, where}. Only public figures can be
    puzzle speakers. `party` is set only for members of Congress (congress-legislators); everyone
    else's is None, so the page never shows a party it can't source to the roster."""
    reg: dict[str, dict] = {}

    def add(name, role, party=None, aliases=(), kind="person", level=None, where=None, **extra):
        if not name:
            return
        key = fold(strip_suffix(name))
        cur = reg.setdefault(key, {"name": strip_suffix(name), "role": role, "party": None, "aliases": set(), "kind": kind,
                                   "level": level, "where": where})
        if kind == "legislator":                            # the roster wins over any hand list
            cur.update(kind=kind, role=role, party=party, level=level, where=where)
        cur["aliases"].update(fold(a) for a in aliases if a)
        if not cur.get("level") and level:
            cur.update(level=level, where=where)
        cur.update({k: v for k, v in extra.items() if v is not None})

    for p in (yaml.safe_load((ROOT / "watch_pool.yaml").read_text()) or {}).get("people", []):
        grp = p.get("group")
        lvl = {"beacon": "local", "dutchess": "local", "state": "state", "national": "national"}.get(grp, "world")
        add(p.get("name"), p.get("role"), level=lvl, where=p.get("place"))
    lp = yaml.safe_load((ROOT / "local_politics.yaml").read_text()) or {}
    for p in lp.get("players", []) or []:
        lw = _local_where(p.get("role")) or ("local", "Beacon area")
        add(p.get("name"), p.get("role"), level=lw[0], where=lw[1])
    for p in (yaml.safe_load((ROOT / "people.yaml").read_text()) or {}).get("people", []):
        if p.get("perspective") or p.get("byline"):        # named public commentators
            add(p.get("name"), p.get("role"), kind="commentator", level="national", where="U.S. media")
    wp = ROOT / "world.yaml"
    for c in ((yaml.safe_load(wp.read_text()) or {}).get("countries", []) if wp.exists() else []):
        if c.get("status") == "unverified":
            continue
        for k in ("head_of_government", "head_of_state", "prime_minister"):
            h = c.get(k) or {}
            if h.get("name"):
                add(h["name"], f"{h.get('title') or 'Leader'} of {'the ' if c['country'] in ('United States', 'United Kingdom', 'Netherlands', 'Philippines') else ''}{c['country']}", aliases=h.get("aliases", []),
                    kind="leader", level="national" if c["country"] == "United States" else "world", where=c["country"])
    if rosters and (rosters / "legislators-current.json").exists():
        for m in json.loads((rosters / "legislators-current.json").read_text()):
            term = (m.get("terms") or [{}])[-1]
            if term.get("end") and term["end"] < date.today().isoformat():
                continue                                   # README: people who left may linger
            n = m.get("name", {})
            full = n.get("official_full") or f"{n.get('first', '')} {n.get('last', '')}".strip()
            st = term.get("state")
            sen = term.get("type") == "sen"
            role = "U.S. Senator" if sen else "U.S. Representative"
            where = US_STATES.get(st, st) if sen else f"{US_STATES.get(st, st)}, district {term.get('district')}"
            first, last = n.get("first") or "", n.get("last") or ""
            als = [n.get("nickname") and f"{n.get('nickname')} {last}", f"{first} {last}",
                   NICK.get(first.lower()) and f"{NICK[first.lower()]} {last}"]
            add(full, role, term.get("party"), aliases=als, kind="legislator", level="state" if st == "NY" else "national", where=where,
                bioguide=m.get("id", {}).get("bioguide"), state=st, chamber="senate" if sen else "house", last=last)
    for v in reg.values():
        v["aliases"] = sorted(a for a in v["aliases"] if a and a != fold(v["name"]))
    return reg


# A quote's "by" often carries the office ("Interior Minister Laurent Nuñez", "District Judge Royce
# Lamberth"). An office in front of a name marks a public official, so the quote can be a puzzle;
# the office becomes the role hint. Fragments left by the extractor ("State Marco Rubio" from
# "Secretary of State Marco Rubio") are recovered from the item's own text.
TITLE = re.compile(r"^(?:(?!(?:State|Deputy|Former|Acting|Interior|Foreign|Defense|Finance|Prime|Vice|Chief|District|Federal|Senior|Majority|Minority|House|Senate|Council|City|County|Town|Assembly|White|Press)\b)(?P<place>[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?=(?:[A-Z][\w.]*\s+)*?(?:President|Prime Minister|Premier|Minister|Secretary|Mayor|Governor|Senator|Congress(?:man|woman)|Supervisor|Legislator|Executive|Assemblymember)\b))?"
                   r"(?P<title>(?:(?:U\.?S\.?|US|UN|State|Deputy|Former|Acting|Interior|Foreign|Defense|Finance|Prime|Vice|Chief|District|Federal|Senior|Majority|Minority|House|Senate|Council|City|County|Town|Assembly|White House|Press|FBI|CIA|Supreme Court|Appeals Court|Circuit)\s+)*"
                   r"(?:President|Prime Minister|Premier|Minister|Secretary|Director|Speaker|Judge|Justice|Attorney General|Mayor|Governor|Gov\.?|Senator|Sen\.?|Rep\.?|Representative|Congress(?:man|woman|member)|Ambassador|Envoy|Chair(?:man|woman)?|Commissioner|Council Members?|Councilmember|Leader|Spokes(?:person|man|woman)|Chancellor|King|Queen|Pope|General|Admiral|CEO|Lieutenant Governor|Comptroller|Assemblymember|Legislator|Supervisor|Superintendent|Executive))\s+"
                   r"(?P<name>[A-Z][\w’'.-]+(?:\s+[A-Z][\w’'.-]+){1,3})$")
FRAGMENT = re.compile(r"^(?P<frag>State|UN|U\.N\.|NATO|Ukraine|Russia|Israel|Treasury|Defense|Justice|Homeland Security)\s+(?P<name>[A-Z][\w’'.-]+(?:\s+[A-Z][\w’'.-]+){1,2})$")
OFFICE = (r"(?:President|Prime Minister|Premier|Minister|Secretary|Press Secretary|Director|Speaker|Judge|Justice|Attorney General|Mayor|Governor|"
          r"Senator|Representative|Congress(?:man|woman|member)|Ambassador|Envoy|Chair(?:man|woman)?|Commissioner|Council ?Member|Leader|"
          r"Chancellor|Comptroller|Assemblymember|Assembly ?member|Legislator|Supervisor|Superintendent|County Executive)")
# "White House press secretary Katie Zacharia said …": a bare name in the quote's "by", with the office
# right before it in the item's own text.
IN_TEXT = r"(?P<office>(?:(?:[A-Z][\w.]*|state|county|city|town|press|deputy|former)\s+){{0,3}}" + OFFICE + r")\s+{name}\b"
# "Ukrainian President …", "Alberta Premier …", "Wallkill Supervisor …": the word before the office
# says where. Demonyms map to the country for the "where" hint.
DEMONYM = {"Ukrainian": "Ukraine", "Russian": "Russia", "Israeli": "Israel", "French": "France", "German": "Germany", "British": "United Kingdom",
           "Canadian": "Canada", "Mexican": "Mexico", "Chinese": "China", "Japanese": "Japan", "Indian": "India", "Brazilian": "Brazil",
           "Albanian": "Albania", "Italian": "Italy", "Spanish": "Spain", "Polish": "Poland", "Turkish": "Turkey", "Iranian": "Iran",
           "Palestinian": "Palestine", "Australian": "Australia", "Venezuelan": "Venezuela", "Argentine": "Argentina", "Korean": "South Korea"}


def find_speaker(reg: dict, by: str, text: str = "") -> dict | None:
    by = re.sub(r"\s+", " ", by or "").strip()
    k = fold(strip_suffix(by))
    if k in reg:
        return reg[k]
    for v in reg.values():
        if k in v["aliases"]:
            return v
    m = TITLE.match(by)
    if m:
        name, title, place = strip_suffix(m.group("name")), m.group("title"), m.group("place")
        known = find_speaker(reg, name) if fold(name) != k else None
        if known:
            return known
        where = DEMONYM.get(place, place) if place else None
        lvl = "state" if where == "New York" else "world" if where in DEMONYM.values() else None
        title = re.sub(r"\bMembers\b", "Member", title)
        return {"name": name, "role": f"{place} {title}" if place and place not in DEMONYM else title, "party": None, "aliases": [],
                "kind": "official", "level": lvl, "where": where}
    if text and re.fullmatch(r"[A-Z][\w’'.-]+(?:\s+[A-Z][\w’'.-]+){1,2}", by):
        m = re.search(IN_TEXT.format(name=re.escape(by)), text, re.I)
        if m and not re.match(r"(former|ex-)", m.group("office"), re.I):
            office = re.sub(r"\s+", " ", m.group("office")).strip()
            office = office[0].upper() + office[1:]
            return {"name": strip_suffix(by), "role": office, "party": None, "aliases": [], "kind": "official", "level": None, "where": None}
    m = FRAGMENT.match(by)
    if m and text:
        name = m.group("name")
        full = re.search(rf"([A-Z][\w ]{{2,40}}?\b{re.escape(m.group('frag'))})\s+{re.escape(name)}", text)
        if full and TITLE.match(f"{full.group(1)} {name}") or (full and re.search(r"Secretary|Ambassador|Envoy|Minister", full.group(1))):
            return {"name": name, "role": full.group(1).strip(), "party": None, "aliases": [], "kind": "official"}
    return None


# ------------------------------------------------------------------ data access
def index(data: dict):
    items = {it["id"]: it for it in data.get("items", [])}
    threads = {t["id"]: t for t in data.get("threads", [])}
    story_of = {}
    for s in data.get("stories", []):
        for mid in s.get("members", []):
            story_of.setdefault(mid, s)
    return items, threads, story_of


def context_for(it: dict, story_of: dict, threads: dict) -> dict:
    s = story_of.get(it["id"]) or {}
    th = threads.get(s.get("thread")) or {}
    return {"story": s.get("id"), "thread": s.get("thread"), "thread_title": th.get("title"),
            "followed": bool(s.get("followed") or th.get("followed"))}


def mask(text: str, names: list[str]) -> str:
    out = text
    for n in names:
        for part in [n] + n.split():
            if len(part) > 2:
                out = re.sub(rf"\b{re.escape(part)}\b", "▒▒▒", out, flags=re.I)
    return re.sub(r"(▒▒▒\s*)+", "▒▒▒ ", out).strip()


# ------------------------------------------------------------------ Who said it
_COUNTRIES: list[str] = []


def countries() -> list[str]:
    if not _COUNTRIES:
        wp = ROOT / "world.yaml"
        _COUNTRIES.extend(sorted((c["country"] for c in ((yaml.safe_load(wp.read_text()) or {}).get("countries", []) if wp.exists() else [])
                                  if c.get("country") and c["country"] != "United States"), key=len, reverse=True))
    return _COUNTRIES


def initials(name: str) -> str:
    parts = [p for p in re.findall(r"[A-Za-zÀ-ÿ’'-]+", strip_suffix(name)) if len(p) > 1 or p.isupper()]
    if not parts:
        return ""
    return " ".join(p[0].upper() + "." for p in (parts[0], parts[-1]) if p) if len(parts) > 1 else parts[0][0].upper() + "."


def speaker_key(name: str) -> str:
    """A hash of the speaker, for "one quote per speaker per week" (hash log: hashes only)."""
    return "spk" + pid("speaker", fold(strip_suffix(name)))


def speaker_where(sp: dict, it: dict) -> tuple[str, str]:
    """(level, where) for the second hint and the local-first ordering."""
    if sp.get("level") and sp.get("where"):
        return sp["level"], sp["where"]
    scope = it.get("scope")
    text = f"{it.get('title', '')} {it.get('summary', '')}"
    if scope == "local":
        return sp.get("level") or "local", sp.get("where") or "Hudson Valley"
    if scope == "state":
        return sp.get("level") or "state", sp.get("where") or "New York State"
    if sp.get("where"):
        return sp.get("level") or ("world" if scope == "world" else "national"), sp["where"]
    if scope == "world":
        c = next((c for c in countries() if re.search(rf"\b{re.escape(c)}\b", text)), None)
        return "world", c or "outside the U.S."
    return "national", "United States"


def leaks(title: str, sp: dict) -> bool:
    """A context line that names the speaker (or their office) gives the answer away."""
    t = fold(title)
    names = [fold(sp["name"]), *sp.get("aliases", [])]
    parts = {w for n in names for w in n.split() if len(w) > 2}
    if any(re.search(rf"\b{re.escape(w)}\b", t) for w in parts):
        return True
    role = fold(sp.get("role") or "")
    return bool(role) and len(role) > 6 and role in t


def who_said_it(data, reg, now, drops, week_speakers=frozenset(), is_used=lambda _id: False) -> list[dict]:
    """One quote per speaker (and none from a speaker already offered earlier this ISO week),
    local, state and followed speakers ahead of national and world ones, newest first within that.
    Hints go role → where → initials; party is the roster's (members of Congress) or None."""
    c = CFG["who_said_it"]
    items, threads, story_of = index(data)
    cut = now - timedelta(days=c["window_days"])
    cands, seen = [], set()
    for it in data.get("items", []):
        t = parse_t(it.get("t") or it.get("published"))
        if not t or t < cut or not it.get("quotes"):
            continue
        ctx = context_for(it, story_of, threads)
        if institutional_only(it, ctx["thread_title"]):
            drops.append(("who_said_it", "institutional-only thread"))
            continue
        for q in it["quotes"]:
            text, by = (q.get("text") or "").strip(), (q.get("by") or "").strip()
            if not (c["min_chars"] <= len(text) <= c["max_chars"]) or not by:
                continue
            sp = find_speaker(reg, by, f"{it.get('title', '')} {it.get('summary', '')}")
            if not sp:
                drops.append(("who_said_it", "speaker not a known public figure"))
                continue
            why = blocked(it.get("title"), it.get("summary"), text, ctx["thread_title"])
            if why:
                drops.append(("who_said_it", why))
                continue
            if fold(sp["name"].split()[-1]) in fold(text):
                drops.append(("who_said_it", "quote names its speaker"))
                continue
            key = pid(fold(text), fold(sp["name"]))
            if key in seen:
                continue
            seen.add(key)
            level, where = speaker_where(sp, it)
            accept = sorted({fold(sp["name"]), fold(sp["name"].split()[-1]), *sp["aliases"]})
            title = it.get("title") or ""
            cands.append({
                "id": "w" + key, "quote": text, "answer": sp["name"], "accept": accept,
                "role": sp.get("role"), "party": sp.get("party") if sp.get("kind") == "legislator" else None,
                "level": level, "where": where, "speaker_key": speaker_key(sp["name"]),
                "context": None if leaks(title, sp) else title,
                "outlet": it.get("source"), "t": iso(t), "link": it.get("link"), "item": it["id"],
                **ctx, "hints": [sp.get("role") or "", where or "", initials(sp["name"])],
                "hint_labels": ["Role", "Where", "Initials"],
            })
    cands.sort(key=lambda x: x["t"], reverse=True)                       # newest first …
    cands.sort(key=lambda x: (not x["followed"], LEVEL_RANK.get(x["level"], 2)))   # … followed, then local/state first
    out, speakers = [], set()
    for q in cands:
        if is_used(q["id"]):
            drops.append(("who_said_it", "used in the last 90 days"))
            continue
        if q["speaker_key"] in week_speakers:
            drops.append(("who_said_it", "speaker already quoted this week"))
            continue
        if q["speaker_key"] in speakers:
            continue                                                        # one quote per speaker
        speakers.add(q["speaker_key"])
        out.append(q)
    return out[: c["pool_size"]]


def iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class QuoteBudget:
    """No single quote feeds more than two games (who said it, cryptoquote, Friday quiz, meta, keyed /
    Patristocrat). Quote ids are burned once published, so the cap holds across the week too."""

    def __init__(self, cap: int = 2):
        self.cap, self.uses = cap, {}

    def ok(self, qid: str, game: str) -> bool:
        u = self.uses.get(qid, set())
        return game in u or len(u) < self.cap

    def take(self, qid: str, game: str) -> bool:
        if not self.ok(qid, game):
            return False
        self.uses.setdefault(qid, set()).add(game)
        return True


# ------------------------------------------------------------------ Cryptoquote
WORDS: set[str] = set()


def load_words():
    for p in ("/usr/share/dict/words", "/usr/share/dict/american-english"):
        if Path(p).exists():
            WORDS.update(w.strip().lower() for w in Path(p).read_text(errors="ignore").split() if w.strip().isalpha())
            return


def pattern(w: str) -> str:
    seen = {}
    return ".".join(str(seen.setdefault(c, len(seen))) for c in w)


_PATTERNS: dict[str, set[str]] = {}


def pattern_unique_words(words: list[str]) -> int:
    """Words whose letter-repeat pattern fits only one dictionary word: each is a giveaway."""
    if not WORDS:
        return 0
    if not _PATTERNS:
        for w in WORDS:
            if 2 <= len(w) <= 12:
                _PATTERNS.setdefault(pattern(w), set()).add(w)
    return sum(1 for w in words if len(w) >= 4 and len(_PATTERNS.get(pattern(w), ())) == 1)


def derangement(rng: random.Random) -> dict[str, str]:
    """A substitution key in which no letter maps to itself (ACA rule)."""
    letters = list(string.ascii_uppercase)
    while True:
        perm = letters[:]
        rng.shuffle(perm)
        if all(a != b for a, b in zip(letters, perm)):
            return dict(zip(letters, perm))


def crypt_features(text: str) -> dict:
    words = [w for w in re.findall(r"[A-Za-z']+", text)]
    letters = [c for c in text.upper() if c.isalpha()]
    counts = {c: letters.count(c) for c in set(letters)}
    plain = [w.lower().strip("'") for w in words]
    return {
        "letters": len(letters),
        "short_words": sum(1 for w in plain if len(w) <= 2),
        "apostrophes": text.count("'") + text.count("’"),
        "doubles": sum(1 for w in plain if re.search(r"(.)\1", w)),
        "singletons": sum(1 for v in counts.values() if v == 1),
        "pattern_unique": pattern_unique_words(plain),
        "distinct": len(counts),
    }


def crypt_difficulty(f: dict) -> int:
    """1 easy … 3 hard. More footholds (short words, apostrophes, doubles, giveaway patterns) = easier;
    short texts and many letters used once = harder."""
    ease = f["short_words"] * 1.0 + f["apostrophes"] * 1.5 + f["doubles"] * 0.7 + f["pattern_unique"] * 1.2
    ease += max(0, f["letters"] - 70) / 25
    hard = f["singletons"] * 0.8 + max(0, 80 - f["letters"]) / 10
    score = ease - hard
    return 1 if score >= 6 else 2 if score >= 2 else 3


def cryptoquotes(wsi: list[dict], seed: str, drops, budget: QuoteBudget | None = None) -> list[dict]:
    c = CFG["cryptoquote"]
    out = []
    for q in wsi:
        if budget and not budget.ok(q["id"], "cryptoquote"):
            drops.append(("cryptoquote", "quote already feeds two games"))
            continue
        n = sum(ch.isalpha() for ch in q["quote"])
        if not (c["min_letters"] <= n <= c["max_letters"]):
            drops.append(("cryptoquote", f"length {n} letters outside {c['min_letters']}–{c['max_letters']}"))
            continue
        rng = random.Random(seed + q["id"])
        key = derangement(rng)
        plain = q["quote"].replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
        cipher = "".join(key.get(ch.upper(), ch) if ch.isalpha() else ch for ch in plain)
        f = crypt_features(plain)
        tier = crypt_difficulty(f)
        # Crib: the longest word that isn't a giveaway, with its position (a hint, not a second puzzle).
        words = [(m.start(), m.group(0)) for m in re.finditer(r"[A-Za-z]+", plain)]
        crib = max(words, key=lambda w: len(w[1]))
        out.append({"id": "c" + q["id"][1:], "source": q["id"], "cipher": cipher, "plain": plain.upper(),
                    "speaker": q["answer"], "role": q["role"], "outlet": q["outlet"], "t": q["t"], "link": q["link"],
                    "story": q["story"], "thread": q["thread"], "thread_title": q["thread_title"], "followed": q["followed"],
                    "tier": tier, "features": f, "crib": {"at": crib[0], "word": crib[1].upper()},
                    "given": next((p for p in sorted({ch for ch in plain.upper() if ch.isalpha()}, key=lambda ch: -plain.upper().count(ch))), None)})
        assert all(k != v for k, v in key.items())
    out.sort(key=lambda x: x["tier"])
    out = out[: c["pool_size"]]
    for x in out:
        if budget:
            budget.take(x["source"], "cryptoquote")
    return out


# ------------------------------------------------------------------ Weekend ciphers
# Keyed Aristocrat (Friday), K1: the plaintext alphabet is keyed (keyword first, then the rest of the
# alphabet), the ciphertext alphabet runs A–Z shifted. Solving recovers the keyed row, so the keyword
# appears as Joe fills the worksheet — a second "aha" that feeds the Saturday meta. No repeated letters
# in the keyword; no letter enciphers to itself. Patristocrat (Sunday): ~80 letters, spaces and
# punctuation removed, five-letter groups.
KEYWORDS = """SENATOR JUSTICE COUNTY MAYOR CAPITOL BUDGET DOCKET CHAMBER CLERK GAVEL VETO WARDS""".split()


def keyed_alphabet(word: str) -> str:
    seen = []
    for ch in word.upper() + string.ascii_uppercase:
        if ch.isalpha() and ch not in seen:
            seen.append(ch)
    return "".join(seen)


WEEK = {"day": None}


def week_keyword() -> str:
    """Friday's keyword is fixed for the whole week, so Saturday's meta can use it."""
    d = date.fromisoformat(WEEK["day"]) if WEEK["day"] else date.today()
    y, w, _ = d.isocalendar()
    words = [x for x in KEYWORDS if len(set(x)) == len(x)]
    return words[random.Random(f"kw-{y}-{w}").randrange(len(words))]


def k1_key(word: str, rng: random.Random) -> dict | None:
    plain = keyed_alphabet(word)
    for shift in rng.sample(range(1, 26), 25):
        cipher = string.ascii_uppercase[shift:] + string.ascii_uppercase[:shift]
        key = dict(zip(plain, cipher))
        if all(k != v for k, v in key.items()):
            return key
    return None


def weekend_ciphers(wsi: list[dict], seed: str, drops, budget: QuoteBudget | None = None, keyed: bool = True, patristocrat: bool = True) -> dict:
    """Friday's keyed Aristocrat and Sunday's Patristocrat, each built on its own day only (so the
    quote isn't spent on a day it can't be played). A null cipher carries its reason on the health row."""
    rng = random.Random(seed + "weekend")
    budget = budget or QuoteBudget()
    kw = week_keyword()
    out = {"keyed": None, "patristocrat": None}
    if keyed:
        # The quote must use every letter of the keyword, or the keyword can't fully appear in the worksheet.
        long_q = sorted([q for q in wsi if 70 <= sum(c.isalpha() for c in q["quote"]) <= 160 and set(kw) <= set(q["quote"].upper())
                         and budget.ok(q["id"], "keyed")], key=lambda q: -len(q["quote"]))
        if long_q:
            q = long_q[0]
            budget.take(q["id"], "keyed")
            key = k1_key(kw, rng)
            plain = q["quote"].replace("’", "'").upper()
            out["keyed"] = {"id": "kk" + q["id"][1:], "source": q["id"], "keyword": kw, "cipher": "".join(key.get(c, c) for c in plain), "plain": plain,
                            "speaker": q["answer"], "role": q.get("role"), "outlet": q.get("outlet"), "t": q.get("t"), "link": q.get("link"), "thread": q.get("thread"),
                            "inverse": {v: k for k, v in key.items()}}
            assert all(k != v for k, v in key.items())
        else:
            drops.append(("keyed", f"no quote of 70–160 letters uses every letter of {kw}"))
    if patristocrat:
        pat = [q for q in wsi if 70 <= sum(c.isalpha() for c in q["quote"]) <= 110 and budget.ok(q["id"], "patristocrat")
               and not (out["keyed"] and out["keyed"]["source"] == q["id"])]
        if pat:
            q = pat[0]
            budget.take(q["id"], "patristocrat")
            key = derangement(rng)
            letters = "".join(c for c in q["quote"].upper() if c.isalpha())
            cipher = "".join(key[c] for c in letters)
            groups = " ".join(cipher[i:i + 5] for i in range(0, len(cipher), 5))
            words_ = [(m.start(), m.group(0)) for m in re.finditer(r"[A-Za-z]+", q["quote"])]
            cw = max(words_, key=lambda w: len(w[1]))
            at = sum(c.isalpha() for c in q["quote"][:cw[0]])
            out["patristocrat"] = {"id": "pp" + q["id"][1:], "source": q["id"], "cipher": groups, "plain": letters, "speaker": q["answer"], "role": q.get("role"),
                                   "outlet": q.get("outlet"), "t": q.get("t"), "link": q.get("link"), "thread": q.get("thread"), "quote": q["quote"],
                                   "crib": {"word": cw[1].upper(), "at": at}}
        else:
            drops.append(("patristocrat", "no quote of 70–110 letters left this week"))
    return out


# ------------------------------------------------------------------ Saturday meta
# The answer is chosen first: a real Hudson Valley place name of 7–9 letters. One feeder per letter
# (so 7–9 feeders), each from the week's verified puzzles, drawn from several games (Friday's keyword,
# people quoted, members who broke ranks, opinion authors, the Beacon board that heard an item,
# officials in the news), never two feeders with the same answer; each gives one letter at a stated
# position, in order. Before it ships, every way of hiding a quarter of the feeders must still leave
# exactly one place in the whole place list that fits.
HV_PLACES = sorted(set("""BEACON GOSHEN CARMEL CROTON TIVOLI AMENIA PAWLING CHESTER WARWICK KINGSTON FISHKILL NEWBURGH GARRISON
CORNWALL HIGHLAND MARLBORO OSSINING BREWSTER HYDEPARK NEWPALTZ PATTERSON MAHOPAC MONTGOMERY WALDEN
MAYBROOK SHAWANGUNK ELLENVILLE CATSKILL HUDSON ATHENS COXSACKIE STANFORD MILLERTON PINEPLAINS
LAGRANGE UNIONVALE DOVER RHINEBECK REDHOOK CLINTON WASHINGTON KENT PUTNAM YORKTOWN PEEKSKILL
CORTLANDT NYACK HAVERSTRAW PIERMONT SUFFERN NEWWINDSOR WOODBURY MONROE FLORIDA""".split()))
META_CAP = {"keyed": 1, "who_said_it": 2, "defectors": 2, "docket": 2, "agenda": 2, "official": 2}


def all_places() -> list[str]:
    """Every place name the uniqueness check must rule out: the meta list plus the four counties'
    full municipality lists (spaces and hyphens dropped)."""
    return sorted(set(HV_PLACES) | {re.sub(r"[^A-Z]", "", p.upper()) for p in HV_COUNTY_OF})


def surname_key(name: str) -> str:
    """ "Alexandria Ocasio-Cortez" → OCASIOCORTEZ; suffixes dropped; accents folded."""
    last = strip_suffix(name).split()[-1] if strip_suffix(name).split() else ""
    return fold(last).replace(" ", "").upper()


def meta_feeders(wsi, dv, dk, budget, ba=(), lib=(), data=None) -> list[dict]:
    feeders = [{"clue": "Friday's keyword (it's in the keyed cipher's worksheet)", "answer": week_keyword(), "src": "keyed"}]
    for q in [x for x in wsi if budget.ok(x["id"], "meta")][:6]:
        feeders.append({"clue": f"Said this week: “{q['quote'][:120]}{'…' if len(q['quote']) > 120 else ''}” (surname)",
                        "answer": surname_key(q["answer"]), "src": "who_said_it", "link": q.get("link"), "qid": q["id"]})
    for d in list(dv)[:4]:
        for b in d["defectors"][:2]:
            feeders.append({"clue": f"Broke with the {'Republicans' if b['party'] == 'R' else 'Democrats'} on {d['bill'] or 'a House vote'} ({d['date']}), from {b['state']} (surname)",
                            "answer": fold(b["last"] or b["name"]).replace(" ", "").upper(), "src": "defectors", "link": d.get("link")})
    for k in list(dk)[:4]:
        if k.get("author") and k.get("author_code") not in ("PC", "D"):
            feeders.append({"clue": f"Wrote the Court's opinion in {k['name']} (surname)", "answer": surname_key(k["author"]), "src": "docket", "link": k.get("pdf")})
    for b in list(ba)[:6]:
        word = {"City Council": "COUNCIL", "Planning Board": "PLANNING", "Zoning Board of Appeals": "ZONING"}.get(b["answer"])
        if word:
            feeders.append({"clue": f"Which Beacon board had this on its agenda (COUNCIL, PLANNING or ZONING)? “{b['text'][:110]}”", "answer": word, "src": "agenda", "link": b.get("link")})
    week = fold(" ".join(f"{it.get('title', '')} {it.get('summary', '')}" for it in (data or {}).get("items", [])))
    for L in lib:
        if L.get("group") not in ("Beacon", "Dutchess", "New York") or L.get("kind") == "forms":
            continue
        for x in L["items"]:
            if x.get("clue") and fold(x["answer"]) in week:
                feeders.append({"clue": f"{L['title']}: {x['clue']} (surname)", "answer": surname_key(x["answer"]), "src": "official"})
    out, seen = [], set()
    for f in feeders:
        if f["answer"].isalpha() and len(f["answer"]) >= 4 and f["answer"] not in seen:
            seen.add(f["answer"])
            out.append(f)
    return out


def meta_unique(ans: str, places: list[str]) -> int:
    """How many feeders can be hidden (a quarter) with exactly one place still fitting, or 0."""
    need = len(ans)
    k_hide = max(1, need // 4)
    for hide in itertools.combinations(range(need), k_hide):
        pat = "".join("." if i in hide else ans[i] for i in range(need))
        if len([p for p in places if len(p) == need and re.fullmatch(pat, p)]) != 1:
            return 0
    return k_hide


def meta(wsi, dv, dk, seed, drops, budget: QuoteBudget | None = None, ba=(), lib=(), data=None) -> dict | None:
    rng = random.Random(seed + "meta")
    budget = budget or QuoteBudget()
    feeders = meta_feeders(wsi, dv, dk, budget, ba, lib, data)
    srcs = {f["src"] for f in feeders}
    if len(feeders) < 7 or len(srcs) < 3:
        drops.append(("meta", f"only {len(feeders)} distinct feeders from {len(srcs)} games this week (need 7 from 3)"))
        return None
    places = all_places()
    answers = [p for p in HV_PLACES if 7 <= len(p) <= 9]
    rng.shuffle(answers)
    for ans in answers:
        k_hide = meta_unique(ans, places)
        if not k_hide:
            continue
        for _ in range(30):                               # several tries at the letter-to-feeder assignment
            chosen, used, per = [], set(), {}
            ok = True
            for i, ch in enumerate(ans):
                cands = [j for j, f in enumerate(feeders) if j not in used and ch in f["answer"] and per.get(f["src"], 0) < META_CAP.get(f["src"], 2)]
                if i == 0 and any(feeders[j]["src"] == "keyed" for j in cands):
                    cands = [j for j in cands if feeders[j]["src"] == "keyed"]   # Friday's keyword leads when it can
                if not cands:
                    ok = False
                    break
                least = min(per.get(feeders[j]["src"], 0) for j in cands)          # spread across games
                j = rng.choice([j for j in cands if per.get(feeders[j]["src"], 0) == least])
                used.add(j)
                f = feeders[j]
                per[f["src"]] = per.get(f["src"], 0) + 1
                pos = [k for k, c in enumerate(f["answer"]) if c == ch]
                chosen.append(dict(f, index=rng.choice(pos) + 1))
            if ok and len(per) >= 3:
                break
        else:
            continue
        if not ok:
            continue
        for c in chosen:
            if c.get("qid"):
                budget.take(c["qid"], "meta")
        return {"id": "mt" + pid("meta", ans, *[c["answer"] for c in chosen]), "category": "a Hudson Valley place", "length": len(ans), "answer": ans,
                "feeders": [{"clue": c["clue"], "answer": c["answer"], "index": c["index"], "link": c.get("link"), "src": c["src"]} for c in chosen],
                "solvable_missing": k_hide}
    drops.append(("meta", "no place name could be built with a unique answer from this week's feeders"))
    return None


# ------------------------------------------------------------------ Case file (Sunday logic grid)
# Fictional applicants before a fictional board: who brought which project, and when was each heard.
# A random solution; a pool of true clues of every kind (direct facts, either/or, "of these two…",
# before/after with at most two ordering clues); clues added until exactly one solution remains
# (brute force over all 576 grids), then removed while it stays unique, so the set is minimal.
# Every case must tie people to projects and projects to times (not just two sorts), and a
# human-style solver must finish it without guessing; its hardest technique is the tier:
#   1 = direct clues, grid elimination (a row or column with one cell left) and cross-grid transfer
#       (A brought the bakery, the bakery was at 7:00, so A was at 7:00)
#   2 = reading either/or, "of these two" and before/after clues against what's still open
#   3 = a short chain: suppose a cell, follow tiers 1–2 to a contradiction, cross it out
# Nothing about spills or remediation (never resembles an Optima job).
CASE_PEOPLE = ["Abernathy", "Brennan", "Castillo", "Dunleavy", "Esposito", "Fairbanks", "Galloway", "Hollis"]
CASE_PROJECTS = ["bakery", "bike shop", "gallery", "recording studio", "bookshop", "climbing gym", "tea room", "print shop"]
CASE_TIMES = ["6:00", "6:30", "7:00", "7:30"]
CASE_N = 4
MAX_ORDER_CLUES = 2


def _row(ref, P, T):
    kind, v = ref
    return v if kind == "p" else P.index(v) if kind == "j" else T.index(v)


def _clue_true(c, P, T) -> bool:
    k = c["kind"]
    if k in ("pj", "pt", "jt"):
        a, b = c["cell"]
        hit = (P[a] == b) if k == "pj" else (T[a] == b) if k == "pt" else (T[P.index(a)] == b)
        return hit == c["yes"]
    r = [_row(x, P, T) for x in c["refs"]]
    if k == "order":
        return T[r[0]] < T[r[1]]
    if k == "adjacent":
        return T[r[0]] + 1 == T[r[1]]
    if k == "either":                       # refs: Z, X1, X2 — Z is X1 or X2, and X1, X2 are different rows
        return r[1] != r[2] and r[0] in (r[1], r[2])
    if k == "pair":                         # refs: X, Y, F1, F2 — {X, Y} == {F1, F2}, X≠Y, F1≠F2
        return r[0] != r[1] and r[2] != r[3] and {r[0], r[1]} == {r[2], r[3]}
    raise ValueError(k)


def _all_solutions(clues, limit=2):
    out = []
    for P in itertools.permutations(range(CASE_N)):
        for T in itertools.permutations(range(CASE_N)):
            if all(_clue_true(c, P, T) for c in clues):
                out.append((P, T))
                if len(out) >= limit:
                    return out
    return out


class _Contradiction(Exception):
    pass


class CaseSolver:
    """Three grids, each cell None (open), True (●) or False (✗): PJ person×project, PT person×time,
    JT project×time. Deductions carry the tier of the technique that made them."""

    def __init__(self, clues):
        n = CASE_N
        self.g = {"PJ": [[None] * n for _ in range(n)], "PT": [[None] * n for _ in range(n)], "JT": [[None] * n for _ in range(n)]}
        self.clues = clues
        self.tier = 0
        self.steps = []

    def copy(self):
        s = CaseSolver(self.clues)
        s.g = {k: [r[:] for r in v] for k, v in self.g.items()}
        return s

    def set(self, grid, a, b, val, tier, why):
        cur = self.g[grid][a][b]
        if cur is val:
            return False
        if cur is not None:
            raise _Contradiction(why)
        self.g[grid][a][b] = val
        self.tier = max(self.tier, tier)
        self.steps.append((grid, a, b, val, tier, why))
        return True

    def solved(self):
        return all(v is not None for G in self.g.values() for r in G for v in r)

    # tier 1 -------------------------------------------------------------
    def direct(self):
        ch = False
        for c in self.clues:
            if c["kind"] in ("pj", "pt", "jt"):
                ch |= self.set(c["kind"].upper(), *c["cell"], c["yes"], 1, c.get("t", c["kind"]))
        return ch

    def eliminate(self):
        ch = False
        n = CASE_N
        for name, G in self.g.items():
            for a in range(n):
                for line, put in ((G[a], lambda b, v, a=a: self.set(name, a, b, v, 1, "only one left in the row")),
                                  ([G[x][a] for x in range(n)], lambda b, v, a=a: self.set(name, b, a, v, 1, "only one left in the column"))):
                    if line.count(True) > 1 or line.count(False) == n:
                        raise _Contradiction("line")
                    if True in line:
                        for b in range(n):
                            if line[b] is None:
                                ch |= put(b, False)
                    elif line.count(False) == n - 1:
                        ch |= put(line.index(None), True)
        return ch

    # tier 2 -------------------------------------------------------------
    def cross(self):
        ch = False
        PJ, PT, JT = self.g["PJ"], self.g["PT"], self.g["JT"]
        n = CASE_N
        for i in range(n):
            for j in range(n):
                for k in range(n):
                    a, b, c = PJ[i][j], PT[i][k], JT[j][k]
                    if a and b:
                        ch |= self.set("JT", j, k, True, 1, "cross-grid")
                    if a and c:
                        ch |= self.set("PT", i, k, True, 1, "cross-grid")
                    if b and c:
                        ch |= self.set("PJ", i, j, True, 1, "cross-grid")
                    if a and b is False:
                        ch |= self.set("JT", j, k, False, 1, "cross-grid")
                    if a and c is False:
                        ch |= self.set("PT", i, k, False, 1, "cross-grid")
                    if b and a is False:
                        ch |= self.set("JT", j, k, False, 1, "cross-grid")
                    if b and c is False:
                        ch |= self.set("PJ", i, j, False, 1, "cross-grid")
                    if c and a is False:
                        ch |= self.set("PT", i, k, False, 1, "cross-grid")
                    if c and b is False:
                        ch |= self.set("PJ", i, j, False, 1, "cross-grid")
        return ch

    def relative(self):
        """Read each either/or, pair and order clue against what's still open (arc consistency)."""
        ch = False
        PJ, PT, JT = self.g["PJ"], self.g["PT"], self.g["JT"]
        n = CASE_N
        for c in self.clues:
            if c["kind"] in ("pj", "pt", "jt"):
                continue
            refs = c["refs"]
            cand = []
            for kind, v in refs:
                cand.append([v] if kind == "p" else [i for i in range(n) if PJ[i][v] is not False] if kind == "j" else [i for i in range(n) if PT[i][v] is not False])
            timed = c["kind"] in ("order", "adjacent")
            sup_row = [set() for _ in refs]
            sup_time = [set() for _ in refs]
            for rows in itertools.product(*cand):
                ok = True
                fixed = {}
                for (kind, v), r in zip(refs, rows):
                    f = fixed.setdefault(r, {})
                    if kind in ("j", "t"):
                        if kind in f and f[kind] != v:
                            ok = False
                            break
                        f[kind] = v
                for r, f in fixed.items():
                    if "j" in f and PJ[r][f["j"]] is False or "t" in f and PT[r][f["t"]] is False or ("j" in f and "t" in f and JT[f["j"]][f["t"]] is False):
                        ok = False
                if not ok:
                    continue
                if c["kind"] == "either" and not (rows[1] != rows[2] and rows[0] in (rows[1], rows[2])):
                    continue
                if c["kind"] == "pair" and not (rows[0] != rows[1] and rows[2] != rows[3] and {rows[0], rows[1]} == {rows[2], rows[3]}):
                    continue
                if not timed:
                    for x, r in enumerate(rows):
                        sup_row[x].add(r)
                    continue
                distinct = sorted(fixed)
                tc = []
                for r in distinct:
                    f = fixed[r]
                    ks = [f["t"]] if "t" in f else [k for k in range(n) if PT[r][k] is not False and ("j" not in f or JT[f["j"]][k] is not False)]
                    tc.append(ks)
                for ts in itertools.product(*tc):
                    if len(set(ts)) != len(ts):
                        continue
                    tm = dict(zip(distinct, ts))
                    t0, t1 = tm[rows[0]], tm[rows[1]]
                    if (c["kind"] == "order" and t0 < t1) or (c["kind"] == "adjacent" and t0 + 1 == t1):
                        for x, r in enumerate(rows):
                            sup_row[x].add(r)
                            sup_time[x].add(tm[r])
            for x, (kind, v) in enumerate(refs):
                if not sup_row[x]:
                    raise _Contradiction(c["kind"])
                if kind == "j":
                    for i in cand[x]:
                        if i not in sup_row[x]:
                            ch |= self.set("PJ", i, v, False, 2, c.get("t", c["kind"]))
                if kind == "t":
                    for i in cand[x]:
                        if i not in sup_row[x]:
                            ch |= self.set("PT", i, v, False, 2, c.get("t", c["kind"]))
                if timed and kind == "p":
                    for k in range(n):
                        if PT[v][k] is None and k not in sup_time[x]:
                            ch |= self.set("PT", v, k, False, 2, c.get("t", c["kind"]))
                if timed and kind == "j":
                    for k in range(n):
                        if JT[v][k] is None and k not in sup_time[x]:
                            ch |= self.set("JT", v, k, False, 2, c.get("t", c["kind"]))
        return ch

    def propagate(self, max_tier):
        while True:
            if self.direct() or self.eliminate():
                continue
            if self.cross():
                continue
            if max_tier >= 2 and self.relative():
                continue
            return

    # tier 3 -------------------------------------------------------------
    def chain(self):
        for name, G in self.g.items():
            for a in range(CASE_N):
                for b in range(CASE_N):
                    if G[a][b] is None:
                        trial = self.copy()
                        try:
                            trial.set(name, a, b, True, 0, "suppose")
                            trial.propagate(2)
                        except _Contradiction:
                            self.set(name, a, b, False, 3, "supposing it leads to a contradiction")
                            return True
        return False

    def solve(self):
        try:
            while True:
                self.propagate(2)
                if self.solved():
                    return True
                if not self.chain():
                    return False
        except _Contradiction:
            return False


def _case_pool(P, T, rng):
    n = CASE_N
    pool = []
    for i in range(n):
        for j in range(n):
            pool.append({"kind": "pj", "cell": (i, j), "yes": P[i] == j})
            pool.append({"kind": "pt", "cell": (i, j), "yes": T[i] == j})
            pool.append({"kind": "jt", "cell": (i, j), "yes": T[P.index(i)] == j})
    ents = [("p", i) for i in range(n)] + [("j", j) for j in range(n)]
    for X in ents:
        for Y in ents:
            rx, ry = _row(X, P, T), _row(Y, P, T)
            if rx == ry or X[0] == Y[0] == "j" and False:
                continue
            if T[rx] < T[ry]:
                pool.append({"kind": "order", "refs": (X, Y)})
            if T[rx] + 1 == T[ry]:
                pool.append({"kind": "adjacent", "refs": (X, Y)})
    allrefs = [("p", i) for i in range(n)] + [("j", j) for j in range(n)] + [("t", k) for k in range(n)]
    for _ in range(40):
        Z = rng.choice(allrefs)
        rz = _row(Z, P, T)
        others = [r for r in allrefs if r[0] != Z[0]]
        X1 = rng.choice([r for r in others if _row(r, P, T) == rz])
        X2 = rng.choice([r for r in others if _row(r, P, T) != rz and r[0] != X1[0] or (_row(r, P, T) != rz and Z[0] != "p")])
        refs = (Z,) + tuple(rng.sample([X1, X2], 2))
        c = {"kind": "either", "refs": refs}
        if _clue_true(c, P, T) and not (Z[0] != "p" and X1[0] == X2[0] == "p" and False):
            pool.append(c)
    for _ in range(40):
        r1, r2 = rng.sample(range(n), 2)
        kx, ky = rng.choice(["p", "t", "j"]), rng.choice(["p", "t", "j"])
        fk = rng.choice([k for k in ("p", "j", "t") if k not in (kx, ky)] or ["j"])
        val = lambda kind, r: r if kind == "p" else P[r] if kind == "j" else T[r]
        X, Y = (kx, val(kx, r1)), (ky, val(ky, r2))
        F1, F2 = (fk, val(fk, r2)), (fk, val(fk, r1))
        c = {"kind": "pair", "refs": (X, Y) + tuple(rng.sample([F1, F2], 2))}
        if _clue_true(c, P, T):
            pool.append(c)
    uniq, seen = [], set()
    for c in pool:
        sig = (c["kind"], c.get("cell"), c.get("yes"), c.get("refs"))
        if sig not in seen:
            seen.add(sig)
            uniq.append(c)
    return uniq


def _case_text(c, people, projects, times):
    def noun(r, cap=False):
        k, v = r
        s = people[v] if k == "p" else f"the {projects[v]} applicant" if k == "j" else f"the {times[v]} applicant"
        return s[0].upper() + s[1:] if cap else s

    def pred(r):
        k, v = r
        return f"is {people[v]}" if k == "p" else f"brought the {projects[v]}" if k == "j" else f"was heard at {times[v]}"

    k = c["kind"]
    if k == "pj":
        i, j = c["cell"]
        return f"{people[i]} brought the {projects[j]}." if c["yes"] else f"{people[i]} didn't bring the {projects[j]}."
    if k == "pt":
        i, j = c["cell"]
        return f"{people[i]} was heard at {times[j]}." if c["yes"] else f"{people[i]} wasn't heard at {times[j]}."
    if k == "jt":
        i, j = c["cell"]
        return f"The {projects[i]} was heard at {times[j]}." if c["yes"] else f"The {projects[i]} wasn't heard at {times[j]}."
    if k == "order":
        return f"{noun(c['refs'][0], True)} was heard before {noun(c['refs'][1])}."
    if k == "adjacent":
        return f"{noun(c['refs'][0], True)} was heard exactly half an hour before {noun(c['refs'][1])}."
    if k == "either":
        Z, X1, X2 = c["refs"]
        if X1[0] == X2[0] == "p" and Z[0] == "j":
            return f"The {projects[Z[1]]} was either {people[X1[1]]}'s or {people[X2[1]]}'s."
        if Z[0] == "p":
            return f"{people[Z[1]]} either {pred(X1)[0:]} or {pred(X2)}."
        return f"{noun(Z, True)} was either {noun(X1)} or {noun(X2)}."
    if k == "pair":
        X, Y, F1, F2 = c["refs"]
        return f"Of {noun(X)} and {noun(Y)}, one {pred(F1)} and the other {pred(F2)}."
    raise ValueError(k)


def _case_links(clues) -> tuple[bool, bool]:
    """(ties people to projects, ties projects to times) somewhere in the clue set."""
    pj = jt = False
    for c in clues:
        if c["kind"] == "pj":
            pj = True
        elif c["kind"] == "jt":
            jt = True
        elif c["kind"] in ("either", "pair"):
            kinds = {r[0] for r in c["refs"]}
            pj |= {"p", "j"} <= kinds
            jt |= {"j", "t"} <= kinds
        elif c["kind"] in ("order", "adjacent"):
            jt |= any(r[0] == "j" for r in c["refs"])
            pj |= {r[0] for r in c["refs"]} == {"p", "j"}
    return pj, jt


def case_grade(clues, P=None, T=None) -> tuple[int | None, list]:
    """The solver's hardest technique, or None if it can't finish without guessing (or, given the
    true answer, if it ever reached a wrong one: the solver must be sound)."""
    s = CaseSolver(clues)
    if not s.solve():
        return None, s.steps
    if P is not None:
        n = CASE_N
        if any(s.g["PJ"][i][P[i]] is not True or s.g["PT"][i][T[i]] is not True for i in range(n)):
            return None, s.steps
    return s.tier, s.steps


def _case_once(rng, target):
    n = CASE_N
    P = list(range(n)); rng.shuffle(P)
    T = list(range(n)); rng.shuffle(T)
    pool = _case_pool(P, T, rng)
    rng.shuffle(pool)
    # Easy days lean on direct facts; hard days on either/or, pairs and negatives.
    pri = {1: {"pj": 0, "pt": 0, "jt": 0, "either": 1, "pair": 2, "order": 1, "adjacent": 2},
           2: {"either": 0, "order": 0.5, "jt": 0.5, "pj": 1, "pt": 1, "adjacent": 1, "pair": 1.5},
           3: {"pair": 0, "either": 0.3, "adjacent": 0.8, "order": 0.8, "jt": 1.5, "pj": 1.5, "pt": 1.5}}[target]
    pool.sort(key=lambda c: pri[c["kind"]] + (1.0 if c.get("yes") and target > 1 else 0) + 2.2 * rng.random())
    clues, orders = [], 0
    for c in pool:
        if c["kind"] in ("order", "adjacent"):
            if orders >= MAX_ORDER_CLUES:
                continue
            orders += 1
        clues.append(c)
        if len(clues) >= 4 and len(_all_solutions(clues)) == 1:
            break
    if len(_all_solutions(clues)) != 1:
        return None
    for c in list(clues):                              # minimal: drop any clue that isn't needed
        trial = [x for x in clues if x is not c]
        if len(_all_solutions(trial)) == 1:
            clues = trial
    if not all(_case_links(clues)):
        return None
    tier, steps = case_grade(clues, P, T)
    if tier is None:
        return None                                    # needs more than a short chain: never ship a guess
    return P, T, clues, tier, steps


def case_target(day: str | None) -> int:
    """Monthly ramp (GAMES.md rule 5): week 1 easiest, week 4 hardest."""
    if not day:
        return 2
    w = (date.fromisoformat(day).day - 1) // 7
    return [1, 2, 2, 3, 3][w]


def casefile(seed, drops, target: int | None = None, tries: int = 60) -> dict | None:
    rng = random.Random(seed + "case")
    target = target or 2
    best = None
    for _ in range(tries):
        got = _case_once(rng, target)
        if not got:
            continue
        if best is None or abs(got[3] - target) < abs(best[3] - target):
            best = got
        if got[3] == target:
            break
    if not best:
        drops.append(("casefile", "no clue set pinned down one solution a person could reach without guessing"))
        return None
    P, T, clues, tier, steps = best
    n = CASE_N
    people = rng.sample(CASE_PEOPLE, n)
    projects = rng.sample(CASE_PROJECTS, n)
    times = CASE_TIMES[:n]
    for c in clues:
        c["t"] = _case_text(c, people, projects, times)
    tier, steps = case_grade(clues, P, T)                 # again, so the trace quotes the clues
    texts = [c["t"] for c in clues]
    rng.shuffle(texts)
    sol = {people[i]: {"project": projects[P[i]], "time": times[T[i]]} for i in range(n)}
    gname = {"PJ": ("person", "project"), "PT": ("person", "time"), "JT": ("project", "time")}
    label = {"person": people, "project": projects, "time": times}
    trace = [{"grid": g, "a": label[gname[g][0]][a], "b": label[gname[g][1]][b], "mark": "o" if v else "x", "tier": t, "why": w}
             for g, a, b, v, t, w in steps if v]
    return {"id": "cf" + pid("case", *sorted(texts), *sorted(f"{k}:{v['project']}:{v['time']}" for k, v in sol.items())),
            "people": people, "projects": projects, "times": times, "clues": texts, "tier": tier, "target": target,
            "solution": sol, "project_times": {projects[P[i]]: times[T[i]] for i in range(n)}, "trace": trace,
            "kinds": sorted({c["kind"] for c in clues}),
            "story": "Four applicants came before a fictional town board one evening. Who brought which project, and when was each heard? "
                     "In \"either … or\" and \"of these two\" clues, the two named are different applicants."}


# ------------------------------------------------------------------ Connections (shadow mode)
# Sixteen items from the week's news, of mixed types: members of Congress, Beacon and Dutchess
# officials, Supreme Court justices, world leaders, countries, Hudson Valley places and government
# agencies. Groups come only from complete sources (the congress roster, local_politics.yaml, the
# Court's bench, world.yaml, the county municipality lists below, the agency list below) plus one
# purple wordplay test run against every item (names with a suffix like "Jr." are tested without
# it). No committee-roster trivia. Uniqueness: every predicate that 4+ of the 16 satisfy is a
# candidate group; the board ships only if exactly one way exists to split the 16 into four of
# them, and only with a near-miss decoy: a real category that 3+ board items fit, drawn from at
# least two of the answer groups.
SCOTUS_APPOINTED = {"John Roberts": "George W. Bush", "Clarence Thomas": "George H. W. Bush", "Samuel Alito": "George W. Bush",
                    "Sonia Sotomayor": "Barack Obama", "Elena Kagan": "Barack Obama", "Neil Gorsuch": "Donald Trump",
                    "Brett Kavanaugh": "Donald Trump", "Amy Coney Barrett": "Donald Trump", "Ketanji Brown Jackson": "Joe Biden"}
# Cities, towns and villages by county (complete for these four counties; New York State's list of
# municipalities). A name that is both a town and a village (Fishkill) is one item.
HV_COUNTIES = {
    "Dutchess": """Beacon Poughkeepsie Amenia Beekman Clinton Dover East_Fishkill Fishkill Hyde_Park LaGrange Milan North_East Pawling
                   Pine_Plains Pleasant_Valley Red_Hook Rhinebeck Stanford Union_Vale Wappinger Washington Millbrook Millerton Tivoli
                   Wappingers_Falls""",
    "Putnam": "Carmel Kent Patterson Philipstown Putnam_Valley Southeast Brewster Cold_Spring Nelsonville",
    "Orange": """Middletown Newburgh Port_Jervis Blooming_Grove Chester Cornwall Crawford Deerpark Goshen Greenville Hamptonburgh
                 Highlands Minisink Monroe Montgomery Mount_Hope New_Windsor Palm_Tree Tuxedo Wallkill Warwick Wawayanda Woodbury
                 Cornwall-on-Hudson Florida Greenwood_Lake Harriman Highland_Falls Kiryas_Joel Maybrook Tuxedo_Park Unionville Walden
                 Washingtonville""",
    "Ulster": """Kingston Denning Esopus Gardiner Hardenburgh Hurley Lloyd Marbletown Marlborough New_Paltz Olive Plattekill Rochester
                 Rosendale Saugerties Shandaken Shawangunk Ulster Wawarsing Woodstock Ellenville""",
}
HV_COUNTY_OF = {p.replace("_", " "): c for c, ps in HV_COUNTIES.items() for p in ps.split()}
# Names that usually mean somewhere else (or something else) in the news: never board items.
HV_AMBIGUOUS = set("""Rochester Washington Florida Clinton Dover Milan Monroe Montgomery Greenville Highlands Lloyd Olive Kent Southeast
Ulster Crawford Stanford Chester Hurley Unionville Woodbury Denning Deerpark""".split())
AGENCIES = {"federal": "EPA FBI CIA CDC FDA FEMA IRS NASA ICE FAA SEC FTC FCC NIH NSA ATF DEA TSA NOAA NTSB OSHA USPS".split(),
            "state": "DEC MTA DMV SUNY OCFS DOCCS NYSERDA PSC".split()}
AGENCY_PARENT = {"FBI": "Justice", "ATF": "Justice", "DEA": "Justice", "CDC": "Health and Human Services", "FDA": "Health and Human Services",
                 "NIH": "Health and Human Services", "FEMA": "Homeland Security", "ICE": "Homeland Security", "TSA": "Homeland Security",
                 "IRS": "the Treasury", "FAA": "Transportation", "NSA": "Defense", "NOAA": "Commerce", "OSHA": "Labor"}
# Membership lists (stable, complete): a second fact about each country, so near misses exist.
BLOCS = {"G7": "Canada France Germany Italy Japan United_Kingdom",
         "NATO": """Albania Belgium Bulgaria Canada Croatia Czechia Denmark Estonia Finland France Germany Greece Hungary Iceland Italy Latvia
                    Lithuania Luxembourg Montenegro Netherlands North_Macedonia Norway Poland Portugal Romania Slovakia Slovenia Spain Sweden
                    Turkey United_Kingdom""",
         "EU": """Austria Belgium Bulgaria Croatia Cyprus Czechia Denmark Estonia Finland France Germany Greece Hungary Ireland Italy Latvia
                  Lithuania Luxembourg Malta Netherlands Poland Portugal Romania Slovakia Slovenia Spain Sweden"""}
BLOC_NAME = {"G7": "G7 members", "NATO": "NATO members", "EU": "European Union members"}
FORM_PLURAL = {"Presidential republic": "Presidential republics", "Semi-presidential republic": "Semi-presidential republics",
               "Parliamentary republic": "Parliamentary republics", "Parliamentary constitutional monarchy": "Constitutional monarchies with a parliament",
               "Absolute monarchy": "Absolute monarchies", "One-party state": "One-party states", "Theocratic republic": "Theocratic republics",
               "Directorial republic": "Directorial republics", "Military-led government": "Military-led governments"}


def _letters(label: str) -> list[str]:
    return [w for w in re.findall(r"[A-Za-z]+", strip_suffix(label)) if len(w) > 1]


def alliterative(label: str) -> bool:
    p = _letters(label)
    return len(p) >= 2 and p[0][0].lower() == p[-1][0].lower()


def surname_is_word(label: str) -> bool:
    p = _letters(label)
    last = p[-1].lower() if len(p) >= 2 else ""
    return bool(WORDS) and len(last) >= 4 and last in WORDS


def same_ends(label: str) -> bool:
    w = "".join(_letters(label)).lower()
    return len(w) >= 5 and w[0] == w[-1]


WORDPLAY = {
    "alliterative": ("First and last names start with the same letter", alliterative),
    "surname_word": ("Surname is also an ordinary English word", surname_is_word),
    "same_ends": ("Begins and ends with the same letter", same_ends),
}


def connections_universe(data, reg, rosters: Path | None, now) -> tuple[dict, dict]:
    """label -> set of predicate ids, and predicate id -> (category name, kind). Only items in the news.
    kind: fact (can be an answer group), wordplay (purple), decoy (near-miss only, never an answer)."""
    cut = now - timedelta(days=CFG["connections"]["window_days"])
    news = [it for it in data.get("items", []) if (parse_t(it.get("t")) or now) >= cut and not blocked(it.get("title"), it.get("summary"))]
    raw = " \n ".join(f"{it.get('title', '')} {it.get('summary', '')}" for it in news)
    rawlocal = " \n ".join(f"{it.get('title', '')} {it.get('summary', '')}" for it in news if it.get("scope") == "local")
    ftext = f" {fold(raw)} "
    inn = lambda name: f" {fold(name)} " in ftext
    preds: dict[str, tuple[str, str]] = {}
    uni: dict[str, set] = {}
    kind_of: dict[str, str] = {}

    def put(label, ps, kind):
        label = strip_suffix(label)
        uni.setdefault(label, set()).update(ps)
        kind_of.setdefault(label, kind)

    # Members of Congress in the news: chamber and state (the roster).
    by_alias = {}
    for v in reg.values():
        if v.get("kind") != "legislator":
            continue
        for a in [fold(v["name"]), *v.get("aliases", [])]:
            by_alias[a] = v
        if inn(v["name"]) or any(len(a.split()) >= 2 and inn(a) for a in v.get("aliases", [])):
            put(v["name"], {f"chamber:{v['chamber']}", f"state:{v['state']}"}, "person")
            preds[f"state:{v['state']}"] = (f"Represent {US_STATES.get(v['state'], v['state'])} in Congress", "fact")
    preds["chamber:senate"] = ("Sitting U.S. senators", "fact")
    preds["chamber:house"] = ("Sitting U.S. representatives", "fact")
    # Beacon and Dutchess officials (local_politics.yaml).
    lp = (yaml.safe_load((ROOT / "local_politics.yaml").read_text()) or {}).get("officials", {})
    cb, dc = lp.get("city_of_beacon", {}), lp.get("dutchess_county", {})
    lists = {
        "local:beacon_council": ("Beacon's mayor and City Council", [cb.get("mayor", {})] + list(cb.get("council", []) or [])),
        "local:reps_beacon": ("Represent Beacon in Congress or Albany", lp.get("state_and_federal_for_beacon", []) or []),
        "local:dutchess_leg": ("Dutchess County legislators", list(dc.get("legislators_for_beacon", []) or []) + list(dc.get("legislature_leaders", []) or [])),
        "local:dutchess_wide": ("Elected countywide in Dutchess", dc.get("countywide", []) or []),
    }
    for pidk, (name, people) in lists.items():
        preds[pidk] = (name, "fact")
        for p in people:
            nm = (p or {}).get("name")
            if not nm or not inn(nm):
                continue
            leg = by_alias.get(fold(strip_suffix(nm)))
            put(leg["name"] if leg else nm, {pidk}, "person")
    # The Supreme Court (its bench), with who appointed each as a near-miss decoy.
    preds["court:scotus"] = ("Supreme Court justices", "fact")
    for j, by in SCOTUS_APPOINTED.items():
        last = j.split()[-1]
        if inn(j) or re.search(rf"\bJustice {re.escape(last)}\b", raw):
            put(j, {"court:scotus", f"appointed:{by}"}, "person")
            preds[f"appointed:{by}"] = (f"Appointed to the Court by {by}", "decoy")
    # World leaders and countries (world.yaml): head of government vs head of state, forms of government.
    wp = ROOT / "world.yaml"
    for c in ((yaml.safe_load(wp.read_text()) or {}).get("countries", []) if wp.exists() else []):
        if c.get("status") == "unverified":
            continue
        g, h = c.get("head_of_government") or {}, c.get("head_of_state") or {}
        for who, role in ((g.get("name"), "hog"), (h.get("name"), "hos")):
            if who and len(who.split()) >= 2 and inn(who) and not by_alias.get(fold(who)):
                put(who, {f"leader:{role}"}, "person")
        if c.get("form") in FORM_PLURAL and c["country"] != "United States" and re.search(rf"\b{re.escape(c['country'])}\b", raw):
            blocs = {f"bloc:{b}" for b, ms in BLOCS.items() if c["country"].replace(" ", "_") in ms.split()}
            put(c["country"], {f"form:{c['form']}"} | blocs, "country")
            preds[f"form:{c['form']}"] = (FORM_PLURAL[c["form"]], "fact")
            for b in blocs:
                preds[b] = (BLOC_NAME[b.split(":")[1]], "fact")
    preds["leader:hog"] = ("Lead their country's government", "fact")
    preds["leader:hos"] = ("Heads of state", "fact")
    # Hudson Valley places in local and state stories, by county.
    for place, county in HV_COUNTY_OF.items():
        if place in HV_AMBIGUOUS:
            continue
        if re.search(rf"\b{re.escape(place)}\b(?!\s+(County|Avenue|Street|Road|St\.|Ave\.))", rawlocal):
            put(place, {f"county:{county}"}, "place")
            preds[f"county:{county}"] = (f"Cities, towns and villages in {county} County", "fact")
    # Agencies by acronym (federal vs New York State).
    for lvl, names in AGENCIES.items():
        for a in names:
            if re.search(rf"\b{a}\b", raw):
                put(a, {f"agency:{lvl}"} | ({f"dept:{AGENCY_PARENT[a]}"} if a in AGENCY_PARENT else set()), "agency")
                if a in AGENCY_PARENT:
                    preds[f"dept:{AGENCY_PARENT[a]}"] = (f"Part of the Department of {AGENCY_PARENT[a]}", "fact")
                preds[f"agency:{lvl}"] = ("Federal agencies" if lvl == "federal" else "New York State agencies", "fact")
    # Purple: one clean trick, run against every item.
    for label in uni:
        uni[label] |= {f"wp:{k}" for k, (_, fn) in WORDPLAY.items() if fn(label)}
    for k, (name, _) in WORDPLAY.items():
        preds[f"wp:{k}"] = (name, "wordplay")
    uni = {k: v for k, v in uni.items() if any(not p.startswith("wp:") for p in v)}
    connections_universe.kinds = kind_of
    return uni, preds


connections_universe.kinds = {}


def partitions(board: list[str], uni: dict, preds: dict) -> list[tuple]:
    """Every way to split the 16 into four groups of four, each group fully inside one answerable predicate."""
    cand = {}
    for p, (name, kind) in preds.items():
        if kind == "decoy":
            continue
        members = [x for x in board if p in uni[x]]
        if len(members) >= 4:
            for combo in itertools.combinations(members, 4):
                cand.setdefault(frozenset(combo), p)
    groups = list(cand.items())
    out = []
    first = board[0]

    def rec(left: frozenset, chosen: list):
        if not left:
            out.append(tuple(chosen))
            return
        pivot = min(left, key=board.index)
        for g, p in groups:
            if pivot in g and g <= left:
                rec(left - g, chosen + [(g, p)])
                if len(out) > 1:
                    return

    rec(frozenset(board), [])
    return out


def grid_item_keys(label: str) -> list[str]:
    """Two hash-log slots per item per week: no item in more than two grids a week."""
    h = pid("grid-item", fold(label))
    return [f"cx1{h}", f"cx2{h}"]


def connections(data, reg, rosters, seed, now, drops, week_used=lambda label: 0) -> dict | None:
    uni, preds = connections_universe(data, reg, rosters, now)
    kinds = connections_universe.kinds
    full = [x for x in uni if week_used(x) >= CFG["connections"]["max_per_week"]]
    for x in full:
        del uni[x]
    if full:
        drops.append(("connections", f"{len(full)} items already in two grids this week"))
    if len(uni) < 16:
        drops.append(("connections", f"only {len(uni)} items in the news with complete facts (need 16)"))
        return None
    rng = random.Random(seed + "conn")
    answerable = [p for p, (_, k) in preds.items() if k != "decoy" and sum(p in s for s in uni.values()) >= 4]
    if len(answerable) < 4:
        drops.append(("connections", "fewer than 4 categories with 4+ members in the news"))
        return None
    reasons = {}

    def why(r):
        reasons[r] = reasons.get(r, 0) + 1

    for _ in range(CFG["connections"]["attempts"]):
        cats = rng.sample(answerable, 4)
        if sum(preds[c][1] == "wordplay" for c in cats) > 1:
            continue
        board, used = [], set()
        ok = True
        for c in cats:
            # members of this category that belong to none of the other three chosen ones
            pool = [x for x in uni if c in uni[x] and x not in used and not any(o in uni[x] for o in cats if o != c)]
            if len(pool) < 4:
                ok = False
                break
            pick = rng.sample(pool, 4)
            used.update(pick)
            board += pick
        if not ok:
            why("not enough members")
            continue
        if len({kinds.get(x) for x in board}) < 2:
            why("one type of item only")
            continue
        names = " ".join(fold(preds[c][0]) for c in cats)
        if any(re.search(rf"\b{re.escape(w)}\b", names) for x in board for w in fold(x).split() if len(w) > 3):
            why("a board word inside a category name")
            continue
        parts = partitions(board, uni, preds)
        if len(parts) != 1:
            why(f"{len(parts)} solutions")
            continue
        groups = parts[0]
        answer = {p for _, p in groups}
        group_of = {x: p for g, p in groups for x in g}
        # A genuine near miss: a real category, 3+ board items, drawn from at least two answer groups.
        decoys = [p for p in preds if p not in answer
                  and sum(p in uni[x] for x in board) >= 3 and len({group_of[x] for x in board if p in uni[x]}) >= 2]
        if not decoys:
            why("no near-miss decoy")
            continue
        def size(p):
            return 99 if preds[p][1] == "wordplay" else -sum(p in s for s in uni.values())
        ordered = sorted(groups, key=lambda gp: size(gp[1]))
        colors = ["yellow", "green", "blue", "purple"]
        rng.shuffle(board)
        return {"id": "g" + pid("grid", *sorted(board)), "board": board, "shadow": True,
                "groups": [{"color": colors[i], "name": preds[p][0], "members": sorted(g)} for i, (g, p) in enumerate(ordered)],
                "decoys": [preds[d][0] for d in decoys][:3], "types": sorted({kinds.get(x) for x in board})}
    top = sorted(reasons.items(), key=lambda kv: -kv[1])[:3]
    drops.append(("connections", "no unique board: " + ", ".join(f"{k} ×{v}" for k, v in top)))
    return None


# ------------------------------------------------------------------ Defectors
# Crossover roll calls only (passage, cloture, amendments, confirmations), each with a plain-words
# "Yea meant". The page shows the result and the party split; Joe names who broke ranks. NY members
# are always in play. Selection that balances the parties across the month happens in the Function.
def legislator_index(rosters: Path | None) -> dict:
    idx = {}
    if rosters and (rosters / "legislators-current.json").exists():
        for m in json.loads((rosters / "legislators-current.json").read_text()):
            n, ids = m.get("name", {}), m.get("id", {})
            term = (m.get("terms") or [{}])[-1]
            info = {"name": n.get("official_full") or f"{n.get('first')} {n.get('last')}", "last": n.get("last"),
                    "nick": n.get("nickname"), "bioguide": ids.get("bioguide"), "state": term.get("state"),
                    "district": term.get("district"), "party": term.get("party")}
            for k in (ids.get("bioguide"), ids.get("lis")):
                if k:
                    idx[k] = info
    return idx


BILL_STOP = set("""united states congress congressional providing purposes amend amended amendment chapter title
section other certain disapproval relating federal national public senate house resolution joint support
american america through under about their which would""".split())


def defectors(data, votes, legis, now, drops) -> list[dict]:
    import rollcalls
    cut = (now - timedelta(days=45)).date().isoformat()
    week = " ".join(f"{it.get('title', '')}" for it in data.get("items", []) if (parse_t(it.get("t")) or now) >= now - timedelta(days=10))
    wk = set(re.findall(r"[a-z]{5,}", fold(week)))
    items, threads, story_of = index(data)
    out = []
    for v in votes:
        if v["date"] < cut:
            continue
        meant = rollcalls.yea_meant(v["question"], v["desc"])
        if not meant:
            drops.append(("defectors", "procedural vote"))
            continue
        why = blocked(v["desc"])
        if why:
            drops.append(("defectors", why))
            continue
        tally, broke = {}, []
        for party in ("R", "D", "Republican", "Democrat", "Democratic"):
            ms = [m for m in v["members"] if m["party"] == party and m["vote"] in ("Yea", "Nay")]
            if len(ms) < 10:
                continue
            p = party[0]
            ye = [m for m in ms if m["vote"] == "Yea"]
            na = [m for m in ms if m["vote"] == "Nay"]
            tally[p] = {"yea": len(ye), "nay": len(na)}
            minority = ye if len(ye) < len(na) else na
            if 1 <= len(minority) <= max(1, int(0.15 * len(ms))):
                broke += [{"name": m["name"], "last": m["last"], "party": p, "state": m["state"], "vote": m["vote"],
                           "accept": sorted({fold(m["name"]), fold(m["last"] or "")} - {""})} for m in minority]
        if not broke:
            drops.append(("defectors", "party-line vote"))
            continue
        if len(broke) > 8:
            drops.append(("defectors", "too many defectors to name"))
            continue
        ny = [{"name": m["name"], "party": (m["party"] or "?")[0], "vote": m["vote"],
               "district": (legis.get(m["id"]) or {}).get("district")} for m in v["members"] if m["state"] == "NY" and m["vote"] in ("Yea", "Nay")]
        words = set(re.findall(r"[a-z]{5,}", fold(v["desc"]))) - BILL_STOP
        overlap = len(words & wk)
        hit = None
        if overlap >= 2:
            for it in data.get("items", []):
                if len(words & set(re.findall(r"[a-z]{5,}", fold(it.get("title", ""))))) >= 3:
                    hit = it
                    break
        ctx = context_for(hit, story_of, threads) if hit else {"story": None, "thread": None, "thread_title": None, "followed": False}
        bill = v["bill"]
        out.append({
            "id": f"d{v['chamber'][0]}{v['date'][:4]}{v['num']}", "chamber": v["chamber"], "num": v["num"], "date": v["date"],
            "question": v["question"], "yea_meant": meant, "result": v["result"], "bill": bill, "desc": v["desc"][:300],
            "tally": tally, "defectors": broke, "defect_party": sorted({b["party"] for b in broke}),
            "ny": ny[:30], "link": v["link"], "in_news": bool(hit), "news_title": hit.get("title") if hit else None,
            "news_link": hit.get("link") if hit else None, **ctx,
        })
    out.sort(key=lambda x: x["date"], reverse=True)
    out.sort(key=lambda x: not x["in_news"])
    return out                                            # main() keeps the first 12 not used lately


# ------------------------------------------------------------------ Legal refreshers
# Cards come from legal.yaml (our wording, cited, second-checked). Only status: verified ships.
# A card whose `news` pattern matches a story from the last week is featured ("From today: …").
def card_scalars(c: dict) -> str | None:
    """YAML turns bare false/no/yes/on/null into booleans or None: a key or text that isn't a string
    would never match Joe's typed answer, so the card is held and the reason shown."""
    for e in c.get("elements") or []:
        if not isinstance(e.get("text"), str):
            return f"element text {e.get('text')!r} is not text (quote it in legal.yaml)"
        for k in e.get("keys") or []:
            if not isinstance(k, str):
                return f"key {k!r} is not text (quote it in legal.yaml)"
    cz = c.get("cloze") or {}
    for k in [cz.get("text"), cz.get("answer"), *(cz.get("accept") or [])] if cz else []:
        if not isinstance(k, str):
            return f"cloze value {k!r} is not text (quote it in legal.yaml)"
    return None


def legal(data, now, drops, openleg_cache: Path | None = None) -> dict:
    cfg = yaml.safe_load((ROOT / "legal.yaml").read_text()) or {}
    held = {}
    if openleg_cache:
        import openleg
        ny = [c for c in cfg.get("cards", []) if c.get("jurisdiction") == "NY"]
        key = os.environ.get("OPENLEG_KEY")
        if key:
            import requests
            res = openleg.refresh(ny, openleg_cache, requests.Session(), key, "TheWire/1.0 (personal news reader; " + os.environ.get("WIRE_CONTACT", "github") + ")", now)
            for e in res["errors"]:
                drops.append(("legal", "Open Legislation: " + e))
        held = openleg.holds(ny, openleg_cache)
    cards = []
    for c in cfg.get("cards", []):
        if c.get("status") != "verified" or not c.get("verified"):
            drops.append(("legal", "card not yet second-checked"))
            continue
        if c["id"] in held:
            drops.append(("legal", f"{c['id']} held: {held[c['id']]}"))
            continue
        bad = card_scalars(c)
        if bad:
            drops.append(("legal", f"{c['id']}: {bad}"))
            continue
        cards.append({k: c.get(k) for k in ("id", "area", "family", "title", "jurisdiction", "cite", "source", "verified", "elements", "cloze", "note")})
    cut = now - timedelta(days=7)
    featured = []
    items, threads, story_of = index(data)
    for c in cfg.get("cards", []):
        if c.get("status") != "verified" or not c.get("news") or c["id"] in held:
            continue
        rx = re.compile(c["news"], re.I)
        rx_not = re.compile(c["news_not"], re.I) if c.get("news_not") else None
        for it in data.get("items", []):
            t = parse_t(it.get("t"))
            both = f"{it.get('title', '')} {it.get('summary', '')}"
            ny_ok = not c.get("news_ny") or it.get("scope") in ("local", "state") or re.search(r"New York|\bN\.?Y\.?\b|Hudson|Dutchess|Beacon|Albany", both)
            if rx_not and rx_not.search(both):
                continue                                  # a neighbouring statute's story, not this card's
            if t and t >= cut and ny_ok and rx.search(it.get("title") or "") and not blocked(it.get("title")):
                featured.append({"card": c["id"], "title": it.get("title"), "link": it.get("link"), "outlet": it.get("source"),
                                 **context_for(it, story_of, threads)})
                break
    return {"cards": cards, "featured": featured[:5], "order": ["environmental", "torts"]}


# ------------------------------------------------------------------ The Ledger
# Estimation on figures with a named public source: Beacon and Dutchess enrollment and results
# (Boards of Elections), dollar amounts on Beacon's posted agendas (with the resolution number),
# House roll-call tallies, members' years in office (congress-legislators), county party committees'
# itemized receipts (NYS BOE via data.ny.gov). Joe gives a range; Estimathon scoring. "Which is
# bigger" pairs differ by at least 2x, come from two different subjects and are never a part against
# its whole (a ward against the city, a winner against the race's total). Each puzzle's id is the
# figure itself, so the 90-day no-reuse rule holds whatever the date.
MONEY = re.compile(r"\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(million|thousand|M\b|K\b)?", re.I)


def agenda_money(data) -> list[dict]:
    figs = []
    for it in data.get("items", []):
        if not it.get("agenda") or "council" not in (it.get("title") or "").lower():
            continue
        for a in it["agenda"]:
            text = a.get("text") or ""
            num = re.search(r"Resolution No\.?\s*(\d+)", text)
            m = MONEY.search(text)
            if not (num and m) or blocked(text):
                continue
            v = float(m.group(1).replace(",", "") + ("." + m.group(2) if m.group(2) else ""))
            mult = (m.group(3) or "").lower()
            v *= 1_000_000 if mult in ("million", "m") else 1_000 if mult in ("thousand", "k") else 1
            what = re.sub(r"^Resolution No\.?\s*\d+\s*[-–—:]?\s*", "", text)
            what = MONEY.sub("", what).strip(" ,-–—")[:110]
            figs.append({"q": f"Beacon City Council Resolution No. {num.group(1)} ({what}): how many dollars?", "a": round(v), "unit": "dollars",
                         "subject": "Beacon budget", "family": f"res-{num.group(1)}-{(it.get('t') or '')[:4]}",
                         "source": f"City of Beacon agenda, {it.get('title')}", "link": it.get("link")})
    return figs


def ledger_figures(votes_dv, rosters, now, data=None) -> list[dict]:
    figs = []
    be = yaml.safe_load((ROOT / "beacon_elections.yaml").read_text()) or {}
    enr = (be.get("enrollment") or [])[-1:]
    for e in enr:
        ds = e.get("districts") or []
        src = e["source"].split(" ")[0]
        whole = f"beacon-active-{e['as_of']}"
        if ds:
            act = sum(sum(d["active"].values()) for d in ds)
            figs.append({"q": f"How many active registered voters did the City of Beacon have on {e['as_of']}?", "a": act, "unit": "voters",
                         "subject": "Beacon voters", "family": whole, "part_of": f"county-active-{e['as_of']}",
                         "source": "NYS Board of Elections enrollment by election district", "link": src})
            blank = sum(d["active"].get("BLANK", 0) for d in ds)
            figs.append({"q": f"How many of Beacon's active voters were enrolled in no party on {e['as_of']}?", "a": blank, "unit": "voters",
                         "subject": "Beacon voters", "family": whole, "part_of": whole,
                         "source": "NYS Board of Elections enrollment by election district", "link": src})
            for w in sorted({d["ward"] for d in ds}):
                n = sum(sum(d["active"].values()) for d in ds if d["ward"] == w)
                figs.append({"q": f"Active voters in Beacon's Ward {w} ({e['as_of']})", "a": n, "unit": "voters", "subject": "Beacon voters", "pair_only": True,
                             "family": whole, "part_of": whole, "source": "NYS Board of Elections", "link": src})
        cty = ((e.get("totals") or {}) and (e.get("county") or {}).get("active")) or None
        if cty:
            figs.append({"q": f"How many active registered voters did Dutchess County have on {e['as_of']}?", "a": sum(cty.values()), "unit": "voters",
                         "subject": "Dutchess voters", "family": f"county-active-{e['as_of']}",
                         "source": "NYS Board of Elections enrollment by election district", "link": src})
    for r in be.get("results") or []:
        tot = (r.get("beacon_totals") or {}).get("total_votes")
        cands = sorted(r.get("candidates") or [], key=lambda c: -(c.get("votes") or 0))
        fam = f"race-{r['year']}-{fold(r['office'])}"
        if cands and cands[0].get("votes"):
            figs.append({"q": f"In Beacon's {r['year']} race for {r['office']}, how many votes did the top finisher ({cands[0]['name']}) receive in Beacon?",
                         "a": cands[0]["votes"], "unit": "votes", "subject": "Beacon elections", "family": fam, "part_of": fam,
                         "source": "Dutchess County Board of Elections certified results", "link": r["source"]})
        if tot:
            figs.append({"q": f"Total votes cast in Beacon for {r['office']}, {r['year']}", "a": tot, "unit": "votes", "subject": "Beacon elections", "pair_only": True,
                         "family": fam, "source": "Dutchess County Board of Elections", "link": r["source"]})
    for d in votes_dv[:6]:
        yea = sum(t["yea"] for t in d["tally"].values())
        nay = sum(t["nay"] for t in d["tally"].values())
        fam = f"roll-{d['chamber']}-{d['date'][:4]}-{d['num']}"
        what = d["bill"] or "roll call " + str(d["num"])
        figs.append({"q": f"How many House members voted yes on {what} ({d['desc'][:90]}) on {d['date']}?",
                     "a": yea, "unit": "votes", "subject": "House votes", "family": fam, "source": "House Clerk roll call", "link": d["link"]})
        if nay:
            figs.append({"q": f"House no votes on {what}, {d['date']}", "a": nay, "unit": "votes", "subject": "House votes", "pair_only": True,
                         "family": fam, "source": "House Clerk roll call", "link": d["link"]})
    if rosters and (rosters / "legislators-current.json").exists():
        for m in json.loads((rosters / "legislators-current.json").read_text()):
            terms = m.get("terms") or []
            if terms and terms[-1].get("state") == "NY" and terms[-1].get("end", "9") >= now.date().isoformat():
                start = min(t["start"] for t in terms)
                yrs = now.year - int(start[:4])
                if yrs >= 2:
                    nm = strip_suffix(m["name"].get("official_full") or m["name"]["last"])
                    kind = "Senator" if terms[-1]["type"] == "sen" else "Rep."
                    figs.append({"q": f"How many years has {kind} {nm} served in Congress (counting from first swearing-in)?", "a": yrs, "unit": "years",
                                 "subject": "NY delegation", "family": "bio-" + m["id"]["bioguide"],
                                 "source": "congress-legislators (CC0)", "link": f"https://bioguide.congress.gov/search/bio/{m['id']['bioguide']}"})
    lp = yaml.safe_load((ROOT / "local_politics.yaml").read_text()) or {}
    yr = str(now.year - 1)                                   # last complete year
    for c in ((lp.get("money") or {}).get("party_committees") or []):
        if "Dutchess County" not in c.get("name", ""):
            continue
        v = (c.get("itemized_raised_by_year") or {}).get(yr) or (c.get("itemized_raised_by_year") or {}).get(int(yr))
        if v:
            figs.append({"q": f"How much did the {c['name']} report in itemized contributions in {yr}?", "a": int(v), "unit": "dollars",
                         "subject": "Dutchess party money", "family": f"money-{c.get('filer_id')}-{yr}",
                         "source": "NYS Board of Elections campaign finance (data.ny.gov); itemized receipts only, a lower bound", "link": c.get("source")})
    if data:
        figs += agenda_money(data)
    return [f for f in figs if f["a"] and f["a"] > 0]


def lineages(figs: list[dict]) -> None:
    """Each figure's family plus every whole it sits inside (a ward → Beacon → Dutchess)."""
    parent = {f["family"]: f["part_of"] for f in figs if f.get("part_of") and f["part_of"] != f.get("family")}
    for f in figs:
        line, todo = {f.get("family")}, [f.get("part_of"), parent.get(f.get("family"))]
        while todo:
            cur = todo.pop()
            if cur and cur not in line:
                line.add(cur)
                todo.append(parent.get(cur))
        f["lineage"] = line - {None}


def pairable(a: dict, b: dict) -> bool:
    """Two figures can face off: same unit, different subjects, neither inside the other (nor two
    pieces of one whole), at least 2x apart."""
    if a is b or a["unit"] != b["unit"] or a["subject"] == b["subject"]:
        return False
    la, lb = a.get("lineage") or {a.get("family")}, b.get("lineage") or {b.get("family")}
    if la & lb:
        return False
    hi, lo = max(a["a"], b["a"]), min(a["a"], b["a"])
    return lo > 0 and hi / lo >= 2


def ledger_id(f: dict) -> str:
    return "l" + pid("ledger", fold(f["q"]), f["a"])


def ledger(votes_dv, rosters, seed, now, drops, data=None, is_used=lambda _id: False) -> list[dict]:
    figs = ledger_figures(votes_dv, rosters, now, data)
    lineages(figs)
    rng = random.Random(seed + "ledger")
    single = [f for f in figs if not f.get("pair_only") and not is_used(ledger_id(f))]
    rng.shuffle(single)
    # Round-robin across subjects so one subject can't fill the week.
    by_subject: dict[str, list] = {}
    for f in single:
        by_subject.setdefault(f["subject"], []).append(f)
    order = []
    subjects = list(by_subject)
    rng.shuffle(subjects)
    while any(by_subject.values()):
        for sbj in subjects:
            if by_subject[sbj]:
                order.append(by_subject[sbj].pop())
    out, used_pairs = [], set()
    for f in order:
        pairs = []
        others = [g for g in figs if g is not f and not (g["lineage"] & f["lineage"])]
        rng.shuffle(others)
        others.sort(key=lambda g: g["subject"] == f["subject"])          # other subjects first
        for a in others:
            for b in others:
                key = frozenset((id(a), id(b)))
                if key in used_pairs or not pairable(a, b) or any(id(x) in (id(a), id(b)) for p in pairs for x in p):
                    continue
                pairs.append((a, b))
                used_pairs.add(key)
                break
            if len(pairs) >= 2:
                break
        out.append({"id": ledger_id(f), "estimate": {k: v for k, v in f.items() if k not in ("family", "part_of", "pair_only", "lineage")},
                    "pairs": [{"a": {"q": a["q"], "v": a["a"], "source": a["source"], "link": a["link"]},
                               "b": {"q": b["q"], "v": b["a"], "source": b["source"], "link": b["link"]}} for a, b in pairs]})
        if len(out) >= 6:
            break
    if not out:
        drops.append(("ledger", "no sourced figures"))
    return out


# ------------------------------------------------------------------ Friday quiz
# Ten templated questions from the week's verified data, each with its source; multiple choice so
# it plays in a gap; distractors are the same kind of thing and checked not to also be true. The
# last question carries a wager (sure / think / guess). No AI-written questions, no point loss.
def short_element(text: str) -> str:
    """An element without its parentheticals (nested ones too) or trailing qualifiers."""
    t = text
    while True:
        u = re.sub(r"\s*\([^()]*\)", "", t)
        if u == t:
            break
        t = u
    return re.sub(r"\s+", " ", re.split(r";|, (?:where|which|including)\b", t)[0]).strip(" ,")


def _mc(rng, right, wrong, k=3):
    opts = rng.sample(wrong, k) + [right]
    rng.shuffle(opts)
    return opts


FQ_MAX = {"who": 2, "defector": 2, "law": 2, "cloze": 1, "docket": 1, "author": 1, "bigger": 2, "order": 1, "agenda": 1, "official": 2}


def friday_quiz(wsi, dv, lg, data, seed, drops, budget: QuoteBudget | None = None, dk=(), ldg=(), tl=(), ba=(), lib=()) -> dict | None:
    """Ten templated questions from the week's verified data, from as many sources as the week has.
    Multiple choice (`options`) or typed (`type: "typed"`, with `accept`): three or four typed. At
    most two "who said it", Beacon at most two, the law odd-one-out drawn from cards of the same area
    and family. The last carries the wager; the two hardest come from followed threads."""
    rng = random.Random(seed + "friday")
    budget = budget or QuoteBudget()
    qs = []

    def add(q, typed=False, beacon=False):
        q.setdefault("followed", False)
        q["type"] = "typed" if typed else "choice"
        q["beacon"] = beacon
        qs.append(q)

    # Who said it: one multiple choice, one typed (surname is enough).
    speakers = sorted({q["answer"] for q in wsi})
    for n, q in enumerate([x for x in wsi if budget.ok(x["id"], "friday_quiz")][:2]):
        wrong = [x for x in speakers if x != q["answer"]]
        if n == 0 and len(wrong) >= 3:
            budget.take(q["id"], "friday_quiz")
            add({"kind": "who", "q": f"Who said: “{q['quote']}”", "options": _mc(rng, q["answer"], wrong), "answer": q["answer"], "why": q.get("role") or "",
                 "source": q.get("outlet"), "link": q.get("link"), "thread": q.get("thread"), "followed": q.get("followed"), "src": q["id"]}, beacon="Beacon" in f"{q.get('where')} {q.get('role')}")
        elif n == 1 or len(wrong) < 3:
            budget.take(q["id"], "friday_quiz")
            add({"kind": "who", "q": f"Who said: “{q['quote']}” (surname is enough)", "answer": q["answer"], "accept": q["accept"], "why": q.get("role") or "",
                 "source": q.get("outlet"), "link": q.get("link"), "thread": q.get("thread"), "followed": q.get("followed"), "src": q["id"]}, typed=True, beacon="Beacon" in f"{q.get('where')} {q.get('role')}")
    # Defectors: which of these broke ranks (distractors voted with their party on the same roll call).
    for d in list(dv)[:2]:
        broke = {b["name"] for b in d["defectors"]}
        party = d["defectors"][0]["party"]
        same = [m["name"] for m in d.get("ny", []) if m["party"] == party and m["name"] not in broke]
        if len(same) < 3:
            continue
        ans = d["defectors"][0]["name"]
        add({"kind": "defector", "q": f"On {d['bill'] or 'the House vote'} ({d['desc'][:80]}), which of these {'Republicans' if party == 'R' else 'Democrats'} broke with their party?",
             "options": _mc(rng, ans, same), "answer": ans, "why": d["yea_meant"], "source": "House Clerk roll call", "link": d["link"], "thread": d.get("thread")})
    # Law: odd one out, the odd element from another card of the same area and family (a near miss).
    cards = [c for c in ((lg or {}).get("cards") or []) if c.get("family") == "elements"]
    for c in rng.sample(cards, len(cards)):
        if sum(q["kind"] == "law" for q in qs) >= 2:
            break
        mine = [short_element(e["text"]) for e in c["elements"]]
        mykeys = {k for e in c["elements"] for k in (e.get("keys") or []) if isinstance(k, str)}
        near = [(short_element(e["text"]), x) for x in cards if x["id"] != c["id"] and x["area"] == c["area"] for e in x["elements"]
                if not mykeys & {k for k in (e.get("keys") or []) if isinstance(k, str)}]
        near = [(t, x) for t, x in near if t not in mine and len(t) <= 70]
        mine = [t for t in mine if len(t) <= 70]
        if len(mine) < 3 or not near:
            continue
        odd, src = rng.choice(near)
        add({"kind": "law", "q": f"{c['title']}: which of these is NOT an element?", "options": None,
             "answer": odd, "why": f"That one belongs to {src['title']}. {c['cite']}", "source": "legal refresher card (second-checked)", "link": c["source"]})
        qs[-1]["options"] = rng.sample(mine, 3) + [odd]
        rng.shuffle(qs[-1]["options"])
    # Law: statute cloze, typed.
    cz = [c for c in ((lg or {}).get("cards") or []) if c.get("cloze")]
    if cz:
        c = rng.choice(cz)
        z = c["cloze"]
        add({"kind": "cloze", "q": f"{c['title']}. Fill the blank: “{z['text']}”", "answer": z["answer"], "accept": sorted({fold(a) for a in (z.get("accept") or [z["answer"]])}),
             "why": c["cite"], "source": "statute text (official)", "link": z.get("source") or c["source"]}, typed=True)
    # The Docket: which case held this; who wrote it (typed).
    for k in list(dk)[:1]:
        add({"kind": "docket", "q": f"Which case held: “{k['holding']}”?", "options": k["options"], "answer": k["name"], "why": f"Decided {k['date']}",
             "source": "Supreme Court of the United States", "link": k.get("pdf")})
        if k.get("author") and k.get("author_code") not in ("PC", "D"):
            add({"kind": "author", "q": f"Which justice wrote the opinion of the Court in {k['name']}? (surname)", "answer": k["author"], "accept": k["author_accept"],
                 "why": f"Decided {k['date']}", "source": "Supreme Court of the United States", "link": k.get("pdf")}, typed=True)
    # The Ledger: which is bigger (sourced, at least 2x apart).
    for l in list(ldg)[:2]:
        for p in l.get("pairs", [])[:1]:
            big = p["a"] if p["a"]["v"] >= p["b"]["v"] else p["b"]
            add({"kind": "bigger", "q": "Which is bigger?", "options": [p["a"]["q"], p["b"]["q"]], "answer": big["q"],
                 "why": f"{p['a']['v']:,} vs {p['b']['v']:,}", "source": "; ".join(sorted({p["a"]["source"], p["b"]["source"]})), "link": big.get("link")},
                beacon="Beacon" in big["q"])
    # Timeline: which came first (event dates from the primary record).
    for t in list(tl)[:1]:
        c2 = sorted(rng.sample(t["cards"], 2), key=lambda c: c["date"])
        if c2[0]["date"] != c2[1]["date"]:
            opts = [c2[0]["text"], c2[1]["text"]]
            rng.shuffle(opts)
            add({"kind": "order", "q": "Which happened first?", "options": opts, "answer": c2[0]["text"], "why": f"{c2[0]['date']} vs {c2[1]['date']}",
                 "source": "primary record", "link": c2[0].get("link")})
    # Beacon Agenda: which board.
    for b in list(ba)[:1]:
        add({"kind": "agenda", "q": f"Which Beacon board had this on its agenda: “{b['text']}”?", "options": b["options"], "answer": b["answer"],
             "why": b.get("status") or "", "source": b.get("meeting"), "link": b.get("link")}, beacon=True)
    # Officials in this week's news (complete public lists): typed.
    week = fold(" ".join(f"{it.get('title', '')} {it.get('summary', '')}" for it in data.get("items", [])))
    for L in lib:
        if L.get("group") not in ("Beacon", "Dutchess", "New York") or L.get("kind") == "forms":
            continue
        for x in L["items"]:
            if fold(x["answer"]) in week and x.get("clue"):
                add({"kind": "official", "q": f"{L['title']}: who is {x['clue']}? (in this week's news)", "answer": x["answer"], "accept": x["accept"],
                     "why": L.get("source") or "", "source": L.get("source"), "link": None}, typed=True, beacon=L.get("group") == "Beacon")
    # Pick: per-kind caps, Beacon at most two, typed three or four, mixed sources.
    rng.shuffle(qs)
    qs.sort(key=lambda q: q["type"] != "typed")
    pick, per, typed, beacon = [], {}, 0, 0
    for q in qs:
        if per.get(q["kind"], 0) >= FQ_MAX.get(q["kind"], 1) or (q["beacon"] and beacon >= 2) or (q["type"] == "typed" and typed >= 4):
            continue
        pick.append(q)
        per[q["kind"]] = per.get(q["kind"], 0) + 1
        typed += q["type"] == "typed"
        beacon += q["beacon"]
        if len(pick) == 10:
            break
    if typed < 3:
        drops.append(("friday_quiz", f"only {typed} typed-answer questions"))
    if len(pick) < 6:
        drops.append(("friday_quiz", f"only {len(pick)} questions"))
        return None
    if len(pick) < 10:
        drops.append(("friday_quiz", f"{len(pick)} of 10 questions this week"))
    # Followed threads last (the hardest two), the very last carries the wager.
    rng.shuffle(pick)
    pick.sort(key=lambda q: (bool(q.get("followed")), q["kind"] in ("law", "cloze")))
    for q in pick:
        q.pop("beacon", None)
    return {"id": "fq" + pid("friday", *sorted(q["q"] + "|" + q["answer"] for q in pick)), "questions": pick}


# ------------------------------------------------------------------ The Docket
# Court cases that are about a private person's crime or sentence (habeas, capital cases) stay out.
COURT_PRIVATE = re.compile(r"habeas|conviction|convicted|sentenc\w+|prisoner|inmate|death row|capital (case|murder)|prosecut\w+|"
                           r"guilty|plea\b|jury verdict|criminal|Fourth Amendment|warrant\w*|Miranda|Confrontation Clause|Sixth Amendment|suppress\w*|"
                           r"search(ed)? (the|his|her) (home|car|house)", re.I)


def court_ok(r) -> str | None:
    why = blocked(r["holding"], r["name"])
    if why:
        return why
    if re.search(r"(^|v\. )([A-Z]\. ?){2,4}($| v\.)|\bIn re [A-Z]\. ?[A-Z]\.|\bDoe\b|\bRoe\b", r["name"]):
        return "party named by initials (often a minor)"
    if COURT_PRIVATE.search(r["holding"]):
        return "criminal case (private defendant)"
    if re.search(r"\b(United States|People|State|Commonwealth) v\.", r["name"]) and not re.search(r"\bv\. (United States|[A-Z][a-z]+ (County|City|Department|Board|Commission))", r["name"]):
        return "criminal case (private defendant)"
    return None

# Decided Supreme Court cases (and emergency-docket orders) from the Court's own opinion list: which
# case held this, and who wrote it. Correct by construction: the holding sentence, the case names
# and the author column are the Court's. Criminal cases and anything on the exclusion list are left
# out (no private defendants as puzzle subjects). Only after decision, always.
def docket(scotus_rows, data, seed, now, drops) -> list[dict]:
    rng = random.Random(seed + "docket")
    rows = [r for r in scotus_rows if r.get("holding") and r.get("name")]
    ok = []
    for r in rows:
        why = court_ok(r)
        if why:
            drops.append(("docket", why))
            continue
        ok.append(r)
    week = fold(" ".join(it.get("title", "") for it in data.get("items", [])))
    out = []
    recent = sorted(ok, key=lambda r: r["date"], reverse=True)
    for r in recent[:30]:
        others = [x["name"] for x in ok if x["name"] != r["name"] and x["emergency"] == r["emergency"]]
        if len(others) < 3:
            others = [x["name"] for x in ok if x["name"] != r["name"]]
        if len(others) < 3:
            continue
        opts = rng.sample(others, 3) + [r["name"]]
        rng.shuffle(opts)
        parties = [w for w in re.findall(r"[A-Z][a-zA-Z’'.-]{3,}", r["name"]) if w not in ("United", "States", "Department", "Court")]
        held = r["holding"]
        for w in parties:
            held = re.sub(rf"\b{re.escape(w)}\b", "▒▒▒", held)
        in_news = any(len(w) >= 5 and fold(w) in week for w in parties)
        last = (r.get("author") or "").split()[-1] if r.get("author_code") not in ("PC", "D") else None
        out.append({"id": "k" + pid(r["docket"], r["date"]), "name": r["name"], "date": r["date"], "docket": r["docket"],
                    "holding": held, "holding_full": r["holding"], "options": opts, "author": r.get("author"), "author_code": r["author_code"],
                    "author_accept": sorted({fold(r["author"]), fold(last)}) if last else ["per curiam"], "emergency": r["emergency"],
                    "pdf": r["pdf"], "in_news": in_news, "term": r["term"]})
    out.sort(key=lambda x: x["date"], reverse=True)
    out.sort(key=lambda x: (not x["in_news"], x["author_code"] in ("PC", "D")))   # in the news, then signed opinions
    return out                                            # main() keeps the first 10 not used lately


# ------------------------------------------------------------------ Timeline
# Cards carry the date the thing happened, from the primary record (the roll call, the Court's
# decision date), never the date it was reported. One card at a time; tap where it goes; three lives.
def timeline(votes, scotus_rows, seed, now, drops) -> list[dict]:
    import rollcalls
    rng = random.Random(seed + "timeline")
    ev = []
    for v in votes:
        meant = rollcalls.yea_meant(v["question"], v["desc"])
        if not meant or blocked(v["desc"]):
            continue
        label = (v["desc"] or v["bill"])
        if re.match(r"Providing for congressional disapproval", label, re.I):
            label = f"Congressional Review Act resolution {v['bill']}".strip()
        elif len(label) > 110:
            label = label[:107].rsplit(" ", 1)[0] + "…"
        ev.append({"text": f"House vote: {label} ({v['result'].lower()})", "date": v["date"], "link": v["link"], "kind": "vote"})
    for r in scotus_rows:
        if court_ok(r):
            continue
        ev.append({"text": f"Supreme Court {'order' if r['emergency'] else 'decision'}: {r['name']}", "date": r["date"], "link": r["pdf"], "kind": "court"})
    ev = [e for e in ev if e["date"]]
    out = []
    for k in range(3):
        rng.shuffle(ev)
        pick, used = [], set()
        for e in ev:
            if e["date"] in used or any(abs((date.fromisoformat(e["date"]) - date.fromisoformat(x["date"])).days) < 3 for x in pick):
                continue
            pick.append(e)
            used.add(e["date"])
            if len(pick) == 7:
                break
        if len(pick) >= 5:
            out.append({"id": "t" + pid("timeline", *sorted(e["text"] for e in pick)), "cards": pick})
    if not out:
        drops.append(("timeline", "fewer than 5 dated events"))
    return out


# ------------------------------------------------------------------ Beacon Agenda
# Which board hears this item? From Beacon's posted agendas (Granicus). Only items brought by a
# company, LLC or the City itself: never a private person's name or home.
BODIES = {"council": "City Council", "planning": "Planning Board", "zoning": "Zoning Board of Appeals",
          "historic": "Historic District & Landmark Commission", "conservation": "Conservation Advisory Committee"}


COMPANY = re.compile(r"\b(LLC|L\.L\.C\.|Inc|Corp|Corporation|Company|Co\.|L\.?P\.?|Partners|Associates|City of Beacon|Holdings|Realty|Development|Developments|Properties|Studios|Center|Trust|Church|District|Authority)\b", re.I)
# Words that give the board away; the question keeps the substance and drops the procedure.
AGENDA_CUES = [
    (r"\*{2,}[^*]+\*{2,}\s*", ""),                                         # ***ADJOURNED …*** (kept as status)
    (r"^Resolution No\.?\s*\d+\s*[-–—:]?\s*", ""),
    (r"\bResolution No\.?\s*\d+\b", "a resolution"),
    (r"\bLocal Law No\.?\s*\d+ of \d{4}\b", "a local law"),
    (r"\b(Amended )?Site Plan( and Subdivision)? Approval\b", lambda m: ("amended " if m.group(1) else "") + "approval"),
    (r"\bSite Plan\b", "plan"),
    (r"\bSubdivision( and Site Plan)? Approval\b", "approval"),
    (r"\b(area |use )?variances?( approval| relief)?\b", "relief"),
    (r"\bSpecial Use Permit\b", "permit"),
    (r"\bCertificate of Appropriateness\b", "Approval"),
    (r"\bArchitectural Review\b", "review"),
    (r"\bTax Certiorari\b", "tax assessment case"),
    (r",?\s*\(?Tax Grid (No|Nos|#)\.?\s*[\d\- ,and]+\)?", ""),
    (r",?\s*in the [A-Z0-9][A-Z0-9.\-]*( district)?(?=,)", ""),             # zoning district codes
]
AGENDA_BOILERPLATE = re.compile(r"\s*(agenda items and/or topics of interest\b|A work session will take place\b|The regular meeting will begin\b).*$", re.I)
AGENDA_VERBS = set("""continue continued public hearing review consider request application submitted resolution authorizing adopting approving
setting proposed concerning regarding amended approval plan site subdivision for the and of a an to on at by with discussion
presentation workshop city beacon local law""".split())


def agenda_status(a: dict, raw: str) -> str:
    """What the posted agenda says about the item, for the reveal (the agenda is the only record we
    read, so this is the stage it was at, not the vote)."""
    flags, t = set(a.get("flags") or []), raw.lower()
    num = re.search(r"Resolution No\.?\s*(\d+)", raw)
    if "ADJOURNED" in flags or "adjourned" in t:
        return "Adjourned at the applicant's request"
    if num:
        return f"Up for a vote as Resolution No. {num.group(1)}"
    if re.search(r"extension", t):
        return "Extension request"
    if "HEARING" in flags or "public hearing" in t:
        return "Public hearing (continued)" if re.match(r"continue", t) else "Public hearing"
    if re.match(r"continue", t):
        return "Continued review"
    if re.match(r"(review|consider)", t):
        return "First review" if t.startswith("review") else "Under consideration"
    if "workshop" in (a.get("section") or "").lower():
        return "Workshop discussion"
    return "On the agenda"


def meeting_date(it: dict) -> date | None:
    m = re.search(r"-\s*([A-Z][a-z]{2}) (\d{1,2}), (\d{4})", it.get("title") or "")
    if m:
        try:
            return datetime.strptime(" ".join(m.groups()), "%b %d %Y").date()
        except ValueError:
            pass
    t = parse_t(it.get("event_at") or it.get("t"))
    return t.astimezone(NY).date() if t else None


def agenda_key(text: str, addr: str | None) -> frozenset:
    if addr:
        return frozenset({"addr:" + fold(re.sub(r"^\d+-", "", addr))})
    return frozenset(w for w in fold(re.sub(r"\d+", " ", text)).split() if len(w) > 3 and w not in AGENDA_VERBS)


def beacon_agenda(data, seed, drops, now: datetime | None = None, max_age_days: int = 21) -> list[dict]:
    """Which board hears this item? From Beacon's posted agendas (Granicus). Never a private person:
    items brought by a person, naming a person (appointments), or about a private home are dropped,
    and "Person (Company LLC)" keeps only the company. The same application on several agendas
    appears once (its newest), meetings over three weeks old are skipped, scraped boilerplate is cut,
    and procedure words that give the board away are taken out of the question."""
    rng = random.Random(seed + "agenda")
    today = (now or datetime.now(timezone.utc)).astimezone(NY).date()
    cands = []
    for it in data.get("items", []):
        if not it.get("agenda"):
            continue
        body = next((k for k, rx in (("zoning", r"zoning"), ("planning", r"planning"), ("historic", r"historic|landmark"),
                                      ("conservation", r"conservation"), ("council", r"council")) if re.search(rx, it.get("title", ""), re.I)), None)
        if not body:
            continue
        md = meeting_date(it)
        if md and (today - md).days > max_age_days:
            drops.append(("beacon_agenda", "meeting more than three weeks old"))
            continue
        for a in it["agenda"]:
            raw = AGENDA_BOILERPLATE.sub("", re.sub(r"\s+", " ", a.get("text") or "")).strip()
            raw = raw.replace("Â§", "§").replace("â€™", "’")
            if re.search(r"\b(single-family|single family|residence of|home of)\b", raw, re.I):
                drops.append(("beacon_agenda", "a private home"))
                continue
            if re.search(r"\bAppoint\w*\s+(of\s+)?[A-Z][a-z]+\s+[A-Z]", raw):
                drops.append(("beacon_agenda", "names a private person (appointment)"))
                continue
            text = raw
            m = re.search(r"submitted by (.+?)(?:,\s*\d|\s*$)", raw)
            if m:
                applicant = m.group(1).strip().rstrip(".")
                paren = re.match(r"^(?P<person>[^()]+?)\s*\((?P<co>[^()]+)\)$", applicant)
                if paren and COMPANY.search(paren.group("co")) and not COMPANY.search(paren.group("person")):
                    text = raw.replace(applicant, paren.group("co"))           # strip the person, keep the company
                    applicant = paren.group("co")
                parts = re.split(r"\s+and\s+|,\s*", applicant)
                if not all(COMPANY.search(x) for x in parts if x.strip()):
                    drops.append(("beacon_agenda", "item brought by a private person"))
                    continue
            if blocked(text) or len(text) < 30:
                continue
            core = re.sub(r"^Resolution No\.?\s*\d+\s*[-–—:]?\s*", "", re.sub(r"^\*{2,}[^*]+\*{2,}\s*", "", text))
            if not re.match(r"(Public hearing|Continue|Consider|Discussion|Approval|Review|Workshop|Presentation|Request|Application|Authoriz|Adopt|Setting|Settlement|Proposed|Certificate|City Council request)", core, re.I):
                continue
            q = text
            for rx, rep in AGENDA_CUES:
                q = re.sub(rx, rep, q, flags=re.I)
            q = re.sub(r"\s{2,}", " ", re.sub(r"\s+,", ",", q)).strip(" ,-")
            q = q[0].upper() + q[1:]
            if re.search(r"\b(variance|site plan|resolution no|special use permit)\b", q, re.I):
                continue                                                         # a cue survived: don't ask
            cands.append({"key": agenda_key(core, a.get("addr")), "md": md or today, "res": "Resolution No" in text,
                          "item": {"text": q[:400], "answer": BODIES[body], "status": agenda_status(a, raw), "meeting": it.get("title"),
                                   "date": (md.isoformat() if md else (it.get("t") or "")[:10]), "link": it.get("link"), "body": body}})
    # The same application across meetings (or a workshop item and its resolution): keep the newest,
    # the resolution when there's one (it carries the number for the reveal).
    cands.sort(key=lambda c: (c["md"], c["res"]), reverse=True)
    out, keys = [], []
    for c in cands:
        k = c["key"]
        dup = any(k == o or (len(k) >= 2 and len(o) >= 2 and len(k & o) / len(k | o) >= 0.6) for o in keys)
        if dup:
            drops.append(("beacon_agenda", "same application on another agenda"))
            continue
        keys.append(k)
        x = c["item"]
        others = [v for kk, v in BODIES.items() if kk != x["body"]]
        x["options"] = rng.sample(others, 3) + [x["answer"]]
        rng.shuffle(x["options"])
        x["id"] = "b" + pid(*sorted(k))
        out.append(x)
    rng.shuffle(out)
    if not out:
        drops.append(("beacon_agenda", "no eligible agenda items this week"))
    return out


# ------------------------------------------------------------------ Library: Name them all / Match
# Lists from complete sources only: local_politics.yaml (each entry sourced), congress-legislators
# (CC0), the Supreme Court's own opinion list. Local lists first. Each list carries its as-of date
# and source. The featured list is the one the week's news mentions most. "Who left the list"
# compares with last week's snapshot (Actions cache).
SCOTUS_NOW = ["John Roberts", "Clarence Thomas", "Samuel Alito", "Sonia Sotomayor", "Elena Kagan",
              "Neil Gorsuch", "Brett Kavanaugh", "Amy Coney Barrett", "Ketanji Brown Jackson"]
STATE_NAMES = None


def _acc(name: str, extra=()) -> list[str]:
    parts = name.replace(",", " ").split()
    last = parts[-1] if parts else name
    if last.lower() in ("jr", "jr.", "ii", "iii", "iv") and len(parts) > 1:
        last = parts[-2]
    first_last = f"{parts[0]} {last}" if len(parts) > 2 else None              # "Andrew Garbarino"
    last_two = " ".join(parts[-2:]) if len(parts) >= 3 and not re.search(r"\.$", parts[-2]) else None   # "Valdes Smith"
    return sorted({fold(name), fold(last), *[fold(x) for x in (first_last, last_two, *extra) if x]} - {""})


# When a roster's team is in the week's news (folded text). Israel and the Rangers need sport context:
# the country and the Texas club are in the news for other reasons.
TEAM_NEWS = {"NYCFC": r"\bnycfc\b|new york city fc", "Mets": r"\bmets\b", "USMNT": r"\busmnt\b|(?<!wo)men.?s national team|(?<!women.s )(?<!women s )world cup",
             "USWNT": r"\buswnt\b|women.?s national team|women.?s world cup",
             "Rangers": r"new york rangers|rangers.{0,40}\b(nhl|hockey|stanley cup)\b",
             "Israel": r"israel.{0,40}\b(soccer|football|nations league|national team)\b"}


def library(rosters, scotus_rows, data, now) -> list[dict]:
    lp = yaml.safe_load((ROOT / "local_politics.yaml").read_text()) or {}
    off = lp.get("officials", {})
    lists = []
    cb = off.get("city_of_beacon", {})
    council = [{"answer": c["name"], "accept": _acc(c["name"]), "clue": c["seat"]} for c in cb.get("council", []) if c.get("name")]
    if cb.get("mayor", {}).get("name"):
        council = [{"answer": cb["mayor"]["name"], "accept": _acc(cb["mayor"]["name"]), "clue": "Mayor"}] + council
    lists.append({"id": "beacon_council", "group": "Beacon", "title": "Beacon's mayor and City Council", "items": council,
                  "source": "local_politics.yaml (city website, county election results)", "as_of": "2026"})
    city = [(k.replace("_", " ").title().replace("Zba", "ZBA"), v) for k, v in cb.items() if isinstance(v, dict) and v.get("name") and k not in ("mayor",)]
    lists.append({"id": "beacon_officials", "group": "Beacon", "title": "Who runs Beacon's offices and boards", "items":
                  [{"answer": v["name"], "accept": _acc(v["name"]), "clue": k} for k, v in city], "source": "local_politics.yaml"})
    reps = [{"answer": r["name"], "accept": _acc(r["name"]), "clue": r["office"]} for r in off.get("state_and_federal_for_beacon", []) or []]
    dc = off.get("dutchess_county", {})
    reps += [{"answer": r["name"], "accept": _acc(r["name"]), "clue": f"County Legislature District {r['district']}"} for r in dc.get("legislators_for_beacon", []) or []]
    reps += [{"answer": r["name"], "accept": _acc(r["name"]), "clue": "Dutchess " + r["office"]} for r in dc.get("countywide", []) or [] if r.get("name")]
    lists.append({"id": "your_reps", "group": "Beacon", "title": "Who represents Beacon", "items": reps, "source": "local_politics.yaml"})
    lead = [{"answer": r["name"], "accept": _acc(r["name"]), "clue": f"{r['role']} (District {r.get('district')})"} for r in dc.get("legislature_leaders", []) or [] if r.get("name")]
    if lead:
        lists.append({"id": "dutchess_leaders", "group": "Dutchess", "title": "Dutchess County Legislature leaders", "items": lead, "source": "local_politics.yaml"})
    if rosters and (rosters / "legislators-current.json").exists():
        today = now.date().isoformat()
        ny, sen = [], []
        for m in json.loads((rosters / "legislators-current.json").read_text()):
            t = (m.get("terms") or [{}])[-1]
            if t.get("end", "9") < today:
                continue
            nm = m["name"].get("official_full") or f"{m['name']['first']} {m['name']['last']}"
            acc = _acc(nm, [m["name"].get("last"), m["name"].get("nickname") and f"{m['name']['nickname']} {m['name']['last']}"])
            if t.get("type") == "rep" and t.get("state") == "NY":
                ny.append({"answer": nm, "accept": acc, "clue": f"NY-{t.get('district')}", "order": t.get("district") or 0})
            if t.get("type") == "sen":
                sen.append({"answer": nm, "accept": acc, "clue": t.get("state"), "order": t.get("state")})
        ny.sort(key=lambda x: x["order"])
        sen.sort(key=lambda x: (x["order"], x["answer"]))
        lists.append({"id": "ny_house", "group": "New York", "title": "New York's House delegation", "items": ny, "source": "congress-legislators (CC0)", "as_of": today})
        lists.append({"id": "senators", "group": "Congress", "title": "All 100 U.S. senators", "items": sen, "source": "congress-legislators (CC0)", "as_of": today, "minutes": 12})
        nysen = [x for x in sen if x["clue"] == "NY"]
        if nysen:
            lists[2]["items"] += [dict(x, clue="U.S. Senator, NY") for x in nysen]
    lists.append({"id": "scotus", "group": "Courts", "title": "The Supreme Court", "items": [{"answer": n, "accept": _acc(n), "clue": "Chief Justice" if n == "John Roberts" else "Associate Justice"} for n in SCOTUS_NOW],
                  "source": "supremecourt.gov (every justice wrote an opinion this term)", "as_of": now.date().isoformat()})
    # Team rosters (rosters.yaml, hand-checked). A list marked unverified stays out until it's checked.
    rp = ROOT / "rosters.yaml"
    for R in ((yaml.safe_load(rp.read_text()) or {}).get("rosters", []) if rp.exists() else []):
        if R.get("status") == "unverified" or not R.get("items"):
            continue
        lists.append({"id": R["id"], "group": R.get("group", "Sports"), "title": R["title"], "as_of": R.get("as_of", "2026"),
                      "source": "; ".join(R.get("sources", [])[:3]), "team": R["title"].split(" — ")[0],
                      "items": [{"answer": x["answer"], "accept": _acc(x["answer"], x.get("aliases", [])), "clue": x.get("clue", "")} for x in R["items"]]})
    lists += world_lists()
    week = fold(" ".join(f"{it.get('title', '')} {it.get('summary', '')}" for it in data.get("items", [])))
    newest = {}                                     # a team in the news features its most recent list
    for L in lists:
        if L.get("team"):
            newest[L["team"]] = max(newest.get(L["team"], ""), str(L.get("as_of", "")))
    for L in lists:
        L["mentions"] = sum(1 for x in L["items"] if fold(x["answer"]) in week)
        tn = TEAM_NEWS.get(L.get("team", ""))
        if tn and str(L.get("as_of", "")) == newest.get(L["team"]) and re.search(tn, week):
            L["mentions"] += 3                      # the team itself is in the news
        L.setdefault("as_of", "2026")
        L["n"] = len(L["items"])
    return [L for L in lists if L["items"]]


FORMS = ["Presidential republic", "Semi-presidential republic", "Parliamentary republic", "Parliamentary constitutional monarchy",
         "Absolute monarchy", "One-party state", "Theocratic republic", "Directorial republic", "Military-led government"]


def world_lists() -> list[dict]:
    """World leaders and forms of government (world.yaml, hand-checked against recent sources).
    Leaders marked unverified stay out; forms of government change rarely, so every country plays."""
    wp = ROOT / "world.yaml"
    if not wp.exists():
        return []
    W = yaml.safe_load(wp.read_text()) or {}
    C = W.get("countries", [])
    asof = str(W.get("as_of", "2026"))
    src = "world.yaml (hand-checked against official and news sources)"
    hog, hos = [], []
    for c in C:
        if c.get("status") == "unverified":
            continue
        g, h = c.get("head_of_government") or {}, c.get("head_of_state") or {}
        if g.get("name"):
            hog.append({"answer": g["name"], "accept": _acc(g["name"], g.get("aliases", [])), "clue": f"{c['country']} · {g.get('title', '')}".strip(" ·")})
        pm = c.get("prime_minister") or {}                 # e.g. South Korea: the President heads the government
        if pm.get("name") and pm.get("name") != g.get("name"):
            hog.append({"answer": pm["name"], "accept": _acc(pm["name"], pm.get("aliases", [])), "clue": f"{c['country']} · {pm.get('title', 'Prime Minister')}"})
        if h.get("name") and h.get("name") != g.get("name"):
            hos.append({"answer": h["name"], "accept": _acc(h["name"], h.get("aliases", [])), "clue": f"{c['country']} · {h.get('title', '')}".strip(" ·")})
    forms = [{"answer": c["form"], "accept": [fold(c["form"])], "clue": c["country"]} for c in C if c.get("form") in FORMS]
    out = []
    if hog:
        out.append({"id": "world_hog", "group": "World", "title": "Who runs the government", "items": sorted(hog, key=lambda x: x["clue"]), "source": src, "as_of": asof, "minutes": 8})
    if hos:
        out.append({"id": "world_hos", "group": "World", "title": "Heads of state (where they're someone else)", "items": sorted(hos, key=lambda x: x["clue"]), "source": src, "as_of": asof, "minutes": 6})
    if forms:
        out.append({"id": "world_forms", "group": "World", "title": "Forms of government", "kind": "forms", "items": forms, "choices": [f for f in FORMS if any(x["answer"] == f for x in forms)], "source": src, "as_of": asof})
    return out


def who_left(lists, snap_path: Path | None, day: str) -> list[dict]:
    """Members who left a list since last week's snapshot, and who's new (Actions cache, public data only)."""
    if not snap_path:
        return []
    prev = json.loads(snap_path.read_text()) if snap_path.exists() else {}
    out = []
    cur = {L["id"]: {x["answer"]: x.get("clue") for x in L["items"]} for L in lists if L.get("kind") != "forms"}
    for lid, now_ in cur.items():
        before = (prev.get("lists") or {}).get(lid)
        if before is None:
            continue
        gone = sorted(set(before) - set(now_))
        new = sorted(set(now_) - set(before))
        if gone or new:
            out.append({"list": lid, "since": prev.get("day"), "gone": [{"name": g, "clue": before[g]} for g in gone],
                        "new": [{"name": n, "clue": now_[n]} for n in new]})
    if not prev or prev.get("day", "") <= (date.fromisoformat(day) - timedelta(days=7)).isoformat():
        snap_path.write_text(json.dumps({"day": day, "lists": cur}))
    return out


# ------------------------------------------------------------------ run
def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("out")
    ap.add_argument("--rosters", type=Path)
    ap.add_argument("--date")
    ap.add_argument("--hashes", type=Path, help="puzzle-hash log (Actions cache): hashes only, never results")
    ap.add_argument("--votes", type=Path, help="roll-call cache directory (Actions cache)")
    ap.add_argument("--fetch-votes", action="store_true", help="fetch new roll calls before generating")
    ap.add_argument("--scotus", type=Path, help="Supreme Court opinion-list cache directory (Actions cache)")
    ap.add_argument("--fetch-scotus", action="store_true", help="make today's one request to supremecourt.gov")
    ap.add_argument("--snapshots", type=Path, help="weekly list snapshot for Who left the list (Actions cache)")
    ap.add_argument("--fetch-oyez", action="store_true", help="make today's one request to the Oyez case list (pending docket)")
    ap.add_argument("--dispositions", type=Path, help="dispositions.json from the hourly docket-check workflow (its own cache)")
    ap.add_argument("--quiz", type=Path, help="write the audio Wire Quiz MP3 into this directory (needs Cloudflare credentials)")
    a = ap.parse_args(argv)
    load_words()
    now = datetime.now(timezone.utc)
    if a.date:
        now = min(now, datetime.fromisoformat(a.date + "T23:59:00").replace(tzinfo=NY).astimezone(timezone.utc))
    day = a.date or now.astimezone(NY).date().isoformat()
    seed = f"wire-games-{day}"
    data = json.loads(Path(a.data).read_text())
    reg = load_registry(a.rosters)
    drops: list[tuple[str, str]] = []
    used = {}
    if a.hashes and a.hashes.exists():
        used = json.loads(a.hashes.read_text())
    cutoff = (date.fromisoformat(day) - timedelta(days=90)).isoformat()
    used = {h: d for h, d in used.items() if d >= cutoff}

    def is_used(i):
        return i in used and used[i] != day

    def fresh(xs, kind, limit=None):
        """Drop what was published in the last 90 days, then keep the first `limit`: candidates past
        the cut aren't burned, so a thin day carries over."""
        keep = []
        for x in xs:
            if is_used(x["id"]):
                drops.append((kind, "used in the last 90 days"))
                continue
            keep.append(x)
        return keep[:limit] if limit else keep

    d0 = date.fromisoformat(day)
    dow = d0.weekday()
    fri = dow == 4 or bool(os.environ.get("WIRE_FRIDAY"))
    sat = dow == 5 or bool(os.environ.get("WIRE_SATURDAY"))
    sun = dow == 6 or bool(os.environ.get("WIRE_SUNDAY"))
    WEEK["day"] = day
    week_start = (d0 - timedelta(days=dow)).isoformat()
    week_speakers = {k for k, d in used.items() if k.startswith("spk") and week_start <= d < day}
    budget = QuoteBudget()
    wsi = who_said_it(data, reg, now, drops, week_speakers, is_used)
    for q in wsi:
        budget.take(q["id"], "who_said_it")
    grid = connections(data, reg, a.rosters, seed, now, drops,
                       lambda label: sum(1 for k in grid_item_keys(label) if week_start <= used.get(k, "") < day))
    dv, vote_errors = [], {}
    if a.votes:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import rollcalls
        if a.fetch_votes:
            import requests
            res = rollcalls.fetch(a.votes, requests.Session(), "TheWire/1.0 (personal news reader; " + os.environ.get("WIRE_CONTACT", "github") + ")", now)
            vote_errors = res["errors"]
            print(f"[games] roll calls: {res['house']} new House, {res['senate']} new Senate" + (f"; {res['errors']}" if res["errors"] else ""))
        dv = fresh(defectors(data, rollcalls.parse(a.votes, legislator_index(a.rosters)), legislator_index(a.rosters), now, drops), "defectors", 12)
        for ch, err in vote_errors.items():
            drops.append(("defectors", f"{ch} votes unavailable: {err}"))
        if not dv and not any(g == "defectors" for g, _ in drops):
            drops.append(("defectors", "no House roll calls in the last 45 days in the cache"))
    else:
        drops.append(("defectors", "no roll-call cache this run (--votes)"))
    dk, pend = [], []
    if a.scotus:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import scotus
        if a.fetch_scotus:
            import requests
            res = scotus.fetch(a.scotus, requests.Session(), "TheWire/1.0 (personal news reader; " + os.environ.get("WIRE_CONTACT", "github") + ")", now)
            if res.get("error"):
                drops.append(("docket", f"supremecourt.gov: {res['error']}"))
        srows_ = scotus.rows(a.scotus)
        dk = fresh(docket(srows_, data, seed, now, drops), "docket", 10)
        if not srows_:
            drops.append(("docket", "no decided cases in the Court's opinion-list cache yet"))
        elif not dk and not any(g == "docket" for g, _ in drops):
            drops.append(("docket", "fewer than four eligible decided cases to choose among"))
        import pending as pendmod
        if a.fetch_oyez:
            import requests
            res = pendmod.fetch_oyez(a.scotus, requests.Session(), "TheWire/1.0 (personal news reader; " + os.environ.get("WIRE_CONTACT", "github") + ")", now)
            if res.get("error"):
                drops.append(("pending_docket", f"oyez: {res['error']}"))
        pend = pendmod.pending(a.scotus, scotus.rows(a.scotus), court_ok, now, _disp(a.dispositions).keys())
        seen_p = a.scotus / "pending_seen.json"
        seen = set(json.loads(seen_p.read_text())) if seen_p.exists() else set()
        seen_p.write_text(json.dumps(sorted(seen | {x["docket"] for x in pend})))
        if not pend:
            drops.append(("pending_docket", "no argued, undecided cases this term in the Oyez cache"))
    else:
        drops.append(("docket", "no Supreme Court cache this run (--scotus)"))
    tl = []
    if a.votes or a.scotus:
        import rollcalls
        vlist = rollcalls.parse(a.votes, legislator_index(a.rosters)) if a.votes else []
        srows = scotus.rows(a.scotus) if a.scotus else []
        tl = fresh(timeline(vlist, srows, seed, now, drops), "timeline", 3)
    ba = fresh(beacon_agenda(data, seed, drops, now), "beacon_agenda")[:12]
    lib = library(a.rosters, [], data, now)
    left = who_left(lib, a.snapshots, day)
    lg = legal(data, now, drops, a.scotus.parent / "openleg.json" if a.scotus else None)
    wk = weekend_ciphers(wsi, seed, drops, budget, keyed=fri, patristocrat=sun)
    cf = casefile(seed, drops, case_target(day))
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import tactics
    tx = tactics.pool(seed)
    if not tx:
        drops.append(("tactics", "no board passed the one-to-three-winning-lines test"))
    ldg = ledger(dv, a.rosters, seed, now, drops, data, lambda i: i in used and used[i] != day)
    fq = friday_quiz(wsi, dv, lg, data, seed, drops, budget, dk=dk, ldg=ldg, tl=tl, ba=ba, lib=lib) if fri else None
    mt = meta(wsi, dv, dk, seed, drops, budget, ba=ba, lib=lib, data=data) if sat else None
    if not WORDS:
        drops.append(("cryptoquote", "word list missing (/usr/share/dict/words): difficulty grading and wordplay are off"))
    cq = fresh(cryptoquotes(wsi, seed, drops, budget), "cryptoquote")
    if not fri:
        drops.append(("keyed", "built on Fridays only"))
    if not sun:
        drops.append(("patristocrat", "built on Sundays only"))
    if not sat:
        drops.append(("meta", "built on Saturdays only"))
    more = [("keyed", 1 if wk.get("keyed") else 0), ("patristocrat", 1 if wk.get("patristocrat") else 0), ("meta", 1 if mt else 0),
            ("casefile", 1 if cf else 0), ("tactics", len(tx)), ("pending_docket", len(pend))]
    pool = {
        "v": FORMAT, "day": day, "made": iso(now), "data_as_of": data.get("generated_at"),
        "who_said_it": wsi, "cryptoquote": cq, "connections_shadow": grid, "defectors": dv, "legal": lg, "ledger": ldg, "friday_quiz": fq, "docket": dk, "timeline": tl, "beacon_agenda": ba, "library": lib, "who_left": left, "weekend": wk, "meta": mt, "casefile": cf, "tactics": tx,
        "pending_docket": pend[:40], "dispositions": _disp(a.dispositions),
        "health": health(wsi, cq, grid, drops, dv, lg, ldg, fq, dk, tl, ba, more=more),
    }
    if not WORDS:                                  # loud: ciphers grade blind and purple wordplay is off without it
        pool["health"].insert(0, {"game": "word_list", "made": 0, "dropped": 1,
                                  "why": [["/usr/share/dict/words missing: cipher grading, pattern giveaways and wordplay are off", 1]]})
    if a.quiz:
        try:
            import requests
            import wirequiz
            label = datetime.fromisoformat(day + "T12:00:00").strftime("%A, %B %-d")
            pool["wirequiz"] = wirequiz.build(pool, requests.Session(), a.quiz, label)
            pool["health"].append({"game": "wirequiz", "made": 1 if pool["wirequiz"] else 0, "dropped": 0 if pool["wirequiz"] else 1,
                                   "why": [] if pool["wirequiz"] else [["fewer than two questions today", 1]]})
        except Exception as exc:                     # the quiz is optional; the puzzles still ship
            pool["wirequiz"] = None
            pool["health"].append({"game": "wirequiz", "made": 0, "dropped": 1, "why": [[f"{type(exc).__name__}", 1]]})
            print(f"[games] audio quiz skipped: {type(exc).__name__}")
    Path(a.out).write_text(json.dumps(pool, ensure_ascii=False, separators=(",", ":")))
    # Connections shadow mode (GAMES.md): it goes live once the generator has made a board on 10 of
    # the last 14 days. The log (Actions cache) holds only made/dropped per day.
    if a.hashes:
        lp = a.hashes.parent / "connections_log.json"
        log_ = json.loads(lp.read_text()) if lp.exists() else {}
        log_[day] = 1 if grid else 0
        cut14 = (date.fromisoformat(day) - timedelta(days=13)).isoformat()
        log_ = {d: v for d, v in log_.items() if d >= cut14}
        lp.write_text(json.dumps(log_))
        pool["connections_live"] = sum(log_.values()) >= 10
        pool["connections_record"] = f"{sum(log_.values())} of {len(log_)} days"
    if a.hashes:
        # Burn only what was published in today's pool for a game served today (functions/games.js
        # picks by weekday; its own served list stops repeats on fallback days). Candidates that
        # weren't offered, or were offered on a day their game can't be played, carry over.
        today_games = {g for g, days in SERVE_DAYS.items() if dow in days}
        published = {"who_said_it": wsi, "cryptoquote": cq, "defectors": dv, "docket": dk, "ledger": ldg, "timeline": tl,
                     "beacon_agenda": ba, "friday_quiz": [fq] if fq else [], "keyed": [wk["keyed"]] if wk.get("keyed") else [],
                     "patristocrat": [wk["patristocrat"]] if wk.get("patristocrat") else [], "meta": [mt] if mt else [],
                     "casefile": [cf] if cf else [], "connections": [grid] if grid else []}
        for g, xs in published.items():
            if g in today_games:
                for x in xs:
                    used.setdefault(x["id"], day)
                    if x.get("source"):                # a cipher's quote is spent too
                        used.setdefault(x["source"], day)
        if today_games & QUOTE_GAMES:              # one quote per speaker per ISO week
            for q in wsi:
                used.setdefault(q["speaker_key"], day)
        for label in (grid or {}).get("board", []):  # no item in more than two grids a week
            for k in grid_item_keys(label):
                if used.get(k, "") < week_start or used.get(k) == day:
                    used[k] = day
                    break
        a.hashes.write_text(json.dumps(used))
    print(f"[games] {day}: who said it {len(wsi)}, cryptoquote {len(cq)}, connections {'1 (shadow)' if grid else 'dropped'}; "
          f"{len(drops)} candidates dropped")
    return 0


# Weekday each game is served on (Mon=0), as functions/games.js assembles the day.
SERVE_DAYS = {"who_said_it": {0}, "cryptoquote": {0, 2}, "defectors": {1}, "docket": {2}, "ledger": {3}, "friday_quiz": {4}, "keyed": {4},
              "timeline": {5}, "meta": {5}, "beacon_agenda": {6}, "patristocrat": {6}, "casefile": {6}, "connections": set(range(7))}
QUOTE_GAMES = {"who_said_it", "cryptoquote", "friday_quiz", "keyed", "patristocrat", "meta"}


def _disp(p: Path | None) -> dict:
    """Supreme Court judgments for cases that were on the pending list: docket -> side and line."""
    if not p or not p.exists():
        return {}
    d = json.loads(p.read_text())
    return {k: v for k, v in d.items() if not k.startswith("_")}


def health(wsi, cq, grid, drops, dv=(), lg=None, ldg=None, fq=None, dk=None, tl=None, ba=None, more=()) -> list[dict]:
    lg = lg or {"cards": []}
    rows = []
    for game, made in (("who_said_it", len(wsi)), ("cryptoquote", len(cq)), ("connections", 1 if grid else 0), ("defectors", len(dv)), ("legal", len(lg["cards"])), ("ledger", len(ldg or [])), ("friday_quiz", 1 if fq else 0), ("docket", len(dk or [])), ("timeline", len(tl or [])), ("beacon_agenda", len(ba or [])), *more):
        why = {}
        for g, r in drops:
            if g == game:
                why[r] = why.get(r, 0) + 1
        rows.append({"game": game, "made": made, "dropped": sum(v for k, v in why.items() if not k.startswith("built on")),
                     "why": sorted(([k, v] for k, v in why.items()), key=lambda kv: -kv[1])[:5]})
    return rows


if __name__ == "__main__":
    sys.exit(main())
