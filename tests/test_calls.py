"""Call it races (pipeline/calls.py). Run: python tests/test_calls.py"""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import calls  # noqa: E402

cfg = {"elections": [{"id": "g27", "date": "2027-11-02", "title": "General election", "jurisdiction": "City of Beacon", "races": [
    {"id": "mayor", "office": "Mayor", "candidates": [{"name": "Ann Ash", "lines": ["Democratic"]}, {"name": "Bo Birch", "lines": ["Republican"]}],
     "result": {"winner": ["Ann Ash"], "margin": 12.5, "called": "Dutchess BOE unofficial", "source": "https://x"}},
    {"id": "council", "office": "City Council at-large", "seats": 2, "candidates": [{"name": "A"}, {"name": "B"}, {"name": "C"}]},
    {"id": "solo", "office": "Judge", "candidates": [{"name": "Only One"}]},
    {"id": "bad", "office": "Clerk", "candidates": [{"name": "X"}, {"name": "Y"}], "result": {"winner": ["Z"], "called": "AP", "source": "https://y"}},
    {"id": "nosrc", "office": "Assessor", "candidates": [{"name": "X"}, {"name": "Y"}], "result": {"winner": ["X"]}}],
    "proposals": [{"id": "p1", "title": "Proposal 1"}]},
    {"id": "old", "date": "2025-11-04", "races": [{"id": "r", "candidates": [{"name": "a"}, {"name": "b"}]}]}],
    "hot_races": [{"id": "fr", "title": "France presidential, round 1", "date": "2027-04-11", "closes": "2027-04-11T08:00:00+02:00", "where": "France", "scope": "international", "why": "w",
                   "candidates": [{"name": "P", "party": "RN"}, {"name": "Q", "party": "Ren"}]},
                  {"id": "tbd", "title": "Later race", "date": "2027-11-02", "candidates": []}]}
drops = []
now = datetime(2027, 10, 1, 12, tzinfo=timezone.utc)
R = {r["id"]: r for r in calls.races(now, cfg, drops)}
checks = [
    set(R) == {"g27:mayor", "g27:council", "g27:bad", "g27:nosrc", "g27:p1"},       # solo uncontested; old out of window; France > 120 days? no: Apr 2027 is past
    R["g27:mayor"]["result"]["winner"] == ["Ann Ash"] and R["g27:mayor"]["closes"] == "2027-11-02T06:00:00-04:00" or R["g27:mayor"]["closes"] == "2027-11-02T06:00:00-05:00",
    R["g27:council"]["seats"] == 2 and R["g27:council"]["margin"] is False,
    "result" not in R["g27:bad"] and "result" not in R["g27:nosrc"],
    any("isn't one of the candidates" in d[1] for d in drops) and any("source" in d[1] for d in drops),
    [c["name"] for c in R["g27:p1"]["candidates"]] == ["Yes", "No"],
    any("tbd" in d[1] and "candidates not set" in d[1] for d in drops),
]
R2 = {r["id"]: r for r in calls.races(datetime(2027, 3, 1, 12, tzinfo=timezone.utc), cfg, [])}
checks += ["hot:fr" in R2 and R2["hot:fr"]["closes"] == "2027-04-11T08:00:00+02:00" and R2["hot:fr"]["why"] == "w",
           calls.upcoming_hot(datetime(2027, 3, 1, 12, tzinfo=timezone.utc), cfg)[0]["title"] == "Later race"]
bad = [i for i, c in enumerate(checks) if not c]
print("calls:", len(checks) - len(bad), "/", len(checks), "ok", bad or "")
sys.exit(1 if bad else 0)
