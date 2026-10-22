# 桌面精力宠物 · 全局结构地图

> 用途：供后续对话复用的**索引与关键导航**——只回答「哪里有什么、谁依赖谁、红线是什么、改东西从哪下手」。
> 各模块接口存根、数据流详情、一致性问题清单已移至 `docs/structure/`，**按需读取**。
> 抽取时间：2026-10-21 · 全量重新实测：2026-10-22（T0 文档对齐轮，覆盖 v1.2 代码状态）· **渐进式披露重构：2026-10-22**
> ⚠️ 本项目有**多个会话并行改动**，行数/用例数会在数小时内失效。**引用任何数字前先重测**。
> 📏 **入口纪律**：本文件目标 ≤400 行。新增详情写进 `docs/structure/` 对应文档，入口只留一行索引，**不得膨胀**。

## 读法（渐进式披露）

| 层 | 内容 | 何时读 |
|---|---|---|
| **L1 入口（本文件）** | 目录树 · 依赖图 · 模块索引 · 不变式 · 修改指引 | 每次动手前，只读相关小节 |
| **L2 模块存根** | `docs/structure/<模块>.md`，与 `src/` 文件 **1:1**（`src/a/b.ts` → `a-b.md`） | 改哪个模块，才读对应那一两份 |
| **L2 专题** | [`data-flows.md`](docs/structure/data-flows.md) 四条主链路 · [`known-issues.md`](docs/structure/known-issues.md) 问题清单（保留 §5.1–5.4 编号） | 动跨模块链路 / 排查「注释与实现不符」「死代码」时 |
| **L3 事实** | 源码 · `npm test` · `DESIGN.md`（设计契约，唯一仲裁处） | 数字与行为**永远以当前源码为准** |

升级路径：**本文件 → 专题存根 → 源码**。任务不涉及某模块时，不要预读它的存根。
历史文档（TASKS.md 等）引用的旧存根编号 §3.x，经 §3 索引表的「原§」列映射到 `docs/structure/`。

## 0. 覆盖范围与取舍

**全量覆盖，无省略。** `src/` 下 **18 个 TypeScript 文件共 6572 行**已全部读取并抽取接口，
包括体量最大的 `renderer/app.ts`（**1265 行**）与 `renderer/pet.ts`（**1081 行**）。
唯一未展开的是**方法体内部实现**（Canvas 绘制细节、SQL 语句、DOM 事件绑定逻辑）——存根文档同样只到签名与关键注释层。

| 项目 | 数量 | 备注 |
|---|---|---|
| TypeScript 源文件 | **18** | 首版漏计 `src/weather/geo.ts`（IP 定位，128 行） |
| 源码总行数 | **6572** | `find src -name '*.ts' -exec cat {} + \| wc -l` |
| 测试文件 | **7**（`tests/*.test.ts`） | core / coordinator / hittest / weather-source / geo / pose / emotion-tiers |
| 测试用例 | **106**（全绿） | core 37 + coordinator 16 + hittest 15 + weather-source 13 + pose 10 + geo 9 + emotion-tiers 6 |
| 构建脚本 | 2（`scripts/build.mjs`、`scripts/build-tests.mjs`） | |

> ⚠️ 根目录 `overview.md` 称「测试 30/30 全绿」，是 **v1.0 之前的旧快照**；`overview.md` 与 `fix-report-*.md`
> 均为历史文档，不是待办来源，也不反映当前状态。详见[问题清单](docs/structure/known-issues.md)。
> 📈 基线演进：40（首版抽取）→ 89 → 90（v1.1 charged 守护）→ 100（M1 尾巴/耳朵 + pose 10）→ **106**（emotion-tiers 6，R7 配色守护）。

---

## 1. 目录树

