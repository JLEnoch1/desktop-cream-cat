# PARALLEL-AGENT-PROMPTS.md — 裁决清单拆分（可并行 agent 子任务提示词）

> 生成：2026-10-22 11:0x  
> 依据：用户《Q1 裁决 + T5/T8 重排裁决》原文 + `DESIGN.md` v1.3 + `TASKS.md` v3 + `STRUCTURE_MAP.md` + 源码实测  
> 基线：`npm run build` ✅ · `npx tsc --noEmit` ✅ · `npm test` **106/106**（core 37 / coordinator 16 / hittest 15 / weather-source 13 / geo 9 / pose 10 / emotion-tiers 6）  
> ⚠️ **本仓库未初始化 git**（`git status` → `fatal: not a git repository`）。规则 2⑤ 的「独立分支名」无法作为真实分支交付，见 §0.3。



---

## 0. 开工前必读

### 0.1 🔴 裁决 vs 代码事实：9 处缺口（拆分前必须由用户裁决，不得由 agent 自行填补）

> ⚠️ **G10 / G11 于 2026-10-22 二次核实追加**。同轮核实还发现：并行会话已把 `DESIGN.md` 推进到 **v1.3**（605 行）、`STRUCTURE_MAP.md` 已重构为 **278 行 L1 入口** + 新建 `docs/structure/` 21 份 L2 存根。⇒ **两份文档的旧行号锚点全部失效**，本文档中凡涉及这些文件的定位一律改为**章节名 + grep 模式**（见 §0.4）。`src/`、`tests/` 行号经抽验**仍然准确**（并行会话只改文档未改代码）。

| #          | 裁决原文引用的机制                                                                  | 实测                                                                                                                                                                                                           | 影响                                                                   | 建议                                                                                                                                             |
| :--------- | :------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1**     | **empathy-bound 脉冲**（「恢复留言含负面词 → 共情脸」）                                     | `grep -n "note\|text\|负面" src/emotion/engine.ts` → **0 命中**。`note` 字段在 `core/events.ts` 的 5 个 payload 里存在且全链路透传到落库，但**从无任何代码读取它做语义判断**                                                                       | 🔴 裁决写的是「**核查**豁免」，实为**新建功能**。且**负面词词典不存在于任何文档**                     | A1 只交付**豁免机制**（`PULSE_BINDING` + `intensity()` 旁路），词典与检测逻辑标 **BLOCKED**，等用户给词典                                                                 |
| **G2**     | 「10 分状态完成 **delta≤-2 任务** → micro 变体可见」                                    | `PULSE_RULES` 6 条无一由「单次任务完成幅度」触发：`grateful/determined` 读 `lastRecoveryDeviation`（只认 `recovery.taken`）、`anxious` 读 `rejectedStreak`、`guilty` 读 `overdueTasks`、`restless` 需 30min 内 ≥4 次调整、`numb` 需 ≥90min 无变化 | 🔴 **该验收断言当前不可能命中**——完成任务不产生任何 pulse                                 | 需新增一条 energy-bound 规则（例：`heavy` ← 单次 `actual_delta ≤ -2`），或把验收改为用 `recovery` 事件触发。**待裁决**                                                      |
| **G3**     | T5「尾摆节奏跟随**打字速度**」+「申请**全局输入监听**（Input Monitoring 权限弹窗）」                   | 🔴 **与 R16 直接冲突**。`DESIGN.md` §8.2：「**禁止**申请 macOS 辅助功能或输入监控权限（TCC）」「**禁止**使用 `globalShortcut`/`uiohook-napi`/任何键盘 hook 库」，唯一允许实现是 `powerMonitor.getSystemIdleTime()`，且 §8.2 明写「它**只返回一个整数**，这个性质必须保持」       | 🔴 **打字速度在架构上不可得**。裁决理由 2「权限请求是最高成本信任交换」恰恰是 R16 要阻止的那个弹窗             | 二选一：**(a)** 尾摆节奏改由 idle 秒数**分档**驱动（合规，但不是真实打字速度）；**(b)** 用户显式批准修订 R16。**未裁决前 T5 不得开工**                                                         |
| **G4**     | `intensity(energy)` 查表 `[8,10]→0.25 [6,7]→0.5 [4,5]→0.75 [0,3]→1.0`        | 区间**有空隙**：`3<x<4`、`5<x<6`、`7<x<8` 未定义。而精力是**浮点**（`round2`，滑块 `step=0.5`），`3.5 / 5.5 / 7.5` 是**高频实际取值**                                                                                                       | 🟡 直接照抄查表会产生 `undefined`                                             | A1 采用**下界包含**的规范形式（`>=8 / >=6 / >=4 / else`），语义与裁决意图一致且全覆盖。已在 §A1 定死，若不同意请指出                                                                   |
| **G5**     | base「**0-1 档**」趴窝变体 vs「**2-3 档**蔫」                                         | `BASE_TIERS` 最低三档 min 为 `burnt(-1)` / `exhausted(1.5)` / `drained(2.5)`，量程 0–10 ⇒「0-1」只覆盖 `burnt` 一档                                                                                                         | 🟡 即 `TASKS.md` **Q10**（仍 ⏳ 待裁决）                                     | A7 按 Q10 建议实现为 `energy < 2.5`（`exhausted`+`burnt` 两档），**并在代码注释标注 Q10 待确认**                                                                     |
| **G6**     | T11 排练模式：「**命名仪式**后触发」「写入本地 **emotionCalibration**」「第 3 天 **ambient** 问号卡」 | 三项 **grep 全 0 命中**（`TASKS.md` §1.2 已记录）。另：裁决写「覆盖**五档带**」，而 G4 的 intensity 是**四段带**，`BASE_TIERS` 是 **10 档** —— 三套边界并存                                                                                         | 🔴 T11 **硬阻塞**，无法拆为可执行 agent                                         | A6 仅登记为 **BLOCKED 占位**，不派工。前置补齐后再拆                                                                                                             |
| **G7**     | R11 修订版「**全程 ≤90s** 自动复位」                                                  | 现值 `INJURY_HOLD_MS = 8000`（8s），且 `DESIGN.md` §5.4 判据写「**8 秒**后自动弹性复位」                                                                                                                                        | 🟡 裁决把 8s 改 90s，但**新增了两个节拍**（绷带冒爱心 → 甩头舔毛 → 回蹭光标），90s 是新序列的总时长       | A4 按 ≤90s 实现，各节拍时长自定并写注释；A8 同步把 §5.4 的「8 秒」改为「≤90s」，**避免文档留悬空条款**                                                                              |
| **G10** 🆕 | 裁决给的是 **`intensity(energy)` 四段查表**（按精力浮点值）+ **empathy 豁免**                 | 🔴 三份文档统一写的是**旧签名 `pulseModulation(tier)`**（按档位）：`DESIGN.md:186` 公式 `× modulation(tier)`、`:193` 与 `:571` 现状/M2 行、`docs/structure/renderer-pet.md:46`、`TASKS.md:624` 甚至写「`tier` **或** `energy`」**参数未定**       | 🟡 签名与参数类型双重不一致：按 tier 查表**无法表达** empathy 豁免，且 tier 是离散档位、裁决查表边界是精力值 | **以契约层（A1）为准**：唯一签名 `intensity(energy: number)` + `pulseIntensity(reaction, energy)`。A8/A9/A10 必须把三份文档里的 `pulseModulation(tier)` 全部改写，**不留旧名** |
| **G11** 🆕 | —（非裁决缺口，是**流程风险**）                                                         | 🔴 文档层正被并行会话**实时改写**：`stat -f '%Sm %N'` 实测 `DESIGN.md` 11:31、`TASKS.md` 11:37（1469→1525 行）、`STRUCTURE_MAP.md` 11:38（2170→**278** 行）、`docs/structure/` 21 份 11:35 新建 —— 全在本轮拆分期间发生                            | 🔴 A8/A9/A10 的行号锚点**已两次失效**；且派工后 agent 可能与另一会话**互相覆盖**               | 已加 §0.4「锚点纪律」（grep 当场定位 / 不回退别人的改动 / 交付记录 mtime）。**建议先确认并行会话是否已停手，再派 A8/A9/A10**；A1/A2/A3/A4/A7（改代码）不受影响可先跑                                    |

### 0.2 拆分可行性结论

| 裁决条目                                                               | 可拆为可执行 agent？                               | 归属                        |
| :----------------------------------------------------------------- | :------------------------------------------ | :------------------------ |
| 废除 `PULSE_THRESHOLD`，全档激活                                          | ✅                                           | A1 + A2 + A3              |
| `intensity(energy)` 四段查表                                           | ✅（按 G4 规范形式）                                | A1                        |
| pulse 覆盖语义 → 偏移 × intensity                                        | ✅                                           | A2                        |
| empathy-bound 豁免**机制**                                             | ✅                                           | A1                        |
| empathy-bound **检测 + 负面词词典**                                       | ❌ BLOCKED（G1）                               | A5                        |
| 「delta≤-2 → micro 变体」验收                                            | ❌ BLOCKED（G2）                               | A5 附带                     |
| `injure()` → `pratfall()` + 强意图手势 + 冷却                             | ✅                                           | A4                        |
| 绷带视觉重设计（呆滞脸/折弯胡须/爱心/回蹭）                                            | ✅                                           | A4                        |
| base 低档趴窝变体                                                        | ⚠️ 可执行但边界待确认（G5）                            | A7                        |
| 🔴 **G10 调制函数签名统一**（`pulseModulation(tier)` → `intensity(energy)`） | ✅（三份文档共 5 处，锚点已核实）                          | A1 定名 + A8/A9/A10 各清自己的文件 |
| T5 键盘感知重排                                                          | ⚠️ **文档改序可执行**（A8/A9），**实现 BLOCKED**（G3）    | A8 + A9                   |
| T11 排练模式                                                           | ❌ BLOCKED（G6）                               | A6 占位                     |
| DESIGN.md / TASKS.md 同步                                            | ⚠️ 可执行，但 🔴 **正被并行会话改写**（G11）⇒ 开工前必须重跑 grep | A8 / A9                   |
| 结构地图同步（入口 + `docs/structure/` 存根）                                  | ⚠️ 同上，且**任务范围已重写**（存根迁出，白名单从 1 个文件扩到 6 个）   | A10                       |

### 0.3 交付方式（因无 git 而调整）

仓库未初始化 git，**无法创建真实分支**。两种方案：

- **方案 A（推荐，需用户点头）**：先 `git init` + 首次全量提交，之后每个 agent 按 §A* 给出的分支名开真分支。
- **方案 B（默认，无需批准）**：不建分支，改为**文件归属纪律 + patch 留痕**。每个 agent 只写白名单内文件，交付时把 `diff` 输出到 `patches/A<n>-<slug>.patch` 供人工审阅。分支名仍照写，作为**未来 init 后的命名约定**。

下文每个提示词的 ⑤ 段按**方案 B** 书写，并附方案 A 的分支名。

### 0.4 🟡 文档漂移：锚点纪律（2026-10-22 二次核实后新增，全体 agent 必读）

**问题**：本项目有多个会话并行工作。本轮拆分期间，`DESIGN.md` 已被推进到 **v1.3**、  
`STRUCTURE_MAP.md` 已被重写（现 **2170 行**，自称「已同步完成」）。  
因此**文档行号在两次核实之间就会失效**。实测：

| 文件                         | 本文档初稿引用的行号                                            | 二次核实结果                                                      |
| :------------------------- | :---------------------------------------------------- | :---------------------------------------------------------- |
| `DESIGN.md`（605 行）         | :188 / :190 / :303-335 / :379 / :470 / :601 / :92     | 🔴 **全部落空**（:188、:303、:335 是空行；:470 是「Electron 内置」）         |
| `STRUCTURE_MAP.md`（2170 行） | :778 / :848 / :1472 / :1780 / :1857                   | 🔴 **全部错位**（:778 现为 `bounce`、:848 现为 `extractPulseSignals`） |
| `src/**`、`tests/**`        | :58 / :351 / :138 / :218 / :262 / :394 / :1231 / :243 | ✅ **全部准确**（并行会话未改代码）                                        |

**纪律（强制）**：

1. **改 `DESIGN.md` / `STRUCTURE_MAP.md` / `TASKS.md` 前，必须先自己 grep 定位**。  
   本文档给出的行号一律视为**过期提示**，不是权威坐标。  
   定位命令模板：
   ```bash
   cd /Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet
   grep -n "PULSE_THRESHOLD\|pulseModulation\|8 秒\|保持不变" DESIGN.md
   grep -n "PULSE_THRESHOLD\|PULSE_OFFSETS\|injure\|say(\|drawBubble" STRUCTURE_MAP.md
   ```
2. **改代码文件时**，本文档行号可用（已抽验），但仍建议 `grep -n` 复核一次，成本极低。
3. **交付说明里必须写「定位方式」而不是「行号」**：例如「§4.3 第 3 个列表项」优于「:189」。
4. 🔴 **发现文档已被别的会话改过 → 不要回退它**。以**当前磁盘内容**为准做增量修改；  
   若别人的改动与本轮裁决冲突，**登记冲突并停下**，不要静默覆盖（这会毁掉并行会话的工作）。
5. 已知会被并行会话反复改写的三个文件：`DESIGN.md`、`STRUCTURE_MAP.md`、`TASKS.md`。  
   A8/A9/A10 三个 agent **不得并发**跑同一文件，且开工第一件事是重跑上述 grep。

---

## 1. 「文件 — agent」归属表

> 规则：**同一文件同一时刻只归属一个 agent**。`pet.ts` 与 `engine.ts` 各被多个任务需要，故列为**串行车道**（见 §3）。

| 文件                                                 | 唯一归属             | 车道      | 备注                                                        |
| :------------------------------------------------- | :--------------- | :------ | :-------------------------------------------------------- |
| `src/emotion/engine.ts`                            | **A1**           | 串行 S1   | `PULSE_THRESHOLD` 定义处、`PULSE_RULES`、`resolve()`           |
| `src/core/types.ts`                                | **A1**           | 串行 S1   | `PulseReaction`、`EmotionState.pulseActive`                |
| `src/emotion/pulse-contract.ts`（**新建**）            | **A1**           | 串行 S1   | 契约层唯一真源                                                   |
| `tests/core.test.ts`                               | **A1**           | 串行 S1   | 含 `assert.equal(PULSE_THRESHOLD, 3)`（:243）需改写             |
| `tests/coordinator.test.ts`                        | **A1**           | 串行 S1   | 含 `pulseActive` 断言（:283）需改写                               |
| `src/renderer/pet.ts`                              | **A2 → A4 → A7** | 串行 S2   | 三个任务顺序接力，**不可并行**                                         |
| `tests/pulse-intensity.test.ts`（**新建**）            | **A2**           | 串行 S2   |                                                           |
| `tests/pratfall.test.ts`（**新建**）                   | **A4**           | 串行 S2   |                                                           |
| `tests/emotion-tiers.test.ts`                      | **A7**           | 串行 S2   | 已有 6 条 R7 守护，追加不覆盖                                        |
| `src/renderer/app.ts`                              | **A3**           | 并行 P1   | 含 `PULSE_THRESHOLD` 消费（:9/:1231/:1232）+ `injure` 注释（:394） |
| `DESIGN.md`                                        | **A8**           | 并行 P1   | 🔴 已被并行会话推进到 **v1.3 / 605 行**，行号须当场 grep                  |
| `TASKS.md`                                         | **A9**           | 并行 P1   | 里程碑改序；🔴 已从 1469 → **1525 行**（并行会话在改）                     |
| `STRUCTURE_MAP.md`                                 | **A10**          | 收尾 P2   | 🔴 已重构为 **278 行 L1 入口**（自设 ≤400 行硬约束）                     |
| `docs/structure/emotion-engine.md`                 | **A10**          | 收尾 P2   | `PULSE_THRESHOLD` ×4                                      |
| `docs/structure/renderer-pet.md`                   | **A10**          | 收尾 P2   | `PULSE_THRESHOLD` ×2、`injur` ×9、`pulseModulation` ×1      |
| `docs/structure/renderer-app.md`                   | **A10**          | 收尾 P2   | `PULSE_THRESHOLD` ×1、`injur` ×1                           |
| `docs/structure/known-issues.md`                   | **A10**          | 收尾 P2   | `PULSE_THRESHOLD` ×2、`injur` ×3（三条问题需「消解改写」而非删行）          |
| `docs/structure/emotion-pulse-contract.md`（**新建**） | **A10**          | 收尾 P2   | 契约层存根，A1 交付后照抄真实签名                                        |
| —                                                  | **A5**           | BLOCKED | G1/G2，无文件归属                                               |
| —                                                  | **A6**           | BLOCKED | G6，无文件归属                                                  |

