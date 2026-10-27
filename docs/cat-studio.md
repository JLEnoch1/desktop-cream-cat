# AI 毛发定制工坊（Cat Studio）— 下载页自定义皮肤生成

> 2026-10-26 新增，同日二轮升级（路线 B/C + 部件拆层）。下载页 `site/index.html` 的 `#studio`
> 区块：上传自己的小猫照片/视频，通过 AI（阿里云百炼 · 千问图像编辑）**把猫重绘成 Q 版卡通
> 角色定稿**，再以定稿锁角色批量产出「统一画风、同一只猫」的两类素材——**动作序列帧 ×7**
> （发呆/散步×2/打盹/被拎起/被摸头/敲键盘，可直接装进 CreamCat）与 **Live2D 式部件拆层稿
> ×12**（脸/头轮廓、左右眼、上下眉毛、嘴巴、双前爪、身体、尾巴、毛发遮挡层、眼睛高光/阴影层，
> 供分层动画制作与画师二创），打包成皮肤包 zip。**画风固定为像素游戏风**（复古桌宠质感、
> 硬边像素块、限色约 32 色；2026-10-27 裁决：厚涂 Q 版 / 扁平 Q 版已下线）。

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
| `DASHSCOPE_API_KEY` | （空） | 百炼 API Key；空则可由页面「配置 API Key」面板运行时注入（见下），两者皆无时接口 503 NotConfigured |
| `CAT_SKIN_MODEL` | `qwen-image-2.0-pro` | 图像编辑模型（当前推荐）；可改 `qwen-image-2.0`；`qwen-image-edit` 为早期模型可能需单独开通（面板高级选项也可改） |
| `DASHSCOPE_BASE_URL` | `https://dashscope.aliyuncs.com` | 业务空间专属域名 / 新加坡地域时覆盖（面板高级选项也可改） |
| `CAT_SKIN_MOCK` | （空） | `=1` 开联调模式 |

环境变量与页面注入的优先级：**env > 运行时注入**。运行时 Key 只存服务进程内存
（`runtimeCfg`），不写盘、日志只打尾号 4 位、服务重启即失效。

## HTTP 接口

### `GET /api/cat-skin/status`

```json
{ "ok": true, "enabled": true, "mock": false, "model": "qwen-image-2.0-pro",
  "keySource": "env|runtime|null",
  "poses": ["idle", "..."], "parts": [{ "id": "face", "label": "脸/头轮廓" }, "..."],
  "styles": ["pixel"] }
```

### `POST /api/cat-skin/generate`

请求：`{ "pose" 或 "part": "<id>", "style": "pixel", "images": ["data:image/jpeg;base64,...", ...] }`
（`pose` ∈ 七姿态、`part` ∈ 12 部件，二选一必填；style 仅 `pixel`（缺省即 pixel，传其它值 400 BadStyle）；images 1–3 张，
单张 ≤10MB 由前端缩放保证；请求体上限 40MB）

成功：`{ "ok": true, "target": "face", "kind": "pose|part", "style": "pixel", "image": "data:image/png;base64,...", "requestId": "...", "ms": 23456 }`
失败：`{ "ok": false, "target": "...", "code": "InvalidApiKey|BadTarget|BadStyle|...", "message": "..." }`（HTTP 502/503/400）

服务端把 DashScope 产物 URL（仅 24h 有效、OSS 跨域）**代下载转成 dataURL** 再回给浏览器；
进程内串行队列保证同一时刻只有一发 DashScope 调用。Key 全程不出本机（页面 → 127.0.0.1
本地服务 → 百炼），服务端不落地任何图片（无状态）。

### `POST /api/cat-skin/check` / `POST /api/cat-skin/config`

页面「配置百炼 API Key」面板的后端。请求：`{ "key": "sk-…", "model"?: "…", "baseUrl"?: "https://…" }`；
`config` 另支持 `{ "key": null }` 清除运行时 Key。

**零成本探针（保守判定）**：两个路由都用「空 messages」打一发 multimodal-generation，
**只有走到参数校验层被拒（`InvalidParameter`/`BadRequest.Input`）或返回 2xx 才算 Key 有效**
（说明鉴权+端点+模型全通过，只是空输入被参数层挡下——**不会真正生成、不计费**）。其余一律
**拒绝保存**并给对症提示，杜绝"假通过"：

