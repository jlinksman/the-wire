"""Listen: the audio edition (2026-10-26).

A spoken version of Today: the top stories' already-checked text (the same "what happened" and
"latest" lines the page shows, which passed the grounding check and the red pen), read by
Cloudflare's MeloTTS voice. Nothing new is written for the audio, so it can't add errors.

One MP3 per edition, one chapter per story, written to dist/listen.mp3 and published to Workers
KV (never git, never the Actions cache); data["listen"] carries the chapters and their start times.
A new edition is made only when the stories' text has changed, at most every LISTEN_EVERY_MIN
minutes, not overnight, and within its own share of the free Workers AI allowance.
"""
from __future__ import annotations

import base64
import hashlib
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
MODEL = "@cf/myshell-ai/melotts"
NEURONS_PER_MIN = 18.63              # Workers AI pricing, MeloTTS
LISTEN_DAILY_NEURONS = 900           # its own share; the build's other AI stays under 6,000 + reading
LISTEN_EVERY_MIN = 120
MAX_CHAPTERS = 8
MAX_WORDS = 1150                     # about 7 to 8 minutes
CHUNK_CHARS = 380                    # per TTS call, split at sentence ends
QUIET_HOURS = range(1, 5)            # no new editions 1–5 AM Eastern


# ------------------------------------------------------------------ script
def _clean(text: str) -> str:
    t = re.sub(r"https?://\S+", "", text or "")
    t = re.sub(r"\[\d+\](\[\d+\])*", "", t)
    t = t.replace("&", " and ").replace("%", " percent").replace("U.S.", "US").replace("—", ", ").replace("–", " to ")
    t = re.sub(r"[\"“”*_#]", "", t)
    return re.sub(r"\s+", " ", t).strip()


def script(data: dict, now: datetime) -> list[dict]:
    """Chapters: an opening, then one per story in Today's order of importance."""
    items = {it["id"]: it for it in data.get("items", [])}
    threads = {t["id"]: t for t in data.get("threads", [])}
    labels = {p.get("story"): p.get("label") for p in (data.get("day_so_far") or {}).get("parts", [])}
    cutoff = now - timedelta(hours=36)

    def recent(s):
        try:
            return datetime.fromisoformat(str(s.get("last")).replace("Z", "+00:00")) >= cutoff
        except ValueError:
            return False

    pool = [s for s in data.get("stories", []) if s.get("desk") != "SPORTS" and (s.get("what") or s.get("card") or s.get("summary")) and recent(s)]
    order = [s for s in pool if s.get("followed")]
    order += [s for s in pool if s["id"] in labels and s not in order]
    order += [s for s in pool if s.get("desk") in ("BEACON", "GOV", "LAW") and s not in order][:3]
    order += [s for s in pool if s not in order]
    local = now.astimezone(NY)
    when = local.strftime("%-I:%M in the %p").replace("AM", "morning").replace("PM", "afternoon" if local.hour < 17 else "evening")
    chapters = [{"label": "The Wire", "title": local.strftime("The Wire · %A, %B %-d"),
                 "say": f"This is The Wire for {local.strftime('%A, %B %-d')}, as of {when}."}]
    words = len(chapters[0]["say"].split())
    for s in order:
        if len(chapters) > MAX_CHAPTERS:
            break
        body = _clean(s.get("what") or s.get("card") or s.get("summary") or "")
        latest = _clean(s.get("latest") or "")
        if latest and latest[:60] not in body:
            body = f"{body} The latest: {latest}"
        lead = items.get(s.get("lead")) or {}
        label = labels.get(s["id"]) or (threads.get(s.get("thread")) or {}).get("title") or s.get("desk", "").title()
        label = _clean(label)[:60]
        say = f"{label}. {body}"
        n = len(say.split())
        if words + n > MAX_WORDS:
            continue
        words += n
        chapters.append({"label": label, "title": lead.get("title") or label, "story": s["id"], "thread": s.get("thread"), "say": say})
    chapters.append({"label": "End", "title": "End of the edition", "say": "That's The Wire. Open the page for sources and the full story on anything you heard."})
    return chapters


