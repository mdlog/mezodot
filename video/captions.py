"""Captions burned into the video (ASS) and uploaded next to it (SRT), timed from the narration's token times, plus a
route chip (bottom left, clear of the app's toasts) naming what is on screen.

    python3 video/captions.py
"""

import json
from pathlib import Path

OUT = Path(__file__).resolve().parent / "out"
LINE = 42  # characters per line, at most two lines per cue
MIN_CUE_S = 1.2
ENDS = (".", "?", "!", ":", ";")

HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Inter,44,&H00FFFFFF,&H00FFFFFF,&H331F1311,&H00000000,0,0,0,0,100,100,0,0,3,14,0,2,200,200,64,1
Style: Chip,DejaVu Sans Mono,24,&H00FFFFFF,&H00FFFFFF,&H331F1311,&H00000000,0,0,0,0,100,100,0,0,3,8,0,1,40,40,26,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def ass_time(s: float) -> str:
    cs = int(round(s * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def srt_time(s: float) -> str:
    ms = int(round(s * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def two_lines(words: list[str]) -> str:
    """The cue's words on one line, or on two lines broken nearest the middle."""
    text = " ".join(words)
    if len(text) <= LINE:
        return text
    best = min(range(1, len(words)), key=lambda k: abs(len(" ".join(words[:k])) - len(" ".join(words[k:]))))
    return " ".join(words[:best]) + "\n" + " ".join(words[best:])


def length(toks: list[dict]) -> int:
    return len(" ".join(t["w"] for t in toks))


def split_sentence(sent: list[dict]) -> list[list[dict]]:
    """A sentence longer than one cue becomes balanced cues, preferring breaks after a comma; never a lone word."""
    if length(sent) <= 2 * LINE or len(sent) < 4:
        return [sent]
    n = -(-length(sent) // (2 * LINE))
    target = length(sent) / n

    def cost(k: int) -> float:
        return abs(length(sent[:k]) - target) - (12 if sent[k - 1]["w"].endswith(",") else 0)

    k = min(range(2, len(sent) - 1), key=cost)
    return [sent[:k], *split_sentence(sent[k:])]


def cues(tokens: list[dict], offset: float) -> list[tuple[float, float, str]]:
    sentences, cur = [], []
    for tok in tokens:
        cur.append(tok)
        if tok["w"].endswith(ENDS):
            sentences.append(cur)
            cur = []
    if cur:
        sentences.append(cur)
    out = [cue for sent in sentences for cue in split_sentence(sent)]
    timed = []
    for i, c in enumerate(out):
        start, end = c[0]["s"] + offset, c[-1]["e"] + offset + 0.15
        nxt = out[i + 1][0]["s"] + offset if i + 1 < len(out) else None
        end = max(end, start + MIN_CUE_S)
        if nxt is not None:
            end = min(end, nxt - 0.02)
        timed.append((start, end, two_lines([t["w"] for t in c])))
    return timed


def main() -> None:
    beats = {b["id"]: b for b in json.loads((OUT / "beats.json").read_text())}
    timeline = json.loads((OUT / "timeline.json").read_text())
    events, srt, at = [], [], 0.0
    for clip in timeline:
        dur = clip["durMs"] / 1000
        words = json.loads((OUT / "tts" / f"{clip['id']}.json").read_text())
        for start, end, text in cues(words["tokens"], at):
            events.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Cap,,0,0,0,,{text.replace(chr(10), r'\N')}")
            srt.append((start, end, text))
        events.append(f"Dialogue: 1,{ass_time(at)},{ass_time(at + dur)},Chip,,0,0,0,,{beats[clip['id']]['chip']}")
        at += dur
    (OUT / "captions.ass").write_text(HEADER + "\n".join(events) + "\n")
    (OUT / "mezodot-demo.srt").write_text(
        "\n".join(f"{i}\n{srt_time(s)} --> {srt_time(e)}\n{t}\n" for i, (s, e, t) in enumerate(srt, 1)))
    print(f"captions: {len(srt)} cues over {at:.1f}s")


if __name__ == "__main__":
    main()