| 探针响应 | 判定 | 常见成因 |
| --- | --- | --- |
| 非 JSON（HTML 404/405 等） | ✗ 拒绝 | 服务地址不是百炼（如内网 Anthropic 文本网关 `ai-gateway…/ai-llm/anthropic`） |
| 401 / `InvalidApiKey` / `Unauthorized` | ✗ 拒绝 | Key 无效 |
| 403 / `*Forbidden*` / `AccessDenied` / `Arrearage` | ✗ 拒绝 | Key 有效但无权访问该图像模型（多为文本 Key、未开通千问图像编辑、非该业务空间） |
| `Model*NotFound` | ✗ 拒绝 | 模型名错（图像编辑用 `qwen-image-2.0-pro`，留空即默认） |
| 其它未知错误码 | ✗ 拒绝 | 保守兜底，透传原始 code/message |
| `InvalidParameter` / 2xx | ✓ 通过 | 鉴权+端点+模型均 OK |

网络不通 → `ProbeFailed`，Key 不保存。历史教训：旧探针对"非 401 的一切"都判通过，导致
误配文本网关（生成时 404）与 `AUTH_RESOURCE_FORBIDDEN` 文本 Key（生成时失败）都被放行；
2026-10-27 改为上表的保守判定后，"测试连接"即可当场拦下这些误配。

- `check`：只测试（面板「测试连接」按钮），不保存；返回 `{ ok, valid, ms, warning? }`。
- `config`：探针通过后把 `{key, model, baseUrl}` 存入进程内存并翻转 `enabled`；
  返回 `{ ok, saved, keySource, enabled, warning? }`。
- 格式防线：Key 必须 `sk-` 开头（`KEY_RE`，格式错不打网络直接 400 BadKeyFormat）；
  model 限 `[\w.-]{1,64}`；baseUrl 必须合法 http(s) 地址；请求体上限 16KB。

### 前端 Key 面板行为

- `status.enabled:false` 且**本地服务在线** → 显示面板（`#stu-key`，位于 `.stu-step` 之外，
  不受 `is-off` 置灰影响）；`fetch` 都失败（file:///纯静态）→ 仍显示旧「未接入」横幅、面板隐藏。
- 「测试连接」= `check`；「保存并启用」= `config`（输入框回车同保存）。失败原因红字回显。
- 「记住在本浏览器」勾选 → Key 存 `localStorage['creamcat.studio.cfg']`，下次打开若服务
  未配置则**静默自动注入**（失败自动清除并提示重填）；不勾则服务重启后需重填。
- 运行时 Key 生效期间显示绿色 `#stu-keynote`（含「清除 Key」按钮 → `config {key:null}`）。

## 生成策略（路线 B：定稿 → 批量派生，锁角色一致性）

1. **链式串行**：`idle 定稿 → 其余姿态（walk1 → walk2 → sleep → drag → pet → tap）→ 部件
   （face → body → tail → 前爪 → 嘴巴 → 双眼 → 眉毛 → 毛发遮挡 → 眼睛高光）`，
   每件约 10–60s；全量 19 件约 4–15 分钟。只要部件时 idle 仍作为「定稿锚点」先生成
   （卡片带「定稿锚点」角标，且保证 zip 里始终有可安装的 idle 皮肤）。
2. **定稿参考**：`idle` 只用真猫照片（1–3 张）；其余姿态与**全部部件**把已生成的 `idle`
   定稿作为最后一张参考图（`walk2` 用 `walk1` 定稿，保证左右爪交替成对）；提示词明确
   「保持与定稿形象完全一致的画风、配色、描边与花纹」。
3. **画风固定像素游戏风**（2026-10-27 裁决，`STYLES=['pixel']`，`STYLE_BLOCKS.pixel` +
   专属 negative_prompt 禁柔边/渐变/抗锯齿模糊/厚涂/照片写实）：整幅由方形像素块构成、
   硬边无抗锯齿、限色约 32 色、深色像素描边、色块阶表现毛发明暗、大头小身 Q 版比例、
   复古桌宠/电子宠物游戏质感、动作感强。前端无画风选择器（`state.style` 恒 `'pixel'`），
   页面用一个 `.stu-opt.is-fixed` 静态 pill 展示当前画风。
