#!/usr/bin/env bash
# Checks the finished take: at most 2:00, 1920x1080 at 30 fps, AAC audio, captions file present; writes a contact
# sheet (one frame every 5 s) to read before calling the take done.
#
#   bash video/verify.sh
set -euo pipefail
OUT="$(cd "$(dirname "$0")" && pwd)/out"
MP4="$OUT/mezodot-demo.mp4"
PROBE="$HOME/.local/bin/ffprobe"
FFMPEG="$HOME/.local/bin/ffmpeg"

fail() { echo "FAIL: $*"; exit 1; }
[ -s "$MP4" ] || fail "no $MP4"
[ -s "$OUT/mezodot-demo.srt" ] || fail "no captions file"

dur=$("$PROBE" -v error -show_entries format=duration -of csv=p=0 "$MP4")
video=$("$PROBE" -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate -of csv=p=0 "$MP4")
audio=$("$PROBE" -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate -of csv=p=0 "$MP4")
echo "duration ${dur}s | video ${video} | audio ${audio}"
awk -v d="$dur" 'BEGIN { exit !(d <= 120.0) }' || fail "longer than 2:00"
[ "$video" = "h264,1920,1080,30/1" ] || fail "video stream is $video"
[ "$audio" = "aac,48000" ] || fail "audio stream is $audio"

"$FFMPEG" -v error -y -i "$MP4" -vf "fps=1/5,scale=480:-1,tile=5x5:padding=6:margin=6" -frames:v 1 "$OUT/contact.png"
echo "contact sheet: $OUT/contact.png"
echo "ok"
