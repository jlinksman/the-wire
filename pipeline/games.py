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


# ------------------------------------------------------------------ public-figure registry
def load_registry(rosters: Path | None) -> dict:
    """name (folded) -> {name, role, party, aliases, kind}. Only public figures can be puzzle speakers."""
    reg: dict[str, dict] = {}

    def add(name, role, party=None, aliases=(), kind="person", **extra):
        if not name:
            return
        key = fold(name)
        cur = reg.setdefault(key, {"name": name, "role": role, "party": party, "aliases": set(), "kind": kind})
        cur["aliases"].update(fold(a) for a in aliases if a)
        cur.update({k: v for k, v in extra.items() if v is not None})

    for p in (yaml.safe_load((ROOT / "watch_pool.yaml").read_text()) or {}).get("people", []):
        add(p.get("name"), p.get("role"), p.get("party"))
    lp = yaml.safe_load((ROOT / "local_politics.yaml").read_text()) or {}
    for p in lp.get("players", []) or []:
        add(p.get("name"), p.get("role"), p.get("party"))
    for p in (yaml.safe_load((ROOT / "people.yaml").read_text()) or {}).get("people", []):
        if p.get("perspective") or p.get("byline"):        # named public commentators
            add(p.get("name"), p.get("role"), None, kind="commentator")
    if rosters and (rosters / "legislators-current.json").exists():
        for m in json.loads((rosters / "legislators-current.json").read_text()):
            term = (m.get("terms") or [{}])[-1]
            if term.get("end") and term["end"] < date.today().isoformat():
                continue                                   # README: people who left may linger
            n = m.get("name", {})
            full = n.get("official_full") or f"{n.get('first', '')} {n.get('last', '')}".strip()
            st = term.get("state")
            role = (f"U.S. Senator from {st}" if term.get("type") == "sen"
                    else f"U.S. Representative, {st}-{term.get('district')}")
            add(full, role, term.get("party"), aliases=[n.get("nickname") and f"{n.get('nickname')} {n.get('last')}",
                                                       f"{n.get('first')} {n.get('last')}"],
                kind="legislator", bioguide=m.get("id", {}).get("bioguide"), state=st,
                chamber="senate" if term.get("type") == "sen" else "house", last=n.get("last"))
    for v in reg.values():
        v["aliases"] = sorted(a for a in v["aliases"] if a and a != fold(v["name"]))
    return reg


# A quote's "by" often carries the office ("Interior Minister Laurent Nuñez", "District Judge Royce
# Lamberth"). An office in front of a name marks a public official, so the quote can be a puzzle;
# the office becomes the role hint. Fragments left by the extractor ("State Marco Rubio" from
# "Secretary of State Marco Rubio") are recovered from the item's own text.
TITLE = re.compile(r"^(?P<title>(?:(?:U\.?S\.?|US|UN|State|Deputy|Former|Acting|Interior|Foreign|Defense|Finance|Prime|Vice|Chief|District|Federal|Senior|Majority|Minority|House|Senate|Council|City|County|Assembly|FBI|CIA|Supreme Court|Appeals Court|Circuit)\s+)*"
                   r"(?:President|Prime Minister|Minister|Secretary|Director|Speaker|Judge|Justice|Attorney General|Mayor|Governor|Gov\.?|Senator|Sen\.?|Rep\.?|Representative|Ambassador|Envoy|Chair(?:man|woman)?|Commissioner|Council Member|Councilmember|Leader|Spokes(?:person|man|woman)|Chancellor|King|Queen|Pope|General|Admiral|CEO|Lieutenant Governor|Comptroller|Assemblymember|Legislator|Supervisor|Superintendent))\s+"
                   r"(?P<name>[A-Z][\w’'.-]+(?:\s+[A-Z][\w’'.-]+){1,3})$")
FRAGMENT = re.compile(r"^(?P<frag>State|UN|U\.N\.|NATO|Ukraine|Russia|Israel|Treasury|Defense|Justice|Homeland Security)\s+(?P<name>[A-Z][\w’'.-]+(?:\s+[A-Z][\w’'.-]+){1,2})$")


def find_speaker(reg: dict, by: str, text: str = "") -> dict | None:
    by = re.sub(r"\s+", " ", by or "").strip()
    k = fold(by)
    if k in reg:
        return reg[k]
    for v in reg.values():
        if k in v["aliases"]:
            return v
    m = TITLE.match(by)
    if m:
        name, title = m.group("name"), m.group("title")
        known = find_speaker(reg, name) if fold(name) != k else None
        return known or {"name": name, "role": title, "party": None, "aliases": [], "kind": "official"}
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
def who_said_it(data, reg, now, drops) -> list[dict]:
    c = CFG["who_said_it"]
    items, threads, story_of = index(data)
    cut = now - timedelta(days=c["window_days"])
    out, seen = [], set()
    for it in data.get("items", []):
        t = parse_t(it.get("t") or it.get("published"))
        if not t or t < cut or not it.get("quotes"):
            continue
        ctx = context_for(it, story_of, threads)
        if ctx["thread_title"] and INSTITUTIONAL.search(ctx["thread_title"]):
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
            accept = sorted({fold(sp["name"]), fold(sp["name"].split()[-1]), *sp["aliases"]})
            out.append({
                "id": "w" + key, "quote": text, "answer": sp["name"], "accept": accept,
                "role": sp.get("role"), "party": sp.get("party"),
                "context": mask(it.get("title") or "", [sp["name"]]),
                "outlet": it.get("source"), "t": iso(t), "link": it.get("link"), "item": it["id"],
                **ctx, "hints": [t.astimezone(NY).strftime("%A, %B %-d"), it.get("source") or "", sp.get("role") or ""],
            })
    out.sort(key=lambda x: x["t"], reverse=True)          # newest first …
    out.sort(key=lambda x: not x["followed"])              # … followed threads ahead (stable sort)
    return out[: c["pool_size"]]


def iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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


def cryptoquotes(wsi: list[dict], seed: str, drops) -> list[dict]:
    c = CFG["cryptoquote"]
    out = []
    for q in wsi:
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
    return out[: c["pool_size"]]


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


def weekend_ciphers(wsi: list[dict], seed: str, drops) -> dict:
    rng = random.Random(seed + "weekend")
    words = [w for w in KEYWORDS if len(set(w)) == len(w)]
    kw = week_keyword()
    out = {"keyed": None, "patristocrat": None}
    # The quote must use every letter of the keyword, or the keyword can't fully appear in the worksheet.
    long_q = sorted([q for q in wsi if 70 <= sum(c.isalpha() for c in q["quote"]) <= 160 and set(kw) <= set(q["quote"].upper())], key=lambda q: -len(q["quote"]))
    if long_q:
        q = long_q[0]
        key = k1_key(kw, rng)
        plain = q["quote"].replace("’", "'").upper()
        out["keyed"] = {"id": "kk" + q["id"][1:], "keyword": kw, "cipher": "".join(key.get(c, c) for c in plain), "plain": plain,
                        "speaker": q["answer"], "role": q.get("role"), "outlet": q.get("outlet"), "t": q.get("t"), "link": q.get("link"), "thread": q.get("thread"),
                        "inverse": {v: k for k, v in key.items()}}
        assert all(k != v for k, v in key.items())
    else:
        drops.append(("weekend_ciphers", "no quote of 70–160 letters for the keyed cipher"))
    pat = [q for q in wsi if 70 <= sum(c.isalpha() for c in q["quote"]) <= 110 and (not long_q or q is not long_q[0])]
    if pat:
        q = pat[0]
        key = derangement(rng)
        letters = "".join(c for c in q["quote"].upper() if c.isalpha())
        cipher = "".join(key[c] for c in letters)
        groups = " ".join(cipher[i:i + 5] for i in range(0, len(cipher), 5))
        words_ = [(m.start(), m.group(0)) for m in re.finditer(r"[A-Za-z]+", q["quote"])]
        cw = max(words_, key=lambda w: len(w[1]))
        at = sum(c.isalpha() for c in q["quote"][:cw[0]])
        out["patristocrat"] = {"id": "pp" + q["id"][1:], "cipher": groups, "plain": letters, "speaker": q["answer"], "role": q.get("role"),
                               "outlet": q.get("outlet"), "t": q.get("t"), "link": q.get("link"), "thread": q.get("thread"), "quote": q["quote"],
                               "crib": {"word": cw[1].upper(), "at": at}}
    else:
        drops.append(("weekend_ciphers", "no quote of 70–110 letters for the Patristocrat"))
    return out


# ------------------------------------------------------------------ Saturday meta
# The answer is chosen first: a real Hudson Valley place name. Seven or eight feeders come from the
# week's verified puzzles (Friday's keyword, people quoted, members who broke ranks, opinion
# authors); each gives one letter at a stated position, in order. Before it ships, every way of
# hiding a quarter of the feeders must still leave exactly one place in the list that fits.
HV_PLACES = """BEACON GOSHEN CARMEL CROTON TIVOLI AMENIA PAWLING CHESTER WARWICK KINGSTON FISHKILL NEWBURGH GARRISON
CORNWALL HIGHLAND MARLBORO OSSINING BREWSTER HYDEPARK NEWPALTZ PATTERSON MAHOPAC MONTGOMERY WALDEN
MAYBROOK SHAWANGUNK ELLENVILLE CATSKILL HUDSON ATHENS COXSACKIE STANFORD MILLERTON PINEPLAINS
LAGRANGE UNIONVALE DOVER RHINEBECK REDHOOK CLINTON WASHINGTON KENT PUTNAM YORKTOWN PEEKSKILL
CORTLANDT NYACK HAVERSTRAW PIERMONT SUFFERN NEWWINDSOR WOODBURY MONROE CHESTER FLORIDA""".split()


