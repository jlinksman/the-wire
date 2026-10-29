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
sys.exit(1 if fail else 0)
