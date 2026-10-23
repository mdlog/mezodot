"""Narration: one MP3 per beat (edge-tts, en-US-AndrewNeural) plus the time of every written token, so record.mjs can
anchor actions to phrases and captions.py can time cues. Measures the take and re-renders faster once if it would run
over the budget.

    video/.venv/bin/python video/tts.py
"""

import asyncio
import difflib
import json
import re
import subprocess
import sys
from pathlib import Path

import edge_tts

VIDEO = Path(__file__).resolve().parent
OUT = VIDEO / "out"
TTS = OUT / "tts"
VOICE = "en-US-AndrewNeural"
TAIL_S = 0.4  # a clip holds this long after its narration ends, unless its beat sets tailMs
BUDGET_S = 118.0  # the event asks for a 2-minute video; keep a margin
FFPROBE = Path.home() / ".local/bin/ffprobe"


def norm(word: str) -> str:
    return re.sub(r"[^a-z0-9]", "", word.lower())


async def synth(text: str, rate: str, mp3: Path) -> list[dict]:
    """Writes the MP3 and returns the word boundaries (seconds)."""
    com = edge_tts.Communicate(text, VOICE, rate=rate, boundary="WordBoundary")
    words = []
    with mp3.open("wb") as f:
        async for chunk in com.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                start = chunk["offset"] / 1e7
                words.append({"w": chunk["text"], "s": start, "e": start + chunk["duration"] / 1e7})
    return words


def align(tokens: list[dict], bounds: list[dict]) -> list[dict]:
    """Times of each written token from the voice's word boundaries; spoken sub-words map back to their token."""
    spoken = [(i, w) for i, t in enumerate(tokens) for w in t["words"] if norm(w)]
    a = [norm(w) for _, w in spoken]
    b = [norm(x["w"]) for x in bounds]
    at: list[int | None] = [None] * len(a)
    for blk in difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
        for k in range(blk.size):
            at[blk.a + k] = blk.b + k
    # A spoken word the voice reported differently takes its neighbours' boundary.
    for k in range(len(at)):
        if at[k] is None:
            prev = next((at[j] for j in range(k - 1, -1, -1) if at[j] is not None), None)
            nxt = next((at[j] for j in range(k + 1, len(at)) if at[j] is not None), None)
            at[k] = prev if prev is not None else nxt
    times = []
    for i, t in enumerate(tokens):
        idx = [at[k] for k, (ti, _) in enumerate(spoken) if ti == i and at[k] is not None]
        if not idx:
            times.append(None)
            continue
        times.append({"w": t["written"], "s": round(bounds[min(idx)]["s"], 3), "e": round(bounds[max(idx)]["e"], 3)})
    # A token without a spoken word (rare) inherits the previous token's end.
    for i, x in enumerate(times):
        if x is None:
            prev_end = times[i - 1]["e"] if i and times[i - 1] else 0.0
            times[i] = {"w": tokens[i]["written"], "s": prev_end, "e": prev_end}
    return times


def duration(mp3: Path) -> float:
    out = subprocess.run([str(FFPROBE), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(mp3)],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


async def render(beats: list[dict], rate: str) -> float:
    total = 0.0
    for b in beats:
        mp3 = TTS / f"{b['id']}.mp3"
        bounds = await synth(b["spoken"], rate, mp3)
        dur = duration(mp3)
        tokens = align(b["tokens"], bounds)
        (TTS / f"{b['id']}.json").write_text(json.dumps({"id": b["id"], "rate": rate, "duration": dur, "tokens": tokens}, indent=1))
        clip = max(dur + b.get("tailMs", TAIL_S * 1000) / 1000, b["minMs"] / 1000)
        total += clip
        print(f"  {b['id']:13s} audio {dur:5.1f}s  clip {clip:5.1f}s  words {len(tokens)}")
    return total


def main() -> None:
    TTS.mkdir(parents=True, exist_ok=True)
    subprocess.run(["node", str(VIDEO / "beats.mjs"), str(OUT / "take.json"), str(OUT / "beats.json")], check=True)
    beats = json.loads((OUT / "beats.json").read_text())
    for rate in ("+0%", "+6%"):
        print(f"rate {rate}")
        total = asyncio.run(render(beats, rate))
        print(f"projected length {total:.1f}s (budget {BUDGET_S:.0f}s)")
        if total <= BUDGET_S:
            (TTS / "summary.json").write_text(json.dumps({"rate": rate, "projected": round(total, 2)}))
            return
    sys.exit("over budget even at +6%: cut narration (start with the architecture beat)")


if __name__ == "__main__":
    main()
