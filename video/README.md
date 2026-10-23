# Demo video

A narrated 1080p MP4 of the live testnet app, produced entirely by this pipeline: no screen recorder, no display,
no human voice. Re-shoot it whenever what is on screen changes. The narration is the clock: every on-screen action
is anchored to a phrase in the voice's word timings, and every number the voice says is read live.

Every transaction in the video is real, sent on camera from a fresh demo wallet (never the owner key). The wallet's
key lives in `video/.secrets/demo.json`, which is git-ignored. Recorded pages see it as an injected EIP-1193 wallet
whose transactions are signed in this Node process, so the key never enters the browser.

## Prerequisites

- The web app on `http://127.0.0.1:3000` and the Mezodot agent on `127.0.0.1:8787`, both on testnet (the agent relays
  the cross-chain message).
- Chromium 1243 in `~/.cache/ms-playwright`, `~/.local/bin/ffmpeg`, the Inter and DejaVu Sans Mono fonts.
- The narration venv: `python3 -m venv video/.venv && video/.venv/bin/pip install edge-tts`.
- The deployer keystore in `.secrets/` (only for `wallet.mjs fund`).

## Take

```bash
node video/select.mjs                      # live facts → out/take.json; refuses failing tests/checks or a missing Sourcify match
node video/wallet.mjs fund                 # top up the demo wallet from the deployer keystore (plan.mjs: fund)
node video/wallet.mjs prepare              # operators, allowances, WETH on Base Sepolia: done off camera
video/.venv/bin/python video/tts.py        # narration per beat + word timings; re-renders faster if over 1:58
node video/record.mjs --connect            # connect the demo wallet through the app's own dialog, keep the session
node video/record.mjs --probe              # every selector and anchor resolves; sends nothing
node video/record.mjs lock                 # first: starts Base finality (~20 min) for the credit beat
node video/record.mjs intro supply loop btc-long position proof outro
node video/record.mjs credit activity      # waits off camera until the lock is delivered on the hub
python3 video/captions.py                  # burned-in captions + mezodot-demo.srt
python3 video/build.py                     # out/mezodot-demo.mp4 (-14 LUFS) + out/youtube.md
bash video/verify.sh                       # ≤ 2:00, 1080p30, AAC; writes out/contact.png: read it before uploading
```

The loop and BTC-long beats wait off camera for a fresh MUSD price (Mezo pushes it about hourly), because a borrow
reverts on a stale one. A beat whose transaction fails on camera, or that shows an error, is refused: fix and refilm
that beat only (`node video/record.mjs <beat>`). Amounts are in `plan.mjs`; the narration reads them from there.

## Files

| File                         | Does                                                                       |
| ---------------------------- | -------------------------------------------------------------------------- |
| `beats.mjs`                  | Beats: route, narration, anchored actions, the off-camera waits            |
| `plan.mjs`                   | What the demo wallet does and holds                                        |
| `select.mjs`, `sourcify.mjs` | Live facts for the narration and the proof beat                            |
| `wallet.mjs`                 | Demo key, funding, approvals, the injected wallet and its Node-side signer |
| `tts.py`                     | edge-tts narration and per-token timings                                   |
| `record.mjs`, `scenes.mjs`   | Chrome screencast per beat; cursor, lower third, terminal and closing card |
| `captions.py`, `build.py`    | Captions, assembly, loudness, YouTube description with every filmed tx     |
| `verify.sh`                  | Final checks and the contact sheet                                         |

`out/` (frames, audio, the MP4) is git-ignored: commit the pipeline, never the video.
