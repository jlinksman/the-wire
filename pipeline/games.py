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
            if t and t >= cut and rx.search(it.get("title") or "") and not blocked(it.get("title")):
                featured.append({"card": c["id"], "title": it.get("title"), "link": it.get("link"), "outlet": it.get("source"),
                                 **context_for(it, story_of, threads)})
                break
    return {"cards": cards, "featured": featured[:5], "order": ["environmental", "torts"]}


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
    lg = legal(data, now, drops)
    pool = {
        "v": FORMAT, "day": day, "made": iso(now), "data_as_of": data.get("generated_at"),
        "who_said_it": wsi, "cryptoquote": cq, "connections_shadow": grid, "defectors": dv, "legal": lg,
        "health": health(wsi, cq, grid, drops, dv, lg),
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
        for x in wsi + cq + dv + ([grid] if grid else []):
            used.setdefault(x["id"], day)
        a.hashes.write_text(json.dumps(used))
    print(f"[games] {day}: who said it {len(wsi)}, cryptoquote {len(cq)}, connections {'1 (shadow)' if grid else 'dropped'}; "
          f"{len(drops)} candidates dropped")
    return 0


def health(wsi, cq, grid, drops, dv=(), lg=None) -> list[dict]:
    lg = lg or {"cards": []}
    rows = []
    for game, made in (("who_said_it", len(wsi)), ("cryptoquote", len(cq)), ("connections", 1 if grid else 0), ("defectors", len(dv)), ("legal", len(lg["cards"]))):
        why = {}
        for g, r in drops:
            if g == game:
                why[r] = why.get(r, 0) + 1
        rows.append({"game": game, "made": made, "dropped": sum(why.values()),
                     "why": sorted(([k, v] for k, v in why.items()), key=lambda kv: -kv[1])[:5]})
    return rows


if __name__ == "__main__":
    sys.exit(main())
