"""Fixture tests for the Puzzle Page generators (GAMES.md rule 2): every generator must reject
known-bad puzzles. Run: python tests/test_games.py (CI: privacy-check workflow)."""
from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import games  # noqa: E402


def test_guardrails():
    bad = [
        ("Oregon school shooter shares his story", "I heard him fire two shots"),
        ("Many feared trapped under collapsed building", "Eleven shops were occupied"),
        ("Council votes on carriages", "When he was taken from his family, from our city"),
        ("Hostages released", "We waited 400 days"),
        ("Man charged with fraud", "I did nothing wrong"),
        ("Optima Environmental wins contract", "We're proud"),
    ]
    for title, quote in bad:
        assert games.blocked(title, quote), f"should be blocked: {title}"
    assert games.blocked("Senate passes farm bill", "This bill keeps family farms going") is None


def test_institutional_threads():
    assert games.INSTITUTIONAL.search("Russia-Ukraine war")
    assert not games.INSTITUTIONAL.search("Beacon zoning rewrite")


def test_speaker_titles():
    reg = {}
    sp = games.find_speaker(reg, "Interior Minister Laurent Nuñez")
    assert sp and sp["name"] == "Laurent Nuñez" and sp["role"] == "Interior Minister"
    assert games.find_speaker(reg, "Kaylub Giamanco") is None          # private person: never a puzzle
    assert games.find_speaker(reg, "X.\nHe") is None
    sp = games.find_speaker(reg, "State Marco Rubio", "Secretary of State Marco Rubio said on Tuesday")
    assert sp and sp["name"] == "Marco Rubio"


def test_cipher_no_self_map():
    for seed in range(200):
        key = games.derangement(random.Random(seed))
        assert all(k != v for k, v in key.items())
        assert sorted(key.values()) == sorted(key.keys())


def _uni(spec):
    return {name: set(ps) for name, ps in spec.items()}


def test_connections_rejects_two_solutions():
    preds = {f"p{i}": (f"cat {i}", "fact") for i in range(5)}
    # 16 items; p0..p3 are the intended groups, but item a3 and b3 both also fit the other's group,
    # so the board splits two ways.
    spec = {}
    for g, letter in enumerate("abcd"):
        for i in range(4):
            spec[f"{letter}{i}"] = {f"p{g}"}
    spec["a3"] |= {"p1"}
    spec["b3"] |= {"p0"}
    uni = _uni(spec)
    parts = games.partitions(list(uni), uni, preds)
    assert len(parts) == 2, parts


def test_connections_accepts_unique_with_decoy():
    preds = {f"p{i}": (f"cat {i}", "fact") for i in range(4)}
    preds["decoy"] = ("decoy", "decoy")
    spec = {}
    for g, letter in enumerate("abcd"):
        for i in range(4):
            spec[f"{letter}{i}"] = {f"p{g}"}
    for x in ("a0", "b1", "c2"):
        spec[x].add("decoy")
    uni = _uni(spec)
    parts = games.partitions(list(uni), uni, preds)
    assert len(parts) == 1


def test_crypt_difficulty_monotone():
    easy = games.crypt_features("It's a fine day and I'll be at the shop at ten, so it's all good to go.")
    hard = games.crypt_features("Quickly judging mixed zebras vexes bold nymphs.")
    assert games.crypt_difficulty(easy) <= games.crypt_difficulty(hard)


def test_docket_excludes_minors_and_criminal():
    rows = [{"name": "West Virginia v. B. P. J.", "holding": "Title IX allows separate teams.", "date": "2026-06-30", "docket": "24-43", "author_code": "BK", "author": "Brett Kavanaugh", "emergency": False, "pdf": "x", "term": 25},
            {"name": "United States v. Smith", "holding": "The statute reaches the conduct.", "date": "2026-06-01", "docket": "24-1", "author_code": "R", "author": "John Roberts", "emergency": False, "pdf": "x", "term": 25}]
    rows += [{"name": f"Agency {i} v. Company {i}", "holding": f"Holding {i}.", "date": f"2026-05-0{i}", "docket": f"24-{i}0", "author_code": "EK", "author": "Elena Kagan", "emergency": False, "pdf": "x", "term": 25} for i in range(1, 6)]
    out = games.docket(rows, {"items": []}, "seed", None, [])
    names = {d["name"] for d in out}
    assert "West Virginia v. B. P. J." not in names and "United States v. Smith" not in names and len(out) == 5


