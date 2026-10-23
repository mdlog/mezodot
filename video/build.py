"""Assembles out/mezodot-demo.mp4: each beat's screencast frames become an exact-length 30 fps clip, the clips are
joined, the narration is laid on each clip's start (padded to the clip's length), and the captions are burned in.
Also writes youtube.md with chapters from the timeline.

    python3 video/build.py
"""

import json
import subprocess
from pathlib import Path

VIDEO = Path(__file__).resolve().parent
OUT = VIDEO / "out"
BUILD = OUT / "build"
FFMPEG = str(Path.home() / ".local/bin/ffmpeg")
FINAL = OUT / "mezodot-demo.mp4"


def ff(*args: str, cwd: Path | None = None) -> None:
    subprocess.run([FFMPEG, "-v", "error", "-y", *args], check=True, cwd=cwd)


def frame_list(clip: dict) -> Path:
    """ffconcat list showing, from t0 to t0 + length, whichever screencast frame was on screen."""
    d = Path(clip["dir"])
    frames = json.loads((d / "frames.json").read_text())
    t0, t1 = clip["t0"], clip["t0"] + clip["durMs"] / 1000
    first = max((i for i, f in enumerate(frames) if f["t"] <= t0), default=0)
    sel = [f for f in frames[first:] if f["t"] < t1]
    lines = ["ffconcat version 1.0"]
    for k, f in enumerate(sel):
        start = t0 if k == 0 else f["t"]
        end = sel[k + 1]["t"] if k + 1 < len(sel) else t1
        if end - start <= 0:
            continue
        lines += [f"file '{d / f['name']}'", f"duration {end - start:.4f}"]
    lines.append(f"file '{d / sel[-1]['name']}'")
    out = BUILD / f"{clip['id']}.ffconcat"
    out.write_text("\n".join(lines) + "\n")
    return out


def normalize(src: Path, dst: Path) -> None:
    """Two-pass EBU R128 loudness normalisation to YouTube's -14 LUFS (true peak -1.5 dBTP): edge-tts speech comes out
    near -20 LUFS, which YouTube plays back quieter than everything around it."""
    target = "I=-14:TP=-1.5:LRA=11"
    probe = subprocess.run([FFMPEG, "-hide_banner", "-i", str(src), "-af", f"loudnorm={target}:print_format=json", "-f", "null", "-"],
                           capture_output=True, text=True, check=True).stderr
    m = json.loads(probe[probe.rindex("{"):probe.rindex("}") + 1])
    ff("-i", str(src), "-af",
       f"loudnorm={target}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
       f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true,aresample=48000",
       "-c:a", "pcm_s16le", str(dst))


EXPLORER = {31611: "https://explorer.test.mezo.org/tx/", 84532: "https://base-sepolia.blockscout.com/tx/",
            11155111: "https://eth-sepolia.blockscout.com/tx/"}


def transactions(timeline: list[dict]) -> str:
    """Every transaction filmed, with its explorer link, so a viewer can check what the video shows."""
    rows = [f"- {clip['chapter'].replace(' (live tx)', '')}: {EXPLORER[tx['chainId']]}{tx['hash']}"
            for clip in timeline for tx in clip.get("txs", [])]
    return "\n".join(rows) or "- (none)"


def chapters(timeline: list[dict]) -> str:
    rows, at = [], 0.0
    for clip in timeline:
        s = int(at)
        rows.append(f"{s // 60}:{s % 60:02d} {clip['chapter']}")
        at += clip["durMs"] / 1000
    return "\n".join(rows)


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    timeline = json.loads((OUT / "timeline.json").read_text())
    take = json.loads((OUT / "take.json").read_text())

    parts = []
    for clip in timeline:
        mp4 = BUILD / f"{clip['id']}.mp4"
        ff("-f", "concat", "-safe", "0", "-i", str(frame_list(clip)),
           "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p",
           "-t", f"{clip['durMs'] / 1000:.3f}", "-an", "-c:v", "libx264", "-crf", "16", "-preset", "medium", str(mp4))
        parts.append(mp4)
    (BUILD / "video.ffconcat").write_text("ffconcat version 1.0\n" + "".join(f"file '{p}'\n" for p in parts))
    ff("-f", "concat", "-safe", "0", "-i", str(BUILD / "video.ffconcat"), "-c", "copy", str(BUILD / "video.mp4"))

    inputs, chains = [], []
    for i, clip in enumerate(timeline):
        inputs += ["-i", str(OUT / "tts" / f"{clip['id']}.mp3")]
        dur = clip["durMs"] / 1000
        chains.append(f"[{i}:a]aresample=48000,apad=whole_dur={dur:.3f},atrim=0:{dur:.3f}[a{i}]")
    graph = ";".join(chains) + ";" + "".join(f"[a{i}]" for i in range(len(timeline))) + f"concat=n={len(timeline)}:v=0:a=1[out]"
    ff(*inputs, "-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_s16le", str(BUILD / "narration.wav"))
    normalize(BUILD / "narration.wav", BUILD / "audio.wav")

    # libass resolves the subtitle path relative to the working directory: run from out/.
    ff("-i", str(BUILD / "video.mp4"), "-i", str(BUILD / "audio.wav"), "-vf", "ass=captions.ass",
       "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p", "-r", "30",
       "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-shortest", str(FINAL), cwd=OUT)

    (OUT / "youtube.md").write_text(f"""# YouTube upload

**Title** (≤ 80 characters)

Mezodot: omnichain MUSD & MEZO money market on Mezo (Buildathon demo)

**Description**

Mezodot is an omnichain money market native to Mezo. Supply MUSD or MEZO for ERC-4626 pMUSD / pMEZO, borrow against BTC on Mezo or WETH / USDC that stays on Base Sepolia or Ethereum Sepolia (Wormhole-verified collateral), open a BTC long through a Tigris flash swap or a 1-click MUSD loop in one transaction. Permissionless keepers relay and liquidate; an MCP server exposes risk to AI agents. Live on Mezo testnet; not audited.

Every transaction in the video is real, sent on camera from a fresh demo wallet:

{transactions(timeline)}

Shown in this take ({take['at'][:10]}): {take['contracts']['passed']} contract tests passing, the live deployment check passing {take['deployment']['passed']} checks, and {take['sourcify']['exact']}/{take['sourcify']['total']} contracts exact-matched on Sourcify.

Code: https://github.com/mdlog/mezodot
Mezo Buildathon · Track 1 (DeFi: borrowing, lending, looping, yield)

**Chapters**

{chapters(timeline)}

**Captions**: upload `mezodot-demo.srt` (English).
""")
    print(f"built {FINAL}")


if __name__ == "__main__":
    main()