4. **部件拆层稿**（`PART_DESC` + `PART_RULES`）：每件只画单一部件、居中留白、纯白背景，
   按 Live2D 分层习惯拆分（脸部基底不含五官细节；毛发遮挡层=悬浮的刘海/颊侧/胸前毛缕；
   眼睛高光/阴影层=按定稿眼位排布的高光与阴影形状）。**app 皮肤管线不消费 parts/**
   （`skins.ts` 只扫皮肤目录顶层图片），它们是素材稿；`parts/` 子目录随皮肤包一起下发。
5. **单张重试**：失败卡片可单独重试，复用当前定稿参考。
6. **提示词**全部收在 `scripts/cat-skin-api.mjs`（`STYLE_BLOCKS`/`POSE_DESC`/`PART_DESC`/
   `POSE_RULES`/`PART_RULES`），统一要求：保留品种毛色花纹五官、**纯白背景、无阴影无地面线**——
   与 app 端 `src/main/skins.ts` 漫水抠图（中性灰白 `min≥190 且 max-min≤14` 判背景）兼容，
   白色背景可被干净抠成透明 PNG（像素风硬边同样兼容）。
7. DashScope 参数：`size=1024*1024`、`n=1`、`prompt_extend=false`（防改写姿态/部件指令）、
   `watermark=false`、`negative_prompt` 随画风切换。

## 皮肤包 zip（浏览器端打包，零依赖）

`site/cat-studio.js` 内置迷你 zip writer（CRC32 + `CompressionStream('deflate-raw')`，
不支持时回退 store）。产物结构：

```
my-cat/               ← 文件夹名 = 猫咪名字 slug（非 ASCII 名回落 my-cat）
  skin.json           ← v2，states: idle/walk(walk1+walk2+步态anim)/sleep/drag/thrown/pet/groom/tap
  idle.png walk1.png walk2.png sleep.png drag.png pet.png tap.png   ← 扩展名随产物 mime
  parts/              ← 部件拆层稿 ×12（face/body/tail/paw-l/paw-r/mouth/eye-l/eye-r/
                        brow-up/brow-low/fur-overlay/eye-light），app 不消费，素材稿
  README.txt          ← 安装指引（与网页第三步一致）+ parts/ 说明
```

`skin.json` **按实际生成的姿态组装**：只勾部件时退化为 idle 单帧皮肤（渲染层对缺失状态
自动回落 idle，依然可安装）；`walk.anim` 与 `expressions`（happy/surprise/tap）参数照抄
内置皮肤 `skins/default/skin.json`；不含 walkSide/walkFront sheet（正面两帧 walk 已够
步态引擎锁相）。

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
- **第 2 步选项**（`#stu-opts`）：画风 radio ×3（name=`stu-style`）+ 输出 checkbox ×2
  （`#stu-opt-poses` 七姿态 / `#stu-opt-parts` 部件×12，默认全勾）；按钮文案实时显示件数
  （「开始生成 19 件素材」），全不勾时按钮变「请至少勾选一种输出」并禁用。
  网格卡片随勾选重建（7 ↔ 19），已有结果回填。
- 生成中可取消（AbortController）；已完成的素材保留。
- 测试钩子：`window.__catStudio = { state, generate, retryTarget, buildZip, addRef, currentTargets, POSES, PART_IDS }`。

## 验证记录（2026-10-26）

一轮（七姿态）：
- `node --check` 三文件通过；mock 模式 curl `status`/`generate` 七姿态全通。
- Electron harness（`scripts/site-verify/studio-e2e.cjs`）走完整流程：注入参考图 → 生成 →
  zip 下载 → `unzip` 校验（文件清单 + skin.json 可解析 + 图片可解码）→ 各步截图。
- 无 key：status `enabled:false` → 页面禁用横幅；`file://` 打开：探测失败 → 同禁用态，无未捕获异常。

二轮（画风 + 部件拆层，17:10）：
- curl 契约：`{part:"face",style:"pixel"}` → ok；pose+part 同传 / 非法 part / 非法 style → 400；
  `buildPrompt` 7 组（姿态/部件 × 三画风 × 有无定稿参考）单测通过。
- E2E（像素风 × 姿态+部件全量）：19 卡初始化、勾选切换 7↔19、生成 19/19、
  zip 下载 completed（612KB / 21 文件：skin.json + 7 姿态 + parts/×12 + README），
  skin.json v2 含 walk.anim 与三表情、parts 全为真 RIFF webp；**切回厚涂画风 → 结果作废、
  19 卡回等待、step3 收起**；主流程零 console 错误。
  期间抓到一个真 bug：`downloadZip` 局部变量 `extOf` 遮蔽同名函数导致打包抛错（已修复并回归）。
- 几何审计：opts 行 5 枚药丸、选中态描边 `rgb(56,113,79)`（`:has` 生效）、19 卡等宽 3 行、
  移动端 0 溢出；`scripts/site-verify/shot.cjs` 整页回归 NO-CONSOLE-ERRORS（imgTotal 27、broken 0）。
- 真实 DashScope 链路仍需有效 key 联调（本机未配置；假 key 验证过错误透传 `InvalidApiKey` 502）。

三轮（页面配置 API Key + 测试连接按钮，10-27 12:05）：
- curl：`check` 格式错→400 BadKeyFormat（零网络）；模型名非法→BadCfg；**假 key 真探针→
  `InvalidApiKey` 197ms 拒绝**；`config` 假 key 拒绝不落存；`{key:null}` 清除→keySource:null；
  无 key `generate`→503 新文案（指向页面面板）。
- 新 harness `scripts/site-verify/studio-key.cjs` 全绿：无 key 服务 → 面板出现且可交互
  （步骤区正确置灰）→ 格式错即时红字 → 假 key 测试/保存均被拒 → status 仍 disabled →
  localStorage 无残留 → file:// 面板隐藏；NO-ERRORS。
- 回归：mock E2E（keyPanelHidden:true、19/19、zip 611967B、零 console 错）+
  `shot.cjs` 整页 NO-CONSOLE-ERRORS（imgTotal 27、broken 0）。
- 顺手修复并行会话搬迁 harness 后遗留的 ROOT 路径差一层问题（studio-e2e/studio-geo/shot）。

四轮（画风收敛像素 + 探针保守化，10-27 14:05）：
- 触发：用户填内网 Anthropic 文本网关（`model=Bailian-Qwen3.8-Max`、
  `base=ai-gateway…/ai-llm/anthropic`）→ 旧探针误判"连接成功"→ 19 件生成全 `HTTP404`；
  换真百炼但填文本模型又遇 `AUTH_RESOURCE_FORBIDDEN` 仍被旧探针放行。用户裁决：**画风只保留
  像素游戏风**。
- 画风：`STYLES=['pixel']`，删 `STYLE_BLOCKS`/`NEGATIVE_BY_STYLE` 的 chibi/flat，缺省 style
  改 pixel；前端删画风 radio 组与切换作废逻辑、`state.style` 恒 `'pixel'`、页面改
  `.stu-opt.is-fixed` 静态 pill；`buildPrompt`/generate 缺省与 fallback 全指向 pixel。
- 探针：改保守判定（见上表）——非 JSON、403/Forbidden、Model*NotFound、未知码一律拒存并给
  对症文案；只有 `InvalidParameter`/2xx 判通过。generate 的 404 文案补"检查服务地址/模型名"。
- curl 复验：`status.styles=['pixel']`；假 key 打真百炼 → `InvalidApiKey` 拒；假 key 打
  `example.com` → `HTTP405` 非 JSON 拒（带网关提示）；chibi 无 key → NotConfigured（有 key 则 BadStyle）。
- 回归全绿：mock E2E（styleFixed=pixel、noStyleRadio、19/19、zip 611967B、零错）+
  Key 面板（假 key 拒、file:// 隐藏、NO-ERRORS）+ 整页 shot（imgTotal 27、broken 0、
  NO-CONSOLE-ERRORS）+ 几何（optPills 3、19 卡等宽、双端 0 溢出）。
- 真图像 API 全链路仍需用户以有权访问 `qwen-image-2.0-pro` 的百炼 Key 实测（`qwen-image-edit`
  为早期模型，用户账号实测 `AUTH_RESOURCE_FORBIDDEN`；文档现推荐 qwen-image-2.0 系列）。
