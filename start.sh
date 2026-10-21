#!/usr/bin/env bash
# 启动桌面精力宠物（脱离父进程组，关闭终端也不会退出应用）
#
# 用法：
#   ./start.sh          正常桌面环境启动
#   ./start.sh --debug  带沙箱兼容参数（无 GPU / 受限环境）
#
# 说明：直接用 nohup 启动时，父 shell 退出会给进程组发 SIGHUP/SIGTERM，
# 应用会跟着「莫名消失」。这里用 node 的 detached spawn 彻底脱离进程组。

set -euo pipefail
cd "$(dirname "$0")"

BIN="./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [[ ! -x "$BIN" ]]; then
  echo "Electron 未安装，请先执行：npm install"
  exit 1
fi

# 构建产物不存在则先构建
if [[ ! -f dist/main/index.js ]]; then
  echo "首次启动，正在构建…"
  node scripts/build.mjs
fi

ARG_LIST=(".")
if [[ "${1:-}" == "--debug" ]]; then
  ARG_LIST+=("--no-sandbox" "--disable-gpu")
fi

# detached + unref：子进程成为独立会话首进程，不受当前终端生命周期影响
node -e '
const { spawn } = require("node:child_process");
const [bin, cwd, ...args] = process.argv.slice(1);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(bin, args, { cwd, env, detached: true, stdio: "ignore" });
child.unref();
console.log(`已启动 · pid=${child.pid}`);
' "$BIN" "$PWD" "${ARG_LIST[@]}"

echo "日志：~/Library/Application Support/energy-pet/crash.log"
echo "停止：pkill -f 'energy-pet/node_modules/electron'"
