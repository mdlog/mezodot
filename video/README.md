# Demo video

A narrated 1080p MP4 of the live testnet app, produced entirely by this pipeline: no screen recorder, no display,
no human voice. Re-shoot it whenever what is on screen changes. The narration is the clock: every on-screen action
is anchored to a phrase in the voice's word timings, and every number the voice says is read live.

Every transaction in the video is real, sent on camera from a demo wallet (never the owner key). The wallet's
key lives in `video/.secrets/demo.json`, which is git-ignored. Recorded pages see it as an injected EIP-1193 wallet
whose transactions and typed messages are signed in this Node process, so the key never enters the browser.

## Prerequisites

- The web app on `http://127.0.0.1:3000` and the Mezodot agent on `127.0.0.1:8787`, both on testnet (the agent serves
  the price proofs).
- Chromium 1243 in `~/.cache/ms-playwright`, `~/.local/bin/ffmpeg`, the Inter and DejaVu Sans Mono fonts.
- The narration venv: `python3 -m venv video/.venv && video/.venv/bin/pip install edge-tts`.
- The deployer keystore in `.secrets/` (only for `wallet.mjs fund`).
- `jq` and `cast`, used by `select.mjs`.

## Take

```bash
pm2 restart mezodot-agent                  # the agent must run the current code, or select.mjs cannot name the oracle legs
node video/select.mjs                      # live facts → out/take.json; refuses failing tests, checks or verification
node video/wallet.mjs prepare              # what the BTC long and the trove close need, done off camera
video/.venv/bin/python video/tts.py        # narration per beat + word timings; re-renders faster if over budget
node video/record.mjs --connect            # connect the demo wallet through the app's own dialog, keep the session
node video/record.mjs --probe              # every selector and anchor resolves; sends nothing
node video/record.mjs intro trove-open trove-close mezo-borrow btc-long crosschain checks proof revenue outro
python3 video/captions.py                  # burned-in captions + mezodot-demo.srt
python3 video/build.py                     # out/mezodot-demo.mp4 (-14 LUFS) + out/youtube.md
bash video/verify.sh                       # ≤ 2:15, 1080p30, AAC; writes out/contact.png: read it before uploading
```

**Funding.** The demo wallet needs `PLAN.fund` before a take: 0.056 BTC and 6 MUSD. A trove needs more BTC than the deployer holds, so send the BTC by hand. It comes back when the trove closes, so a retake costs about 2 MUSD. `trove-open` must be filmed before `trove-close`, and needs a wallet with no open trove.

The borrow and BTC-long beats wait off camera for a fresh MUSD and MEZO price (Mezo pushes them about hourly), because a borrow reverts on a stale one. A beat whose transaction fails on camera, or that shows an error, is refused: fix and refilm that beat only (`node video/record.mjs <beat>`). Amounts are in `plan.mjs`; the narration reads them from there.

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
