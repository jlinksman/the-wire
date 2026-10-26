"""Privacy check (2026-10-25). Run: python pipeline/privacy_check.py — and on every push.

The repository is public. Nothing describing Joe's views, priorities, answers, matches or
proposals may be in it, in its build logs, or in Ballot Match. This check fails (exit 1) on:

- private data files tracked in git (quiz, ballot, engage, follows, proposals, share);
- a `crit:` tag in any questionnaire file (which statements inform his scorecard is private);
- percentages next to "priority" or "criteria" in any tracked text (his scorecard weights);
- JSON files in git carrying answer-shaped records ({"v": .., "w": ..});
- a workflow step that prints from quiz, ballot, engage or proposals data;
- Ballot Match (share/) code or deploy config that names the private KV binding (WIRE).

It checks shapes, not specific words, so the check itself never names anything private.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRIVATE_FILES = re.compile(r"(^|/)(quiz|ballot|engage|follows|proposals|share|debate_now|debate_log|positions|moments|onair_stars|ai_usage)\.json$")
QUIZ_FILES = {"values.yaml", "elections.yaml", "israel_quiz.yaml", "baseline.yaml", "memes.yaml"}
WEIGHTS = re.compile(r"(priorit|criteri)[^\n]{0,80}\b\d{1,2}\s?%|\b\d{1,2}\s?%[^\n]{0,80}(priorit|criteri)", re.I)
ANSWER_SHAPE = re.compile(r'"v"\s*:\s*-?[0-2]\s*,\s*"w"\s*:\s*[1-3]')
PRINTS_PRIVATE = re.compile(r"^[^\n]*\b(print|echo|cat)\b[^\n]*$", re.I | re.M)
PRIVATE_NAME = re.compile(r"(quiz|ballot|engage|proposals?)\.json|\bd\.get\('(pulse|elections|values|races)'", re.I)
ALLOWED_PRINTS = re.compile(r"json\.load\(open\(f\)\)|> (quiz|ballot|follows)\.json|rm -f")


def tracked() -> list[str]:
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [f for f in out.splitlines() if f]


def main() -> int:
    errs = []
    for f in tracked():
        p = ROOT / f
        if PRIVATE_FILES.search(f) and not f.startswith(("functions/", "share/functions/")):
            errs.append(f"{f}: private data file is tracked in git")
            continue
        if not p.is_file() or p.suffix not in {".md", ".yaml", ".yml", ".json", ".js", ".py", ".html", ".txt", ".toml", ".sh"}:
            continue
        if f == "pipeline/privacy_check.py":
            continue
        s = p.read_text(errors="ignore")
        if f in QUIZ_FILES and re.search(r"^\s*-?\s*\{?[^#\n]*\bcrit:", s, re.M):
            errs.append(f"{f}: has crit: tags (the criteria links are private; they live in the scorecard in KV)")
        for m in WEIGHTS.finditer(s):
            errs.append(f"{f}: looks like scorecard weights: …{m.group(0)[:90]}…")
        if p.suffix == ".json" and ANSWER_SHAPE.search(s):
            errs.append(f"{f}: contains answer-shaped records")
        if f.startswith(".github/"):
            for m in PRINTS_PRIVATE.finditer(s):
                if PRIVATE_NAME.search(m.group(0)) and not ALLOWED_PRINTS.search(m.group(0)):
                    errs.append(f"{f}: prints private data to the public log: {m.group(0).strip()[:100]}")
        if f.startswith("share/") or f == ".github/workflows/deploy-share.yml":
            if re.search(r'binding\s*=\s*"WIRE"|env\.WIRE\b', s):
                errs.append(f"{f}: Ballot Match names the private KV binding")
    print(f"privacy check: {len(errs)} problems")
    for e in errs:
        print("  ERROR", e)
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
