"""Writes a cross-check fixture for the tactics engine: pool boards plus sampled legal lines with
the Python result (tests/tactics_cross.test.js replays them through site/games.js)."""
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import tactics  # noqa: E402

out = []
for seed in ("fx1", "fx2"):
    for P in tactics.pool(seed, per_tier=1):
        terrain = {(x, y): t for x, y, t in P["terrain"]}
        b = tactics.Board(terrain, [tuple(x) for x in P["buildings"]], P["enemies"], P["units"])
        rng = random.Random(P["id"])
        lines = []
        for path, end in tactics.lines(b):
            if rng.random() < 0.01:
                lines.append({"line": [{"unit": i, "to": list(to), "attack": list(a)} for i, to, a in path], "win": not end.hit})
        lines += [{"line": l, "win": True} for l in P["solutions"]]
        out.append({"board": P, "lines": lines})
json.dump(out, sys.stdout)