> 🔴 **`docs/structure/` 是并行会话 2026-10-22 11:35 新建的 21 份 L2 存根文档**（渐进式披露重构）。  
> 其余 16 份本轮**无需改动**，仍属只读。若 A1/A2/A4/A7 交付后发现别的存根也过期  
> （例如 `main-coordinator.md` 记录了 `pulseActive`），**登记到交付说明里报告**，不要越界改。

**全体 agent 只读黑名单（禁止修改，违者视为越界）**：  
`src/storage/sqlite.ts`、`src/ledger/*.ts`、`src/core/events.ts`、`src/core/hittest.ts`、`src/core/bus.ts`、`src/task/center.ts`、`src/recovery/deck.ts`、`src/insight/engine.ts`、`src/weather/*.ts`、`src/main/*.ts`、`src/preload/index.ts`、`src/renderer/index.html`、`src/renderer/styles.css`、`tests/pose.test.ts`、`tests/hittest.test.ts`、`tests/geo.test.ts`、`tests/weather-source.test.ts`、`PLAN-5issues.md`、`dist/**`、`dist-tests/**`、`node_modules/**`、`package.json`、`tsconfig.json`

> ⚠️ `src/main/*.ts` 与 `src/preload/index.ts` 在黑名单里，是因为本轮裁决**没有**任何条目需要改主进程（T5 被 G3 阻塞）。若用户批准 T5 开工，需把这两个文件 + IPC 从黑名单移出并新开 agent。

---

## 2. 子任务提示词（复制即用）

> 每条自包含。**§3.0 共用前置约束必须连同每条提示词一起粘贴。**

### 3.0 共用前置约束（每条都要带）

```text
项目：/Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet
（Electron + TypeScript + node:sqlite 桌面精力宠物，完全离线，程序化 Canvas）

环境陷阱（已踩过，勿重复）：
- shell 的 cwd 每条命令都会重置 → 几乎每条命令都要
  `cd /Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet && ...`
- 改完 src **必须 `npm run build`**，否则自检跑的是旧 dist（会误判「改了没生效」）
- 本机会话 shell 带 ELECTRON_RUN_AS_NODE=1，直接 `npx electron .` 会退化成纯 Node 执行而报错。
  自检模板：
    mkdir -p /tmp/shot && env -u ELECTRON_RUN_AS_NODE \
      ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . \
      --selfcheck /tmp/shot/x.png --no-sandbox --disable-gpu \
      --user-data-dir=/tmp/ep-selfcheck
  （`--user-data-dir` 绕行单实例锁，不必杀用户正在跑的实例；截图目录必须先 mkdir）
- 测试冻结时钟唯一正确姿势：`new Date(Date.now())` 而非裸 `new Date()`；
  `t.mock.timers.enable({ apis: ['Date'], now: T })`
- `queryRange(start, end)` 是**半开区间** `[start, end)`，含「此刻」时上界传 `now + 1`

验证顺序（每条任务收尾必跑，三步全绿才算完成）：
    npm run build && npx tsc --noEmit && npm test
测试数**不得少于 106**（会随并行会话上升，开工前先跑一次取当前值为基线）。

冲突约束（硬性）：
- **禁止全仓格式化**（不得跑 prettier/eslint --fix 扫全仓；只改自己动的行）
- **禁止修改白名单外的任何文件**（黑名单见任务卡）
- **禁止重复迁移**（改名类操作只做一次；若发现已被别人改过，停手并报告，不要二次改）
- **语义冲突以契约层（`src/emotion/pulse-contract.ts`）为准**
- 代码与 DESIGN.md 不一致时以**代码**为准，并立即通知负责 DESIGN.md 的 agent（A8），
  不要自己改 DESIGN.md
```

---

### A1 · 契约层：pulse 分类 + intensity 查表 + 废除 PULSE_THRESHOLD

```text
【① 背景与目标】
裁决原文（Q1 第 1–2 条）：
  「PULSE_THRESHOLD 删除（或置为量程外常量并标注 deprecated）。裁决 C 第 1 条原文就是
   『门槛取消，全档触发』——threshold 是旧设计的遗产，本就该在这轮一起火化。留着它 + 调制表，
   等于给全幅区间装了个只许全幅通过的闸门。」
  「调制用查表，不用连续函数。四段查表天然免疫『跨全量程递减导致激活区间内被压扁』。」
  「intensity(energy) = 查表：[8,10]→0.25  [6,7]→0.5  [4,5]→0.75  [0,3]→1.0」
  「0-3 区间内部不再细分——那是全幅区，细分只会重新引入『区间内递减』。
   你提的『低精力区内部细分』方案我否决：它是在保留 threshold 的前提下打补丁，
   而正解是拆掉前提。」
裁决原文（Q1 第 3 条 · empathy 豁免）：
  「threshold 若曾经网关所有 pulse，那么『恢复留言含负面词 → 共情脸』在精力 ≥3 时也从不触发
   ——这违反裁决 C 第 3 条（共情类不受调制、任何档位全幅）。废除 threshold 后，
   确认 empathy-bound 的 intensity 恒为 1.0，energy-bound 走查表。」

目标：建立**契约层唯一真源**，让下游 A2/A3/A4 可并行对齐。本任务是全链路的第一个交付，
在你完成前其他 agent 不得开工。

⚠️ 已核实的两处事实，按此执行，不要自行发挥：
(G4) 裁决给的区间字面量有空隙：3<x<4 / 5<x<6 / 7<x<8 未定义，而精力是浮点
     （round2，滑块 step=0.5），3.5/5.5/7.5 是高频实际取值。
     → 采用**下界包含**规范形式：>=8 → 0.25；>=6 → 0.5；>=4 → 0.75；else → 1.0。
       这与裁决意图一致且全覆盖。在函数注释里写明这个空隙问题与取法理由。
(G1) **empathy-bound 脉冲当前不存在**：`note` 字段虽全链路透传落库，但
     `src/emotion/engine.ts` 从不读取它，也没有任何负面词词典。
     → 你**只交付豁免机制**（分类表 + intensity 旁路 + 单测用桩验证机制生效），
       **不要**自行发明词典或情感检测。现有 6 个 PulseReaction 全部归 'energy'，
       empathy 槽位保留为空。在注释里写明「empathy 集合待用户给词典后填充」。

【② 文件白名单 / 黑名单】
可修改（且仅这些）：
  - src/emotion/engine.ts
  - src/core/types.ts
  - src/emotion/pulse-contract.ts        ← 新建
  - tests/core.test.ts
  - tests/coordinator.test.ts
  - tests/pulse-contract.test.ts         ← 新建
只读参考（禁止修改）：src/renderer/pet.ts、src/renderer/app.ts、src/insight/engine.ts、
  src/storage/sqlite.ts、src/core/events.ts、所有其他 src/**、所有其他 tests/**、
  DESIGN.md、TASKS.md、STRUCTURE_MAP.md
理由：pet.ts / app.ts 是 PULSE_THRESHOLD 的**消费方**，由 A2/A3 并行清理；
  你若代劳就违反了「同一文件同一时刻只归属一个 agent」。

【③ 接口签名 / 常量表 / 命名规范】
新建 src/emotion/pulse-contract.ts，导出以下**精确签名**（下游按此 import，改名即破坏契约）：

  export type PulseBinding = 'energy' | 'empathy';

  /** 每个 pulse 反应的归类。empathy 类不受 intensity 调制（恒 1.0）。 */
  export const PULSE_BINDING: Record<PulseReaction, PulseBinding>;
  //   现值：6 个既有 reaction 全部 'energy'；'none' → 'energy'（无副作用）

  /** 四段查表（下界包含，全量程覆盖，见 G4）。返回值 ∈ {0.25, 0.5, 0.75, 1.0} */
  export function intensity(energy: number): number;

  /** 唯一入口：按 binding 决定是否施加 intensity。empathy 恒 1.0。 */
  export function pulseIntensity(reaction: PulseReaction, energy: number): number;

  /** intensity 的全部合法取值，供测试遍历与下游钳制参考 */
  export const INTENSITY_LEVELS: readonly [0.25, 0.5, 0.75, 1.0];

命名规范：
  - 函数/常量 camelCase，常量全大写下划线；类型 PascalCase
  - 文件内**禁止**出现 `PULSE_THRESHOLD` 字样（除 deprecated 别名，见下）
  - 注释用中文，与既有代码风格一致（解释「为什么」，不复述「做什么」）

engine.ts 的改动：
  - 删除 `export const PULSE_THRESHOLD = 3;`（:58）。
    **不要**保留 deprecated 别名——裁决说「火化」，留别名等于留复活入口；
    消费方（pet.ts:14/218、app.ts:9/1231/1232）由 A2/A3 清理，
    你删掉后 tsc 会红，这是**预期的**：请在交付说明里明确列出这 5 处待清理点，
    并确认 A2/A3 的提示词已覆盖它们。
  - `resolve()` 内 `const pulseActive = energy < PULSE_THRESHOLD;`（:351）
    → 全档激活后 `pulseActive` 恒为 true。**保留字段**（EmotionState 契约不变，
    避免波及 pet.ts/app.ts/types.ts 之外的消费方），改为 `const pulseActive = true;`
    并在注释写明「门槛已废除（Q1 裁决），全档激活；字段保留以维持 EmotionState 形状，
    下游可安全忽略」。若你判断该字段已彻底无消费者，**不要自行删**，
    在交付说明里提请 A8 记入 DESIGN.md 待办。
  - :138 注释「low 与 PULSE_THRESHOLD(3) 对齐」需改写：`energyBand()` 的 low 档（<3）
    仍是 composite 查表用的**独立分档**，与已废除的 pulse 门槛不再有任何关系。
    这条注释若不改，会让未来会话以为门槛还在。
  - `PULSE_RULES` 的 6 条规则**不动**（G2 的新规则属 BLOCKED，不在本任务）。

【④ 可机检验收标准】
1. `grep -rn "PULSE_THRESHOLD" src/` → **零命中**
   （`tests/` 与 `*.md` 允许残留，分别由 A1 自己清理 tests、A8/A9/A10 清理文档）
2. `grep -rn "PULSE_THRESHOLD" tests/` → **零命中**（你负责改掉 core.test.ts:243 的
   `assert.equal(PULSE_THRESHOLD, 3)` 与 :21 的 import）
3. intensity 查表数值断言（写进 tests/pulse-contract.test.ts）：
     intensity(10) === 0.25   intensity(8)  === 0.25
     intensity(7.5) === 0.5   intensity(6)  === 0.5      ← G4 空隙点，必须覆盖
     intensity(5.5) === 0.75  intensity(4)  === 0.75     ← G4 空隙点，必须覆盖
     intensity(3.5) === 1.0   intensity(0)  === 1.0      ← G4 空隙点，必须覆盖
     intensity(-1) === 1.0   （burnt 档 min=-1，越界仍须落全幅）
4. **0-3 区间内部不细分**：断言 `intensity(2.9) === intensity(0.2) === 1.0`
   （裁决第 2 条的正面守护——防止有人后续在这里插 ramp）
5. **empathy 豁免机制生效**：用桩验证——临时构造一个 binding='empathy' 的 reaction
   （可在测试内用局部 Record 覆盖，不改生产表），断言
   `pulseIntensity(stubEmpathy, 10) === 1.0` 而 `pulseIntensity('grateful', 10) === 0.25`。
   这条是 G1 的**机制**验收：词典虽缺，旁路必须已经通。
6. **全档激活**：`resolve({ energy: 10, ... })` 与 `resolve({ energy: 0, ... })`
   两者的 `pulseActive` 均为 true。
7. 既有 106 条测试全绿（允许因语义变更而**改写**断言，不允许**删除**测试）。
   `tests/coordinator.test.ts:283` 的 `assert.equal(lo.pulseActive, true)` 仍应通过；
   但请补一条 `c.ledger.setEnergy(9)` 后 `pulseActive === true` 的断言（原来 9 分是 false）。

【⑤ 交付方式】
方案 B（默认，无 git）：
  - 只写白名单文件；完成后执行
      cd /Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet && \
        npm run build && npx tsc --noEmit && npm test
    tsc **预期红**在 pet.ts / app.ts 的 5 处 PULSE_THRESHOLD 引用上——这是交接信号，
    不是你的 bug。请在交付说明里贴出这 5 处，并确认 A2/A3 提示词覆盖。
    **例外**：若你选择先让 tsc 绿再交付，唯一合规做法是等 A2/A3 完成，
    不要为了让 tsc 绿而去改 pet.ts/app.ts（越界）。
  - 提交粒度：3 个逻辑提交
      1) 新建 pulse-contract.ts + 其单测
      2) engine.ts 废除 PULSE_THRESHOLD + 注释改写
      3) 既有测试改写（core.test.ts / coordinator.test.ts）
  - 交付说明必须包含：G1 的 empathy 空槽现状、G4 的空隙取法、
    5 处待清理消费点清单、pulseActive 是否建议后续删除。
方案 A（若已 git init）：分支 `feat/a1-pulse-contract`
自检命令：
  grep -rn "PULSE_THRESHOLD" src/ tests/ ; npm run build ; npx tsc --noEmit ; npm test
```

---

### A2 · 渲染层：pulse 覆盖语义 → 偏移 × intensity

