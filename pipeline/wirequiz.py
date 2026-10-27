"""The Wire Quiz (GAMES.md): a short listen-only audio quiz for the car, in the Listen queue.

Built once a day by games.yml from the Puzzle Page pool: a few Who said it quotes, a Defectors
vote and (when verified cards exist) a legal refresher. Each question is one sentence, read twice,
then a pause (default 5 seconds), then the answer in a full sentence with one line of why. Numbers
are said the way people say them. No voice input and no taps: nothing to do while driving.

Voice: Cloudflare MeloTTS (the same as Listen). About 3 minutes, ~60 neurons, inside the reserve the
debate budget leaves untouched. Written to dist/wirequiz.mp3 for Workers KV; chapters go into the pool.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import listen  # noqa: E402  (TTS, WAV→PCM, MP3 encoder)

PAUSE_S = 5.0
LONG_PAUSE_S = 10.0
MAX_QUESTIONS = 5
STATE = {"R": "Republican", "D": "Democrat", "I": "Independent"}
STATES = dict(x.split(":") for x in """AL:Alabama AK:Alaska AZ:Arizona AR:Arkansas CA:California CO:Colorado CT:Connecticut DE:Delaware FL:Florida
GA:Georgia HI:Hawaii ID:Idaho IL:Illinois IN:Indiana IA:Iowa KS:Kansas KY:Kentucky LA:Louisiana ME:Maine MD:Maryland MA:Massachusetts
MI:Michigan MN:Minnesota MS:Mississippi MO:Missouri MT:Montana NE:Nebraska NV:Nevada NH:New_Hampshire NJ:New_Jersey NM:New_Mexico
NY:New_York NC:North_Carolina ND:North_Dakota OH:Ohio OK:Oklahoma OR:Oregon PA:Pennsylvania RI:Rhode_Island SC:South_Carolina
SD:South_Dakota TN:Tennessee TX:Texas UT:Utah VT:Vermont VA:Virginia WA:Washington WV:West_Virginia WI:Wisconsin WY:Wyoming
DC:the_District_of_Columbia PR:Puerto_Rico GU:Guam VI:the_Virgin_Islands AS:American_Samoa MP:the_Northern_Mariana_Islands""".split())
STATES = {k: v.replace("_", " ") for k, v in STATES.items()}


def _say(text: str) -> str:
    return listen._clean(text)


def script(pool: dict, day_words: str) -> list[dict]:
    """[{label, ask, pause, answer}] — questions from items the visual puzzles are least likely to use today."""
    qs = []
    allq = pool.get("who_said_it") or []
    wsi, seen = [], set()
    for q in allq[3:] + allq[:3]:                 # prefer quotes the page is less likely to use today
        if q["answer"] not in seen:
            seen.add(q["answer"])
            wsi.append(q)
    for q in wsi[:3]:
        quote = q["quote"].rstrip(".")
        who = q["answer"] + (f", {q['role']}" if q.get("role") else "")
        qs.append({"label": "Who said it", "ask": f"Who said this, reported by {q.get('outlet') or 'the news'}: {quote}. Once more: {quote}.",
                   "pause": PAUSE_S, "answer": f"That was {who}."})
    dv = (pool.get("defectors") or [])[1:2] or (pool.get("defectors") or [])[:1]
    for d in dv:
        by = {}
        for b in d["defectors"]:
            by.setdefault(b["party"], []).append(b)
        party, people = sorted(by.items(), key=lambda kv: len(kv[1]))[0]
        n = len(people)
        noun = STATE.get(party, party) + ("s" if n > 1 else "")
        bill = re.sub(r"\s+", " ", d.get("desc") or d.get("bill") or "a bill")[:140]
        names = ", ".join(f"{p['name']} of {STATES.get(p['state'], p['state'])}" for p in people[:4])
        qs.append({"label": "Defectors", "ask": f"In the {d['chamber'].title()} vote on {bill}, {n} {noun} broke with their party and voted {people[0]['vote'].lower()}. Name {'one of them' if n > 1 else 'that member'}.",
                   "pause": PAUSE_S, "answer": f"{'They were' if n > 1 else 'It was'} {names}. {d['yea_meant'].replace('Yea =', 'A yes vote meant:')}."})
    lg = (pool.get("legal") or {}).get("cards") or []
    if lg:
        c = lg[len(day_words) % len(lg)]
        title = re.sub(r"\s*\((NY|federal)\)", lambda m: " in New York" if m.group(1) == "NY" else "", c["title"].split(" — ")[0])
        els = [e["text"].split(" (")[0] for e in c["elements"]]
        qs.append({"label": "Law", "ask": f"Name the {len(els)} elements of {title}. Again: the {len(els)} elements of {title}.",
                   "pause": LONG_PAUSE_S, "answer": "They are: " + "; ".join(els) + f". That's from {c['cite'].split(';')[0]}."})
    return qs[:MAX_QUESTIONS]


def build(pool: dict, session, dist: Path, day_label: str, log=print) -> dict | None:
    qs = script(pool, day_label)
    if len(qs) < 2:
        log("[wirequiz] not enough questions today")
        return None
    pcm, fmt, t, chapters = bytearray(), None, 0.0, []

    def speak(text):
        nonlocal fmt, t, pcm
        for piece in listen._chunks(_say(text)):
            p, rate, ch, width = listen.wav_pcm(listen.tts(session, piece))
            if fmt and fmt != (rate, ch, width):
                raise RuntimeError("the voice changed audio format mid-quiz")
            fmt = (rate, ch, width)
            pcm += p
            t += len(p) / (rate * ch * width)

    def silence(sec):
        nonlocal t, pcm
        n = int(fmt[0] * sec) * fmt[1] * fmt[2]
        pcm += b"\x00" * n
        t += sec

    chapters.append({"label": "The Wire Quiz", "t": 0.0})
    speak(f"The Wire Quiz for {day_label}. {len(qs)} questions. Think of your answer in the pause.")
    silence(0.8)
    for i, q in enumerate(qs, 1):
        chapters.append({"label": f"{i}. {q['label']}", "t": round(t, 2)})
        speak(f"Question {i}. {q['ask']}")
        silence(q["pause"])
        speak(q["answer"])
        silence(1.0)
    speak("That's the Wire Quiz. The puzzles are on the page when you're parked.")
    audio = listen.encode_mp3(bytes(pcm), fmt[0], fmt[1])
    (dist / "wirequiz.mp3").write_bytes(audio)
    import hashlib
    v = hashlib.sha1(audio).hexdigest()[:10]
    log(f"[wirequiz] {len(qs)} questions, {t / 60:.1f} min, {len(audio) // 1024} KB")
    return {"v": v, "seconds": round(t, 1), "chapters": chapters, "neurons": round(t / 60 * listen.NEURONS_PER_MIN, 1)}
