# 多 Agent 并行分配方案 v2（4 agent · 基于 git 分支）

> 生成：2026-10-22 13:00 · 依据：当前磁盘实测（非历史文档）
> 根目录：`/Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet`
> 本文只输出**方案**，不含实现代码。详细五段式提示词见 `PARALLEL-AGENT-PROMPTS.md`（A1–A10），
> 本文是它的**合并调度层**：把 10 个槽位收敛为 4 个可派工 agent + 明确的 git 分支/合并顺序。

---

## 0. 结论速览

| 项 | 实测结论 |
|:--|:--|
| 根目录 | `energy-pet/`（Electron + TS + node:sqlite，18 个 src 文件 / 6572 行） |
| git | ✅ 已 init，`main` 分支，远端 `ssh://git@ssh.github.com:443/JLEnoch1/symmetrical-petstick.git`，已有 2 个提交 |
| .gitignore | ✅ 已排除 `node_modules/ dist/ dist-tests/ *.log .env .DS_Store`；无密钥/数据库/日志入库 |
| 基线 | ✅ `npm run build` · `tsc --noEmit` · `npm test` **106/106 pass / 0 fail** |
| 🔴 工作区 | **810 行未提交改动**（M1 尾巴/耳朵/配色 + 预测校准回路）+ 5 个未跟踪文件 ⇒ **派工前必须先提交基线**（见 §0.5） |
| agent 数 | **4 个**（领域 / 渲染 / 设计文档 / 任务结构文档），文件路径零重叠 |
| 关键路径 | `Phase0 基线提交 → A 领域契约 → B 渲染 → (C ∥ D) 文档` |

---

## 0.5 🔴 Phase 0（前置，必须先做，否则后续全部作废）

**问题**：`git log` 只有 2 个提交，且 Initial commit 是**更早的快照**。当前工作区有 **810 行未提交的真实成果**：

```
 M src/core/types.ts        M src/emotion/engine.ts   M src/insight/engine.ts
 M src/main/coordinator.ts  M src/renderer/app.ts     M src/renderer/pet.ts (+323 行)
 M src/storage/sqlite.ts    M tests/core.test.ts      M STRUCTURE_MAP.md
 M docs/structure/known-issues.md   M docs/structure/renderer-pet.md
?? DESIGN.md  ?? TASKS.md  ?? PARALLEL-AGENT-PROMPTS.md
?? tests/emotion-tiers.test.ts  ?? tests/pose.test.ts
```

若不先提交就开分支，每个 agent 会**从未完成的工作树分叉**，改动互相缠绕、无法干净合并。

**动作**（在 `main` 上，一次性固化当前全绿基线）：

1. 先确认并行会话已停手：`stat -f '%Sm %N' src/**/*.ts *.md`，mtime 距现在 >5min 且不再变化。
2. 复核基线仍绿：`npm run build && ./node_modules/.bin/tsc --noEmit && npm test`（应 106/106）。
3. 全量提交：
   ```
   git add -A
   git commit -m "chore: 固化 M1(尾巴/耳朵/配色)+预测校准回路 基线 (106 tests green)"
   ```
4. （可选，需你确认）推送：`git push origin main`。
   ⚠️ 推送会把 DESIGN.md/TASKS.md 等内部规划文档公开到该 GitHub 仓库——确认这个仓库可以是公开的再推。

> 本方案默认 **Phase 0 由主控会话执行**，不派给 agent。执行后记下基线 commit hash，作为所有分支的共同起点。

---

## 1. 拆分原则

1. **按文件边界切，路径零重叠**：每个 agent 的「可写白名单」互斥，任何两个 agent 不同时写同一文件。
2. **契约先行**：跨文件公共语义（pulse 分类枚举、`intensity()` 查表、偏移合成公式）由**领域 agent 一次性定死**并最先合入；下游只消费不重定义。语义冲突以契约层为准。
3. **单文件多任务 → 归一个 agent 内部串行**：`pet.ts` 有 3 个必做子任务（偏移化 / pratfall / 趴窝变体），**不拆给 3 个 agent**（拆了也只能串行，还多两次交接），而是归渲染 agent 一人按序做完。
4. **渲染层整体归一个 agent**：`app.ts` 改动极小（解耦一个常量 + 改一行注释），且与 `pet.ts` 有 API 耦合（拖动轨迹/`pratfall` 触发），合并进渲染 agent 可**消除跨 agent 接口协调**。
5. **文档 agent 与代码 agent 分离**：文档只描述代码的**终态**，必须等代码冻结后再写，否则记录到中间态。
6. **只读黑名单**：本轮无任何条目需要改 `src/main/*`、`src/preload/*`、`src/storage/*`、`src/ledger/*`、`src/core/{events,bus,hittest}.ts`、`src/task/*`、`src/recovery/*`、`src/insight/*`、`src/weather/*`、`index.html`、`styles.css`、`package.json`、`tsconfig.json` ⇒ 全体 agent 禁止改（`coordinator.ts` 实测 0 处相关引用，本轮不动）。

