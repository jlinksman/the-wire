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
