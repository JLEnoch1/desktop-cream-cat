#!/usr/bin/env bash
# 冒烟启动脚本。
# 默认直接启动；若处于受限环境（沙箱/无 GPU/远程会话），加 --compat 参数：
#   ./smoke.sh          正常启动
#   ./smoke.sh --compat 禁用 sandbox/GPU 启动（CI、受限环境验证用）
set -e
cd "$(dirname "$0")"

unset ELECTRON_RUN_AS_NODE   # 关键：否则 Electron 退化为纯 Node，窗口不出现

ELECTRON="./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$ELECTRON" ]; then
  ELECTRON="./node_modules/.bin/electron"
fi

npm run build >/dev/null

if [ "$1" = "--compat" ]; then
  exec "$ELECTRON" . --no-sandbox --disable-gpu --disable-software-rasterizer "${@:2}"
else
  exec "$ELECTRON" . "$@"
fi