```
energy-pet/
├── package.json                  # npm 脚本入口；main 指向 dist/main/index.js
├── tsconfig.json                 # strict；ES2022 + Bundler；paths 别名 @/* → src/*
├── DESIGN.md                     # 设计契约（唯一仲裁处）
├── TASKS.md                      # 任务清单与裁决记录（引用旧 §3.x 编号，经 §3 索引表映射）
├── PLAN-5issues.md               # 五问题规划（历史文档）
├── smoke.sh / start.sh           # 启动封装（smoke 自动 unset ELECTRON_RUN_AS_NODE）
├── selfcheck.png                 # --selfcheck 窗口截图产物
├── scripts/
│   ├── build.mjs                 # esbuild 三路打包 main(cjs)/preload(cjs)/renderer(iife)
│   └── build-tests.mjs           # tests/*.test.ts → dist-tests/*.mjs
├── src/
│   ├── core/                     # ── L0 契约层：零依赖根，所有模块向下依赖它 ──
│   │   ├── types.ts              # 领域类型唯一契约；仅类型+常量，禁止行为逻辑
│   │   ├── events.ts             # append-only 事件契约 + 15 个事件草稿工厂
│   │   ├── bus.ts                # EventBus 轻量发布订阅（Coordinator 自建实例，全局单例未被用）
│   │   └── hittest.ts            # click-through 命中区几何判定，纯函数
│   ├── storage/
│   │   └── sqlite.ts             # L1 DecisionLog：node:sqlite 事件流持久化，唯一写入口
│   ├── ledger/
│   │   ├── fold.ts               # L1 精力折叠纯函数：energy = fold(events) 唯一实现
│   │   └── energy.ts             # L2 EnergyLedger 精力账本，代理 DecisionLog
│   ├── emotion/
│   │   └── engine.ts             # L2 三层情绪合成纯函数（跨进程复用；导出 R7 守护锚点 BASE_TIERS/WARM_HUE_*）
│   ├── task/
│   │   └── center.ts             # L2 TaskCenter 任务管理，状态由事件流 fold 得出
│   ├── recovery/
│   │   └── deck.ts               # L2 RecoveryDeck 恢复项卡片组 + 默认值版本历史
│   ├── weather/
│   │   ├── geo.ts                # L2 IP 定位：ip-api.com，7 天缓存，失败降级深圳兜底
│   │   └── sensor.ts             # L2 天气源级联 QQ→Open-Meteo，双层缓存三级降级，永不抛错
│   ├── insight/
│   │   └── engine.ts             # L2 InsightEngine 只读事件流：周报 + 偏差推荐
│   ├── main/                     # ── Electron 主进程 ──
│   │   ├── coordinator.ts        # L3 模块装配 + AppState 计算 + 两套状态机（调节窗口①/滑动卡②）
│   │   └── index.ts              # L4 主进程入口：窗口/IPC/托盘/命中轮询/拖拽/崩溃自愈
│   ├── preload/
│   │   └── index.ts              # L3 contextBridge 白名单桥接，暴露 window.pet
│   └── renderer/                 # ── Electron 渲染进程 ──
│       ├── index.html            # 单页结构，72 个 id 挂载点（全量清单在 renderer-app.md 末尾）
│       ├── styles.css            # 透明窗口 + 面板/卡片样式（含已登记的孤立规则，见问题清单 §5.4）
│       ├── app.ts                # L4 渲染主控：状态 diff、滑动卡、面板、HUD 10 格、命中区上报
│       └── pet.ts                # L3 Canvas 三层图层合成 + RAF 动画；导出 resolveTailPose/resolveEarPose 纯函数
├── tests/                        # 7 个 *.test.ts（明细见 §0）
├── docs/structure/               # 🆕 按需详情：18 份模块存根 + data-flows + known-issues
├── dist/                         # [构建产物] main/preload/renderer
└── dist-tests/                   # [构建产物] *.mjs，node --test 直接运行
```

> ⚠️ **`npm run build` 是自检前置**：改完 `src/` 不重新构建，`--selfcheck` 跑的仍是旧 `dist/`，
> 会把"改了没生效"误判成"改动无效"。

---

## 2. 依赖方向

### 2.1 分层规则