```text
【① 背景与目标】
裁决原文（Q1 第 2 条）：
  「调制用查表，不用连续函数。你 T4 提示词里的担忧（跨全量程递减导致激活区间内被压扁）
   正是连续 ramp 的病；四段查表天然免疫。」
  「intensity(energy) = 查表：[8,10]→0.25  [6,7]→0.5  [4,5]→0.75  [0,3]→1.0」
裁决原文（验收）：
  「2 分状态同事件 → 全幅瘫倒」
DESIGN.md §4.3（矛盾 C 裁决）原文：
  「pulse 是 base 的偏移量，且偏移幅度受档位调制。final = base + pulse_offset × modulation(tier)」

⚠️ 裁决已校正 §4.3 的**转录错误**：原文写「modulation 随精力档位递减：高精力时 pulse 表达充分，
低精力时 pulse 被压制」——方向**反了**。正确方向是**高精力压缩、低精力全幅**
（8-10 → 0.25 … 0-3 → 1.0）。你实现时以裁决的查表为准，**不要**照抄 §4.3 那句话。
（§4.3 的文字修订属 A8，不在你的白名单内。）

目标：把 `buildParams()` 的三处 `??` 覆盖语义改为「偏移 × intensity」加权叠加。

【② 文件白名单 / 黑名单】
可修改：
  - src/renderer/pet.ts
  - tests/pulse-intensity.test.ts   ← 新建
只读（禁止修改）：src/emotion/pulse-contract.ts（**契约层，只 import 不改**）、
  src/emotion/engine.ts、src/core/types.ts、src/renderer/app.ts、所有其他文件
🔴 前置：A1 必须已交付。开工前先确认 `src/emotion/pulse-contract.ts` 存在且导出
  `pulseIntensity` / `intensity` / `PULSE_BINDING`；不存在就停手报告，不要自己造契约。

【③ 接口签名 / 常量表 / 命名规范】
从契约层 import（**不得复制实现**）：
  import { pulseIntensity } from '../emotion/pulse-contract.js';

改名（DESIGN.md §4.3 明确要求的命名）：
  const PULSE_PARAMS  →  export const PULSE_OFFSETS
  类型保持 Record<PulseReaction, Partial<{ mouthCurve; tremble; eyeOpen }>>

🔴 数值必须重新设计为**偏移量**，不能只改运算符。现值是「绝对目标值」：
  none{} / anxious{tremble:0.3, mouthCurve:-0.25} / guilty{mouthCurve:-0.4, eyeOpen:0.7} /
  numb{eyeOpen:0.1, mouthCurve:-0.15} / restless{tremble:0.45} /
  grateful{mouthCurve:0.5} / determined{mouthCurve:0.3, eyeOpen:1.0}
其中 `guilty.eyeOpen:0.7`、`numb.eyeOpen:0.1`、`determined.eyeOpen:1.0` 直接当偏移会爆表。
建议：eyeOpen 偏移取小量级（±0.1~0.25），mouthCurve 偏移 ±0.2~0.5，tremble 偏移 +0.15~0.45。
每个值旁写一行注释说明「这是相对 base 的偏移，不是目标值」。

叠加公式（buildParams 内）：
  const k = pulseActive ? pulseIntensity(pulse, energy) : 0;
  eyeOpen:    clamp(ep.eyeOpen    + (po.eyeOpen    ?? 0) * k, 0, 1)
  mouthCurve: clamp(ep.mouthCurve + (po.mouthCurve ?? 0) * k, -1, 1)
  tremble:    clamp(ep.tremble    + (po.tremble    ?? 0) * k, 0, 0.9)
（tremble 上限 0.9：burnt 档 base 已 0.6，叠加后不得出现视觉抽搐）

同时清理 pet.ts 内的 PULSE_THRESHOLD 消费（A1 已删定义，tsc 会指到这里）：
  - :14  import 里删掉 PULSE_THRESHOLD
  - :218 `setPreview()` 内 `const pulseActive = energy < PULSE_THRESHOLD;` → `const pulseActive = true;`
    并注释「门槛已废除（Q1 裁决），预览态同样全档激活，保证拖动时 pulse 表现与松手后一致」

命名规范：偏移常量表用 PULSE_OFFSETS；局部系数名统一用 `k`；
  钳制函数复用文件内既有的 `clamp(v, lo, hi)`，**不要**新写一个。

【④ 可机检验收标准】
1. `grep -n "PULSE_PARAMS" src/` → **零命中**（已全量改名）
2. `grep -n "PULSE_THRESHOLD" src/renderer/pet.ts` → **零命中**
3. `grep -n "??" src/renderer/pet.ts` 在 buildParams 函数体内 → **零命中**
   （覆盖语义已消除；注意只查 buildParams 内，文件其他处的 ?? 不动）
4. `grep -n "pulseIntensity" src/renderer/pet.ts` → **≥1 命中**（确实走了契约层）
5. 数值断言（tests/pulse-intensity.test.ts，纯函数级，不起 Electron）：
   - **全幅**：energy=2 时，某 energy-bound pulse 的 mouthCurve 偏移**完整施加**
     → 断言 `|result.mouthCurve - ep.mouthCurve| === |offset.mouthCurve|`（k=1.0）
   - **压缩但非零**：energy=10 时同一 pulse → 偏移量恰为 0.25 倍，且 **≠ 0**
     （这是裁决「0.25 不是 0」的守护；若为 0 则等于在高精力区关掉了 pulse）
   - **钳制生效**：构造 base=-0.85（burnt）+ 负向偏移，断言结果 ≥ -1；
     base=1.0（blissful）+ 正向偏移，断言结果 ≤ 1
   - **单调性**：固定同一 pulse，energy 从 10→0 扫描，断言施加的偏移幅度**单调不减**
     （防止有人把方向改回「低精力压制」）
6. 若 `buildParams` 目前是 private，为了能单测，改为 **export 的模块级纯函数**
   （例：`export function buildRenderParams(energy, base, pulse, pulseActive)`），
   类内方法改为调用它。**不要**用 `(pet as any).buildParams` 这种反射式测试。
7. selfcheck 截图目视：energy=10 与 energy=0 各截一张，确认高精力档 pulse **可见但微弱**、
   低精力档**全幅**。命令见 §3.0。
8. 全量测试 ≥106 绿 + `npx tsc --noEmit` 干净。

【⑤ 交付方式】
方案 B：只写白名单文件；提交粒度 2 个
  1) PULSE_PARAMS → PULSE_OFFSETS 改名 + 数值重设计为偏移量
  2) buildParams 改加权叠加 + 导出为纯函数 + 新建 pulse-intensity.test.ts
交付说明必须包含：新的偏移数值表（逐值说明理由）、selfcheck 两张截图路径。
方案 A：分支 `feat/a2-pulse-offsets`
自检命令：
  grep -n "PULSE_PARAMS\|PULSE_THRESHOLD" src/renderer/pet.ts ;
  npm run build && npx tsc --noEmit && npm test
🔴 你在 pet.ts 车道上是**第一棒**。完成后必须显式通知 A4 可以接力（A4 改同一文件）。
```

---

### A3 · 渲染层入口：清理 PULSE_THRESHOLD 消费 + injure 注释除名

```text
【① 背景与目标】
裁决原文（Q1 第 1 条）：
  「PULSE_THRESHOLD 删除（或置为量程外常量并标注 deprecated）。裁决 C 第 1 条原文就是
   『门槛取消，全档触发』——threshold 是旧设计的遗产，本就该在这轮一起火化。」
裁决原文（Q1 验收）：
  「grep 确认 pulse 触发路径上无任何能量阈值比较。」
用户 2026-10-22 10:47 追加指令（原文）：
  「另建议全文 grep 一次 injure：除 §5.3.4 的裁决记录（作为被否决方案留档）外，
   任何代码注释、类型定义、任务提示词里的 injure() 引用都应改为 pratfall() 或删除
   ——防止旧名在后续 AI 对话里复活。」
裁决原文（§5.3.4）：
  「injure() 已从领域层删除，永不接线任何领域事件。……甩墙/绷带彩蛋以 renderer 层
   局部函数 pratfall() 存续。」

目标：清理 app.ts 里对已废除常量的消费，并把注释里的旧名 injure 除名。
🔴 本任务**只做清理与文案**，不改任何交互逻辑、不动 toast 的触发结构。

【② 文件白名单 / 黑名单】
可修改：
  - src/renderer/app.ts
只读（禁止修改）：src/emotion/**、src/core/**、src/renderer/pet.ts（属 A2/A4 车道）、
  src/main/**、src/preload/**、src/renderer/index.html、src/renderer/styles.css、
  所有 tests/**、所有 *.md
🔴 注意：app.ts:394 那句注释提到 `pet.injure()`，但**改名动作本身在 pet.ts（A4 负责）**。
  你只改注释文字为 `pet.pratfall()`；若 A4 尚未完成，pet.ts 里方法仍叫 injure，
  这会造成短暂的名字不一致——**可接受**，因为注释不产生编译依赖。
  请在交付说明里注明「已与 A4 对齐命名，等待其落地」。

【③ 接口签名 / 常量表 / 命名规范】
需处理的 3 处（实测行号，会漂移，**用特征字符串定位**）：
  :9     `import { tierFor, PULSE_THRESHOLD, describe as describeEmotion } from '../emotion/engine.js';`
         → 删掉 PULSE_THRESHOLD 这个 import 项
  :1231  `if (prev && prev.energy >= PULSE_THRESHOLD && s.energy < PULSE_THRESHOLD) {`
  :1232  `  toast(\`电量低于 ${PULSE_THRESHOLD} 分了，要不要休息一下？\`, 3200);`

🔴 关键判断（必须按此执行，不要自行发挥）：
  :1231 的这个 toast **不是 pulse 触发路径**，它是「精力向下跨过某个值时的一次性提醒」。
  裁决要废的是 **pulse 的激活门槛**，不是这个 UI 提醒。二者共用同一个常量纯属历史耦合。
  正确处置：
    - 在 app.ts 内**新建一个本地常量**承接 UI 提醒语义，与 pulse 彻底解耦：
        /** 低精力提醒的 UI 阈值（与已废除的 pulse 激活门槛无关，Q1 裁决后二者解耦） */
        const LOW_ENERGY_TOAST_AT = 3;
    - :1231/:1232 改用 LOW_ENERGY_TOAST_AT
    - 在注释里写明「本常量只服务这条 toast；pulse 已全档激活，不再有门槛」
  ⚠️ 若你认为这条 toast 本身也该删（它带「要不要休息一下」的劝导语气），
    **不要自行删**——那是产品语义变更，超出本次裁决范围。在交付说明里提请用户裁决。
  :394   `// 永不触发受伤——甩墙只能由 pet.injure() 显式调用（当前无调用方）。`
         → 改为 `// 永不触发跌倒——甩墙只能由 pet.pratfall() 显式调用（当前无调用方）。`
         （同时把「受伤」措辞改为「跌倒」，与 R11 修订版「跌倒彩蛋」对齐）

命名规范：本地常量全大写下划线；注释中文；不引入任何新依赖。

【④ 可机检验收标准】
1. `grep -rn "PULSE_THRESHOLD" src/renderer/app.ts` → **零命中**
2. `grep -rn "injure" src/renderer/app.ts` → **零命中**
3. `grep -rn "LOW_ENERGY_TOAST_AT" src/renderer/app.ts` → **≥2 命中**（定义 + 使用）
4. **裁决要求的总验收**：`grep -rn "PULSE_THRESHOLD" src/` → **零命中**
   （这是全项目断言，需 A1/A2/A3 都完成后才成立；你是最后一棒时负责跑它并记录结果）
5. **pulse 触发路径无能量阈值比较**：
   `grep -rn "energy <\|energy >" src/emotion/engine.ts src/renderer/pet.ts` → 逐条人工核对，
   确认剩余命中都是 composite 查表用的 `energyBand()`（合法保留），**不是** pulse 门槛。
   把核对结果写进交付说明。
6. toast 行为不变：手动验证精力从 3.5 拖到 2.5 时 toast 仍弹一次、文案不变。
7. `npm run build && npx tsc --noEmit && npm test` 全绿，测试数 ≥106。

【⑤ 交付方式】
方案 B：只写 src/renderer/app.ts；提交粒度 1 个
  （改动很小，拆多个提交反而制造噪音）
交付说明必须包含：第 4/5 条的 grep 输出原文、是否建议删除该 toast（提请裁决，不自行删）。
方案 A：分支 `chore/a3-app-threshold-cleanup`
自检命令：
  grep -rn "PULSE_THRESHOLD\|injure" src/renderer/app.ts ; grep -rn "PULSE_THRESHOLD" src/ ;
  npm run build && npx tsc --noEmit && npm test
```

---

### A4 · pet.ts：injure → pratfall + 强意图手势 + 绷带视觉重设计

```text
【① 背景与目标】
裁决原文（§5.3.4 受伤态终局裁决 · 封闭条款）：
  「injure() 已从领域层删除，永不接线任何领域事件。『连续拒绝恢复建议 N 次』类触发源被
   明确否决，理由三条，重提须先逐条推翻：① 语义重复——『你太久没休息』的信息已由
   base 0-1 档承载，镜子不需要第二套词汇；② 时长错配——短时自愈、不落库的状态承载不了
   多日行为叙事，而计数『连续拒绝』需要影子计数器，违背信任姿态；③ 视觉即文案——
   在拒绝休息的上下文里猫瘫倒，无需文字自动读作控诉（RSD 流失引信）。
   甩墙/绷带彩蛋以 renderer 层局部函数 pratfall() 存续，仅由强意图手势触发
   （拖拽超距 + 3s 内方向反转 ≥3 次），单击/连点/普通拖拽物理上不可命中。
   用户长期未休息的合法提醒载体是既有 ambient 脉冲（深夜打瞌睡等），不新建惩罚态。」
裁决原文（🔴 R11 修订版）：
  「跌倒彩蛋（pratfall()）是纯喜剧叙事：无血、无泪、无控诉文案；全程 ≤90s 自动复位
   （平铺→绷带冒爱心→甩头舔毛复原→主动回蹭光标），不落库、不改精力、周报零痕迹；
   仅可由强意图手势触发，永不接受领域事件、单击或连点触发。三判据不变：
   拟物化而非拟人痛苦（呆滞放空脸 + 折弯胡须，禁止 X 眼/旋转/真实伤口/泪痕/悲伤下垂眼）；
   可逆且自愈（不留持久痕迹，10 分钟冷却防重复触发）；不指向用户
   （禁止任何『你弄疼我了』式语义，视觉与文案同禁）。」
裁决原文（绷带视觉重设计 · 无条件项）：
  「X 眼 + 波浪嘴 + 十字贴布 → 呆滞放空脸 + 一根胡须折弯 + 额头绷带冒小爱心；
   复位后接『和好』节拍（回蹭光标）。原 T12 的『累瘫』视觉方向（眼皮沉重、融化式瘫软、
   缓慢起伏）**不属于本项**——并入 base 0-1 档作为趴窝态增强变体。」
   ⇒ 累瘫变体是 **A7** 的活，**你不要做**（禁止重复迁移）。

⚠️ 已核实的冲突，按此执行：
(G7) 现值 INJURY_HOLD_MS = 8000（8s），裁决改为**全程 ≤90s** 且新增节拍
     （平铺 → 绷带冒爱心 → 甩头舔毛 → 回蹭光标）。90s 是**新序列总时长上限**，
     各节拍时长由你定，总和 ≤90s，每个值旁写注释说明。
「回蹭光标」需要光标位置：pet.ts 现有 dragMoveBy/poke 路径能拿到窗口内坐标。
  若现有 API 不足以拿到**静止时的**光标位置，**不要**去改 app.ts（A3 的文件）或
  main/preload（黑名单）——在交付说明里标为待确认，先用「回蹭到最近一次交互点」降级实现。

【② 文件白名单 / 黑名单】
可修改：
  - src/renderer/pet.ts
  - tests/pratfall.test.ts   ← 新建
只读（禁止修改）：src/emotion/**（契约层）、src/core/**、src/renderer/app.ts、
  src/main/**、src/preload/**、src/renderer/index.html、styles.css、所有其他 tests/**、所有 *.md
🔴 前置：**A2 必须已完成并交接**（你与 A2 共用 pet.ts，串行车道第二棒）。
  开工前先 `grep -n "PULSE_OFFSETS" src/renderer/pet.ts` 确认 A2 已落地；
  若仍是 PULSE_PARAMS，停手报告，不要抢棒。
🔴 禁止触碰 A2 的改动区（PULSE_OFFSETS 表、buildParams/buildRenderParams 的叠加公式）。
  你若需要调 pulse 数值，**停下来找 A2**，不要自己改。

【③ 接口签名 / 常量表 / 命名规范】
改名（一次性，禁止留旧名）：
  injure()            → pratfall()
  private injury      → private pratfall
  INJURY_FLY_MS       → PRATFALL_FLY_MS
  INJURY_HOLD_MS      → 拆分为新节拍常量（见下）
  INJURY_RETURN_MS    → PRATFALL_RETURN_MS
  局部变量 injured    → pratfalling
  drawBandage()       → 保留名字（它画的仍是绷带），但内部视觉重做

新增常量（命名规范：PRATFALL_ 前缀 + 全大写下划线）：
  const PRATFALL_FLY_MS       = 350;    // 沿用原值
  const PRATFALL_LIE_MS       = ...;    // 平铺 + 绷带冒爱心
  const PRATFALL_GROOM_MS     = ...;    // 甩头舔毛复原
  const PRATFALL_NUZZLE_MS    = ...;    // 回蹭光标（和好节拍）
  const PRATFALL_RETURN_MS    = 500;    // 沿用原值
  const PRATFALL_TOTAL_MAX_MS = 90_000; // 🔴 R11 修订版硬上限
  const PRATFALL_COOLDOWN_MS  = 600_000;// 🔴 10 分钟冷却
  // 强意图手势判定
  const PRATFALL_DRAG_MIN_PX  = ...;    // 「拖拽超距」的距离阈值，你定并写理由
  const PRATFALL_REVERSAL_WINDOW_MS = 3000; // 裁决原文：3s 内
  const PRATFALL_REVERSAL_MIN = 3;          // 裁决原文：方向反转 ≥3 次

新增/改动的可测纯函数（**必须导出**，供 tests/pratfall.test.ts 单测，不起 Electron）：
  export interface PratfallGestureSample { x: number; y: number; t: number }
  /** 强意图手势判定：拖拽超距 + 3s 内方向反转 ≥3 次。纯函数，无副作用。 */
  export function isPratfallGesture(samples: readonly PratfallGestureSample[]): boolean;

🔴 R10 守护（这是本任务最容易踩的雷）：
  - `poke()` 路径**物理上不得**能触发 pratfall。poke() 现在每次点击 push clickTimes、
    满 3 次清空并触发呼噜。若把 pratfall 挂在连点上，「摸 3 下」会变成
    第 2 下摔墙 + 第 3 下呼噜，两个反馈打架，且直接违反 R10
    （「禁止以任何形式恢复『连点/拖动 → 惩罚』映射，含调高阈值后恢复」）。
  - 判定必须**只在 drag 路径**采样，且要求「超距 + 快速方向反转」同时成立。
    普通拖拽（单向平滑移动）**必须不命中**——这是裁决原文的硬要求。
  - 实现方式：在 dragMoveBy() 里采样 {x,y,t}，在 dragEnd() 时调 isPratfallGesture() 判定。
    **不要**在 poke() 里加任何采样。

视觉重做（drawBandage + drawEyes + drawMouth 的 pratfalling 分支）：
  - 眼睛：X 眼 → **呆滞放空**（半闭无神，瞳孔小而不聚焦）。🔴 禁止 X、禁止旋转眼球、
    禁止泪痕、禁止悲伤下垂眼角。
  - 嘴：波浪嘴 → 可保留轻微波浪（卡通惯例），但不得读作痛苦。
  - 侧脸十字贴布 → **删除**；额头绷带保留，并**冒小爱心**（用心形路径绘制，
    程序化 Canvas，禁止引入图片/GIF/精灵表）。
  - 新增 `private drawWhiskers(...)`：猫当前**无胡须**
    （`grep -i whisker src/` = 0 结果），需新建。pratfall 期间**一根胡须折弯**。
    胡须应作为常驻图层（非 pratfall 期间正常平直），否则「折弯」无从对比。
  - 复位后接「和好」节拍：主动回蹭光标（见 ① 末的降级说明）。

【④ 可机检验收标准】
1. `grep -rn "injure\|INJURY\|injured" src/ tests/` → **零命中**
   （用户 10:47 指令 + TASKS.md 回归清单第 28 项；注意原裁决写「领域层」，
    而 injure 从来在 renderer 层，按领域层查会 trivially pass，必须全项目查）
2. `grep -n "pratfall" src/renderer/pet.ts` → **≥8 命中**（方法/常量/字段/手势函数）
3. `grep -n "X 眼\|drawXEye" src/renderer/pet.ts` → 眼睛的 X 绘制分支**已删除**
   （人工核对 drawEyes 的 pratfalling 分支不再有两条交叉线）
4. `grep -in "whisker" src/renderer/pet.ts` → **≥3 命中**（drawWhiskers 定义 + 调用 + 折弯逻辑）
5. 数值断言（tests/pratfall.test.ts，纯函数级）：
   - **单击不触发**：1 个样本 → `isPratfallGesture() === false`
   - **连点不触发**：3 个同位置样本（间隔 <300ms）→ **false**（🔴 R10 核心守护）
   - **普通拖拽不触发**：20 个单向平滑递增样本（总距 > 阈值）→ **false**
     （裁决原文「普通拖拽物理上不可命中」）
   - **强意图手势触发**：超距 + 3s 内 x 方向反转 3 次 → **true**
   - **超时窗口不触发**：同样的反转但跨度 >3s → **false**
   - **反转不足不触发**：超距 + 反转 2 次 → **false**
6. 时序断言：`PRATFALL_FLY_MS + PRATFALL_LIE_MS + PRATFALL_GROOM_MS + PRATFALL_NUZZLE_MS
   + PRATFALL_RETURN_MS <= PRATFALL_TOTAL_MAX_MS`（90s），写成一条测试断言，
   防止后续有人加长某个节拍而悄悄突破 R11。
7. 冷却断言：`PRATFALL_COOLDOWN_MS === 600_000`。
8. **不落库/不改精力**：`grep -rn "pratfall" src/storage/ src/ledger/ src/insight/` → **零命中**
   （R11：不落库、不改精力、周报零痕迹）
9. selfcheck 截图：触发 pratfall 后截 3 张（平铺冒爱心 / 甩头舔毛 / 回蹭），
   肉眼核对 R11 三判据：无血、无泪、无 X 眼、无控诉文案、呆滞放空脸 + 折弯胡须。
   截图是**唯一**能验视觉的手段——纯函数测试全绿也可能画出恐怖的脸（本项目已踩过两次）。
10. `npm run build && npx tsc --noEmit && npm test` 全绿，测试数 ≥106（含你新增的）。
11. 回归：连点 3 次仍**只出呼噜**，绝不触发 pratfall（TASKS.md 回归清单第 30 项）。

【⑤ 交付方式】
方案 B：只写白名单文件；提交粒度 4 个
  1) 改名 injure→pratfall（含常量/字段/局部变量），行为不变
  2) isPratfallGesture() 纯函数 + tests/pratfall.test.ts
  3) 视觉重做：呆滞脸 + drawWhiskers + 爱心 + 删十字贴布/X 眼
  4) 节拍重排（≤90s）+ 10min 冷却 + 回蹭光标
  （拆开是为了让「改名」这一步可独立 review——它必须零行为变更）