def meta(wsi, dv, dk, seed, drops) -> dict | None:
    rng = random.Random(seed + "meta")
    feeders = []
    kw = week_keyword()
    feeders.append({"clue": "Friday's keyword (it's in the keyed cipher's worksheet)", "answer": kw, "src": "keyed"})
    for q in wsi[:8]:
        feeders.append({"clue": f"Said this week: “{q['quote'][:120]}{'…' if len(q['quote']) > 120 else ''}” (surname)", "answer": fold(q["answer"]).split()[-1].upper(), "src": "who_said_it", "link": q.get("link")})
    for d in dv[:4]:
        for b in d["defectors"][:2]:
            feeders.append({"clue": f"Broke with the {'Republicans' if b['party'] == 'R' else 'Democrats'} on {d['bill'] or 'a House vote'} ({d['date']}), from {b['state']} (surname)",
                            "answer": fold(b["last"] or b["name"]).replace(" ", "").upper(), "src": "defectors", "link": d.get("link")})
    for k in dk[:4]:
        if k.get("author") and k.get("author_code") not in ("PC", "D"):
            feeders.append({"clue": f"Wrote the Court's opinion in {k['name']} (surname)", "answer": fold(k["author"]).split()[-1].upper(), "src": "docket", "link": k.get("pdf")})
    feeders = [f for f in feeders if f["answer"].isalpha() and len(f["answer"]) >= 4]
    if len(feeders) < 7:
        drops.append(("meta", f"only {len(feeders)} feeders this week"))
        return None
    places = [p for p in HV_PLACES if 6 <= len(p) <= 8]
    rng.shuffle(places)
    for ans in places:
        need = len(ans)
        chosen, used = [], set()
        ok = True
        # Friday's keyword always feeds first if it can.
        for i, ch in enumerate(ans):
            cands = [f for j, f in enumerate(feeders) if j not in used and ch in f["answer"]]
            if i == 0:
                kwc = [f for f in cands if f["src"] == "keyed"]
                cands = kwc or cands
            if not cands:
                ok = False
                break
            f = rng.choice(cands)
            used.add(feeders.index(f))
            pos = [k for k, c in enumerate(f["answer"]) if c == ch]
            chosen.append(dict(f, index=rng.choice(pos) + 1))
        if not ok:
            continue
        # Uniqueness with a quarter of the feeders missing.
        k_hide = max(1, need // 4)
        unique = True
        for hide in itertools.combinations(range(need), k_hide):
            pat = "".join("." if i in hide else ans[i] for i in range(need))
            fits = [p for p in HV_PLACES if len(p) == need and re.fullmatch(pat, p)]
            if len(fits) != 1:
                unique = False
                break
        if not unique:
            continue
        return {"id": "mt" + pid(seed, ans), "category": "a Hudson Valley place", "length": need, "answer": ans,
                "feeders": [{"clue": c["clue"], "answer": c["answer"], "index": c["index"], "link": c.get("link"), "src": c["src"]} for c in chosen],
                "solvable_missing": k_hide}
    drops.append(("meta", "no place name could be built with a unique answer"))
    return None


# ------------------------------------------------------------------ Case file (Sunday logic grid)
# Fictional applicants before a fictional board, their projects and hearing times. A random solution,
# a pool of true clues, clues added until exactly one solution remains (checked by brute force), then
# removed one by one while it stays unique, so the set is minimal. Graded by the clue types it needs.
# Nothing about spills or remediation (never resembles an Optima job).
CASE_PEOPLE = ["Abernathy", "Brennan", "Castillo", "Dunleavy", "Esposito", "Fairbanks", "Galloway", "Hollis"]
CASE_PROJECTS = ["bakery", "bike shop", "gallery", "recording studio", "bookshop", "climbing gym", "tea room", "print shop"]
CASE_TIMES = ["6:00", "6:30", "7:00", "7:30"]


def _solutions(n, clues):
    out = []
    for proj in itertools.permutations(range(n)):
        for tm in itertools.permutations(range(n)):
            if all(c["test"](proj, tm) for c in clues):
                out.append((proj, tm))
                if len(out) > 1:
                    return out
    return out


def casefile(seed, drops) -> dict | None:
    rng = random.Random(seed + "case")
    n = 4
    people = rng.sample(CASE_PEOPLE, n)
    projects = rng.sample(CASE_PROJECTS, n)
    times = CASE_TIMES[:n]
    proj = list(range(n)); rng.shuffle(proj)          # person i -> project proj[i]
    tm = list(range(n)); rng.shuffle(tm)              # person i -> time tm[i]
    who_proj = {proj[i]: i for i in range(n)}
    pool = []
    for i in range(n):
        for j in range(n):
            if proj[i] == j:
                pool.append({"t": f"{people[i]} brought the {projects[j]}.", "kind": "pos", "test": (lambda i, j: lambda P, T: P[i] == j)(i, j)})
            else:
                pool.append({"t": f"{people[i]} didn't bring the {projects[j]}.", "kind": "neg", "test": (lambda i, j: lambda P, T: P[i] != j)(i, j)})
            if tm[i] == j:
                pool.append({"t": f"{people[i]} was heard at {times[j]}.", "kind": "pos", "test": (lambda i, j: lambda P, T: T[i] == j)(i, j)})
            else:
                pool.append({"t": f"{people[i]} wasn't heard at {times[j]}.", "kind": "neg", "test": (lambda i, j: lambda P, T: T[i] != j)(i, j)})
    for a in range(n):
        for b in range(n):
            if a == b:
                continue
            if tm[a] < tm[b]:
                pool.append({"t": f"{people[a]} was heard before {people[b]}.", "kind": "order", "test": (lambda a, b: lambda P, T: T[a] < T[b])(a, b)})
            if tm[a] + 1 == tm[b]:
                pool.append({"t": f"{people[a]} was heard exactly half an hour before {people[b]}.", "kind": "adjacent", "test": (lambda a, b: lambda P, T: T[a] + 1 == T[b])(a, b)})
            pa, pb = projects[proj[a]], projects[proj[b]]
            if tm[a] < tm[b]:
                pool.append({"t": f"The {pa} was heard before the {pb}.", "kind": "order",
                             "test": (lambda ja, jb: lambda P, T: T[P.index(ja)] < T[P.index(jb)])(proj[a], proj[b])})
    for j in range(n):
        i = who_proj[j]
        other = rng.choice([x for x in range(n) if x != i])
        pool.append({"t": f"The {projects[j]} was either {people[i]}'s or {people[other]}'s.", "kind": "either",
                     "test": (lambda i, o, j: lambda P, T: P[i] == j or P[o] == j)(i, other, j)})
    rng.shuffle(pool)
    # Prefer the interesting clue types; positives last (they make it too easy).
    pool.sort(key=lambda c: {"order": 0, "adjacent": 0, "either": 1, "neg": 2, "pos": 3}[c["kind"]])
    clues = []
    for c in pool:
        clues.append(c)
        if len(_solutions(n, clues)) == 1:
            break
    if len(_solutions(n, clues)) != 1:
        drops.append(("casefile", "clue pool didn't pin down one solution"))
        return None
    for c in list(clues):                              # minimal: drop any clue that isn't needed
        trial = [x for x in clues if x is not c]
        if len(_solutions(n, trial)) == 1:
            clues = trial
    kinds = {c["kind"] for c in clues}
    tier = 3 if {"either", "adjacent"} & kinds else 2 if "order" in kinds else 1
    rng.shuffle(clues)
    return {"id": "cf" + pid(seed, *people), "people": people, "projects": projects, "times": times,
            "clues": [c["t"] for c in clues], "tier": tier,
            "solution": {people[i]: {"project": projects[proj[i]], "time": times[tm[i]]} for i in range(n)},
            "story": "Four applicants came before a fictional town board one evening. Who brought which project, and when was each heard?"}


# ------------------------------------------------------------------ Connections (shadow mode)
# Groups come only from complete sources (full rosters, full committee lists) plus one purple
# wordplay test run against every item. Uniqueness: every predicate that 4+ of the 16 satisfy is
# a candidate group; the board ships only if exactly one way exists to split the 16 into four of
# them, and only with a decoy (a non-answer predicate covering 3+ of the 16).
def alliterative(label: str) -> bool:
    p = [w for w in re.findall(r"[A-Za-z]+", label) if len(w) > 1]
    return len(p) >= 2 and p[0][0].lower() == p[-1][0].lower()


def surname_is_word(label: str) -> bool:
    last = re.findall(r"[A-Za-z]+", label)[-1].lower() if label else ""
    return bool(WORDS) and len(last) >= 4 and last in WORDS


WORDPLAY = {
    "alliterative": ("First and last names start with the same letter", alliterative),
    "surname_word": ("Surname is also an ordinary English word", surname_is_word),
}


def connections_universe(data, reg, rosters: Path | None, now) -> tuple[dict, dict]:
    """label -> set of predicate ids, and predicate id -> (category name, kind). Only items in the news."""
    items, threads, story_of = index(data)
    cut = now - timedelta(days=CFG["connections"]["window_days"])
    text = " \n ".join(f"{it.get('title', '')} {it.get('summary', '')}" for it in data.get("items", [])
                       if (parse_t(it.get("t")) or now) >= cut and not blocked(it.get("title"), it.get("summary")))
    ftext = fold(text)
    preds: dict[str, tuple[str, str]] = {}
    uni: dict[str, set] = {}
    committees = {}
    if rosters and (rosters / "committee-membership-current.json").exists():
        names = {}
        if (rosters / "committees-current.json").exists():
            for c in json.loads((rosters / "committees-current.json").read_text()):
                n = re.sub(r"^(House|Senate|Joint) (Special |Select |Permanent Select )?Committee on (the )?", "", c.get("name") or "")
                names[c["thomas_id"]] = f"{c.get('type', '').title()} {n} Committee".strip()
        for cid, members in json.loads((rosters / "committee-membership-current.json").read_text()).items():
            if cid in names:                      # full committees only, not subcommittees
                for m in members:
                    committees.setdefault(m.get("bioguide"), set()).add(cid)
        preds.update({f"cmte:{k}": (f"Sit on the {v}", "fact") for k, v in names.items()})
    for v in reg.values():
        if v.get("kind") != "legislator" or fold(v["name"]) not in ftext:
            continue
        label = v["name"]
        p = {f"chamber:{v['chamber']}", f"state:{v['state']}"}
        p |= {f"cmte:{c}" for c in committees.get(v.get("bioguide"), ())}
        p |= {f"party:{v.get('party')}"}            # decoy only, never an answer category
        p |= {f"wp:{k}" for k, (_, fn) in WORDPLAY.items() if fn(label)}
        uni[label] = p
    for v in reg.values():
        if v.get("kind") == "legislator":
            preds[f"state:{v['state']}"] = (f"Represent {v['state']} in Congress", "fact")
    preds["chamber:senate"] = ("Sitting U.S. senators", "decoy")      # too broad to be an answer
    preds["chamber:house"] = ("Sitting U.S. representatives", "decoy")
    for k, (name, _) in WORDPLAY.items():
        preds[f"wp:{k}"] = (name, "wordplay")
    for p in {"party:Democrat", "party:Republican", "party:Independent"}:
        preds[p] = (p.split(":")[1], "decoy")
    return uni, preds


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


def connections(data, reg, rosters, seed, now, drops) -> dict | None:
    uni, preds = connections_universe(data, reg, rosters, now)
    if len(uni) < 16:
        drops.append(("connections", f"only {len(uni)} people in the news with complete roster facts (need 16)"))
        return None
    rng = random.Random(seed + "conn")
    answerable = [p for p, (_, k) in preds.items() if k != "decoy" and sum(p in s for s in uni.values()) >= 4]
    if len(answerable) < 4:
        drops.append(("connections", "fewer than 4 categories with 4+ members in the news"))
        return None
    reasons = {}
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
            reasons["not enough members"] = reasons.get("not enough members", 0) + 1
            continue
        parts = partitions(board, uni, preds)
        if len(parts) != 1:
            reasons[f"{len(parts)} solutions"] = reasons.get(f"{len(parts)} solutions", 0) + 1
            continue
        groups = parts[0]
        answer = {p for _, p in groups}
        decoys = [p for p in preds if p not in answer and sum(p in uni[x] for x in board) >= 3]
        if not decoys:
            reasons["no decoy"] = reasons.get("no decoy", 0) + 1
            continue
        # Difficulty: biggest predicate first (yellow) … wordplay last (purple).
        def size(p):
            return 99 if preds[p][1] == "wordplay" else -sum(p in s for s in uni.values())
        ordered = sorted(groups, key=lambda gp: size(gp[1]))
        colors = ["yellow", "green", "blue", "purple"]
        rng.shuffle(board)
        return {"id": "g" + pid(seed, *sorted(board)), "board": board, "shadow": True,
                "groups": [{"color": colors[i], "name": preds[p][0], "members": sorted(g)} for i, (g, p) in enumerate(ordered)],
                "decoys": [preds[d][0] for d in decoys][:3]}
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
    return out[:12]


# ------------------------------------------------------------------ Legal refreshers
# Cards come from legal.yaml (our wording, cited, second-checked). Only status: verified ships.
# A card whose `news` pattern matches a story from the last week is featured ("From today: …").
def legal(data, now, drops) -> dict:
    cfg = yaml.safe_load((ROOT / "legal.yaml").read_text()) or {}
    cards = []
    for c in cfg.get("cards", []):
        if c.get("status") != "verified" or not c.get("verified"):
            drops.append(("legal", "card not yet second-checked"))
            continue
        cards.append({k: c.get(k) for k in ("id", "area", "title", "jurisdiction", "cite", "source", "verified", "elements", "cloze", "note")})
    cut = now - timedelta(days=7)
    featured = []
    items, threads, story_of = index(data)
    for c in cfg.get("cards", []):
        if c.get("status") != "verified" or not c.get("news"):
            continue
        rx = re.compile(c["news"], re.I)
        for it in data.get("items", []):
            t = parse_t(it.get("t"))
            ny_ok = not c.get("news_ny") or it.get("scope") in ("local", "state") or re.search(r"New York|\bN\.?Y\.?\b|Hudson|Dutchess|Beacon|Albany", f"{it.get('title', '')} {it.get('summary', '')}")
            if t and t >= cut and ny_ok and rx.search(it.get("title") or "") and not blocked(it.get("title")):
                featured.append({"card": c["id"], "title": it.get("title"), "link": it.get("link"), "outlet": it.get("source"),
                                 **context_for(it, story_of, threads)})
                break
    return {"cards": cards, "featured": featured[:5], "order": ["environmental", "torts"]}


# ------------------------------------------------------------------ The Ledger
# Estimation on figures with a named public source: Beacon enrollment and results (Board of
# Elections), House roll-call tallies, members' years in office (congress-legislators). Joe gives a
# range; Estimathon scoring. "Which is bigger" pairs always differ by at least 2x. Figures are spread
# across subjects; nothing contested is framed as a misconception.
def ledger_figures(votes_dv, rosters, now) -> list[dict]:
    figs = []
    be = yaml.safe_load((ROOT / "beacon_elections.yaml").read_text()) or {}
    enr = (be.get("enrollment") or [])[-1:]
    for e in enr:
        ds = e.get("districts") or []
        if ds:
            act = sum(sum(d["active"].values()) for d in ds)
            figs.append({"q": f"How many active registered voters did the City of Beacon have on {e['as_of']}?", "a": act, "unit": "voters",
                         "subject": "Beacon voters", "source": "NYS Board of Elections enrollment by election district", "link": e["source"].split(" ")[0]})
            blank = sum(d["active"].get("BLANK", 0) for d in ds)
            figs.append({"q": f"How many of Beacon's active voters were enrolled in no party on {e['as_of']}?", "a": blank, "unit": "voters",
                         "subject": "Beacon voters", "source": "NYS Board of Elections enrollment by election district", "link": e["source"].split(" ")[0]})
            for w in sorted({d["ward"] for d in ds}):
                n = sum(sum(d["active"].values()) for d in ds if d["ward"] == w)
                figs.append({"q": f"Active voters in Beacon's Ward {w} ({e['as_of']})", "a": n, "unit": "voters", "subject": "Beacon wards", "pair_only": True,
                             "source": "NYS Board of Elections", "link": e["source"].split(" ")[0]})
    for r in be.get("results") or []:
        tot = (r.get("beacon_totals") or {}).get("total_votes")
        cands = sorted(r.get("candidates") or [], key=lambda c: -(c.get("votes") or 0))
        if cands and cands[0].get("votes"):
            figs.append({"q": f"In Beacon's {r['year']} race for {r['office']}, how many votes did the top finisher ({cands[0]['name']}) receive in Beacon?",
                         "a": cands[0]["votes"], "unit": "votes", "subject": f"Beacon {r['year']} election",
                         "source": "Dutchess County Board of Elections certified results", "link": r["source"]})
        if tot:
            figs.append({"q": f"Total votes cast in Beacon for {r['office']}, {r['year']}", "a": tot, "unit": "votes", "subject": f"Beacon {r['year']} election", "pair_only": True,
                         "source": "Dutchess County Board of Elections", "link": r["source"]})
    for d in votes_dv[:6]:
        yea = sum(t["yea"] for t in d["tally"].values())
        nay = sum(t["nay"] for t in d["tally"].values())
        figs.append({"q": f"How many members voted yes on {d['bill'] or 'roll call ' + str(d['num'])} ({d['desc'][:90]}) on {d['date']}?",
                     "a": yea, "unit": "votes", "subject": "House votes", "source": "House Clerk roll call", "link": d["link"]})
        if nay:
            figs.append({"q": f"No votes on {d['bill'] or 'roll call ' + str(d['num'])}, {d['date']}", "a": nay, "unit": "votes", "subject": "House votes", "pair_only": True,
                         "source": "House Clerk roll call", "link": d["link"]})
    if rosters and (rosters / "legislators-current.json").exists():
        for m in json.loads((rosters / "legislators-current.json").read_text()):
            terms = m.get("terms") or []
            if terms and terms[-1].get("state") == "NY":
                start = min(t["start"] for t in terms)
                yrs = now.year - int(start[:4])
                if yrs >= 2:
                    nm = m["name"].get("official_full") or m["name"]["last"]
                    kind = "Senator" if terms[-1]["type"] == "sen" else "Rep."
                    figs.append({"q": f"How many years has {kind} {nm} served in Congress (counting from first swearing-in)?", "a": yrs, "unit": "years",
                                 "subject": "NY delegation", "source": "congress-legislators (CC0)", "link": f"https://bioguide.congress.gov/search/bio/{m['id']['bioguide']}"})
    return [f for f in figs if f["a"] and f["a"] > 0]


def ledger(votes_dv, rosters, seed, now, drops) -> list[dict]:
    figs = ledger_figures(votes_dv, rosters, now)
    rng = random.Random(seed + "ledger")
    single = [f for f in figs if not f.get("pair_only")]
    out = []
    rng.shuffle(single)
    subjects = set()
    for f in single:
        if f["subject"] in subjects:
            continue
        subjects.add(f["subject"])
        pairs = []
        others = [g for g in figs if g is not f and g["subject"] != f["subject"]]
        rng.shuffle(others)
        for a in others:
            for b in others:
                if a is b or a["unit"] != b["unit"] or a in [p[0] for p in pairs] or b in [p[1] for p in pairs]:
                    continue
                hi, lo = max(a["a"], b["a"]), min(a["a"], b["a"])
                if lo and hi / lo >= 2:
                    pairs.append((a, b))
                    break
            if len(pairs) >= 2:
                break
        pid_ = "l" + pid(seed, f["q"])
        out.append({"id": pid_, "estimate": f, "pairs": [{"a": {"q": a["q"], "v": a["a"], "source": a["source"], "link": a["link"]},
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
def friday_quiz(wsi, dv, lg, data, seed, drops) -> dict | None:
    rng = random.Random(seed + "friday")
    qs = []
    speakers = sorted({q["answer"] for q in wsi})
    for q in wsi[:4]:
        wrong = [x for x in speakers if x != q["answer"]]
        if len(wrong) < 3:
            break
        opts = rng.sample(wrong, 3) + [q["answer"]]
        rng.shuffle(opts)
        qs.append({"kind": "who", "q": f"Who said: “{q['quote']}”", "options": opts, "answer": q["answer"], "why": q.get("role") or "",
                   "source": q.get("outlet"), "link": q.get("link"), "thread": q.get("thread"), "followed": q.get("followed")})
    for d in dv[:2]:
        broke = {b["name"] for b in d["defectors"]}
        party = d["defectors"][0]["party"]
        loyal = [m for m in d.get("ny", []) if m["name"] not in broke]
        pool_names = [b["name"] for b in d["defectors"]][:1]
        # Distractors: same-party members who voted with their party on this roll call (from the record).
        same = [m["name"] for m in d.get("ny", []) if m["party"] == party and m["name"] not in broke]
        if len(same) < 3:
            continue
        opts = rng.sample(same, 3) + pool_names
        rng.shuffle(opts)
        qs.append({"kind": "defector", "q": f"On {d['bill'] or 'the House vote'} ({d['desc'][:80]}), which of these {'Republicans' if party == 'R' else 'Democrats'} broke with their party?",
                   "options": opts, "answer": pool_names[0], "why": d["yea_meant"], "source": "House Clerk roll call", "link": d["link"], "thread": d.get("thread")})
    cards = (lg or {}).get("cards") or []
    if len(cards) >= 2:
        for c in rng.sample(cards, min(2, len(cards))):
            short = lambda t: re.sub(r"\s*\([^()]*\)\s*$", "", t)
            other = [short(e["text"]) for x in cards if x["id"] != c["id"] for e in x["elements"]]
            mine = [short(e["text"]) for e in c["elements"]]
            if len(mine) < 3 or not other:
                continue
            odd = rng.choice(other)
            if odd in mine:
                continue
            opts = rng.sample(mine, 3) + [odd]
            rng.shuffle(opts)
            qs.append({"kind": "law", "q": f"{c['title']}: which of these does NOT belong?", "options": opts, "answer": odd,
                       "why": c["cite"], "source": "legal refresher card (second-checked)", "link": c["source"]})
    items, threads, story_of = index(data)
    outlets = sorted({it.get("source") for it in data.get("items", []) if it.get("source")})
    for th in [t for t in data.get("threads", []) if t.get("followed")] + [t for t in data.get("threads", []) if not t.get("followed")]:
        if len([q for q in qs if q["kind"] == "first"]) >= 2:
            break
        if blocked(th.get("title")) or INSTITUTIONAL.search(th.get("title") or "") or len(th.get("title") or "") < 30 or th.get("kind") not in (None, "event", "story"):
            continue
        mem = sorted((items[m] for m in th.get("members", []) if m in items), key=lambda it: it.get("t") or "")
        if len(mem) < 3 or not mem[0].get("source"):
            continue
        first = mem[0]["source"]
        later = sorted({it.get("source") for it in mem[1:] if it.get("source") and it.get("source") != first})
        if len(later) < 3:
            continue
        opts = rng.sample(later, 3) + [first]
        rng.shuffle(opts)
        qs.append({"kind": "first", "q": f"Of the outlets The Wire follows, which reported this first: “{th['title']}”?", "options": opts, "answer": first,
                   "why": "First item in the thread, " + (mem[0].get("t") or "")[:16].replace("T", " ") + " UTC", "source": first, "link": mem[0].get("link"),
                   "thread": th["id"], "followed": th.get("followed")})
    if len(qs) < 6:
        drops.append(("friday_quiz", f"only {len(qs)} questions"))
        return None
    # The two hardest come from followed threads when there are any; the last carries the wager.
    qs.sort(key=lambda q: (bool(q.get("followed")), q["kind"] == "law"))
    return {"id": "fq" + pid(seed), "questions": qs[:10]}


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
    return out[:10]


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
            out.append({"id": "t" + pid(seed, k, *[e["text"] for e in pick]), "cards": pick})
    if not out:
        drops.append(("timeline", "fewer than 5 dated events"))
    return out


# ------------------------------------------------------------------ Beacon Agenda
# Which board hears this item? From Beacon's posted agendas (Granicus). Only items brought by a
# company, LLC or the City itself: never a private person's name or home.
BODIES = {"council": "City Council", "planning": "Planning Board", "zoning": "Zoning Board of Appeals",
          "historic": "Historic District & Landmark Commission", "conservation": "Conservation Advisory Committee"}


def beacon_agenda(data, seed, drops) -> list[dict]:
    rng = random.Random(seed + "agenda")
    out = []
    for it in data.get("items", []):
        if not it.get("agenda"):
            continue
        body = next((k for k, rx in (("zoning", r"zoning"), ("planning", r"planning"), ("historic", r"historic|landmark"),
                                      ("conservation", r"conservation"), ("council", r"council")) if re.search(rx, it.get("title", ""), re.I)), None)
        if not body:
            continue
        for a in it["agenda"]:
            text = a.get("text") or ""
            m = re.search(r"submitted by ([^,]+(?:,\s*(?:LLC|Inc\.?|L\.P\.|Corp\.?))?)", text)
            applicant = m.group(1) if m else ""
            if m and not re.search(r"\b(LLC|Inc|Corp|Company|L\.?P\.?|Partners|Associates|City of Beacon|Holdings|Realty|Development|Properties)\b", applicant, re.I):
                drops.append(("beacon_agenda", "item brought by a private person"))
                continue
            if blocked(text) or len(text) < 40 or not re.match(r"(Public hearing|Continue|Consider|Discussion|Resolution|Approval|Review|Workshop|Presentation|Request|Application)", text, re.I):
                continue
            others = [v for k, v in BODIES.items() if k != body]
            opts = rng.sample(others, 3) + [BODIES[body]]
            rng.shuffle(opts)
            out.append({"id": "b" + pid(it["id"], a.get("n"), text[:60]), "text": text[:400], "answer": BODIES[body], "options": opts,
                        "meeting": it.get("title"), "date": (it.get("t") or "")[:10], "link": it.get("link")})
    rng.shuffle(out)
    if not out:
        drops.append(("beacon_agenda", "no eligible agenda items this week"))
    return out[:12]


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
    week = fold(" ".join(f"{it.get('title', '')} {it.get('summary', '')}" for it in data.get("items", [])))
    for L in lists:
        L["mentions"] = sum(1 for x in L["items"] if fold(x["answer"]) in week)
        L.setdefault("as_of", "2026")
        L["n"] = len(L["items"])
    return [L for L in lists if L["items"]]


def who_left(lists, snap_path: Path | None, day: str) -> list[dict]:
    """Members who left a list since last week's snapshot, and who's new (Actions cache, public data only)."""
    if not snap_path:
        return []
    prev = json.loads(snap_path.read_text()) if snap_path.exists() else {}
    out = []
    cur = {L["id"]: {x["answer"]: x.get("clue") for x in L["items"]} for L in lists}
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

    def fresh(xs, kind):
        keep = []
        for x in xs:
            if x["id"] in used and used[x["id"]] != day:
                drops.append((kind, "used in the last 90 days"))
                continue
            keep.append(x)
        return keep

    wsi = fresh(who_said_it(data, reg, now, drops), "who_said_it")
    cq = fresh(cryptoquotes(wsi, seed, drops), "cryptoquote")
    grid = connections(data, reg, a.rosters, seed, now, drops)
    dv, vote_errors = [], {}
    if a.votes:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import rollcalls
        if a.fetch_votes:
            import requests
            res = rollcalls.fetch(a.votes, requests.Session(), "TheWire/1.0 (personal news reader; " + os.environ.get("WIRE_CONTACT", "github") + ")", now)
            vote_errors = res["errors"]
            print(f"[games] roll calls: {res['house']} new House, {res['senate']} new Senate" + (f"; {res['errors']}" if res["errors"] else ""))
        dv = fresh(defectors(data, rollcalls.parse(a.votes, legislator_index(a.rosters)), legislator_index(a.rosters), now, drops), "defectors")
        for ch, err in vote_errors.items():
            drops.append(("defectors", f"{ch} votes unavailable: {err}"))
    dk = []
    if a.scotus:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import scotus
        if a.fetch_scotus:
            import requests
            res = scotus.fetch(a.scotus, requests.Session(), "TheWire/1.0 (personal news reader; " + os.environ.get("WIRE_CONTACT", "github") + ")", now)
            if res.get("error"):
                drops.append(("docket", f"supremecourt.gov: {res['error']}"))
        dk = fresh(docket(scotus.rows(a.scotus), data, seed, now, drops), "docket")
    tl = []
    if a.votes or a.scotus:
        import rollcalls
        vlist = rollcalls.parse(a.votes, legislator_index(a.rosters)) if a.votes else []
        srows = scotus.rows(a.scotus) if a.scotus else []
        tl = fresh(timeline(vlist, srows, seed, now, drops), "timeline")
    ba = fresh(beacon_agenda(data, seed, drops), "beacon_agenda")
    lib = library(a.rosters, [], data, now)
    left = who_left(lib, a.snapshots, day)
    lg = legal(data, now, drops)
    WEEK["day"] = day
    wk = weekend_ciphers(wsi, seed, drops)
    cf = casefile(seed, drops)
    mt = meta(wsi, dv, dk, seed, drops) if date.fromisoformat(day).weekday() == 5 or os.environ.get("WIRE_SATURDAY") else None
    ldg = fresh(ledger(dv, a.rosters, seed, now, drops), "ledger")
    fq = friday_quiz(wsi, dv, lg, data, seed, drops) if date.fromisoformat(day).weekday() == 4 or os.environ.get("WIRE_FRIDAY") else None
    pool = {
        "v": FORMAT, "day": day, "made": iso(now), "data_as_of": data.get("generated_at"),
        "who_said_it": wsi, "cryptoquote": cq, "connections_shadow": grid, "defectors": dv, "legal": lg, "ledger": ldg, "friday_quiz": fq, "docket": dk, "timeline": tl, "beacon_agenda": ba, "library": lib, "who_left": left, "weekend": wk, "meta": mt, "casefile": cf,
        "health": health(wsi, cq, grid, drops, dv, lg, ldg, fq, dk, tl, ba),
    }
    if a.quiz:
        try:
            import requests
            import wirequiz
            label = datetime.fromisoformat(day + "T12:00:00").strftime("%A, %B %-d")
            pool["wirequiz"] = wirequiz.build(pool, requests.Session(), a.quiz, label)
        except Exception as exc:                     # the quiz is optional; the puzzles still ship
            pool["wirequiz"] = None
            pool["health"].append({"game": "wirequiz", "made": 0, "dropped": 1, "why": [[f"{type(exc).__name__}", 1]]})
            print(f"[games] audio quiz skipped: {type(exc).__name__}")
    Path(a.out).write_text(json.dumps(pool, ensure_ascii=False, separators=(",", ":")))
    if a.hashes:                                   # offered today = used; never back within 90 days
        for x in wsi + cq + dv + ldg + dk + tl + ([grid] if grid else []):
            used.setdefault(x["id"], day)
        a.hashes.write_text(json.dumps(used))
    print(f"[games] {day}: who said it {len(wsi)}, cryptoquote {len(cq)}, connections {'1 (shadow)' if grid else 'dropped'}; "
          f"{len(drops)} candidates dropped")
    return 0


def health(wsi, cq, grid, drops, dv=(), lg=None, ldg=None, fq=None, dk=None, tl=None, ba=None) -> list[dict]:
    lg = lg or {"cards": []}
    rows = []
    for game, made in (("who_said_it", len(wsi)), ("cryptoquote", len(cq)), ("connections", 1 if grid else 0), ("defectors", len(dv)), ("legal", len(lg["cards"])), ("ledger", len(ldg or [])), ("friday_quiz", 1 if fq else 0), ("docket", len(dk or [])), ("timeline", len(tl or [])), ("beacon_agenda", len(ba or []))):
        why = {}
        for g, r in drops:
            if g == game:
                why[r] = why.get(r, 0) + 1
        rows.append({"game": game, "made": made, "dropped": sum(why.values()),
                     "why": sorted(([k, v] for k, v in why.items()), key=lambda kv: -kv[1])[:5]})
    return rows


if __name__ == "__main__":
    sys.exit(main())
