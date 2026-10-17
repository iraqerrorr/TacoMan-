#!/usr/bin/env bash
#
# encode-videos.sh — turn your original videos into web-ready 4K + 1080p files
# that stream properly from GitHub Pages.
#
#   tools/encode-videos.sh [SOURCE_DIR] [OUTPUT_DIR]
#
#   SOURCE_DIR  where your original videos are      (default: originals)
#   OUTPUT_DIR  where the encoded files are written  (default: assets)
#
# For every video in SOURCE_DIR (mp4, mov, mkv, webm, m4v) it writes
#   <name>_2160p.mp4   (only if the original is at least ~4K tall; never upscaled)
#   <name>_1080p.mp4
#
# Name your originals after what the page expects, e.g.
#   background.mp4  hacker_background.mp4  rain_background.mov
#   anime_background.mp4  car_background.mp4
#
# What the encode does, and why:
#   -movflags +faststart   moves the index to the front so playback starts
#                          immediately and seeking works over HTTP range requests
#   H.264 High + yuv420p   plays in every browser; 4K needs hardware decode on
#                          most devices, which H.264 has almost everywhere
#   -an                    drops the audio track (the page mutes the video anyway)
#   size cap               each file is kept under MAX_MB so it can be pushed to
#                          GitHub (hard limit 100 MB per file, warning at 50 MB)
#   fps cap                60 fps 4K is very heavy for a background loop, so the
#                          default is 30. Set FPS_CAP=60 to keep 60.
#
# Tunables (environment variables):
#   MAX_MB=45     maximum size per output file, in megabytes
#   FPS_CAP=30    maximum frame rate
#   BR_2160=12000 target bitrate for 4K,    in kbit/s
#   BR_1080=5000  target bitrate for 1080p, in kbit/s
#   PRESET=slow   x264 preset (slower = smaller file, longer encode)
#
set -euo pipefail

SRC="${1:-originals}"
OUT="${2:-assets}"
MAX_MB="${MAX_MB:-45}"
FPS_CAP="${FPS_CAP:-30}"
BR_2160="${BR_2160:-12000}"
BR_1080="${BR_1080:-5000}"
PRESET="${PRESET:-slow}"

for tool in ffmpeg ffprobe awk; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found. Install ffmpeg first." >&2; exit 1; }
done
[ -d "$SRC" ] || { echo "error: source folder '$SRC' doesn't exist. Put your original videos there." >&2; exit 1; }
mkdir -p "$OUT"

probe() { ffprobe -v error -select_streams v:0 -show_entries "stream=$1" -of default=nw=1:nk=1 "$2" | head -n1; }

# encode <input> <output> <height> <target_kbps> <duration_s> <src_height> <src_fps>
encode() {
  local in="$1" out="$2" h="$3" target="$4" dur="$5" src_h="$6" src_fps="$7"

  # Highest bitrate that still fits under MAX_MB (8% headroom for container + rate-control slack).
  local cap
  cap=$(awk -v mb="$MAX_MB" -v d="$dur" 'BEGIN { printf "%d", (mb * 8 * 1024 * 0.92) / d }')   # kbit/s
  local br=$(( target < cap ? target : cap ))
  if (( br < target )); then
    echo "    note: ${dur%.*}s clip → bitrate lowered from ${target}k to ${br}k to stay under ${MAX_MB} MB"
  fi

  # Scale down only, never up. Add an fps filter only if the source is faster than the cap.
  local vf="scale=w='if(gt(ih,${h}),-2,iw)':h='if(gt(ih,${h}),${h},ih)':flags=lanczos"
  if awk -v f="$src_fps" -v c="$FPS_CAP" 'BEGIN { exit !(f > c + 0.5) }'; then
    vf="${vf},fps=${FPS_CAP}"
  fi
  vf="${vf},format=yuv420p"

  ffmpeg -hide_banner -loglevel error -stats -y -i "$in" \
    -an -map_metadata -1 \
    -vf "$vf" \
    -c:v libx264 -preset "$PRESET" -profile:v high -crf 23 \
    -maxrate "${br}k" -bufsize "${br}k" \
    -movflags +faststart \
    "$out"

  local bytes mb
  bytes=$(wc -c < "$out" | tr -d ' ')
  mb=$(awk -v b="$bytes" 'BEGIN { printf "%.1f", b / 1048576 }')
  echo "    → $out  (${mb} MB)"
  if awk -v m="$mb" 'BEGIN { exit !(m > 95) }'; then
    echo "    WARNING: over 95 MB. GitHub rejects files over 100 MB. Lower MAX_MB or BR_${h}." >&2
  elif awk -v m="$mb" 'BEGIN { exit !(m > 50) }'; then
    echo "    warning: over 50 MB. GitHub will warn when you push this." >&2
  fi
}

shopt -s nullglob nocaseglob
count=0
for f in "$SRC"/*.mp4 "$SRC"/*.mov "$SRC"/*.mkv "$SRC"/*.webm "$SRC"/*.m4v; do
  base="$(basename "$f")"
  stem="${base%.*}"
  case "$stem" in *_2160p|*_1080p) continue ;; esac   # don't re-encode our own output

  src_h="$(probe height "$f")"
  fr="$(probe avg_frame_rate "$f")"
  src_fps="$(awk -v r="$fr" 'BEGIN { split(r, a, "/"); print (a[2] > 0) ? a[1] / a[2] : a[1] }')"
  dur="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" | head -n1)"

  echo "• $base  (${src_h}p, ${src_fps%.*} fps, ${dur%.*}s)"
  count=$(( count + 1 ))

  if (( src_h >= 2000 )); then
    encode "$f" "$OUT/${stem}_2160p.mp4" 2160 "$BR_2160" "$dur" "$src_h" "$src_fps"
  else
    echo "    skipping 2160p: source is only ${src_h}p and won't be upscaled"
  fi
  encode "$f" "$OUT/${stem}_1080p.mp4" 1080 "$BR_1080" "$dur" "$src_h" "$src_fps"
done

if (( count == 0 )); then
  echo "No videos found in '$SRC'." >&2
  exit 1
fi
echo "Done. Commit the *_2160p.mp4 and *_1080p.mp4 files in '$OUT'."