---

## 2. 分配表

| Agent | 名称 | 负责模块 | 可写文件白名单（精确路径） | 上游依赖 | 交付物 | 验收标准（可机检） |
|:--|:--|:--|:--|:--|:--|:--|
| **A** | `domain-contract`<br>领域/契约 | pulse 语义真源：废门槛 + 分类 + intensity 查表 | 🆕`src/emotion/pulse-contract.ts`<br>`src/emotion/engine.ts`<br>`tests/core.test.ts`<br>`tests/coordinator.test.ts`<br>🆕`tests/pulse-intensity.test.ts` | Phase 0 | 契约层新文件 + engine 去门槛 + intensity 四段查表 + empathy 豁免机制 + 测试 | `grep -rn "PULSE_THRESHOLD" src/ tests/`=0；`grep -n "intensity\\|pulseIntensity\\|PULSE_BINDING" src/emotion/pulse-contract.ts`≥4；`npm test`≥106 且新增 intensity 用例通过；查表在 3.5/5.5/7.5 有定义 |
| **B** | `renderer`<br>渲染层 | pet.ts 三子任务（内部串行）+ app.ts 解耦 | `src/renderer/pet.ts`<br>`src/renderer/app.ts`<br>`tests/pose.test.ts`<br>🆕`tests/pratfall.test.ts`<br>`tests/emotion-tiers.test.ts` | **A**（import 契约层） | ①`PULSE_PARAMS`→`PULSE_OFFSETS` 偏移×intensity ②`injure`→`pratfall`+强意图手势+绷带视觉重设计+`drawWhiskers` ③base 低档趴窝变体 ④app.ts 用本地 `LOW_ENERGY_TOAST_AT` 解耦 | `grep -rn "injur" src/`=0；`grep -n "pratfall\\|drawWhiskers\\|resolveProneVariant\\|PULSE_OFFSETS" src/renderer/pet.ts`≥4；`grep -n "PULSE_THRESHOLD" src/renderer/app.ts`=0；`npm test` 全绿；R7 配色守护 6 条不破 |
| **C** | `design-doc`<br>设计契约文档 | DESIGN.md 同步 | `DESIGN.md` | **A + B**（语义冻结） | §4.3 方向纠错 + intensity 查表 + 门槛废除 + `pulseModulation`→`intensity`(G10) + §5.4/§10 R11 修订版 + 8s→≤90s(G7) + T5/T8 改序 + G3 冲突登记 + 变更日志 v1.4 | `grep -n "PULSE_THRESHOLD\\|pulseModulation\\|低精力时 pulse 被压制\\|8 秒后自动\\|8s 自愈" DESIGN.md`=0（正文）；`grep -n "intensity(energy)" DESIGN.md`≥1；R11 行无「仅可由领域事件触发」 |
| **D** | `tasks-structure-doc`<br>任务+结构文档 | TASKS.md + 结构地图系统 | `TASKS.md`<br>`STRUCTURE_MAP.md`<br>`docs/structure/*.md`（含🆕`emotion-pulse-contract.md`） | **A + B + C** | Q1/Q9/Q10 裁决落地 + T5/T8 改序 + 回归清单 + 结构地图存根同步（门槛清除/injure→pratfall/契约层新存根/G10 签名） | `grep -rn "PULSE_THRESHOLD\\|pulseModulation" STRUCTURE_MAP.md docs/`=0（除历史注记）；`grep -rn "injur" docs/ STRUCTURE_MAP.md` 仅剩留档处；新存根文件存在；`wc -l STRUCTURE_MAP.md`≤400 |

**暂不派工（阻塞，需你先裁决）**：

| 槽位 | 内容 | 阻塞原因 |
|:--|:--|:--|
| A5 | empathy-bound 脉冲检测 + 负面词词典 | **G1**：词典不存在于任何文档；裁决写「核查」实为「新建」。A 已交付豁免**机制**，词典待你给 |
| — | 「delta≤-2 任务 → micro 变体」验收 | **G2**：现有 6 条 PULSE_RULES 无一由单次任务幅度触发，该验收当前不可能命中 |
| A6 | T11 情绪猜谜排练模式 | **G6**：命名仪式 / emotionCalibration / ambient 三项前置 grep 全 0 |
| — | T5 键盘感知实现 | **G3**🔴：「打字节奏 / Input Monitoring 权限」与 R16 直接冲突（`getSystemIdleTime()` 只返回一个整数）。文档改序归 C/D，**实现不得开工** |