def test_keyed_aristocrat():
    for w in games.KEYWORDS:
        assert len(set(w)) == len(w), w
        key = games.k1_key(w, random.Random(w))
        assert key and all(k != v for k, v in key.items())
        assert sorted(key.values()) == list(games.string.ascii_uppercase)
        # Reading the plaintext under ciphertext A–Z (in cipher order, rotated) shows the keyword in sequence.
        inv = {v: k for k, v in key.items()}
        row = "".join(inv[c] for c in games.string.ascii_uppercase)
        assert w in row + row, (w, row)


def test_casefile_unique_and_minimal():
    for k in range(6):
        cf = games.casefile(f"seed{k}", [])
        assert cf and 3 <= len(cf["clues"]) <= 16
        sol = cf["solution"]
        assert sorted(v["project"] for v in sol.values()) == sorted(cf["projects"])
        assert sorted(v["time"] for v in sol.values()) == sorted(cf["times"])


def test_tactics_boards():
    import tactics
    for P in tactics.pool("t-fixture", per_tier=1):
        assert 1 <= len(P["solutions"]) <= 3 and P["tier"] in (1, 2, 3)
        assert all(tactics.replay(P, l) for l in P["solutions"])
        b = tactics.Board({(x, y): t for x, y, t in P["terrain"]}, [tuple(x) for x in P["buildings"]], P["enemies"], P["units"])
        assert not tactics.greedy(b)                     # the obvious line loses
        b.enemies_attack()
        assert b.hit                                     # doing nothing loses


def test_docket_dispositions():
    import pending
    d = pending.disposition
    assert d("Pp. 4-19. 101 F. 4th 22, reversed and remanded. KAGAN, J., delivered the opinion of the Court")[0] == "petitioner"
    assert d("The Court of Appeals reversed. Pp. 3-9. 98 F.4th 1, affirmed. THOMAS, J., delivered the opinion of the Court")[0] == "respondent"
    assert d("55 F.4th 9, affirmed in part, reversed in part, and remanded. ROBERTS, C. J., delivered the opinion of the Court")[0] == "mixed"
    assert d("3 F.4th 2, vacated and remanded. BARRETT, J., delivered the opinion of the Court")[0] == "petitioner"
    assert d("no judgment line") is None


def test_openleg_holds():
    import json
    import tempfile
    import openleg
    card = {"id": "x", "jurisdiction": "NY", "verified": "2026-10-27", "source": "https://www.nysenate.gov/legislation/laws/NAV/181",
            "openleg": ["NAV/181", "NAV/172"], "cloze": {"text": "strictly liable, ___, for all", "answer": "without regard to fault", "source": "https://www.nysenate.gov/legislation/laws/NAV/181"}}
    assert openleg.watched(card) == ["NAV/181", "NAV/172"]
    p = Path(tempfile.mkdtemp()) / "ol.json"
    p.write_text(json.dumps({"NAV/181": {"active": "2014-09-22", "hash": "a", "base": "a", "phrases": {"x": True}}}))
    assert openleg.holds([card], p) == {}
    p.write_text(json.dumps({"NAV/172": {"active": "2027-01-01", "hash": "a", "base": "a"}}))
    assert "changed 2027-01-01" in openleg.holds([card], p)["x"]
    p.write_text(json.dumps({"NAV/181": {"active": "2014-09-22", "hash": "a", "base": "a", "phrases": {"x": False}}}))
    assert "no longer matches" in openleg.holds([card], p)["x"]


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok  ", name)
            except AssertionError as e:
                fails += 1
                print("FAIL", name, e)
    sys.exit(1 if fails else 0)