# ------------------------------------------------------------------ MP3 handling
_BITRATES = {  # (version_bit, layer_bits) -> kbps table index 1..14 ; MPEG-1 L3 and MPEG-2/2.5 L3
    "1": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    "2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
_RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def _strip_tags(b: bytes) -> bytes:
    if b[:3] == b"ID3" and len(b) > 10:
        size = (b[6] & 0x7F) << 21 | (b[7] & 0x7F) << 14 | (b[8] & 0x7F) << 7 | (b[9] & 0x7F)
        b = b[10 + size + (10 if b[5] & 0x10 else 0):]
    if len(b) > 128 and b[-128:-125] == b"TAG":
        b = b[:-128]
    return b


def mp3_frames(b: bytes) -> tuple[bytes, float]:
    """Layer III frames only (no Xing/Info header frames), and their duration in seconds."""
    b = _strip_tags(b)
    out, secs, i = bytearray(), 0.0, 0
    while i + 4 <= len(b):
        h = b[i:i + 4]
        if h[0] != 0xFF or (h[1] & 0xE0) != 0xE0:
            i += 1
            continue
        ver = (h[1] >> 3) & 3          # 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
        layer = (h[1] >> 1) & 3        # 1 = Layer III
        bri, sri, pad = h[2] >> 4, (h[2] >> 2) & 3, (h[2] >> 1) & 1
        if ver == 1 or layer != 1 or bri in (0, 15) or sri == 3:
            i += 1
            continue
        kbps = _BITRATES["1" if ver == 3 else "2"][bri]
        rate = _RATES[ver][sri]
        samples = 1152 if ver == 3 else 576
        length = (samples // 8) * kbps * 1000 // rate + pad
        if length < 4 or i + length > len(b):
            break
        frame = b[i:i + length]
        if b"Xing" not in frame[:64] and b"Info" not in frame[:64] and b"VBRI" not in frame[:64]:
            out += frame
            secs += samples / rate
        i += length
    return bytes(out), secs


# ------------------------------------------------------------------ TTS
def _chunks(text: str) -> list[str]:
    parts, cur = [], ""
    for s in re.split(r"(?<=[.!?])\s+", text):
        if cur and len(cur) + len(s) + 1 > CHUNK_CHARS:
            parts.append(cur)
            cur = s
        else:
            cur = (cur + " " + s).strip()
    if cur:
        parts.append(cur)
    out = []
    for p in parts:                      # a single long sentence: split at commas
        while len(p) > CHUNK_CHARS * 1.5:
            cut = p.rfind(", ", 0, CHUNK_CHARS)
            cut = cut if cut > 50 else CHUNK_CHARS
            out.append(p[:cut + 1])
            p = p[cut + 1:].strip()
        out.append(p)
    return [p for p in out if p.strip()]


def tts(session, text: str) -> bytes:
    acct, token = os.environ.get("CLOUDFLARE_ACCOUNT_ID"), os.environ.get("CLOUDFLARE_API_TOKEN")
    if not acct or not token:
        raise RuntimeError("Cloudflare account ID or API token not set")
    r = session.post(f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/{MODEL}",
                     headers={"Authorization": f"Bearer {token}"}, json={"prompt": text, "lang": "en"}, timeout=90)
    ctype = r.headers.get("content-type", "")
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    if ctype.startswith("audio/"):
        return r.content
    body = r.json()
    if not body.get("success", True):
        raise RuntimeError(("; ".join(e.get("message", "") for e in body.get("errors", [])) or "failed")[:160])
    res = body.get("result", body)
    audio = res.get("audio") if isinstance(res, dict) else None
    if not audio:
        raise RuntimeError("no audio in the response")
    return base64.b64decode(audio)


# ------------------------------------------------------------------ run
def run(state: dict, data: dict, session, dist: Path, log) -> dict:
    now = datetime.now(timezone.utc)
    st = state.setdefault("listen", {})
    today = now.date().isoformat()
    if st.get("day") != today:
        st.update({"day": today, "neurons": 0.0})
    row = {"id": "listen", "name": "Audio edition (Cloudflare MeloTTS)", "short": "Audio edition", "desk": "SYSTEM", "poll": LISTEN_EVERY_MIN,
           "last_success": st.get("at"), "last_attempt": st.get("tried"), "last_error": st.get("error"), "last_status": None, "robots": "n/a",
           "items": len(st.get("chapters") or [])}
    chapters = script(data, now)
    text = "\n".join(c["say"] for c in chapters if c.get("story"))
    digest = hashlib.sha1(text.encode()).hexdigest()
    last = datetime.fromisoformat(st["at"]) if st.get("at") else None
    est = sum(len(c["say"].split()) for c in chapters) / 150 * NEURONS_PER_MIN
    due = (digest != st.get("hash") and len(chapters) > 3
           and (not last or now - last >= timedelta(minutes=LISTEN_EVERY_MIN))
           and now.astimezone(NY).hour not in QUIET_HOURS
           and st["neurons"] + est <= LISTEN_DAILY_NEURONS)
    (dist / "listen.mp3").unlink(missing_ok=True)
    if due:
        st["tried"] = now.isoformat()
        try:
            audio, t, out = bytearray(), 0.0, []
            for c in chapters:
                start = t
                for piece in _chunks(c["say"]):
                    frames, secs = mp3_frames(tts(session, piece))
                    if not frames:
                        raise RuntimeError("the voice returned no MP3 frames")
                    audio += frames
                    t += secs
                out.append({k: c[k] for k in ("label", "title", "story", "thread") if c.get(k)} | {"t": round(start, 2)})
            (dist / "listen.mp3").write_bytes(bytes(audio))
            st.update({"hash": digest, "at": now.isoformat(), "chapters": out, "seconds": round(t, 1), "bytes": len(audio),
                       "v": digest[:10], "error": None})
            st["neurons"] += t / 60 * NEURONS_PER_MIN
            log(f"[listen] new edition: {len(out)} chapters, {t / 60:.1f} min, {len(audio) // 1024} KB")
        except Exception as exc:
            st["error"] = f"{type(exc).__name__}: {exc}"[:240]
            log(f"[listen] {type(exc).__name__}")
    if st.get("chapters"):
        data["listen"] = {k: st.get(k) for k in ("at", "chapters", "seconds", "v")}
    row.update({"last_success": st.get("at"), "last_attempt": st.get("tried"), "last_error": st.get("error"), "items": len(st.get("chapters") or [])})
    return row
