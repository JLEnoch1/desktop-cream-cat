# AI 毛发定制工坊（Cat Studio）— 下载页自定义皮肤生成

> 2026-10-26 新增。下载页 `site/index.html` 的 `#studio` 区块：上传自己的小猫照片/视频，
> 通过 AI（阿里云百炼 · 千问图像编辑）生成保留毛色花纹的七姿态卡通形象，
> 打包成可直接装进 CreamCat 的皮肤包 zip。

## 组成

| 文件 | 角色 |
| --- | --- |
| `site/index.html` `#studio` | 区块骨架（三步：上传 → 生成 → 下载/安装指引） |
| `site/cat-studio.js` | 前端全部逻辑（零依赖）：上传校验、视频抽帧、链式生成、进度卡片、浏览器端 zip 打包 |
| `site/style.css` `.stu-*` | 样式（独立命名空间，追加在文件末尾） |
| `scripts/cat-skin-api.mjs` | 后端接口模块：提示词组装 + DashScope 调用 + mock |
| `scripts/serve-site.mjs` | 挂载 `/api/cat-skin/*` 路由（其余为原静态文件逻辑） |

## 运行

```bash
# 真实 AI 生成（必配百炼 API Key，产品唯一形态）
DASHSCOPE_API_KEY=sk-xxx npm run site:dev

# 本地联调（不调真 API，返回 site/assets/poses 内置素材，仅供开发/测试走通全链路）
CAT_SKIN_MOCK=1 npm run site:dev
```

纯静态托管 / `file://` 直接打开时，`/api/cat-skin/status` 探测失败 → 区块显示
「生成服务未接入」禁用态，页面其余部分不受影响（与 `site/downloads/README.md`
的静态部署承诺兼容）。**未配置 key 时功能整体禁用，不做本地模拟降级**（产品裁决）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | （空） | 百炼 API Key；空则接口返回 503 NotConfigured，前端禁用 |
| `CAT_SKIN_MODEL` | `qwen-image-2.0-pro` | 图像编辑模型；旧 key 可改 `qwen-image-edit` |
| `DASHSCOPE_BASE_URL` | `https://dashscope.aliyuncs.com` | 业务空间专属域名 / 新加坡地域时覆盖 |
| `CAT_SKIN_MOCK` | （空） | `=1` 开联调模式 |

## HTTP 接口

### `GET /api/cat-skin/status`

```json
{ "ok": true, "enabled": true, "mock": false, "model": "qwen-image-2.0-pro", "poses": ["idle", "..."] }
```

### `POST /api/cat-skin/generate`

请求：`{ "pose": "idle|walk1|walk2|sleep|drag|pet|tap", "images": ["data:image/jpeg;base64,...", ...] }`
（images 1–3 张，单张 ≤10MB 由前端缩放保证；请求体上限 40MB）

成功：`{ "ok": true, "pose": "idle", "image": "data:image/png;base64,...", "requestId": "...", "ms": 23456 }`
失败：`{ "ok": false, "pose": "...", "code": "InvalidApiKey|...", "message": "..." }`（HTTP 502/503/400）

服务端把 DashScope 产物 URL（仅 24h 有效、OSS 跨域）**代下载转成 dataURL** 再回给浏览器；
进程内串行队列保证同一时刻只有一发 DashScope 调用。key 只存在于服务端进程环境，
页面永不接触。服务端不落地任何图片（无状态）。

## 生成策略（角色一致性）

1. **链式串行**：`idle → walk1 → walk2 → sleep → drag → pet → tap`，每张约 10–60s，整套 2–7 分钟。
2. **定稿参考**：`idle` 只用真猫照片（1–3 张）；其余姿态把已生成的 `idle` 定稿作为最后一张
   参考图（`walk2` 用 `walk1` 定稿，保证左右爪交替成对）；提示词明确「保持与定稿形象完全一致」。
3. **单张重试**：失败卡片可单独重试，复用当前定稿参考。
4. **提示词**全部收在 `scripts/cat-skin-api.mjs`（`POSE_DESC`/`STYLE`/`STYLE_RULES`），
   统一要求：Q 版奶油插画风、保留品种毛色花纹五官、**纯白背景、无阴影无地面线**——
   与 app 端 `src/main/skins.ts` 漫水抠图（中性灰白 `min≥190 且 max-min≤14` 判背景）兼容，
   白色背景可被干净抠成透明 PNG。
5. DashScope 参数：`size=1024*1024`、`n=1`、`prompt_extend=false`（防改写姿态指令）、
   `watermark=false`、`negative_prompt`（人手/文字/多猫/阴影/写实等）。

## 皮肤包 zip（浏览器端打包，零依赖）

`site/cat-studio.js` 内置迷你 zip writer（CRC32 + `CompressionStream('deflate-raw')`，
不支持时回退 store）。产物结构：

```
my-cat/               ← 文件夹名 = 猫咪名字 slug（非 ASCII 名回落 my-cat）
  skin.json           ← v2，states: idle/walk(walk1+walk2+步态anim)/sleep/drag/thrown/pet/groom/tap
  idle.png walk1.png walk2.png sleep.png drag.png pet.png tap.png   ← 扩展名随产物 mime
  README.txt          ← 安装指引（与网页第三步一致）
```

`skin.json` 的 `walk.anim` 与 `expressions`（happy/surprise/tap）参数照抄内置皮肤
`skins/default/skin.json`；不含 walkSide/walkFront sheet（渲染层 `sprite-skin.ts`
对缺失状态自动回落 idle，正面两帧 walk 已够步态引擎锁相）。

## 安装与生效（写入网页指引与 zip README）

1. 右键桌面猫 →「打开皮肤文件夹」（即 `userData/skins`：macOS
   `~/Library/Application Support/CreamCat/skins/`，Windows `%APPDATA%\CreamCat\skins\`）。
2. 解压 zip，把整个 `my-cat/` 放进去。
3. **把原 `default` 改名为 `.default`**——`resolveSkin()` 取扫描到的第一个皮肤目录、
   无选择器，点开头目录被忽略（`skins.ts` 过滤规则），改名是唯一可靠的上位方式。
4. `watchSkins` 700ms 防抖 → 桌宠自动热重载；也可右键「重新加载皮肤」。
   还原：`.default` 改回 `default`。

> 注：未改 app 源码（`resolveSkin` 无皮肤选择语义），避免与并行会话冲突；
> 若未来 app 增加皮肤选择器，指引第 3 步可删。

## 前端流程细节

- **照片**：≤12MB/张、最多 3 张；canvas 缩到最长边 1280 → JPEG q0.88 再上传。
- **视频**：≤100MB、mp4/webm；`<video>`+canvas 均匀抽 8 帧（webm 缺 duration 时
  seek 大法修正）→ 点选 1–3 帧作参考（默认选首/中/尾）→ 与照片合并计 ≤3。
- 生成中可取消（AbortController）；已完成的姿态保留。
- 测试钩子：`window.__catStudio = { state, generate, retryPose, buildZip, addRef, POSES }`。

## 验证记录（2026-10-26）

- `node --check` 三文件通过；mock 模式 curl `status`/`generate` 七姿态全通。
- Electron harness（`site-shots/studio-e2e.cjs`）走完整流程：注入参考图 → 生成 →
  zip 下载 → `unzip` 校验（文件清单 + skin.json 可解析 + 图片可解码）→ 各步截图。
- 无 key：status `enabled:false` → 页面禁用横幅；`file://` 打开：探测失败 → 同禁用态，无未捕获异常。
- 真实 DashScope 链路需持有有效 key 联调（本机未配置，未跑真 key）。