```
        ┌──────────────────────────────────────────────────┐
  L4    │ main/index.ts        renderer/app.ts             │  进程入口
        │ (Electron API)       (DOM + window.pet)          │
        └────────┬─────────────────────────┬───────────────┘
                 │                         │
        ┌────────▼─────────┐      ┌────────▼─────────┐
  L3    │ main/coordinator │      │ renderer/pet.ts  │      装配 / 表现
        │ preload/index.ts │      │                  │
        └────────┬─────────┘      └────────┬─────────┘
                 │                         │
        ┌────────▼─────────────────────────▼───────────────┐
  L2    │ ledger/energy  task/center  recovery/deck        │      领域模块
        │ insight/engine emotion/engine                    │      （跨领域互不依赖）
        │ weather/sensor ──▶ weather/geo  ← 子系统内单向依赖 │
        └────────┬─────────────────────────┬───────────────┘
                 │                         │
        ┌────────▼─────────┐      ┌────────▼─────────┐
  L1    │ storage/sqlite   │      │ ledger/fold      │      状态与折叠
        └────────┬─────────┘      └────────┬─────────┘
                 │                         │
        ┌────────▼─────────────────────────▼───────────────┐
  L0    │ core/types  core/events  core/bus  core/hittest  │      契约层（零依赖根）
        └──────────────────────────────────────────────────┘
```

**关键约束**：
- L0 不 import 任何项目内模块（`events.ts` 仅 type-import `types.ts`）——真正的依赖根。
- L2 现为 **7 个**领域模块（v1.3：新增 `weather/geo.ts`）。**跨领域横向零依赖**，全部只向下依赖 L0/L1，彼此通过 `Coordinator` 装配。
- ⚠️ **唯一的 L2 子系统内横向依赖**：`weather/sensor.ts` → `weather/geo.ts`（`sensor.ts:16` import `readCachedGeo`）。
  weather 子系统内部**单向**依赖（无环），不算违反"跨领域零依赖"；但改 geo 的导出签名时须知会 sensor。`coordinator` 也独立 import geo 的 `resolveGeo`（定位成功后调 `sensor.setLocation`）。
- `emotion/engine.ts` 是唯一跨进程复用的 L2 模块：主进程 `coordinator` 与渲染进程 `app.ts`/`pet.ts` 同时 import 它。
- `ledger/fold.ts` 被 `storage/sqlite.ts`（写路径）与 `ledger/energy.ts`（重放路径）共享，独立成模块正是为了**打破 storage↔ledger 循环依赖**。
- `core/hittest.ts` 几何纯函数供主进程调用，渲染进程 `app.ts` **自行重定义**了同名局部类型 `HotRect`（未 import），属有意的进程隔离。

### 2.2 精确 import 关系（源码实测）

| 源文件 | 依赖的项目内模块 |
|---|---|
| `core/types.ts` | —（零依赖） |
| `core/events.ts` | `core/types`（仅 type） |
| `core/bus.ts` | —（零依赖） |
| `core/hittest.ts` | —（零依赖） |
| `ledger/fold.ts` | `core/events`, `core/types` |
| `storage/sqlite.ts` | `core/events`, `ledger/fold` |
| `ledger/energy.ts` | `storage/sqlite`, `core/events`, `ledger/fold` |
| `emotion/engine.ts` | `core/events`, `core/types` |
| `task/center.ts` | `storage/sqlite`, `core/events`, `core/types` |
| `recovery/deck.ts` | `storage/sqlite`, `core/events`, `core/types` |
| `weather/sensor.ts` | `storage/sqlite`(type), `core/events`, `core/types`, **`weather/geo`**（`readCachedGeo`） |
| `weather/geo.ts` | 🆕 `storage/sqlite`（仅 type）——只依赖 DecisionLog 的 meta 读写，**不依赖 sensor**（无环） |
| `insight/engine.ts` | `storage/sqlite`, `core/events`, `core/types`, `ledger/fold` |
| `main/coordinator.ts` | `storage/sqlite`（含 `localDateStr`）, `core/bus`, `core/events`, `core/types`, `ledger/energy`, `ledger/fold`, `task/center`, `recovery/deck`, `weather/sensor`, **`weather/geo`**（`resolveGeo`）, `insight/engine`, `emotion/engine` |
| `main/index.ts` | `main/coordinator`, `core/types`, `core/hittest` |
| `preload/index.ts` | `core/types`, `core/events`（全部仅 type） |
| `renderer/pet.ts` | `core/types`, `emotion/engine` |
| `renderer/app.ts` | `renderer/pet`, `emotion/engine`, `core/types`, `preload/index`（仅 type） |

