"""Lint the questionnaires against QUIZZES.md (2026-10-25). Run: python pipeline/quiz_lint.py

Flags, per instrument: statements that join two claims or add a condition, negate, or carry a
number (rule 2); keying imbalance per dimension (rule 4); dimensions with too few statements for a
map (rule 24); statements without an explainer (rule 7); match positions without a source (rule 9)
and actors coded on too few statements (rule 20); statements no actor has a position on, and
near-consensus statements every coded actor answers the same way (rule 6). Exit code 1 on errors
(unsourced positions, missing explainers on match instruments); warnings don't fail.
"""
import re
import sys
from collections import Counter
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
PATTERNS = {
    "joins two claims?": r"\b(and|or)\b",
    "condition": r"\b(even if|even at|even when|even without|until|unless)\b",
    "negation": r"\b(not|never|don't|doesn't|shouldn't|isn't|no longer)\b",
    "number": r"\d",
}
# Joined nouns that are one thing ("owners and contractors", "math and English") are fine; a
# reviewer clears them by listing the statement here with the reason.
CLEARED = {
    "q03": "one law; 'owners and contractors' names who it covers",
    "q07": "one rule covering two places",
    "q15": "one claim about two costs",
    "q20": "the law and its targets are one thing",
    "q22": "one law",
    "q26": "one policy",
    "q27": "the administration is the defendant",
    "q28": "one office's mission",
    "q30": "one watchdog role",
    "q31": "one asset class",
    "q42": "one mechanism",
    "q43": "both are charges on the same bill",
    "q44": "the ages are the issue",
    "q19": "the toll is the issue",
    "q18": "build and own is one policy",
    "v01": "one guarantee",
    "v03": "the threshold is the issue",
    "v10": "standard survey wording (Pew/Gallup)",
    "v18": "one deployment policy",
    "v23": "one zoning question",
    "v27": "the trade-off is the issue",
    "v28": "the trade-off is the issue",
    "il01": "the condition is the standard framing of the question",
    "il07": "the date is the event",
    "il14": "the exemption is the issue",
    "il15": "one institution's two powers",
    "il16": "two legal forms of one recognition",
    "il17": "examples of core subjects",
    "il21": "standard wording of the question",
    "il23": "the trade-off is the issue",
    "il24": "one regulatory question",
    "il04": "the end point is part of the policy",
    "il06": "acting alone is the issue",
    "il26": "one Shabbat-closure policy",
    "il27": "one fiscal direction",
    "il28": "one policy direction",
    "t30": "the trade-off is the issue",
    "t17": "the contrast is the claim",
    "t22": "the condition is the restraint position",
}


def lint(name, items, dims=None, stances=None, explain=None, kind="match", min_shared=3):
    errors, warns = [], []
    for it in items:
        hits = [k for k, p in PATTERNS.items() if re.search(p, it["text"], re.I)]
        if hits and it["id"] not in CLEARED:
            warns.append(f"{it['id']}: {', '.join(hits)} — {it['text']}")
        if explain is not None and it["id"] not in explain:
            (errors if kind == "match" else warns).append(f"{it['id']}: no explainer")
    keyed = Counter((it.get("axis") or it.get("dim"), it.get("dir")) for it in items if it.get("axis") or it.get("dim"))
    for d in sorted({k[0] for k in keyed}):
        pos, neg = keyed.get((d, 1), 0), keyed.get((d, -1), 0)
        if pos + neg < 4:
            warns.append(f"dimension {d}: {pos + neg} statements (a map needs 4+)")
        if pos + neg >= 4 and min(pos, neg) / (pos + neg) < 0.3:
            warns.append(f"dimension {d}: keying {pos} agree-right vs {neg} agree-left (aim for about half)")
    if stances is not None:
        ids = {it["id"] for it in items}
        for actor, cells in stances.items():
            for q, x in cells.items():
                if q not in ids:
                    warns.append(f"{actor}/{q}: coded on a statement that isn't in the instrument")
                if not x.get("source"):
                    errors.append(f"{actor}/{q}: position without a source")
            n = len([q for q in cells if q in ids])
            if n < min_shared:
                warns.append(f"{actor}: only {n} coded statements")
        for it in items:
            vals = [cells[it["id"]]["v"] for cells in stances.values() if it["id"] in cells]
            if not vals:
                warns.append(f"{it['id']}: no actor has a position")
            elif len(vals) >= 3 and len({(v > 0) - (v < 0) for v in vals}) == 1:
                warns.append(f"{it['id']}: every coded actor on the same side (near-consensus)")
    print(f"== {name}: {len(items)} statements, {len(errors)} errors, {len(warns)} warnings")
    for e in errors:
        print("  ERROR", e)
    for w in warns:
        print("  warn ", w)
    return errors


def main():
    explain = yaml.safe_load((ROOT / "explain.yaml").read_text()) or {}
    errs = []
    el = yaml.safe_load((ROOT / "elections.yaml").read_text())
    for e in el.get("elections") or []:
        q = e.get("quiz") or {}
        if q.get("items"):
            errs += lint(f"election check {e['id']}", q["items"], stances=q.get("stances") or {}, explain=explain, min_shared=2)
    il = ROOT / "israel_quiz.yaml"
    if il.exists():
        b = yaml.safe_load(il.read_text())
        errs += lint("Israel match", b["items"], stances=b.get("stances") or {}, explain=explain)
    sf = ROOT / "solutions.yaml"
    if sf.exists():
        for k, S in ((yaml.safe_load(sf.read_text()) or {}).get("issues") or {}).items():
            mech = S.get("mechanisms") or []
            stances = {a: {m: {"v": x["v"], "source": x.get("source")} for m, x in cells.items()} for a, cells in (S.get("plans") or {}).items()}
            errs += lint(f"Your solutions {k}", mech, stances=stances, min_shared=2)
    v = yaml.safe_load((ROOT / "values.yaml").read_text())
    errs += lint("Where you stand", v["items"], explain=explain, kind="scale")
    tf = ROOT / "values_topup.yaml"
    if tf.exists():
        errs += lint("Where you stand · top-ups", yaml.safe_load(tf.read_text())["items"], kind="scale")
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