---

## 3. 数量与节奏

### 为什么是 4 个（不是 3，也不是 5+）

- **下限 3 不够**：代码（领域+渲染）与文档（设计+任务结构）若压成 3 个，必有一个 agent 同时写 `engine.ts` 和 `DESIGN.md`——违反「文档等代码冻结」原则，会记录中间态。
- **上限 5+ 无收益**：唯一的并行瓶颈是 `pet.ts`（3 子任务争用），它**物理上只能串行**；再拆只是把串行任务分给多人 + 增加交接，不缩短工期。`app.ts` 改动仅 ~4 行且与 pet.ts 耦合，单列一个 agent 是浪费。
- **4 个恰好**：2 个代码 agent（领域/渲染，A→B 串行）+ 2 个文档 agent（C/D，可并行）。文件零重叠，交接最少。
- 若你坚持要 5 个：把 B 拆成 `B1 pet.ts` + `B2 app.ts`，但两者仍是 B1→B2 串行（app 依赖 pet 的 API），**并行度不增**，不推荐。

### 阶段划分（哪些并行 / 哪些串行）

```
Phase 0（主控，串行）   基线提交 → 记下 base commit
        │
        ▼
Phase 1（串行·必须最先）  Agent A 领域契约
        │  冻结 engine.ts 导出 + 新建 pulse-contract.ts + 合入 main
        ▼
Phase 2（串行·关键路径）  Agent B 渲染层
        │  内部顺序：pet.ts①偏移化 → ②pratfall+视觉 → ③趴窝变体 → app.ts 解耦
        │  合入 main（rebase on A）
        ├───────────────┐
        ▼               ▼
Phase 3（并行）      Agent C 设计文档   ∥   Agent D 任务+结构文档
        （C/D 文件不重叠，可同时跑；都依赖 A+B 已合入的终态）
        │               │
        └───────┬───────┘
                ▼
        全项目总验收（主控跑一次 §3.5 命令）
```

- **必须串行**：Phase 0→1→2（契约→渲染，因为 B import A 的产物）。
- **可并行**：Phase 3 的 C ∥ D（DESIGN.md 与 TASKS.md/STRUCTURE_MAP.md 文件互斥）。
- **关键路径**：`Phase0 → A → B → (C 或 D)`，长度由 B（pet.ts 三子任务）决定。
- **压缩工期唯一合规手段**：把 B 的三子任务合并为「一个 agent 一次改完」（已经是这样），**不是**让多 agent 并发写 pet.ts。

---

## 4. 共享文件：归属与合并顺序

| 共享文件 | 类型 | 本轮归属 | 说明 |
|:--|:--|:--|:--|
| `src/emotion/pulse-contract.ts` 🆕 | 契约层（枚举+查表+分类） | **A 独占创建** | 🔴 全项目 pulse 语义唯一真源；B/C/D 只读引用，冲突以此为准 |
| `src/emotion/engine.ts` | 领域逻辑 + 导出 `PULSE_THRESHOLD`(删)/`describe`/`tierFor` | **A 独占** | B 的 pet.ts/app.ts **import 它** ⇒ A 必须先合入并冻结导出签名，B 才能开工 |
| `src/core/types.ts` | 全局类型（`PulseReaction` 在 :58） | **只读冻结** | A 只**读** `PulseReaction` 定义 `PulseBinding`，不改 types.ts；`PulseBinding` 放进 A 自己的 pulse-contract.ts |
| `tests/*.test.ts` | 测试 | A 与 B **各占不同文件**（见分配表） | `scripts/build-tests.mjs` 用 `globSync('tests/**/*.test.ts')` **自动发现** ⇒ 新增测试文件**无需改 package.json** |
| `package.json` / `tsconfig.json` | 配置 | **只读冻结** | 自动 glob + 无新依赖 ⇒ 本轮无人需要改 |
| `src/main/coordinator.ts` | 装配 | **只读冻结** | 实测 0 处 pulse/injure 引用，本轮不动 |
| `DESIGN.md` | 设计契约 | **C 独占** | 与 D 的文件不重叠 |
| `STRUCTURE_MAP.md` + `docs/structure/*` | 结构地图 | **D 独占** | 21 份存根 + 入口；入口自设 ≤400 行硬约束 |