### 2.3 运行时数据流转（四条主链路）

> 完整链路图（含降级分支、定时器清理坑、双记录语义）：[`docs/structure/data-flows.md`](docs/structure/data-flows.md)。此处只留骨架。

| 链路 | 一句话骨架 |
|---|---|
| ① 启动 | `whenReady` → 装配 `Coordinator` → `start()`：seed → session 事件 → 天气刷新(不阻塞) → 3 个 `setInterval` → 晨间基线 → 3s 洞察批 → 1.5s IP 定位（成功后 `setLocation` 热更新并重刷天气，失败静默） |
| ② 写入 | 用户操作 → IPC → Coordinator → 领域模块 → EventDraft 工厂 → **`DecisionLog.append()`（唯一写入口）** → bus 广播 → `pushState()` JSON 去重推送 → 渲染层 `applyState()` diff |
| ③ 滑动确认 | `requestSlide()` 产出 `PendingSlide`（同一时刻最多一张）→ 拖动仅预览不落库（本地即时 + 80ms 节流 IPC）→ `confirmSlide(target)` 按 **actual = target − baseEnergy**（绝对精力语义）落库 |
| ④ 偏差学习 | `recovery.taken` 双记 predicted/actual → InsightEngine 每 10min 扫偏差 → ≥3 次不匹配产出推荐卡 → accepted/modified/rejected 三种处置回写恢复项默认值（双写事件+版本历史） |

> ⚠️ 定时器红线：`timers` 数组**只装 setInterval**；所有 setTimeout（insightStartupTimer / geoTimer / adjustTimer）必须在 `stop()` 单独 clearTimeout，漏清会报 "database is not open"。

---

## 3. 模块索引（存根按需展开）

> 接口存根全文在 `docs/structure/`，命名 1:1 映射源码路径。**改哪个模块才读哪份**。
> 「原§」列兼容 TASKS.md 等历史文档的旧编号引用；「行数」为抽取时快照，引用前重测。
> 存根约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致；`private` 成员仅在影响职责边界时列名。