交付说明必须包含：各节拍时长表 + 总和、PRATFALL_DRAG_MIN_PX 取值理由、
  3 张截图路径、「回蹭光标」是否用了降级实现（若是，标待确认）。
方案 A：分支 `feat/a4-pratfall`
自检命令：
  grep -rn "injure\|INJURY\|injured" src/ tests/ ; grep -in "whisker" src/renderer/pet.ts ;
  npm run build && npx tsc --noEmit && npm test
🔴 你是 pet.ts 车道**第二棒**。完成后显式通知 A7 接力（A7 改同一文件的 base 低档变体）。
```

---

### A7 · pet.ts：base 低档「趴窝态」增强变体

```text
【① 背景与目标】
裁决原文（绷带视觉重设计段末）：
  「原 T12 的『累瘫』视觉方向（眼皮沉重、融化式瘫软、缓慢起伏）不属于本项——
   并入 base 0-1 档作为趴窝态增强变体，随 M2 情绪层一起交付。
   验收：对照 R11 修订版三判据逐条过；0-1 档新变体与 2-3 档『蔫』做区分度对比测试。」
裁决原文（§5.3.4 理由 ①）：
  「语义重复——『你太久没休息』的信息已由 base 0-1 档承载，镜子不需要第二套词汇。」

目标：把「累瘫」表达落到 base 低档，成为**镜子（状态层）的正当词汇**，
取代被否决的惩罚态。这是 §5.3.4 的**正向交付**部分。

⚠️ 已核实的边界歧义（G5，即 TASKS.md Q10，仍 ⏳ 待裁决）：
  裁决写「base 0-1 档」，但 BASE_TIERS 最低三档 min 为 burnt(-1) / exhausted(1.5) / drained(2.5)，
  量程 0–10 ⇒「0-1」只覆盖 burnt 一档；而验收又要求与「2-3 档」对比，
  2-3 对应 drained(2.5)。
  → 按 TASKS.md Q10 的建议实现为 **energy < 2.5**（exhausted + burnt 两档）为「趴窝变体」，
    **drained(2.5–3.4)** 为「蔫」。在代码注释里显式标注
    「档位边界依 Q10 建议取 energy<2.5，裁决原文写 0-1 档，待用户确认」。
    **不要**自行修改 BASE_TIERS 的 min 值（那是红线相关常量）。

【② 文件白名单 / 黑名单】
可修改：
  - src/renderer/pet.ts
  - tests/emotion-tiers.test.ts
只读（禁止修改）：src/emotion/engine.ts（**BASE_TIERS 定义处，属 A1**）、
  src/emotion/pulse-contract.ts、src/core/types.ts、src/renderer/app.ts、
  所有其他文件
🔴 前置：**A4 必须已完成并交接**（pet.ts 串行车道第三棒）。
  开工前 `grep -n "pratfall" src/renderer/pet.ts` 确认 A4 已落地；未落地则停手报告。
🔴 若你判断「趴窝变体」必须写进 BASE_TIERS（engine.ts，A1 的文件），
  **不要越界改**。优先在 pet.ts 内用 EMOTION_PARAMS 的 squish/eyeOpen/breath 表达；
  确实需要 tier 级数据时，在交付说明里提请 A1 追加契约字段。

【③ 接口签名 / 常量表 / 命名规范】
在 pet.ts 内实现，命名规范：LOW_TIER_ 前缀 + 全大写下划线。

  /** 趴窝变体的档位边界（G5/Q10：裁决原文「0-1 档」，量程 0–10 下取 energy<2.5，待确认） */
  const LOW_TIER_PRONE_MAX = 2.5;
  /** 「蔫」档下界（drained），用于区分度对比 */
  const LOW_TIER_WILTED_MIN = 2.5;

  /** 纯函数，必须导出以便单测：给定精力，返回趴窝变体的三通道增强系数 */
  export function resolveProneVariant(energy: number): {
    /** 眼皮沉重：eyeOpen 的额外下压量（0 = 不下压） */
    lidDroop: number;
    /** 融化式瘫软：squish 的额外增量 */
    meltSquish: number;
    /** 缓慢起伏：breath 周期的放大倍数（>=1） */
    breathScale: number;
  };

三通道语义（裁决原文用词，逐条对应）：
  - **眼皮沉重** → lidDroop，叠加到 eyeOpen（钳制 ≥0，不得为负）
  - **融化式瘫软** → meltSquish，叠加到 squish（钳制 ≤0.45，避免画穿影子线）
  - **缓慢起伏** → breathScale，乘到 breath（钳制 ≤2.0，即周期最长 13s）
🔴 与既有通道的一致性（DESIGN.md §3.2.2 已踩过的坑）：
  抚摸呼噜会压低 eyeOpen（舒服到眯眼），而 `resolveEarPose()` 的 droop 项已按
  `(1 - max(0, joy))` 门控。你新增的 lidDroop **不得**破坏这个门控——
  否则一只被摸到呼噜的低精力猫会同时触发「眯眼享受」和「眼皮沉重」两套语义，
  耳朵会被压成飞机耳。实现时确认 lidDroop 只作用于 base 低档、且不与 petting 叠加冲突。
🔴 R7 守护：疲惫**只**通过 squish/eyeOpen/breath 表达，**绝不通过色相**。
  不得改动 hue/sat/lum 任何值（tests/emotion-tiers.test.ts 已有 6 条守护会抓到）。

【④ 可机检验收标准】
1. `grep -n "resolveProneVariant" src/renderer/pet.ts` → **≥2 命中**（定义 + 调用）
2. `grep -n "LOW_TIER_PRONE_MAX" src/renderer/pet.ts` → **≥2 命中**
3. 数值断言（追加到 tests/emotion-tiers.test.ts，**不得删改既有 6 条 R7 守护**）：
   - **档位边界**：`resolveProneVariant(2.4)` 三通道**均非零**（趴窝生效）；
     `resolveProneVariant(2.6)` 三通道**均为零/1.0**（蔫档不生效）
   - **区分度对比测试**（裁决明确要求的验收项）：断言 energy=1（趴窝）与 energy=3（蔫）
     在 squish 或 eyeOpen 上的**可辨差值 ≥ 0.08**——两档必须肉眼可分，
     否则「0-1 档 vs 2-3 档」的对比验收不成立。把阈值理由写进注释。
   - **单调性**：energy 从 2.4 → 0 扫描，lidDroop 与 meltSquish **单调不减**
     （越低越瘫，不得出现回升）
   - **钳制**：`resolveProneVariant(-1)`（burnt 档 min）三通道均在钳制范围内
     （meltSquish ≤ 0.45、breathScale ≤ 2.0、lidDroop 使 eyeOpen 仍 ≥ 0）
   - **R7 不被破坏**：既有 6 条 hue/sat/lum 断言全绿
4. 🔴 R11 三判据逐条过（写成注释清单 + 截图核对，不是自动化断言）：
   - 拟物化而非拟人痛苦：趴窝是「融化式瘫软」，**不得**出现泪痕/悲伤下垂眼角/真实伤口
   - 可逆且自愈：变体是 base 的**连续函数**，精力回升即自然恢复，无持久痕迹、无独立状态机
   - 不指向用户：**无任何文案**。趴窝态不得触发 toast/tooltip/气泡
     （`grep -n "趴窝\|累瘫" src/renderer/app.ts` → 零命中）
5. **镜子不需要第二套词汇**（裁决理由 ①）：确认趴窝变体**不引入新的 PulseReaction**、
   **不新增事件类型**、**不落库**。`grep -rn "resolveProneVariant" src/storage/ src/ledger/`
   → 零命中。
6. selfcheck 截图：energy = 3.0（蔫）/ 2.4（趴窝临界）/ 1.0 / 0.2 各一张，
   **并排肉眼对比**区分度。这是本任务的主要验收手段——
   数值断言只能保证「有差异」，看不出「差异是否读得出来」。
7. `npm run build && npx tsc --noEmit && npm test` 全绿，测试数 ≥106 + 你新增的。

【⑤ 交付方式】
方案 B：只写白名单文件；提交粒度 2 个
  1) resolveProneVariant() 纯函数 + 接入 buildParams/render 管线
  2) tests/emotion-tiers.test.ts 追加区分度/单调性/钳制断言
交付说明必须包含：4 张截图路径 + 肉眼区分度结论、G5/Q10 边界待确认的显式声明、
  是否与 petting 眯眼门控有交互（若有，说明如何避免语义冲突）。
方案 A：分支 `feat/a7-prone-variant`
自检命令：
  grep -n "resolveProneVariant\|LOW_TIER_PRONE_MAX" src/renderer/pet.ts ;
  npm run build && npx tsc --noEmit && npm test
🔴 你是 pet.ts 车道**第三棒（末棒）**。完成后跑一次全项目 grep 总验收（见 §3 表）。
```

---

### A5 · BLOCKED：empathy-bound 脉冲检测 + 负面词词典

```text
状态：🔴 **BLOCKED，本任务不派工**。

阻塞理由（G1 / G2，均已实测核实）：
1. 裁决把它写作「**核查**豁免」，但 empathy-bound 脉冲**在仓库中不存在**：
   `grep -n "note\|text\|负面" src/emotion/engine.ts` → 0 命中。
   `note` 字段虽在 core/events.ts 的 5 个 payload 中存在且全链路透传落库
   （recoveryTakenDraft / taskCompletedDraft / energyDeltaDraft / taskDroppedDraft / noteDraft），
   但**从无任何代码读取它做语义判断**。所以这不是「核查」，是**新建功能**。
2. 新建它需要一份「负面词词典」，而该词典**不存在于 DESIGN.md / TASKS.md /
   STRUCTURE_MAP.md / 裁决清单任何一处**。规则明确「不要臆造规则」，故不自行发明。
3. 裁决的验收项「10 分状态完成 delta≤-2 任务 → micro 变体可见」**当前不可能命中**：
   PULSE_RULES 6 条无一由「单次任务完成幅度」触发
   （grateful/determined 读 lastRecoveryDeviation，只认 recovery.taken；
    anxious 读 rejectedStreak；guilty 读 overdueTasks；
    restless 需 30min 内 ≥4 次调整；numb 需 ≥90min 无变化）。
   完成任务这个动作本身不产生任何 pulse。

需用户裁决的 3 个问题（回答后即可拆为可执行 agent）：
  Q-A 负面词词典的内容与来源？是否允许离线本地词典（R18 要求完全离线，
      不得调用任何网络情感分析）？
  Q-B empathy-bound 是**新增第 7 条 PULSE_RULE**（例：reaction 'touched'，
      触发条件 = 最近一条 recovery.taken 的 note 命中词典），
      还是把既有某条 reaction 重新归类为 empathy？
      若是后者，请指明哪一条（现有 6 条按语义都属 energy-bound）。
  Q-C 「delta≤-2 任务 → micro 变体」是否需要新增一条 energy-bound 规则
      （例：reaction 'heavy'，触发 = 单次 actual_delta ≤ -2）？
      还是把该验收改为用 recovery 事件触发（现有规则即可命中）？

