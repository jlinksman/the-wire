"""Build site/memes.json (the meme map's bank) from memes.yaml and memes_media.yaml.

Run after editing either file: python pipeline/memes_build.py. The page fetches memes.json when
the meme map opens. Checks that every card's img and see exist and every result source exists.
"""
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
bank = yaml.safe_load((ROOT / "memes.yaml").read_text())
media = yaml.safe_load((ROOT / "memes_media.yaml").read_text())
errs = []
for q in bank["questions"]:
    if len(q["cards"]) != 4:
        errs.append(f"{q['id']}: {len(q['cards'])} cards")
    for c in q["cards"]:
        if c.get("img") and c["img"] not in media["images"]:
            errs.append(f"{q['id']}: no image {c['img']}")
        if c.get("see") and c["see"] not in media["links"]:
            errs.append(f"{q['id']}: no link {c['see']}")
for c in bank["currents"]:
    if c["src"] not in bank["sources"]:
        errs.append(f"current {c['id']}: no source {c['src']}")
if errs:
    sys.exit("\n".join(errs))
out = {k: bank[k] for k in ("sources", "currents", "dims", "questions")} | {"images": media["images"], "links": media["links"]}
(ROOT / "site" / "memes.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
print(f"memes.json: {len(bank['questions'])} questions, {len(bank['currents'])} currents, {len(media['images'])} images")