| 原§ | 模块 | 层 | 职责一句话 | 行数 | 存根文档 | 测试 |
|---|---|---|---|---|---|---|
| 3.1 | `core/types.ts` | L0 | 领域类型唯一契约，禁止行为逻辑 | 303 | [core-types.md](docs/structure/core-types.md) | —（经 core 间接覆盖） |
| 3.2 | `core/events.ts` | L0 | append-only 事件契约 + 15 个草稿工厂 | 213 | [core-events.md](docs/structure/core-events.md) | core |
| 3.3 | `core/bus.ts` | L0 | EventBus 发布订阅（Coordinator 自建实例） | 117 | [core-bus.md](docs/structure/core-bus.md) | — |
| 3.4 | `core/hittest.ts` | L0 | 命中区几何判定纯函数 | 136 | [core-hittest.md](docs/structure/core-hittest.md) | hittest 15 |
| 3.5 | `ledger/fold.ts` | L1 | energy = fold(events) 唯一实现 | 76 | [ledger-fold.md](docs/structure/ledger-fold.md) | core |
| 3.6 | `storage/sqlite.ts` | L1 | DecisionLog 事件流持久化，唯一写入口 | 447 | [storage-sqlite.md](docs/structure/storage-sqlite.md) | core |
| 3.7 | `ledger/energy.ts` | L2 | EnergyLedger 精力账本（代理 DecisionLog） | 124 | [ledger-energy.md](docs/structure/ledger-energy.md) | core |
| 3.8 | `emotion/engine.ts` | L2 | 三层情绪合成纯函数，跨进程复用 | 384 | [emotion-engine.md](docs/structure/emotion-engine.md) | core + emotion-tiers 6 |
| 3.9 | `task/center.ts` | L2 | 任务管理，状态由事件流 fold 得出 | 136 | [task-center.md](docs/structure/task-center.md) | core |
| 3.10 | `recovery/deck.ts` | L2 | 恢复项卡片组 + 默认值版本历史 | 127 | [recovery-deck.md](docs/structure/recovery-deck.md) | core |
| 3.11 | `weather/sensor.ts` | L2 | 天气级联 + 双层缓存 + 三级降级，永不抛错 | 216 | [weather-sensor.md](docs/structure/weather-sensor.md) | weather-source 13 |
| 3.11b | `weather/geo.ts` | L2 | IP 定位，7 天缓存，降级深圳 | 128 | [weather-geo.md](docs/structure/weather-geo.md) | geo 9 |
| 3.12 | `insight/engine.ts` | L2 | 只读事件流：周报 + 偏差推荐 | 362 | [insight-engine.md](docs/structure/insight-engine.md) | core |
| 3.13 | `main/coordinator.ts` | L3 | 模块装配 + AppState + 两套状态机 | 653 | [main-coordinator.md](docs/structure/main-coordinator.md) | coordinator 16 |
| 3.14 | `main/index.ts` | L4 | 主进程入口：窗口/IPC/托盘/命中轮询/自愈 | 693 | [main-index.md](docs/structure/main-index.md) | —（selfcheck） |
| 3.15 | `preload/index.ts` | L3 | contextBridge 白名单，暴露 window.pet | 111 | [preload-index.md](docs/structure/preload-index.md) | — |
| 3.16 | `renderer/pet.ts` | L3 | Canvas 三层合成 + RAF + 姿态解算纯函数 | 1081 | [renderer-pet.md](docs/structure/renderer-pet.md) | pose 10 |
| 3.17 | `renderer/app.ts` | L4 | 渲染主控：diff/滑动卡/面板/HUD/命中上报 | 1265 | [renderer-app.md](docs/structure/renderer-app.md) | —（selfcheck 截图） |

> `renderer/index.html`（72 个 id）与 `styles.css` 无独立存根：DOM id 全量清单与「已剔除 id」注记在 [renderer-app.md](docs/structure/renderer-app.md) 末尾；孤立 CSS 规则登记在[问题清单 §5.4](docs/structure/known-issues.md)。

---

## 4. 关键设计不变式

修改代码前必须守住的约束，违反任一条都会破坏系统正确性：

| # | 不变式 | 保障位置 |
|---|---|---|
| 1 | **精力值 = fold(events)**，事件流是唯一事实源 | `ledger/fold.ts`；`DecisionLog.rebuildEnergy()` 启动全量重放校验 |
| 2 | **所有写入只走 `DecisionLog.append()`** | 领域模块均无直接 SQL；`append` 内计算 `energy_after` |
| 3 | **事件不可变**，只追加不修改 | schema 无 UPDATE 路径（`resolveRecommendation` 改的是 recommendations 表，非 events） |
| 4 | **折叠语义单一**：写路径与重放路径共用 `nextEnergy` | `foldDraft`（写）/ `foldEvent`（重放）都委托它 |
| 5 | **同一时刻最多一张滑动卡** | `Coordinator.requestSlide()` 首行 `if (this.pendingSlide) return null` |
| 6 | **`actual_delta` = target − baseEnergy**（绝对精力语义，非增量） | `confirmSlide()`；`predicted_delta` 仅作参考记录 |
| 7 | **`manual-adjust` 永不落库** | `confirmSlide()` 首分支直接关卡返回 null |
| 8 | **天气永不抛错**，只降级 | `WeatherSensor.current()` / `doRefresh()` catch 全兜底 |
| 9 | **命中区宁可偏大不可为空** | `fallbackHotRects()` 兜底 + `sanitizeRects()` 过滤脏数据 |
| 10 | **命中来源唯一**：只用 `win:hotRects` 轮询 | `win:hitTest` 保留为 deprecated 空实现，避免两套机制打架 |
| 11 | **精度统一两位小数** | 全部经 `core/events.round2()` |
| 12 | **情绪合成为纯函数** | `emotion/engine.ts` 无 IO、无状态，双进程可安全复用 |
| 13 | 🆕 **姿态解算为纯函数、只读连续量、无随机** | `resolveTailPose()`/`resolveEarPose()`（`pet.ts:101/:124`）只读 `RenderParams` 子集，`tests/pose.test.ts` 10 条守护（DESIGN.md §3.2） |
| 14 | 🆕 **多通道读同一输入方向必须一致** | `resolveEarPose()` 的 droop 项按 `(1-max(0,joy))` 门控：愉悦眯眼 ≠ 疲惫耷眼（DESIGN.md §3.2.2） |
| 15 | 🆕 **看得见的部位必须点得到** | 耳尖/尾梢几何并入 `petBounds()`（耳上界 -1.8R、尾梢 `tailTip`）；改尾巴/耳朵几何必须同步复核命中区 |
| 16 | 🆕 **低精力配色不退暖**（R7） | `BASE_TIERS` hue ∈ [`WARM_HUE_MIN`=30, `WARM_HUE_MAX`=46]，疲惫靠 sat+lum 双降；`tests/emotion-tiers.test.ts` 6 条守护（含变异验证） |
| 17 | 🔴 **跌倒态永不由用户行为触发**（R10/R11，**v1.4 已修订措辞**） | `injure()`（`pet.ts:262`）**无调用方**且已裁决除名；连点只走 `poke()`→呼噜。**勿把 `injure()` 接线到任何事件或手势**（含领域事件与"拒绝计数"）。⚠️ `pratfall()` 尚不存在（`grep -rn pratfall src/` = 0），是 T12 的计划改名 |

