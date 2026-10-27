"""Chess puzzle sample for the Puzzle Page (GAMES.md). Run monthly by .github/workflows/chess.yml:

    curl … lichess_db_puzzle.csv.zst | zstd -dc | python pipeline/chess_sample.py > dist/chess.json

Streams the Lichess puzzle database (CC0, ~6M rows) and keeps a stratified sample of well-liked,
well-measured puzzles: popularity ≥ 80, ≥ 1,000 plays, rating deviation ≤ 90, 150 per 100-point
rating band from 600 to 2,599 (about 3,000 puzzles, ~450 KB). Reservoir sampling with a fixed seed
for the month, so a rerun gives the same sample. Never in git: the output goes to Workers KV.
"""
from __future__ import annotations

import csv
import json
import random
import sys
from datetime import date

PER_BAND = 150
LO, HI = 600, 2600


def main() -> int:
    rng = random.Random(f"chess-{date.today():%Y-%m}")
    bands: dict[int, list] = {b: [] for b in range(LO, HI, 100)}
    seen = {b: 0 for b in bands}
    reader = csv.reader(sys.stdin)
    header = next(reader)
    col = {h: i for i, h in enumerate(header)}
    total = 0
    for row in reader:
        total += 1
        try:
            rating, dev = int(row[col["Rating"]]), int(row[col["RatingDeviation"]])
            pop, plays = int(row[col["Popularity"]]), int(row[col["NbPlays"]])
        except (ValueError, IndexError):
            continue
        if pop < 80 or plays < 1000 or dev > 90 or not (LO <= rating < HI):
            continue
        b = rating // 100 * 100
        seen[b] += 1
        rec = [row[col["PuzzleId"]], row[col["FEN"]], row[col["Moves"]], rating, row[col["Themes"]]]
        if len(bands[b]) < PER_BAND:
            bands[b].append(rec)
        else:
            j = rng.randrange(seen[b])
            if j < PER_BAND:
                bands[b][j] = rec
    out = {"v": 1, "made": date.today().isoformat(), "source": "Lichess puzzle database (CC0), database.lichess.org",
           "fields": ["id", "fen", "moves", "rating", "themes"],
           "puzzles": [p for b in sorted(bands) for p in bands[b]]}
    json.dump(out, sys.stdout, separators=(",", ":"))
    print(f"[chess] read {total} rows, kept {len(out['puzzles'])}", file=sys.stderr)
    return 0 if len(out["puzzles"]) > 1000 else 1


if __name__ == "__main__":
    sys.exit(main())