**合并顺序（强制）**：
```
main(Phase0 基线)
  ← A 合并（契约+engine）         [必须最先，冻结导出]
  ← B 合并（rebase on A 后）       [import A 的契约]
  ← C 合并 ∥ D 合并（顺序不限，互不重叠）
```
- 每个 agent 从**同一个 base commit**（Phase 0 产物）开分支，避免链式 rebase 冲突。
- 分支名：`feat/a-domain-contract` · `feat/b-renderer` · `docs/c-design` · `docs/d-tasks-structure`。
- 🔴 **合并前每个 agent 自跑** `npm run build && tsc --noEmit && npm test`，绿了才允许合；B 合并前必须 `git rebase main`（拿到 A 的契约）再跑一次。
- C/D 合并无代码风险，但需人工核对「描述的是 A+B 的终态而非中间态」。

---

## 5. 一致性要求（每个 agent 开工前必做）

1. **先读后写**：动任何文件前，先读它 + 它的直接依赖，沿用既有风格：
   - 命名：常量 `SCREAMING_SNAKE`（`PULSE_THRESHOLD`/`WARM_HUE_MIN`）、纯函数 `camelCase`（`resolveTailPose`/`energyBand`）、类型 `PascalCase`（`PulseReaction`/`BaseTier`）。
   - 分层：L0 core → L1 ledger/storage → L2 领域模块（emotion/task/…横向零依赖）→ L3 main/preload/renderer。**禁止**反向或 L2 横向 import。
   - 错误处理：天气/IO 层**永不抛错只降级**（`WeatherSensor` catch 全兜底）；纯函数无 IO 无状态。
   - 精度：精力值一律过 `core/events.round2()`（两位小数）。
2. **守 17 条不变式**（`STRUCTURE_MAP.md §4`）：尤其 #12 情绪合成纯函数、#13 姿态解算纯函数无随机、#16 低精力配色不退暖(R7)、#17 跌倒态永不由用户行为触发。
3. **守红线**（`DESIGN.md §10` R1–R20）：R10 连点只正向反馈、R11 跌倒态无血无泪无 X 眼、R16 禁 TCC 输入监控权限、R19 雷阵雨不配正向修饰。
4. **文档锚点纪律**（本项目多会话并行，行号会漂移）：改 `.md` 前**自己 grep 定位**，交付说明写「章节名 + 邻近原文」而非行号；发现别的会话改过**不回退**，以磁盘当前内容做增量。
5. **环境陷阱**：shell cwd 不持久（每条命令带 `cd .../energy-pet &&`）；本机 shell 带 `ELECTRON_RUN_AS_NODE=1`（selfcheck 用 `env -u` 起隔离实例 + `--user-data-dir`）；改 src 后**必须先 `npm run build`** 再自检；git 命令用 `GIT_PAGER=cat` 或 `git -C <path>` 避免 pager 卡交互。
6. **不留悬空**：删一个符号就全仓 grep 它的引用（含注释、文档、任务提示词），一次清干净——本项目已因 `injure` 旧名残留吃过亏。

---

## 6. 与现有 A1–A10 文档的映射

| 本方案 | 对应 `PARALLEL-AGENT-PROMPTS.md` | 变化 |
|:--|:--|:--|
| Phase 0 | （原文档无，因当时无 git） | 🆕 新增：基线提交（G8 已解决） |
| Agent A | A1 | 范围不变 |
| Agent B | A2 + A3 + A4 + A7 | **4 合 1**（pet.ts 三棒 + app.ts 归一人，消除跨 agent 接口协调） |
| Agent C | A8 | 范围不变 |
| Agent D | A9 + A10 | **2 合 1**（任务文档 + 结构地图，都属"描述终态"且串行于代码之后） |
| 暂不派工 | A5 / A6 | 仍 BLOCKED（G1/G2/G6/G3 待你裁决） |

> 各 agent 的**完整五段式提示词**（背景/白黑名单/接口签名/可机检验收/交付方式）仍在 `PARALLEL-AGENT-PROMPTS.md`，
> 派工时把对应 A* 段 + 本文 §5 一致性要求一起投喂即可。本文负责**调度层**（谁先谁后、合到哪、共享文件归谁）。

---

## 7. 待你拍板

1. **Phase 0 是否现在执行**？（提交 810 行基线到 `main`；测试已绿、无密钥，安全。推送远端前请确认仓库可公开）
2. **是否先让并行会话停手**？（`docs/structure/` 与三份 .md 在 11:31–11:38 仍被改写；不停手则 C/D 有撞车风险）
3. **G1/G2/G3/G6 四项阻塞裁决**（见 §2 暂不派工表）——不给结论则 A5/A6/T5 实现无法开工，但**不影响 A/B/C/D 四车道**。
4. agent 数确认 **4**（还是要拆成 5）？
