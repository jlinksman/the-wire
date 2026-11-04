"""Officials refresh with each election (pipeline/succession.py). Run: python tests/test_succession.py"""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import succession as su  # noqa: E402

acc = lambda n: [n.lower()]  # noqa: E731
cfg = {"elections": [{"id": "g", "date": "2026-11-03", "title": "General election", "races": [
    {"id": "sd", "holds": "State Senate District 39", "term_start": "2027-01-01", "map": "x|s39",
     "candidates": [{"name": "Rob Inc", "incumbent": True}, {"name": "Cha Llenger"}],
     "result": {"winner": ["Cha Llenger"], "margin": 2.0, "called": "AP", "source": "https://s"}},
    {"id": "gov", "holds": "Governor", "term_start": "2027-01-01",
     "candidates": [{"name": "Kay Gov", "incumbent": True}, {"name": "Other"}],
     "result": {"winner": ["Kay Gov"], "called": "AP", "source": "https://g"}},
    {"id": "nores", "holds": "Comptroller", "term_start": "2027-01-01", "candidates": [{"name": "A"}, {"name": "B"}]},
    {"id": "badres", "holds": "Clerk", "term_start": "2027-01-01", "candidates": [{"name": "A"}, {"name": "B"}], "result": {"winner": ["Z"], "called": "x", "source": "y"}},
]}]}
ch = su.changes(cfg)
lists = lambda: [{"id": "your_reps", "items": [{"answer": "Rob Inc", "accept": ["rob inc"], "clue": "State Senate District 39"}]}]  # noqa: E731
checks = [len(ch) == 2, ch[0]["changed"] is True, ch[1]["changed"] is False]
# November: winners list appears; the seat hasn't switched; the re-elected governor joins Who represents Beacon.
L = lists(); out = su.apply(L, ch, date(2026, 11, 4), acc)
reps = L[0]["items"]
won = [x for x in L if x["id"].startswith("won_")]
checks += [reps[0]["answer"] == "Rob Inc", any(x["clue"] == "Governor" and x["answer"] == "Kay Gov" for x in reps),
           len(won) == 1 and won[0]["title"] == "Who won on November 3, 2026" and {x["clue"] for x in won[0]["items"]} == {"State Senate District 39 · new", "Governor · re-elected"},
           out["seats"] == [{"map": "x", "shape": "s39", "who": "Cha Llenger", "office": "State Senate District 39", "from": "2027-01-01", "changed": True, "election": "2026-11-03", "live": False}]]
# January 1: the seat switches; the map goes live; the won list stays until 60 days after.
L = lists(); out = su.apply(L, ch, date(2027, 1, 1), acc)
checks += [L[0]["items"][0]["answer"] == "Cha Llenger", out["seats"][0]["live"] is True, any(x["id"].startswith("won_") for x in L)]
L = lists(); su.apply(L, ch, date(2027, 3, 5), acc)
checks += [not any(x["id"].startswith("won_") for x in L)]
bad = [i for i, c in enumerate(checks) if not c]
print("succession:", len(checks) - len(bad), "/", len(checks), "ok", bad or "")
sys.exit(1 if bad else 0)