---

## 5. 一致性问题清单（摘要）

> 全文（含逐条行号与 v1.3 重测注记）：[`docs/structure/known-issues.md`](docs/structure/known-issues.md)，保留 §5.1–5.4 编号。
> 全部**仅登记，未改动任何代码**（T0 只改 .md）。四类的划分：

- **§5.1 注释与实现矛盾** — 源码注释/历史文档说的与代码做的不一致（🔴 会误导实现者）。最危险：`PULSE_THRESHOLD` 实为 **3**，两处注释仍写"<6"；`pet.ts:238` 的 `injure()` 注释仍预留"未来接线（领域事件触发）"许可，**已被裁决否决**（源码级悬空许可，待 T12 随改名删除）。📌 注：**DESIGN.md 的红线 R10/R11 措辞已于 v1.4 修订**（用户 11:49 批准，`injure()` 不再出现"仅可由领域事件触发"），文档层冲突已消；剩下的只是这行**源码注释**尚未跟进。
- **§5.2 无调用方的公开 API** — TS 层死代码（约 13 个），多为测试可达性预留。⚠️ 例外：`injure()` 已裁决**永久除名**，不要当预留 API 接线。
- **§5.3 有意的重复定义（勿"修复"）** — 最危险：`ENERGY_AFFECTING`（events.ts）与 `isEnergyAffecting()`（insight）同一规则两处表达，**新增精力事件两处都必须改**，否则周报漏项。
- **§5.4 孤立死代码 / 已废弃通道 🆕** — 渲染层与协议层的重构残留。最危险：`preload` 的 `recoveryTake()` **恒返回 null 且静默无操作**（已迁 `recoveryStartAdjust`）；`win:hitTest` 空 handler 是刻意的，勿补实现。
  ⚠️ 与 §5.2 的关键区别：§5.2 **调不到**（无调用方），§5.4② **调得到但静默无操作**（更危险）。

---

## 6. 修改指引（按任务类型定位）

