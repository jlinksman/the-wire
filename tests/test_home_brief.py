"""The kitchen brief's spoken text (pipeline/home_brief.py). Run: python tests/test_home_brief.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import home_brief as h  # noqa: E402

cases = [
    ("Gov. Hochul signs $2.5B NYC housing plan", "The N.Y. Senate passed it 40-22 (see https://x.com/a). Sen. Smith called it 'historic.' 🎉",
     lambda s: "Governor" not in s and "New York Senate passed it 40 to 22" in s and "http" not in s and "Senator Smith" in s and "🎉" not in s),
    ("Beacon City Council approves Main St. rezoning", "", lambda s: s == "Beacon City Council approves Main Street rezoning."),
    ("Board meets", "File photo of the board. Kevin Smith of the Times has this report.", lambda s: s == "Board meets."),
    ("Sun River Health Hunger Relief Program", "Screenshot Screenshot Screenshot", lambda s: s == "Sun River Health Hunger Relief Program."),
    ("Planning Board - Nov 10", "The board meets at 7:00 p.m. to discuss agenda items and/or topics.", lambda s: "7 PM" in s and "and and" not in s and "or topics" in s),
    ("Election Day is here", "A poll site in Summit, NJ. Nov.", lambda s: s == "Election Day is here."),
    ("A" + " word" * 60, "", lambda s: len(s.split()) <= 40 and s.endswith(".")),
]
fail = 0
for t, sm, ok in cases:
    got = h.say_for(t, sm)
    if not ok(got) or len(got.split()) > 40 or any(c in got for c in "*#_`[]<>"):
        fail += 1
        print("FAIL", repr(got))
    else:
        print("ok  ", got[:70])

# Editions, ahead lines, evening order, follow terms (2026-11-03).
import json, tempfile
from datetime import datetime, timezone
UTC = timezone.utc
noon, six = datetime(2026, 11, 3, 17, 0, tzinfo=UTC), datetime(2026, 11, 3, 23, 0, tzinfo=UTC)   # 12 PM, 6 PM Eastern
checks = [h.edition_of(noon) == "Morning", h.edition_of(six) == "Evening"]
data = {"generated_at": "x", "follows": {"topics": [{"title": "Hudson River PCB dredging"}], "threads": [{"title": "Beacon Main Street rezoning"}], "searches": [{"title": "spill", "query": "NYSDEC spill"}]},
        "items": [{"id": "e1", "title": "City Council workshop - Nov 4", "event_at": "2026-11-04T00:00:00Z", "desk": "BEACON"},
                  {"id": "e2", "title": "Planning Board", "event_at": "2026-11-04T14:30:00Z", "desk": "BEACON"},
                  {"id": "e3", "title": "Late hearing", "event_at": "2026-11-05T20:00:00Z", "desk": "GOV"}]}
ah = h._ahead(data, six, "Evening")
checks += [ah == ["At 7 PM, City Council workshop.", "Tomorrow at 9:30 AM, Planning Board."], h._ahead(data, noon, "Morning") == ["At 7 PM, City Council workshop."]]
picked = [{"id": "old", "t": "2026-11-03T05:00:00Z", "title": "Old big story", "score": 9, "section": "World", "source": "AP"},
          {"id": "new", "t": "2026-11-03T21:00:00Z", "title": "New evening story", "score": 2, "section": "World", "source": "AP"},
          {"id": "dev", "t": "2026-11-03T04:00:00Z", "title": "Developing story", "score": 1, "section": "World", "source": "AP", "developing": True}]
with tempfile.TemporaryDirectory() as d:
    h.build(picked, [], data, Path(d), lambda m: None, now=six)
    ev = json.loads((Path(d) / "home-brief.json").read_text())
    h.build(picked, [], data, Path(d), lambda m: None, now=noon)
    mo = json.loads((Path(d) / "home-brief.json").read_text())
checks += [ev["edition"] == "Evening", [x["headline"] for x in ev["items"]] == ["New evening story", "Developing story", "Old big story"],
           mo["edition"] == "Morning", mo["items"][0]["headline"] == "Old big story",
           {"w": ["hudson", "river", "pcb", "dredging"], "n": 3} in ev["listen_for"], {"w": ["spill"], "n": 3} in ev["listen_for"],
           any(x["n"] == 1 and "evening" in x["w"] for x in ev["listen_for"])]
for i, c in enumerate(checks):
    if not c:
        fail += 1
        print("FAIL edition check", i, ev if i > 3 else ah)
print("edition checks:", len(checks) - sum(not c for c in checks), "/", len(checks))
sys.exit(1 if fail else 0)