A1 已交付的部分（无需等待本任务）：豁免**机制**已就位——
  PULSE_BINDING 分类表 + pulseIntensity() 对 'empathy' 恒返回 1.0 的旁路 + 桩测试。
  本任务解锁后只需往 PULSE_BINDING 里填 'empathy' 并新增检测逻辑，机制无需重做。

预期文件归属（解锁后）：src/emotion/engine.ts（检测逻辑，需与 A1 串行）+
  src/emotion/pulse-contract.ts（填 PULSE_BINDING）+ tests/core.test.ts。
  ⚠️ 这三个文件都属 A1，故本任务**必须在 A1 之后串行**，不可并行。
```

---

### A6 · BLOCKED：T11 排练模式（情绪猜谜 onboarding）

```text
状态：🔴 **BLOCKED，本任务不派工**（仅登记，防止裁决原文丢失）。

裁决原文（情绪猜谜 onboarding 段）：
  「命名仪式后触发。猫演出与账本脱钩的档位，用户猜『它演的这档是几分』；
   排练期间 HUD 替换为 10 格答题选择器（R3 以交互件形态在场），结束后恢复。
   5 轮 ≤30s，覆盖五档带，末轮固定 8-10 档收尾（慢眨+呼噜）；±1 档内猫点头盖章，
   偏差大则该档加大幅度重演一次。永久可跳过（『直接开始』常驻）、设置页永久重玩；
   跳过者仅在第 3 天收到一次角落问号卡提示（ambient），此后不再提。
   校准偏差写入本地 emotionCalibration，驱动对应档位表情幅度加成。
   验收：排练期间账本零写入；答题界面任何位置不出现真实精力值。」

阻塞理由（G6，TASKS.md §1.2 已记录，本轮重新核实仍为 0 命中）：
  - 「命名仪式」：`grep -rn "命名" src/` 仅命中 task/center.ts:77 的 '未命名任务'
    （任务标题兜底），**无任何宠物命名功能** ⇒ 触发时机无锚点
  - 「emotionCalibration」：grep **0 结果** ⇒ 需新建存储表
  - 「ambient 通道」/「深夜打瞌睡」：grep **0 结果** ⇒ 需新建
    （⚠️ 注意：§5.3.4 裁决也引用了「既有 ambient 脉冲（深夜打瞌睡等）」作为
     「用户长期未休息的合法提醒载体」——它同样不存在。这两处引用的是同一个缺失机制，
     建一次可同时解锁 T11b 与 §5.3.4 的提醒载体，建议合并为一个前置任务）
  - 「首次正式镜像」：app.ts:160 的「镜像」指 AdjustWindow 本地镜像，与情绪镜像无关
  - 另：裁决写「覆盖**五档带**」，而 Q1 的 intensity 是**四段带**（8/6/4/3 下界），
    BASE_TIERS 是 **10 档** ⇒ 三套边界并存，即 TASKS.md **Q12**（⏳ 待裁决）。
    TASKS.md 的建议是答题带直接用 10 档（与 HUD 10 格一一对应，零错位）。

可立即开工的子集（TASKS.md 已拆为 T11a，本文件不重复拆）：
  T11a = 排练引擎 `pet.rehearse(tierIndex)` + HUD 10 格答题选择器 +
         hud-num/hud-tier/hud-weather 抑制 + 5 轮时序 + 反馈 + emotionCalibration 存储。
  ⚠️ 但 T11a 要改 pet.ts（与 A2/A4/A7 同车道）+ index.html + styles.css（本轮黑名单）
     + 新建存储（sqlite.ts，黑名单）。**在本轮 A2/A4/A7 车道清空前不得开工**，
     否则必然文件冲突。建议排在本轮全部交付之后单独一轮。
  🔴 另需提醒：TASKS.md 已记录「HUD 除 10 格外还有 hud-num（数字读数）、
     hud-tier（档位文字，直接写出答案）、hud-weather」，三者不抑制则
     违反裁决自己的验收「答题界面任何位置不出现真实精力值」。
```

---

### A8 · DESIGN.md 同步

````text
【① 背景与目标】
DESIGN.md 自身规定（文件头）：
  「本文档是设计冲突的唯一仲裁处；代码与本文档不一致时，以代码为准并**立即修订本文档**
   （不允许留悬空条款）。」
本轮裁决产生 6 处必须同步的文档变更；不改就会留下悬空条款，
未来会话会照着过期文字把已废除的机制「修回来」。

目标：把 Q1 裁决 + §5.3.4 终局裁决 + R11 修订版 + T5/T8 重排落进 DESIGN.md，
并修正裁决指出的**转录错误**。

【② 文件白名单 / 黑名单】
可修改：**DESIGN.md（仅此一个文件）**
只读（禁止修改）：TASKS.md（属 A9）、STRUCTURE_MAP.md（属 A10）、所有 src/**、所有 tests/**
🔴 你**不改代码**。若发现代码与裁决仍不一致（例如 A2/A4 未完成），
  在文档里如实标注「⏳ 待实现」，**不要**把未实现的事写成已实现
  （本项目已发生过一次：v1.2 称配色已纠偏，同节旧数据块仍写蓝紫「严重偏离」）。

【③ 需落地的变更（逐条，🔴 锚点为**章节 + grep 模式**，不是行号 —— 见 §0.4）】

⚠️ **开工第一步**：先跑（🔴 本段在提示词围栏内，故用缩进而非 ``` 代码块，避免提前关闭外层围栏）

    cd /Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet
    wc -l DESIGN.md                       # 2026-10-22 核实为 605 行 / v1.3
    grep -n "PULSE_THRESHOLD\|pulseModulation\|modulation(tier)" DESIGN.md
    grep -n "8 秒\|hold 8s\|8s 自愈\|保持不变" DESIGN.md

`DESIGN.md` 已被并行会话推进到 **v1.3**，本文档初稿引用的 :188/:190/:303-335/:379/:470/:601/:92
**全部失效**。以下用 2026-10-22 核实的锚点，你仍需自行 grep 复核。

1. **§4.3 转录错误修正**（锚点：`### 4.3 pulse 🟡（矛盾 C 裁决）` 段内；
   实测 `grep -n "低精力时 pulse 被压制" DESIGN.md` → **:189**）
   现文：「`modulation` 随精力档位递减：高精力时 pulse 表达充分（状态好，情绪反应外放），
         低精力时 pulse 被压制（累到没力气大喜大悲）。」
   → 改为：**高精力压缩、低精力全幅**，并贴上查表：
     `intensity(energy)`：`>=8 → 0.25`、`>=6 → 0.5`、`>=4 → 0.75`、`else → 1.0`
   → 同时删除/改写随之失效的推论句「`exhausted + grateful` 不再是"大笑"，而是"苦中作乐"
     ——嘴角从 -0.6 抬到 -0.2 左右」（实测在 :190）：按新方向，exhausted（低精力）是**全幅**，
     该例应改为**高精力**档举例（例：blissful + guilty 只有 0.25 幅度）。
     ⚠️ 这个例子是原文用来论证「偏移语义比覆盖语义诚实」的核心论据，
        方向一改论据就失效，必须重写而不是删掉。
2. **公式与函数名（🔴 G10，本轮新增）**
   - `final = base + pulse_offset × modulation(tier)`（实测 :186，在 ``` 代码块内）
     → 改为 `final = base + pulse_offset × pulseIntensity(reaction, energy)`
   - `pulseModulation(tier)` 共 **2 处**（实测 :193「M2 改造项」句、:571 §11 M2 行）
     → 全部改为契约层真名：**`intensity(energy)`**（四段查表）+ **`pulseIntensity(reaction, energy)`**（含 empathy 豁免）
   - 🔴 **不得保留 `pulseModulation` 旧名**，也不得保留「按 tier 调制」的说法：
     按离散档位**无法表达** empathy 豁免，且裁决查表边界是精力值不是档位。
     这是三份文档共同的过期签名（另见 A9 的 `TASKS.md:582`、A10 的 `STRUCTURE_MAP.md:1552`）。
3. **PULSE_THRESHOLD 表述**（实测 `grep -n "PULSE_THRESHOLD" DESIGN.md` → **:191、:380**，共 2 处）
   - :191（§4.3 内）现文：「`PULSE_THRESHOLD = 3` 保持不变（pulse 只在低精力区激活，
     与 `energyBand` 的 `low` 档对齐）。」
   - :380（§6.2 末）现文：「**关联确认**：`PULSE_THRESHOLD = 3` 保持不变（§4.3）。
     日清单便签与 pulse 层互不干涉……」
   → 两处均改为：门槛已**废除**（Q1 裁决），pulse **全档激活**；
     `energyBand()` 的 low 档（<3）仍是 composite 查表用的**独立分档**，与 pulse 无关。
   → :380 那句「关联确认」整句需重写（保留「便签与 pulse 互不干涉」的结论，删掉门槛依据）。
4. **§4.3 现状段**（实测 :193「⚪ **现状**：覆盖语义（`??`）。**M2 改造项**：…」）
   → 更新为 A2 的实际交付（PULSE_PARAMS → PULSE_OFFSETS、加权叠加、走契约层 `pulseIntensity`）。
   **等 A2 交付后再写**，未交付则标 ⏳。注意该句同时含 G10 的 `pulseModulation(tier)`，
   两条改动落在同一行，一次改完。
5. **§5.4 + §10 R11**（锚点：`### 5.4 绷带 = 喜剧叙事 🔴`，实测起于 **:304**；
   `## 10. 设计红线总表` 实测起于 **:507**，R11 行在 **:523**）
   - §5.4 已含 2026-10-22 裁决记录（v1.3 已落地），需**补齐本轮新增细节**：
     强意图手势定义（拖拽超距 + 3s 内方向反转 ≥3 次）、10 分钟冷却、
     四节拍序列（平铺 → 绷带冒爱心 → 甩头舔毛 → 回蹭光标）、≤90s 总时长
   - 🔴 **「8 秒 / hold 8s」共 3 处需统一**（实测 :306「hold 8s」、:313「8 秒后自动弹性复位」、
     :523 R11 行「8s 自愈」）：全改为 **≤90s**，并说明这是四节拍序列的总时长上限
     （原 8s 是单一 hold 节拍）。⚠️ 初稿只登记了 2 处，**漏了 :523 R11 表格行里的「8s 自愈」**。
   - §5.4 末（实测 :332 附近）已登记的「R11 措辞冲突（悬空许可）」→ 本轮裁决**已给出修订版全文**，
     把它正式写进 §10 红线总表的 R11 行（:523），并删掉「待用户确认后修订」的登记语
     （裁决即确认）。同时删掉文件头 :8 的
     「⚠️ **R10/R11 措辞冲突已登记待用户确认**（§5.4 末）……v1.3 未自行修改 §10 表格原文」。
   - 🔴 R11 行现文「`injure()` **仅可由领域事件触发**，不可由手势触发」是**悬空许可**
     （裁决恰恰否决了领域事件路径）→ 改为「跌倒态永不由任何用户行为序列触发；
     `pratfall()` 仅由强意图手势触发，且**不落库、不改精力、永不接线到领域事件**」。
   - §3 附件通道表「绷带」行（实测 **:93**）同步：X 眼 → 呆滞放空脸 + 折弯胡须 + 爱心。
6. **§11 里程碑表：T5 移到 T8 之后**（锚点：`## 11. 里程碑` 实测起于 **:536**，
   M2 在 **:567**、M3 在 **:577**；裁决原文见 A9）
   - M2 表里 T5（键盘感知）移出，改挂到 M3 的 T8 之后
   - 🔴 **必须留一行重排理由**（裁决明确要求：「防止未来对话把顺序『改回去』当作 bug 修」），
     三条理由照录：首因锚定 / 信任时刻不可贱卖 / 无下游阻塞
   - 同时把裁决的配套要求写进 M3：「T5 验收以五通道齐全为前提：
     耳角 + 尾摆（含打字节奏耦合）+ 瞳孔细缝 + 呼吸起伏，四者缺一不验收」
   - 🔴 **必须同时登记 G3 冲突**（见 ④ 第 6 条）：这段配套要求里的
     「打字节奏耦合」与 §8.2（实测起于 **:474**）/ R16 直接冲突，不能只抄裁决不抄冲突。
   - 另：M2 表内 :571 那行含 `pulseModulation` → 见第 2 条 G10。
7. **变更日志追加 v1.4 行**（锚点：`## 12. 变更日志` 实测起于 **:598**，
   现有末行是 :605 的 v1.3；在表格**末尾追加**）
   记录：Q1 裁决（废 threshold + intensity 四段查表 + 方向转录纠错 + **G10 签名统一**）、
   §5.3.4 终局裁决细节、R11 修订版正式入表、T5/T8 重排 + 理由、
   以及 G1/G2/G3/G5/G6/G10 六项待确认登记。

版本号：v1.3 → **v1.4**，文件头的「适用代码」行同步为交付后的实际测试数
（2026-10-22 复验基线：**106/106**，7 个测试文件）。

【④ 可机检验收标准】
1. `grep -n "PULSE_THRESHOLD" DESIGN.md` → **零命中**
   （或仅出现在变更日志里作为「已废除」的历史记述；正文条款必须零命中）
2. `grep -n "保持不变" DESIGN.md` 中与 PULSE_THRESHOLD 相关的句子 → **零命中**
3. `grep -n "低精力时 pulse 被压制" DESIGN.md` → **零命中**（转录错误已纠）
4. `grep -n "0.25\|0.75" DESIGN.md` → **≥2 命中**（intensity 查表已写入）
5. 🔴 `grep -n "8 秒后自动弹性复位\|hold 8s\|8s 自愈" DESIGN.md` → **零命中**
   （G7 已统一为 ≤90s；**三个模式都要查**，初稿漏了 R11 表格行里的「8s 自愈」）
6. 🔴 **G3 冲突必须被登记**：`grep -n "Input Monitoring\|输入监控" DESIGN.md` →
   除 §8.2 原有的禁止条款外，**M3 里程碑表附近必须新增一处冲突登记**，
   内容包含：裁决要求「打字节奏耦合」，而 §8.2/R16 禁止 TCC 输入监控权限、
   且 `getSystemIdleTime()` 只返回一个整数（架构上得不到打字速度）⇒
   **T5 实现 BLOCKED，待用户在「idle 分档降级」与「修订 R16」之间裁决**。
   ⚠️ 这条不可省略。只抄裁决的配套要求而不抄冲突，等于把不可实现项写进契约，
      下游 agent 会照着它去申请 R16 明令禁止的权限。
7. 🔴 **G10 签名统一**：`grep -n "pulseModulation\|modulation(tier)" DESIGN.md` → **零命中**
   （含 :186 公式、:193 现状段、:571 M2 行三处）；
   `grep -n "intensity(energy)\|pulseIntensity" DESIGN.md` → **≥3 命中**
8. `grep -n "R11" DESIGN.md` → §10 表格里的 R11 行**已是修订版全文**（无「8s 自愈」、
   无「仅可由领域事件触发」），且 §5.4 末与文件头 :8 均不再有「待用户确认后修订」的登记语。
9. **无悬空条款自查**：通读 §4.3 / §5.4 / §10 / §11，确认没有任何一处
   仍描述已废除的机制（threshold、X 眼、8s、injure、T5 在 M2、pulseModulation）。
10. 文档内**不得**出现 `injure()`（除变更日志的历史记述与 §5.4 的「被否决方案留档」）。

【⑤ 交付方式】
方案 B：只写 DESIGN.md；提交粒度 4 个
  1) §4.3 方向纠错 + intensity 查表 + threshold 废除（③ 第 1/3 条）
  2) G10 签名统一：公式 + `pulseModulation` → `intensity`/`pulseIntensity`（③ 第 2 条）
  3) §5.4 / §10 R11 修订版 + §3 绷带行 + G7 时长统一（③ 第 5 条）
  4) §11 里程碑改序 + 重排理由 + G3 冲突登记 + 变更日志 v1.4（③ 第 6/7 条）
