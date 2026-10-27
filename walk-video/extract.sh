#!/usr/bin/env bash
# 视频抽帧（简报 §10 步骤3）: ./extract.sh <视频文件> [fps，默认15]
set -euo pipefail
in="${1:?用法: extract.sh <walk.mp4> [fps]}"
fps="${2:-15}"
[ -f "$in" ] || { echo "找不到文件: $in"; exit 1; }
name="$(basename "${in%.*}")"
out="$(cd "$(dirname "$in")" && pwd)/frames-${name}-${fps}fps"
mkdir -p "$out"
ffmpeg -hide_banner -loglevel error -stats -i "$in" -vf fps="$fps" "$out/f%03d.png"
n="$(ls "$out" | wc -l | tr -d ' ')"
echo "✓ ${n} 帧 → $out"