| 想做的事 | 改哪里 | 注意事项 |
|---|---|---|
| 新增事件类型 | `core/events.ts`（`EventType` + `EventPayload` + 工厂）→ `ledger/fold.ts` `nextEnergy()` | 若影响精力，必须同时加入 `ENERGY_AFFECTING` **和** `insight/engine.ts` 的 `isEnergyAffecting()`（两处重复，见[问题清单 §5.3](docs/structure/known-issues.md)） |
| 改精力计算规则 | `ledger/fold.ts` 的 `nextEnergy()` | 单点修改即可，写路径与重放路径自动同步（不变式 4） |
| 加情绪档位 | `emotion/engine.ts` 的 `BASE_TIERS`（含 `hue/sat/lum`）+ `renderer/pet.ts` 的 `EMOTION_PARAMS` | 两个 Record 都按 `BaseEmotion` 索引，漏一处会 TS 报错。**hue 必须落在 `WARM_HUE_MIN(30)–WARM_HUE_MAX(46)`**，`tests/emotion-tiers.test.ts` 6 条性质断言会拦住越界（红线 R7） |
| 加 pulse 反应 | `core/types.ts` `PulseReaction` → `emotion/engine.ts` `PULSE_RULES` + `PULSE_PARAMS` → `pet.ts` `drawPulseAura` 内联 `colors` 表 | 规则按 priority 首个命中生效，不叠加。⚠️ `PULSE_PARAMS` 是**覆盖语义**（非叠加），且 colors 是 `Record<string,string>` **不受类型检查**，漏加会静默落到默认灰紫 `rgba(160,160,200,0.4)`（[问题清单 §5.4③](docs/structure/known-issues.md)）。⚠️ T4 待办：覆盖语义要改为偏移+档位调制，动这块前先读 [DESIGN.md §4.3](DESIGN.md)（矛盾 C 裁决） |
| 改尾巴/耳朵姿态 | `renderer/pet.ts` `resolveTailPose()` / `resolveEarPose()` | **必须是纯函数**（只读 RenderParams、无随机、无内部状态），`tests/pose.test.ts` 10 条覆盖。多通道读同一输入时方向必须一致（如 droop 按 `(1-max(0,joy))` 门控），见不变式 14/15 |
| 加恢复项 | `recovery/deck.ts` 的 `DEFAULT_ITEMS` | `seedIfEmpty()` 会自动为新项写初始版本历史 |
| 加 IPC 通道 | `main/index.ts` `registerIpc()` + `preload/index.ts` `api` | 两处签名需一致；`preload` 只暴露白名单 |
| 加面板 UI | `renderer/index.html`（id）→ `styles.css` → `app.ts` | 新增可交互元素须确保被 `collectHotRects()` 收集到，否则点击穿透（不变式 9） |
| 改窗口行为 | `main/index.ts` `createWindow()` / `applyModeToWindow()` | **勿设 `focusable:false`**，macOS 会同时失去鼠标事件接收能力 |
| 改托盘菜单 | `main/index.ts` `createTray()` | **勿动态重建菜单**，macOS 菜单显示中调 `setContextMenu` 会 SIGABRT |
| 改命中判定 | `core/hittest.ts`（几何）+ `renderer/app.ts` `collectHotRects()`（采集） | 几何纯函数有单测覆盖，改完跑 `npm test` |

**验证命令**（顺序不可颠倒：改完 src 必须先 build，否则自检跑的是旧 dist）：
```bash
cd energy-pet
npm run build        # scripts/build.mjs → dist/          ← 自检/启动前必做
npm run typecheck    # tsc --noEmit（strict + noUnusedLocals/Parameters）
npm test             # build:tests → node --test dist-tests/*.mjs
                     #   用例数快照见 §0（会过期，以实跑为准）
npm start            # build + electron .
./smoke.sh           # 沙箱环境启动（自动 unset ELECTRON_RUN_AS_NODE）
```
> ⚠️ 本机 shell 带 `ELECTRON_RUN_AS_NODE=1`，直接 `npx electron .` 会以纯 Node 执行而报错。
> 自检截图模板：
> `env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . \`
> `  --selfcheck /tmp/x.png --user-data-dir=/tmp/xxx --no-sandbox --disable-gpu`
> （`--user-data-dir` 可绕行单实例锁，不必杀掉正在跑的实例；截图目录须先 `mkdir -p`）
>
> `noUnusedLocals`/`noUnusedParameters` 已开启，意味着[问题清单 §5.2](docs/structure/known-issues.md) 列出的未使用**导出**不会报错
> （导出符号不受该规则约束），但新增未使用的局部变量会。