交付说明必须包含：
  - ④ 第 6 条 G3 登记的**原文**
  - 六处待确认（G1/G2/G3/G5/G6/**G10**）在文档中的落点（用**章节名 + 邻近原文片段**描述，
    不要用行号 —— 见 §0.4，行号会被并行会话冲掉）
  - 你实际改动前跑的那条 `grep -n` 输出原文（证明锚点是当场定位的，不是抄本文档的）
方案 A：分支 `docs/a8-design-sync`
自检命令（全部应零命中，除 Input Monitoring 需人工核对落点）：
  grep -n "PULSE_THRESHOLD\|pulseModulation\|modulation(tier)" DESIGN.md ;
  grep -n "低精力时 pulse 被压制\|8 秒后自动弹性复位\|hold 8s\|8s 自愈" DESIGN.md ;
  grep -n "injure" DESIGN.md ; grep -n "Input Monitoring" DESIGN.md
⚠️ 时序：③ 第 4 条（§4.3 现状段）依赖 A2 交付。建议你在 A1 完成后即开工第 1/2/3/5/6/7 条，
  第 4 条等 A2；不要为了等 A2 而阻塞整份文档。
🔴 并发纪律：A8（DESIGN.md）/ A9（TASKS.md）/ A10（STRUCTURE_MAP.md）三者文件互斥，**可以并行**；
  但每个 agent 开工前必须重跑 grep（§0.4 第 5 条），且**不得回退别的会话已做的改动**。
````

---

### A9 · TASKS.md：里程碑改序 + Q1/Q9/Q10 裁决落地

```text
【① 背景与目标】
裁决原文（T5/T8 裁决 · 重排）：
  「重排——T5 移到尾巴（T8）之后，不接受降级实施。
   里程碑顺序是计划默认值，不是红线；红线层（R3/R7/R11 等）才是绑定约束。
   两者冲突时，顺序让位于质量。三条理由：
   1. 首因锚定：键盘感知的全部产品主张就是『陪伴姿态』——猫落键盘位、尾摆节奏跟随
      打字速度。缺了尾巴先上线，用户对这功能的读数会锚定在『猫坐那儿，仅此而已』；
      后补尾巴时，感知不是『功能变好了』而是『功能变了』。
      感知通道的第一次亮相必须是完全体。
   2. 信任时刻不可贱卖：T5 要申请全局输入监听（macOS 上是 Input Monitoring 权限弹窗 +
      隐私说明）。权限请求是产品与用户之间最高成本的信任交换，不能拿一个半成品的回报去换。
      尾巴齐了再弹这个窗，用户付权限买到的第一眼就是完整体验。
   3. 无下游阻塞：T5 是感知增强项，没有其他任务依赖它先行；重排零连带成本。
   配套要求：
   - DESIGN.md 里程碑表同步改序并留一行重排理由（防止未来对话把顺序『改回去』当作 bug 修）。
   - T5 验收标准中的陪伴姿态定义以五通道齐全为前提：耳角 + 尾摆（含打字节奏耦合）+
     瞳孔细缝 + 呼吸起伏，四者缺一不验收。
   - 若你后续有强理由必须先上 T5（比如要赶演示），降级方案是仅耳角+瞳孔+呼吸、
     尾巴参数位预留 hook（tail rhythm 参数写入但渲染端忽略），尾巴上线时自动点亮
     ——但这走的是例外审批，不是默认路径。」

目标：把重排落进 TASKS.md 的任务总表 / 主线梯队 / T5 卡 / T8 卡，
并把 Q1（已裁决）、Q9（已裁决）、Q10（部分裁决）的状态从 ⏳ 改为 ✅ 并写入裁决结论。

⚠️ 已核实的两点事实：
- 裁决理由 3「无下游阻塞」**成立**：TASKS.md 任务总表的「依赖」列中，
  没有任何任务把 T5 列为前置。可放心重排。
- 裁决要求的「T5 移到 T8 之后」意味着 T5 从 **M2** 移到 **M3 末尾**，
  且新依赖链为 `T6 → T7 → T8 → T5`（T8 卡原文：「前置：T1（尾巴）+ T7（便签容器）必须已完成」）。
  这比现状（T5 依赖 T1 ✅，属第二梯队可立即开工）**大幅推后**，
  请在文档里如实写明这个后果，不要淡化。
- 🔴 裁决理由 2 与配套要求里的「申请全局输入监听 / Input Monitoring 权限弹窗 /
  打字节奏耦合」**与 🔴 R16 直接冲突**（DESIGN.md §8.2 明令禁止 TCC 输入监控权限、
  禁止一切键盘 hook 库，唯一允许 `powerMonitor.getSystemIdleTime()`，
  且「它只返回一个整数，这个性质必须保持」⇒ 架构上得不到打字速度）。
  你**必须**在 T5 卡里登记这个冲突并标 BLOCKED，不得把不可实现项写成验收标准。

【② 文件白名单 / 黑名单】
可修改：**TASKS.md（仅此一个文件）**
只读（禁止修改）：DESIGN.md（属 A8）、STRUCTURE_MAP.md（属 A10）、所有 src/**、所有 tests/**

【③ 需落地的变更（逐条，含实测行号锚点，行号会漂移 → 用特征字符串定位）】
1. **任务总表**（「## 2. 任务总表与执行顺序」的表格）
   - T5 行：里程碑 `M2` → `M3`；依赖 `T1 ✅（尾巴已在）` → `T8（猫叼纸）+ T1 ✅`；
     「是否需裁决」列补 **Q2 已裁决 + 🔴 G3 权限冲突 BLOCKED**
   - T4 行：「是否需裁决」列 **Q1** → `✅ 已裁决（废 threshold + intensity 四段查表）`
   - T12 行：**Q9** → `✅ 已裁决（强意图手势：拖拽超距 + 3s 内反转 ≥3 次）`；
     **Q10** → `⚠️ 部分裁决（原文仍写 0-1 档，实现按 energy<2.5，待确认）`
   - T11 行：补注 `🔴 BLOCKED（G6：命名仪式/emotionCalibration/ambient 三项前置仍全不存在）`
2. **推荐主线（五梯队）重排**
   现状：`第三梯队（需先裁决 Q2）T5 键盘感知` / `第四梯队（M3 便签链）T7 → T8`
   → 改为：T5 移到 T8 **之后**，成为便签链的末棒；第三梯队位置由谁补位需你判断并写明理由
     （建议：把 A2/A4/A7 的 pulse + pratfall 车道提前，因为它们已解锁且零依赖）
   → 🔴 必须留一行**重排理由**（裁决明确要求，防未来会话改回去当 bug 修），三条理由照录。
3. **T5 卡正文**（`### T5 · 键盘感知（陪伴/巡游双姿态）`）
   - 前置说明改为「依赖 T8（猫叼纸身体语言）+ T1 ✅（尾巴）。裁决理由见下」
   - 追加裁决三条理由原文（首因锚定 / 信任时刻不可贱卖 / 无下游阻塞）
   - 追加配套要求：陪伴姿态以五通道齐全为前提（耳角 + 尾摆 + 瞳孔细缝 + 呼吸起伏，
     四者缺一不验收）；降级方案（仅耳角+瞳孔+呼吸、tail rhythm 参数位预留 hook）
     **走例外审批，不是默认路径**
   - 🔴 追加 **G3 冲突登记 + BLOCKED 标记**（内容同 A8 第 6 条），并给出两个待选处置：
     (a) 尾摆节奏改由 `getSystemIdleTime()` 的秒数**分档**驱动（合规，但不是真实打字速度）
     (b) 用户显式批准修订 R16（红线变更，门槛最高）
   - ⚠️ T5 卡现有的「⚠️ 依赖说明：本任务建议在 T1（尾巴）之后做」需改写——
     裁决把依赖从 T1 加强到 T8，旧说明已不足。
4. **T8 卡正文**：追加一行「⚠️ T5 现依赖本任务（2026-10-22 裁决重排），
   本任务延期会连带延期 T5」。
5. **Q1 / Q9 / Q10 裁决表**（「Q1 | pulse 调制曲线 …」所在的表格）
   - Q1 状态 ⏳ → ✅，结论列改为裁决原文要点：
     废除 PULSE_THRESHOLD 全档激活 + intensity 四段查表（>=8→0.25 / >=6→0.5 /
     >=4→0.75 / else→1.0）+ **0-3 区间内部不再细分**（明确否决「低精力区内部细分」方案）
     + empathy-bound 恒 1.0
   - 🔴 Q1 原结论「在**低精力区内部**细分…**不改** PULSE_THRESHOLD」是被本轮裁决
     **推翻**的旧结论，必须删除或标注为「已被 2026-10-22 裁决推翻」，
     不能留着让未来会话照旧结论实现。
   - Q9 状态 ⏳ → ✅，结论：强意图手势（拖拽超距 + 3s 内方向反转 ≥3 次），
     单击/连点/普通拖拽物理上不可命中
   - Q10 状态 ⏳ → ⚠️ 部分裁决：原文「base 0-1 档」在量程 0–10 下只覆盖 burnt 一档，
     实现按 energy<2.5（exhausted+burnt），**待用户确认**
6. **回归清单**（36 项那张表）
   - 第 28 项（全项目 grep injure 零命中）→ 标为 A4 的验收项，补注
     「2026-10-22 实测基线：改前 `grep -rn "injur\|INJURY" src/` = **40 行**
     （`renderer/pet.ts` 39 行 + `renderer/app.ts` 1 行，后者为 :394 注释）；
     `tests/` 与 `scripts/` = **0 行**。A4 交付后 src/ 必须归零」
   - 第 30 项（连点 ≥3 次只出呼噜，绝不触发 pratfall）→ 补注 A4 已用纯函数测试守护
   - 新增一项：`grep -rn "PULSE_THRESHOLD" src/ tests/` → 零命中
   - 新增一项：intensity 查表在 3.5/5.5/7.5 三个**空隙点**有定义（G4）
   - 新增一项：empathy 豁免机制的桩测试存在且通过（G1 的机制部分）
7. **§1.1 勿重做清单**：若 A2/A4/A7 已交付，把 T4/T12 的对应子项移入勿重做清单
   （**等它们真交付后再移**，不要提前写）。
8. 🔴 **G10 签名统一**（本轮新增，2026-10-22 核实）：`grep -n "pulseModulation" TASKS.md`
   实测命中 **2 处**（T4 卡实现要求「新增可导出纯函数 `pulseModulation(tier 或 energy)` → number（0..1）」、
   以及文档同步项「STRUCTURE_MAP.md §3.16（…补 `pulseModulation` / `composeParams`）」）：
   - 前者 → 改为契约层真名：**`intensity(energy: number): number`**（四段查表）
     + **`pulseIntensity(reaction, energy): number`**（含 empathy 豁免）。
     🔴 原文「`tier` **或** `energy`」是**参数未定**的模糊表述，必须定死为 `energy`
     （裁决查表边界是精力值；且按离散 tier 无法表达 empathy 豁免）。
   - 后者 → 🔴 **该引用已失效**：STRUCTURE_MAP.md 已于 2026-10-22 做「渐进式披露重构」，
     接口存根**全部迁出**到 `docs/structure/<模块>.md`，`§3.16` 编号不再存在。
     改为指向 **`docs/structure/renderer-pet.md`**（PetRenderer 存根的新家）。
   - 顺带检查 T4 卡里是否还有其它 `STRUCTURE_MAP.md §3.x` 形式的引用，一律改指
     `docs/structure/` 对应文件（映射表在 STRUCTURE_MAP.md §3「模块索引」的「原§」列）。
9. 🔴 **T4 卡的「设计张力」段必须整段删除或标注推翻**（实测 :600-606 附近）：
   该段现文写「`PULSE_THRESHOLD = 3` 保持不变」「这意味着 pulse **只在 energy < 3 时激活**」
   「请你自己判断并给出方案……若你认为需要调整 `PULSE_THRESHOLD` 或……」——
   这是**留给实现者的开放问题**，而 Q1 裁决已经**关闭**了它（废门槛 + 四段查表 + 0-3 不再细分）。
   🔴 不删的后果：未来会话读到「请你自己判断」会重新展开一轮已裁决的讨论。
   改为：照录裁决结论 + 标注「原设计张力已于 2026-10-22 Q1 裁决关闭，勿重开」。

【④ 可机检验收标准】
1. `grep -n "PULSE_THRESHOLD" TASKS.md` → 仅允许出现在**裁决历史记录**里（标注「已废除」），
   任何**待办/实现要求**段落零命中（🔴 特别是 T4 卡 :600-606 的「设计张力」段，见 ③ 第 9 条）
2. `grep -n "不改 PULSE_THRESHOLD\|低精力区内部.*细分" TASKS.md` →
   若命中，必须紧邻「已被 2026-10-22 裁决推翻」标注
3. T5 行的里程碑列 == `M3`，依赖列含 `T8`
4. `grep -n "首因锚定\|信任时刻不可贱卖\|无下游阻塞" TASKS.md` → **3 处均命中**
   （裁决要求留理由，防改回去）
5. 🔴 `grep -n "Input Monitoring\|输入监控\|getSystemIdleTime" TASKS.md` →
   T5 卡内**必须**有 G3 冲突登记 + BLOCKED 标记
6. `grep -n "intensity" TASKS.md` → **≥2 命中**（Q1 结论 + 回归清单）
7. Q1/Q9 状态列为 ✅，Q10 为 ⚠️ 部分裁决
8. 回归清单条数 ≥ 36 + 3（新增 3 项）
9. 🔴 **G10**：`grep -n "pulseModulation" TASKS.md` → **零命中**；
   `grep -n "STRUCTURE_MAP.md §3" TASKS.md` → **零命中**（存根已迁 `docs/structure/`）
10. **无自相矛盾自查**：通读 T4/T5/T8/T12 卡与主线梯队，确认没有任何一处
   仍写「T5 在 M2」「T5 依赖 T1 即可开工」「Q1 待裁决」「请你自己判断（threshold）」。

【⑤ 交付方式】
方案 B：只写 TASKS.md；提交粒度 4 个
  1) Q1/Q9/Q10 裁决状态落地 + 旧结论标注推翻 + T4 设计张力段关闭（③ 第 5/9 条）
  2) T5/T8 重排（总表 + 主线梯队 + 两张卡 + 三条理由）
  3) G3 冲突登记 + BLOCKED 标记 + 回归清单新增 3 项
  4) G10 签名统一 + `STRUCTURE_MAP.md §3.x` 失效引用改指 `docs/structure/`（③ 第 8 条）
交付说明必须包含：第三梯队补位方案及理由、G3 登记原文、Q10 待确认的显式声明、
  以及你实际改动前跑的 `grep -n` 定位输出原文（⚠️ TASKS.md 正被并行会话改写：
  本轮核实时已从 1469 行涨到 **1525 行**，本文档提到的任何行号都当作过期提示）。
方案 A：分支 `docs/a9-tasks-reorder`
自检命令：
  grep -n "PULSE_THRESHOLD\|pulseModulation\|首因锚定\|Input Monitoring\|intensity\|STRUCTURE_MAP.md §3" TASKS.md
⚠️ 时序：本任务与 A8 有语义耦合（都要写重排理由与 G3 登记 + G10 签名统一），但**文件不重叠**，可并行。
  两边措辞需一致 ⇒ 建议先与 A8 对齐 G3/G10 登记的表述再各自落笔。
```

---

### A10 · 结构地图同步（入口 STRUCTURE_MAP.md + docs/structure/ 存根）

> 🔴 **本任务于 2026-10-22 11:40 整体重写**。原因：并行会话完成了「渐进式披露重构」——  
> `STRUCTURE_MAP.md` 从 2170 行**瘦身到 278 行**（只做 L1 入口，自设「目标 ≤400 行」硬约束），  
> 接口存根**全部迁出**到 `docs/structure/<模块>.md`（21 份，命名 1:1 映射源码路径）。  
> 初稿的 A10 假设「STRUCTURE_MAP.md 是唯一存根文档、单文件白名单」，**已完全失效**。

```text
【① 背景与目标】
结构地图现在是**两层**：
  L1 入口 `STRUCTURE_MAP.md`（278 行）= 目录树 / 依赖图 / 模块索引表 / 17 条不变式 / 问题清单摘要 / 修改指引
  L2 存根 `docs/structure/<模块>.md`（21 份）= 接口级存根全文，命名 1:1（`src/a/b.ts` → `a-b.md`）
  L2 专题 `docs/structure/data-flows.md`（四条主链路）、`docs/structure/known-issues.md`（§5.1–5.4 问题全文）

本轮 A1（废 PULSE_THRESHOLD + 新建契约层）、A2（PULSE_PARAMS→PULSE_OFFSETS + intensity）、
A3（app.ts 解耦 LOW_ENERGY_TOAST_AT）、A4（injure→pratfall + drawWhiskers）、
A7（resolveProneVariant + LOW_TIER_PRONE_MAX）都会改变存根记录的接口签名。
不同步 ⇒ 未来会话照过期存根写代码，把已废除的门槛「修回来」。

✅ **已被并行会话修好、你不用再做的项**（2026-10-22 11:40 实测确认）：
  - §0 统计数字已准确：18 文件 / 6572 行 / 7 测试文件 / 106 用例（与 `find`、`npm test` 输出逐字一致）
    ⚠️ 但 A1 新建 `pulse-contract.ts` 后会变 **19 文件**、行数也变 ⇒ **交付前重新实测**，别抄这里的数字
  - §1 目录树已含 `src/weather/geo.ts`
  - `BaseTier` 已含 `lum` 字段（在 `docs/structure/emotion-engine.md`）
  - `Coordinator` 已补 checkReportDue/confirmReport/commitAdjust/adjustDraft/expireAdjustWindow
  - `say()`/`drawBubble()`/`wrapText()` 已标注为「❌ 已删除（R1 气泡系统）」
    ⚠️ 这类**删除线/❌ 注记是刻意保留的历史说明，不是残留**，不要再删一遍
  - `resolveTailPose()`/`resolveEarPose()`/`pettingUntil` 已入存根；不变式已扩到 17 条

目标：只做**本轮裁决带来的增量**——废门槛、契约层新文档、injure→pratfall、G10 签名统一。

【② 文件白名单 / 黑名单】
可修改（🔴 从「单文件」扩为「入口 + 5 份存根」，2026-10-22 实测命中清单）：
  1. `STRUCTURE_MAP.md`                    —— §3 索引表、§4 不变式、§5 摘要、§6 修改指引
  2. `docs/structure/emotion-engine.md`    —— PULSE_THRESHOLD ×4（:14/:42/:68/:112）
  3. `docs/structure/renderer-pet.md`      —— PULSE_THRESHOLD ×2（:48/:89）、injur ×9、pulseModulation ×1（:46）
  4. `docs/structure/renderer-app.md`      —— PULSE_THRESHOLD ×1（:239）、injur ×1（:110）
  5. `docs/structure/known-issues.md`      —— PULSE_THRESHOLD ×2（:27/:33）、injur ×3（:30/:52/:57）
  6. `docs/structure/emotion-pulse-contract.md` —— 🆕 **新建**（A1 交付后，命名遵循 1:1 约定）
只读（禁止修改）：`DESIGN.md`（A8）、`TASKS.md`（A9）、其余 16 份 `docs/structure/*.md`、
  所有 `src/**`、所有 `tests/**`
🔴 你**不改代码**，只记录代码的接口形状。若某 agent 尚未交付，
  对应存根标 `⏳ 待实现（A2/A4/A7）`，**不要**写成已存在。
🔴 **入口膨胀纪律**：`STRUCTURE_MAP.md` 自设「目标 ≤400 行，不得膨胀」。
  新增详情一律写进 `docs/structure/` 对应文档，入口只留**一行索引**。
  当前 278 行 ⇒ 你的入口改动预算约 **≤20 行**（新增 1 行索引 + 改写若干现有行）。

⚠️ 行号会漂移（本文件在 11:38 刚被重写过）⇒ 一律用 `grep -n` 当场定位，
   上面的行号只是 2026-10-22 11:40 的快照提示。开工第一步：
     cd /Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet
     grep -rn "PULSE_THRESHOLD\|pulseModulation\|injur" STRUCTURE_MAP.md docs/

【③ 需落地的变更】
1. **🆕 新建 `docs/structure/emotion-pulse-contract.md`**（A1 交付后照抄其真实签名）：
     export type PulseBinding = 'energy' | 'empathy';
     export const PULSE_BINDING: Record<PulseReaction, PulseBinding>;
     export function intensity(energy: number): number;
     export function pulseIntensity(reaction: PulseReaction, energy: number): number;
     export const INTENSITY_LEVELS: readonly [0.25, 0.5, 0.75, 1.0];
   必须注明三件事：
   - 🔴 **语义冲突以本文件为准**（本轮拆分的冲突仲裁点，取代旧的 `pulseModulation(tier)` 说法）
   - 查表采用**下界包含**（`>=8 / >=6 / >=4 / else`），因为精力是浮点（step=0.5），
     3.5/5.5/7.5 是高频实际取值（G4）
   - empathy 集合当前为**空**（G1：负面词词典待用户裁决，A1 只交付豁免机制）
   文档格式照抄同目录任一存根（如 `emotion-engine.md`）的头部约定。
2. **§3 模块索引表**（入口 `STRUCTURE_MAP.md`）：新增一行
     `| 3.8b | emotion/pulse-contract.ts | L2 | pulse 分类 + intensity 查表（🔴 冲突仲裁点） | <实测行数> | [emotion-pulse-contract.md](docs/structure/emotion-pulse-contract.md) | pulse-intensity <N> |`
   ⚠️ 表头有「行数」列 = 抽取时快照，**必须实测**后填；「测试」列填 A1 新建的测试文件与用例数。
3. **§1 目录树**：补 `src/emotion/pulse-contract.ts`；补 A1/A2/A4/A7 新建的测试文件
   （`tests/pulse-intensity.test.ts`、`tests/pratfall.test.ts` 等，以实际交付为准）。
4. **§0 统计数字**：交付前重新实测后填写，禁止抄旧值：
     find src -name '*.ts' | wc -l                    # 现 18 → A1 后应为 19
     find src -name '*.ts' -exec cat {} + | wc -l     # 现 6572
     ls tests/*.test.ts | wc -l                       # 现 7
     npm test 2>&1 | grep -E "^# (tests|pass)"        # 现 106
   并注明实测时间戳。⚠️ §0 末尾有「📈 基线演进：40 → 89 → 90 → 100 → 106」一行，
   本轮若新增测试用例，**追加**到这条演进链末尾，不要改写历史值。
5. 🔴 **`PULSE_THRESHOLD` 全量清除**（跨 4 份存根 + 入口，共 **9 处**）：
   - `docs/structure/emotion-engine.md`：
     · 文件头注释「pulse 日志驱动的瞬时反应 → 精力 < PULSE_THRESHOLD 时激活」→ 改「**全档激活**（门槛已废除）」
     · `export const PULSE_THRESHOLD = 3;` 存根行 → 改为一行历史注记：
       「~~`export const PULSE_THRESHOLD = 3`~~ 已废除（2026-10-22 Q1 裁决），pulse 全档激活」
     · `energyBand` 注释「low 与 PULSE_THRESHOLD(3) 对齐」→ 改为
       「low(<3) 是 composite 查表用的**独立分档**，与已废除的 pulse 门槛**无关**」
     · `resolve()` 存根「pulseActive = energy < PULSE_THRESHOLD」→
       「pulseActive 恒 true（门槛已废除，字段保留以维持 EmotionState 形状）」
   - `docs/structure/renderer-pet.md`：
     · 「勿自改 PULSE_THRESHOLD=3」的告诫注释 → 整段改写为**新告诫**：
       「pulse 全档激活，幅度由 `pulseIntensity(reaction, energy)` 调制；勿在这里加能量阈值比较」
     · `setPreview()` 存根的 `pulseActive = energy < PULSE_THRESHOLD` → 同上改「恒 true」
   - `docs/structure/renderer-app.md`：
     · 「⑥ 精力跨过 PULSE_THRESHOLD 向下 → toast 3200ms」→
       「精力跨过 `LOW_ENERGY_TOAST_AT`(3) 向下 → toast 3200ms」，并注明该常量在 `app.ts`
       内**本地定义**，与已废除的 pulse 门槛**无关**（A3 解耦）
   - `docs/structure/known-issues.md`：见第 7 条（问题本身消失，需改写而非删除）
   - 入口 `STRUCTURE_MAP.md` §5 摘要里「最危险：`PULSE_THRESHOLD` 实为 **3**，两处注释仍写"<6"」
     → 该问题已随门槛废除而**消失**，改写为「（已随 2026-10-22 Q1 裁决废除门槛而消解）」
6. 🔴 **G10 签名统一**：`docs/structure/renderer-pet.md` 内
   「M2/T4 将改为 `PULSE_OFFSETS` + `pulseModulation(tier)`」→
   改为「已改为 `PULSE_OFFSETS` + **`pulseIntensity(reaction, energy)`**（契约层，见 emotion-pulse-contract.md）」，
   并注明**数值语义已从绝对目标值改为偏移量**（最容易让未来会话踩的坑，必须写明）。
   ⚠️ 全仓 `grep -rn "pulseModulation" docs/ STRUCTURE_MAP.md` 交付后必须**零命中**。
7. **`known-issues.md` 三条记录改写**（问题消失 ≠ 直接删行，要留可追溯的消解说明）：
   - §5.1「`engine.ts:6` 文件头称『精力 < 6 时激活』，实际 `PULSE_THRESHOLD = 3`」
     → 改写为「engine.ts 文件头原称『精力 < 6 时激活』、实际曾为 3；
        2026-10-22 Q1 裁决**废除门槛**、全档激活，该注释已随之删除 ⇒ **本条消解**」
   - §5.1 末「注：`PULSE_THRESHOLD = 3` 与 `energyBand()` 的 low 档对齐，实现自洽；错的只是注释」
     → 改写为「门槛已废除，`energyBand()` 的 low 档仍用于 composite 查表，两者不再有关联」
   - §5.1「`pet.ts:238` 附近 `injure()` 注释预留『未来接线到领域事件』许可 = **悬空许可**」
     → 改写为「A4 已删除该注释并改名 `pratfall()`；裁决明确**永不接线**（DESIGN.md §5.4）⇒ **本条消解**」
8. **§4 不变式表**（入口）：
   - 第 17 条现文「🔴 受伤态永不由用户行为触发…`injure()` 无调用方且已裁决除名；
     连点只走 `poke()`→呼噜。勿把 `injure()`/`pratfall()` 接线到任何事件或手势」
     → 改名后重写为「**跌倒态永不由任何用户行为序列触发**（R10/R11 修订版）：
       `pratfall()` 仅由**强意图手势**触发（拖拽超距 + 3s 内方向反转 ≥3 次，
       纯函数 `isPratfallGesture()` 判定），单击/连点/普通拖拽物理上不可命中；
       连点只走 `poke()`→呼噜。**永不接线到领域事件、不落库、不改精力**」
   - 🆕 **新增第 18 条**：「**pulse 全档激活，幅度由精力调制**（Q1 裁决）|
     `pulseIntensity(reaction, energy)`：energy-bound 走四段查表（>=8→0.25 / >=6→0.5 /
     >=4→0.75 / else→1.0），empathy-bound **恒 1.0** 不受调制；
     🔴 禁止在 pulse 触发路径上加任何能量阈值比较 | `emotion/pulse-contract.ts`；
     `tests/pulse-intensity.test.ts` 守护」
9. **§6 修改指引**（入口）「加 pulse 反应」那一行：现文写
   「`PULSE_PARAMS` 是**覆盖语义**（非叠加）…⚠️ T4 待办：覆盖语义要改为偏移+档位调制」
   → A2 交付后改为「`PULSE_OFFSETS` 是**偏移语义**，最终值 = base + offset × `pulseIntensity(reaction, energy)`；
     新增反应必须同时在 `PULSE_BINDING` 里登记 energy/empathy 分类（漏登记会 TS 报错）」，
     并删掉「T4 待办」字样。⚠️ 该行原有的 `drawPulseAura` colors 表
     「`Record<string,string>` 不受类型检查、漏加静默落到默认灰紫」警告**必须保留**（那是独立问题）。
10. **`docs/structure/renderer-pet.md` PetRenderer 存根**（A2/A4/A7 交付后同步）：
   - `injure()` → **`pratfall()`**，并补 `isPratfallGesture()`（导出纯函数）、
     `drawWhiskers()`（新增私有方法）、`resolveProneVariant()`（A7 导出纯函数）
   - 补 PRATFALL_* 常量组（含 `PRATFALL_TOTAL_MAX_MS = 90_000`、`PRATFALL_COOLDOWN_MS = 600_000`、
     `PRATFALL_REVERSAL_WINDOW_MS = 3000`、`PRATFALL_REVERSAL_MIN = 3`）
   - 补 `LOW_TIER_PRONE_MAX = 2.5`，注明 G5/Q10 边界待确认
   - `private injury` 字段 → `private pratfall`；相位枚举若改名（`fly/hold/return` →
     四节拍）以 A4 实际交付为准，**照抄源码**不要自己发明
   - `drawEyes`/`drawMouth`/`drawBandage` 的 `injured = false` 形参名 → 跟 A4 实际改名同步；
     注释里「injured=true → 眩晕 X 眼」→ 改「呆滞放空脸 + 折弯胡须」（🔴 R11 修订版禁止 X 眼）
   - `PULSE_PARAMS` → `PULSE_OFFSETS`（见第 6 条）
11. 🔴 **`injure` 全文清扫**（用户 10:47 指令）：`STRUCTURE_MAP.md` + `docs/structure/**` 内
    所有 `injure`/`injury`/`injured` 引用改为 `pratfall` 系，**唯一例外**是明确标注为
    「被否决方案留档 / 改名历史 / ❌ 已删除」的地方。
    2026-10-22 11:40 实测基线（`grep -rn "injur" STRUCTURE_MAP.md docs/`）：
      · `docs/structure/renderer-pet.md` **9 行**（:101 定义 / :105 无调用方注 / :136 字段 /
        :153 绘制顺序 / :172 drawEyes 形参 / :175 X眼注 / :177 drawMouth 形参 /
        :178 波浪嘴注 / :180 绷带「仅 injure() 路径调用」）
      · `docs/structure/known-issues.md` **3 行**（:30 悬空许可 / :52 §5.2 死代码表 / :57 例外注）
      · `docs/structure/renderer-app.md` **1 行**（:110 R10 永不触发受伤）
      · `STRUCTURE_MAP.md` **3 行**（:228 不变式 17 / :237 §5.1 摘要 / :238 §5.2 摘要）
      合计 **16 行**，逐处判断是「改」还是「留档」，并在交付说明里列出判定表。
    ⚠️ 初稿曾把基线写成「STRUCTURE_MAP.md 14 行」——那是**重构前**的旧文件，已作废。

【④ 可机检验收标准】
1. `grep -rn "PULSE_THRESHOLD" STRUCTURE_MAP.md docs/` → 仅允许出现在**带删除线/历史注记/「已消解」**的行，
   任何存根签名行、告诫注释、修改指引零命中
2. `grep -rn "pulseModulation" STRUCTURE_MAP.md docs/` → **零命中**（G10）
3. `grep -rn "injur" STRUCTURE_MAP.md docs/` → 剩余命中必须**逐处**紧邻
   「留档/历史/被否决/❌ 已删除」字样（交付说明里列出每处路径:行号 + 判定理由）
4. `grep -rn "pulse-contract" STRUCTURE_MAP.md docs/` → **≥3 命中**
   （§1 目录树 + §3 索引表 + 新存根文档自身；另 renderer-pet.md/emotion-engine.md 的交叉引用）
5. `test -f docs/structure/emotion-pulse-contract.md` → 存在，且含
   `intensity`、`pulseIntensity`、`PULSE_BINDING`、`INTENSITY_LEVELS` 四个符号各 ≥1 命中
6. `grep -rn "pratfall\|drawWhiskers\|resolveProneVariant\|PULSE_OFFSETS" docs/structure/renderer-pet.md`
   → **4 个符号均 ≥1 命中**（对应 agent 交付后）
7. `grep -n "intensity\|全档激活" STRUCTURE_MAP.md` → 不变式第 18 条 **≥1 命中**
8. `grep -rn "眩晕 X 眼" docs/` → 若命中，必须紧邻「🔴 已裁决改『呆滞放空』」标注
   （不能留成待实现的现状描述）
9. §0 的四个统计数字与实测命令输出**逐字一致**（交付说明里贴命令输出原文 + 时间戳）
10. 🔴 **入口未膨胀**：`wc -l STRUCTURE_MAP.md` ≤ **400**（自设硬约束，现 278）
11. 文档内所有 `⏳ 待实现` 标记与实际交付状态一致（未交付的不写成已存在）
12. **交叉引用不断链**：`grep -o "docs/structure/[a-z-]*\.md" STRUCTURE_MAP.md | sort -u`
    输出的每个路径都真实存在（新建的 pulse-contract 存根必须同时被索引表引用）

【⑤ 交付方式】
方案 B：提交粒度 4 个
  1) 🆕 新建 `docs/structure/emotion-pulse-contract.md` + §1 目录树 + §3 索引表新行 + §0 数字重测
  2) `PULSE_THRESHOLD` 全量清除（4 份存根 9 处 + 入口 §5 摘要）+ known-issues 三条消解改写
  3) G10 签名统一 + §6 修改指引「加 pulse 反应」行 + §4 不变式 17 重写 + 新增 18
  4) `injure` → `pratfall` 全文清扫（16 行逐处判定）+ renderer-pet.md 存根补全
交付说明必须包含：
  - 第 1/9 条的实测命令输出原文（含时间戳）
  - injure 剩余命中的**逐处判定表**（路径:行号 → 改/留档 → 理由）
  - `wc -l STRUCTURE_MAP.md` 结果（证明未突破 400 行入口纪律）
  - 你实际改动前跑的 `grep -rn` 定位输出原文（证明锚点是当场定位的）
方案 A：分支 `docs/a10-structure-map-sync`
自检命令：
  grep -rn "PULSE_THRESHOLD\|pulseModulation" STRUCTURE_MAP.md docs/ ;
  grep -rn "injur" STRUCTURE_MAP.md docs/ ;
  grep -rn "pulse-contract\|pratfall\|drawWhiskers\|resolveProneVariant" STRUCTURE_MAP.md docs/ ;
  wc -l STRUCTURE_MAP.md ; find src -name '*.ts' | wc -l
⚠️ 时序：**必须在 A1/A2/A3/A4/A7 全部交付后最后执行**，否则会记录到中间态接口。
🔴 并发提醒：`docs/structure/` 是并行会话 11:35 刚创建的，**它可能还在继续重构**
   （入口文件在 11:38 还被改过一次）。开工前先看 `ls -la docs/structure/` 的 mtime；
   若发现文件在你在做的过程中被改动，**不要回退别人的改动**，以磁盘当前内容为准做增量。
```

---

## 3. 并行 / 串行依赖说明表

### 3.1 车道划分

| 车道     | 类型           | 序列               | 原因                                                                                                                                                                   |
| :----- | :----------- | :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1** | 串行（**必须最先**） | **A1**           | 契约层。`engine.ts` / `types.ts` / `pulse-contract.ts` 是全体下游的语义真源；规则 3 明确「契约层先定死枚举与查表」                                                                                   |
| **S2** | 串行（3 棒接力）    | **A2 → A4 → A7** | 三者都改 `src/renderer/pet.ts`。规则 1「同一文件同一时刻只归属一个 agent」⇒ **不可并行**。棒次顺序理由：A2 先定 pulse 管线（A4/A7 都要在同一管线里叠加）；A4 次之（pratfall 改的是独立相位机，不依赖 A7）；A7 末棒（base 低档变体要读 A2 定稿的钳制边界） |
| **P1** | 并行           | **A3 ∥ A8 ∥ A9** | 三者文件互不重叠（`app.ts` / `DESIGN.md` / `TASKS.md`），且都只依赖 A1 的契约结论，不依赖 S2                                                                                                  |
| **P2** | 串行（**必须最后**） | **A10**          | 记录全体接口变更，早做会记到中间态                                                                                                                                                    |
| **—**  | BLOCKED      | **A5 / A6**      | G1/G2/G6，无文件归属，不派工                                                                                                                                                   |

### 3.2 时序图

```
              ┌─ A1 契约层 ─────────────────────────────┐
              │  engine.ts / types.ts /                 │
              │  pulse-contract.ts(新) /                │
              │  core.test.ts / coordinator.test.ts     │
              └───────────────┬─────────────────────────┘
                              │ 契约定死（枚举 + 查表 + 分类）
          ┌───────────────────┼───────────────────────┐
          ▼                   ▼                       ▼
   ┌── S2: pet.ts 串行 ──┐   ┌── P1: 并行 ────────────────────┐
   │  A2 pulse 偏移化    │   │  A3 app.ts 清理                │
   │   ↓ 交接            │   │  A8 DESIGN.md 同步             │
   │  A4 pratfall+视觉   │   │  A9 TASKS.md 改序              │
   │   ↓ 交接            │   │  （三者文件互不重叠）          │
   │  A7 base 低档变体   │   └────────────────────────────────┘
   └─────────┬───────────┘              │
             └────────────┬──────────────┘
                          ▼
                 ┌── A10 STRUCTURE_MAP.md ──┐
                 │  （必须最后，记录终态）  │
                 └──────────────────────────┘

   BLOCKED（不派工）：A5 empathy 检测（G1/G2）· A6 T11 排练（G6）
   BLOCKED（文档可改序，实现不可开工）：T5 键盘感知（G3 vs R16）
```

### 3.3 依赖矩阵

| Agent   | 硬前置                   | 可并行对象          | 阻塞对象                  | 文件冲突风险                                                                                                           |
| :------ | :-------------------- | :------------- | :-------------------- | :--------------------------------------------------------------------------------------------------------------- |
| **A1**  | 无                     | 无（必须独跑）        | A2 A3 A4 A7 A8 A9 A10 | 无                                                                                                                |
| **A2**  | A1                    | A3 A8 A9       | A4 A7 A10             | 🔴 与 A4/A7 争 `pet.ts` ⇒ 串行                                                                                       |
| **A3**  | A1                    | A2 A8 A9       | A10                   | 无（独占 `app.ts`）                                                                                                   |
| **A4**  | A1 + **A2 交接**        | A3 A8 A9       | A7 A10                | 🔴 与 A2/A7 争 `pet.ts`                                                                                            |
| **A7**  | A1 + **A4 交接**        | A3 A8 A9       | A10                   | 🔴 与 A2/A4 争 `pet.ts`；⚠️ 若需 tier 级数据会争 `engine.ts`（A1）⇒ 已在提示词内禁止越界                                               |
| **A8**  | A1（第 3 条需 A2）         | A3 A9（+ S2 全体） | A10                   | ⚠️ 与 A9 语义耦合（重排理由/G3 登记措辞需一致），文件不重叠                                                                              |
| **A9**  | A1                    | A3 A8（+ S2 全体） | A10                   | ⚠️ 同 A8                                                                                                          |
| **A10** | **A1 A2 A3 A4 A7 全部** | 无              | 无                     | 无（独占入口 + 5 份存根）。🔴 但 `docs/structure/` 与三份 .md **正被并行会话改写**（11:31–11:38 实测 mtime），开工前必须重跑 grep 定位，且**不得回退别人的改动** |
| **A5**  | 🔴 用户裁决 G1/G2         | —              | —                     | 解锁后须与 A1 串行（争 `engine.ts`）                                                                                       |
| **A6**  | 🔴 用户裁决 G6 + S2 车道清空  | —              | —                     | 解锁后争 `pet.ts`/`index.html`/`styles.css`/`sqlite.ts`                                                              |

> 🔴 **本轮新增的系统性风险：文档层并发写入**。2026-10-22 11:31–11:41 的十分钟内，  
> `DESIGN.md`（→v1.3）、`TASKS.md`（1469→1525 行）、`STRUCTURE_MAP.md`（2170→278 行 + 新建  
> `docs/structure/` 21 份）全部被并行会话改写。⇒ **A8/A9/A10 三个文档 agent 虽然文件互斥，  
> 但都可能与"另一个会话"撞车**。纪律：  
> ① 开工第一步 `stat -f '%Sm %N'` 看 mtime + 重跑 grep 定位（本文档所有行号当作过期提示）；  
> ② 只读黑名单里的文件被别的会话改了也不要去"修回来"；  
> ③ 交付说明里必须写明你开工时各目标文件的行数/mtime，便于事后追溯是谁改的。

### 3.4 最短关键路径

```
A1 → A2 → A4 → A7 → A10        （5 棒，全部串在 pet.ts + 契约层上）
并行侧 A3/A8/A9 可在 A1 完成后随时插入，不影响关键路径长度。
```

**关键路径瓶颈是 `src/renderer/pet.ts`**：A2/A4/A7 三个任务都必须改它，无法并行。  
若需压缩工期，唯一合规手段是**合并为单个 agent 一次改完**（牺牲 review 粒度），  
而不是让多个 agent 同时写同一文件。

### 3.5 全项目总验收（A7 或 A10 收尾时跑一次）

```bash
cd /Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet

# 裁决 Q1：门槛彻底火化
grep -rn "PULSE_THRESHOLD" src/ tests/          # 期望：零命中

# 裁决 Q1：pulse 触发路径无能量阈值比较（人工逐条核对命中项）
grep -rn "energy <\|energy >" src/emotion/ src/renderer/pet.ts

# 用户 10:47 指令 + TASKS 回归清单第 28 项：旧名除名
grep -rn "injure\|INJURY\|injured" src/ tests/  # 期望：零命中

# 契约层存在且被真实消费
grep -rn "pulseIntensity" src/                  # 期望：≥2 文件命中
grep -n "INTENSITY_LEVELS" src/emotion/pulse-contract.ts

# 新增纯函数已导出（可单测，非反射）
grep -n "export function isPratfallGesture\|export function resolveProneVariant\|export function buildRenderParams" src/renderer/pet.ts

# R7 未被 A7 破坏
npm test 2>&1 | grep -E "^# (tests|pass|fail)"   # 期望：≥106 pass / 0 fail

npm run build && npx tsc --noEmit               # 期望：均 exit 0

# ── 文档层（A8/A9/A10 交付后追加）──────────────────────────
# G10：旧签名彻底火化（三份文档 + 存根，共 5 处）
grep -rn "pulseModulation" DESIGN.md TASKS.md STRUCTURE_MAP.md docs/   # 期望：零命中

# 门槛与旧名在文档里只剩历史注记
grep -rn "PULSE_THRESHOLD" DESIGN.md TASKS.md STRUCTURE_MAP.md docs/   # 逐条人工核对：仅删除线/已废除/已消解
grep -rn "injur" DESIGN.md TASKS.md STRUCTURE_MAP.md docs/             # 逐条人工核对：仅留档/❌ 已删除
grep -rn "低精力时 pulse 被压制\|8 秒后自动弹性复位\|hold 8s\|8s 自愈" DESIGN.md  # 期望：零命中

# 契约层存根已建且被索引
test -f docs/structure/emotion-pulse-contract.md && echo OK
grep -rn "pulse-contract" STRUCTURE_MAP.md docs/ | wc -l               # 期望：≥3

# 交叉引用不断链（索引表里指向的存根都真实存在）
for f in $(grep -o "docs/structure/[a-z-]*\.md" STRUCTURE_MAP.md | sort -u); do test -f "$f" || echo "断链: $f"; done

# 入口未膨胀（STRUCTURE_MAP.md 自设 ≤400 行硬约束）
wc -l STRUCTURE_MAP.md                                                 # 期望：≤400
```

---

## 4. 待确认清单（阻塞项汇总，需用户裁决）

| #          | 待确认                                                                                                                                   | 依据来源                                                                              | 阻塞                               | 建议默认值（若用户不另行指定）                                                                                                                                                   |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------- | :------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1**     | empathy-bound 负面词词典的内容/来源；是否新增第 7 条 PULSE_RULE                                                                                        | 裁决 Q1 第 3 条 vs `src/emotion/engine.ts` 实测 0 命中                                    | A5                               | 词典不提供则 A5 保持 BLOCKED；A1 的豁免机制已可独立交付                                                                                                                               |
| **G2**     | 「delta≤-2 任务 → micro 变体」是否需要新增 energy-bound 规则                                                                                        | 裁决 Q1 验收项 vs `PULSE_RULES` 6 条实测无一匹配                                              | A5 的验收                           | 建议新增 `heavy` ← 单次 `actual_delta ≤ -2`；或把验收改用 `recovery` 事件                                                                                                        |
| **G3**     | 🔴 T5「打字节奏耦合 / Input Monitoring 权限」与 R16 冲突如何处置                                                                                       | 裁决 T5 理由 2 + 配套要求 vs `DESIGN.md` §8.2 / R16                                       | **T5 全部实现**                      | (a) 尾摆节奏改由 idle 秒数分档驱动（合规）；(b) 批准修订 R16（红线变更）                                                                                                                     |
| **G4**     | intensity 查表区间空隙（3.5/5.5/7.5 未定义）                                                                                                     | 裁决 Q1 查表字面量 vs 精力为浮点（`round2`/`step=0.5`）                                         | 已在 A1 内解决                        | 下界包含：`>=8 / >=6 / >=4 / else`（已写入 A1，若不同意请指出）                                                                                                                     |
| **G5**     | base「0-1 档」边界（= Q10）                                                                                                                  | 裁决 §5.3.4 vs `BASE_TIERS` min 值 burnt(-1)/exhausted(1.5)/drained(2.5)             | A7 的档位边界                         | `energy < 2.5`（exhausted+burnt），代码注释标待确认                                                                                                                          |
| **G6**     | T11 三项前置（命名仪式 / emotionCalibration / ambient）+ 五档带 vs 四段带 vs 10 档边界（= Q12/Q13）                                                        | 裁决 onboarding 段 vs `grep` 全 0 命中                                                  | A6 / T11 全部                      | 保持 BLOCKED；建议先建 ambient 通道（§5.3.4 也引用它作提醒载体，一次建两处受益）                                                                                                              |
| **G7**     | R11「≤90s」与 §5.4「8 秒」的时长冲突                                                                                                             | 裁决 R11 修订版 vs `INJURY_HOLD_MS = 8000` + `DESIGN.md` §5.4                          | 已在 A4/A8 内解决                     | 统一 ≤90s（四节拍总时长上限），A8 负责删掉文档里的「8 秒」                                                                                                                                |
| **G8**     | 无 git 仓库，分支交付方式                                                                                                                       | `git status` → `fatal: not a git repository`                                      | 规则 2⑤                            | 方案 B（文件归属纪律 + `patches/A*.patch` 留痕）；或用户批准后 `git init` 走方案 A                                                                                                      |
| **G9**     | 第三梯队补位（T5 移走后空出的位置）                                                                                                                   | 裁决「T5 移到 T8 之后」vs `TASKS.md` 主线五梯队                                                | A9 的梯队表                          | 把已解锁且零依赖的 pulse/pratfall 车道（A2/A4/A7 对应的 T4/T12）提前补位                                                                                                              |
| **G10** 🆕 | 调制函数的**唯一签名**：`intensity(energy)`（裁决）vs `pulseModulation(tier)`（三份文档现存）                                                               | `DESIGN.md:186/:193/:571`、`TASKS.md:624/:655`、`docs/structure/renderer-pet.md:46` | A1/A2 的接口名 + A8/A9/A10 的文档改写     | **以契约层为准**：`intensity(energy: number)` + `pulseIntensity(reaction, energy)`；旧名 `pulseModulation` 全仓清除。`TASKS.md:624` 原文「`tier` **或** `energy`」参数未定，必须定死为 `energy` |
| **G11** 🆕 | 文档层正被**并行会话实时改写**（11:31–11:41 十分钟内 `DESIGN.md`→v1.3、`TASKS.md` 1469→1525 行、`STRUCTURE_MAP.md` 2170→278 行 + 新建 `docs/structure/` 21 份） | `stat -f '%Sm %N'` 实测 mtime                                                       | A8/A9/A10 的**行号锚点全部失效**；且有撞车覆盖风险 | 已加 §0.4「锚点纪律」：一律 grep 当场定位、不回退别人的改动、交付说明记录开工时行数/mtime。**是否要先让并行会话停下来再派 A8/A9/A10？**（建议：是）                                                                         |
