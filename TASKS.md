# TASKS.md — 确定任务列表（可直接逐条执行）

> 生成：2026-10-22 · **修订 v3：2026-10-22 09:59**
> 基线：`npm run build` ✅ · `npx tsc --noEmit` ✅ · `npm test` **106/106 绿**
> （core 37 / coordinator 16 / hittest 15 / weather-source 13 / pose 10 / geo 9 / emotion-tiers 6，共 **7** 个测试文件）
> 依据：`DESIGN.md` **v1.2**（设计契约，唯一仲裁处）+ `STRUCTURE_MAP.md`（接口存根，⚠️ 仍停在 v1.0 未同步）+ **源码实测核对**
> 用法：每条任务自带一段**可直接投喂新会话的提示词**（§3）。按 §2 的顺序逐条执行，做完一条跑一次验证门（§4）。
>
> **v3 变更摘要**：① 检测到**并行会话已完成 M1 全组**（T1 尾巴 + T2 耳朵 + T3 配色守护，DESIGN.md 已升 v1.2），三项移入勿重做清单，基线 90 → **106**；② T0 条目按 v1.2 实况重算（A/B/L/M 已部分完成，剩余聚焦 STRUCTURE_MAP 全量 + §3.1 残留数据块）；③ 落地用户 T11/T12/T13 裁决，附「裁决 vs 代码事实」**12 处偏差**核对；④ 新增 Q9–Q13；⑤ 回归清单 23 → **36 项**；⑥ 主线重排五梯队。
>
> ⚠️ **并行会话警示**：本项目有另一个会话在同时工作（09:16 写 `pose.test.ts`、09:35 改 `pet.ts`、09:42 写 `emotion-tiers.test.ts`、09:43 升 DESIGN.md 到 v1.2）。
> **每轮开工前必须重新跑 `npm test` + grep 核对基线，不得信任本文档或上一轮的结论。**
> 本文件的 v2 就在写完后 16 分钟内被并行进展超越（当时记的基线 100，实际已 106）。

---

## 0. 执行前必读

**代码与文档不一致时，以代码为准。** 本轮核对发现文档有 4 处过期，已在 §1 标注。执行任何任务前，先用 §1 的「勿重做清单」确认该项是否真的还没做。

**行号会漂移。** 提示词里给出的行号是 2026-10-22 的快照，完成前序任务后会变。**优先用函数名 + 特征字符串定位**（提示词里两者都给了），行号只作参考。

**每条任务完成的硬门槛**：`npm run build` → `npx tsc --noEmit` → `npm test` 全绿，测试数**不得少于 106**（该数字会随并行会话推进而上升，开工前先跑一次取当前值）。涉及渲染的任务额外跑 `--selfcheck` 截图目视确认。

---

## 1. 现状核对结论

### 1.1 ⚠️ 勿重做清单（文档说要做，代码已完成）

| 项 | 文档记载 | 实测结论 | 处置 |
|:--|:--|:--|:--|
| **T1 尾巴通道** | `DESIGN.md` §3 称「完全不存在（pet.ts 全文无 tail 绘制代码）🔴 金渐层选型的最大缺口。M1」 | **已落地**。`pet.ts:80 TailPose` 接口、`:101 resolveTailPose()` 导出纯函数、`:681 drawTail()`（身体后图层，`:537` 注释「M1 情绪通道」）；且已接入命中区（`:344-351` 用 `tailTip` 扩展 petBounds 左右下边界，避免尾巴可点区漏报） | ❌ **不要重做**。已有 `tests/pose.test.ts` 5 例守护 |
| **T2 耳朵情绪通道** | `DESIGN.md` §3 称「只是小触角，摆动仅由 breathPhase 驱动 🔴 未编码情绪」 | **已落地**。`pet.ts:124 resolveEarPose()` 导出纯函数（返回 `pose ∈ [-1,1]`）；`drawEar()` 签名已改为 `(ctx,x,y,side,pose,breathPhase,p,bodyR)`，实现圆角三角猫耳 + 耳内暖粉；三态齐全：前倾（pose>0）/ 自然外张（0）/ **飞机耳**（pose<0，外张+下压+缩短+耳廓内暖色收淡）；呼吸摆动降到 0.03 rad 作「活着」的底噪 | ❌ **不要重做**。已有 `tests/pose.test.ts` 5 例守护 |
| **T3 配色回归测试守护** | 本文件 v1/v2 列为待办（「R7 无测试守护」） | **已落地**。`tests/emotion-tiers.test.ts` 6 例 + `WARM_HUE_MIN/MAX` 导出常量 + 变异验证（hue→250 触发 3 条失败）。DESIGN v1.2 §3.1 已补守护句 | ❌ **不要重做**。⚠️ 但 DESIGN §3.1 **旧数据块残留**、§3 通道 5 **仍标 ⚠️ 偏离** ⇒ 转 T0 条目 A/B |
| **M1 配色纠偏（R7）** | `DESIGN.md` §3.1 称低精力档 hue 为 `210 → 288`（蓝→紫），「严重偏离」，列为 M1 待办 | **已落地**。`BASE_TIERS` 实测 hue = `46/44/42/40/38/37/36/35/34/33`，全程暖区间；且已新增 `lum` 通道（`80→52`），由 `sat + lum` 表达疲惫。`pet.ts:26` 注释已写明「R7：低精力靠 sat+lum 表达疲惫」。DESIGN v1.2 裁决段已更新 | ❌ **不要重做配色**。⚠️ §3.1 第 100–102 行**旧数据块仍写着蓝紫值** ⇒ T0 条目 A |
| **R1 气泡系统删除** | `STRUCTURE_MAP.md` §3.16 仍列出 `say(text, ms?)`、`drawBubble()`、`bubbleText`、`wrapText()` | **已删除**。`grep 'say(\|drawBubble\|bubbleText\|wrapText' src/renderer/pet.ts` 无结果 | ❌ 不要重做。转为 T0 文档修订 |
| **`charged` 删除（R19）** | v1.1 变更日志称已删 | **已落地**。源码仅 `emotion/engine.ts:161` 注释里作为历史说明出现，`CompositeModifier` / `COMPOSITE_TABLE` / `MODIFIER_LABEL` 均无该键 | ❌ 已完成，勿动 |
| **`PLAN-5issues.md` 需求 1–5** | 标注「状态：待确认（确认后开工）」 | **全部已落地**：气泡移除、dock 常驻、HUD 10 格（`HUD_CELL_COUNT`/`initHudCells`/`renderHudCells`）、天气 IP 定位（`src/weather/geo.ts`，QQ 天气主源）、周报 17:30 弹窗（`checkReportDue()`） | ❌ 该文件是**历史文档**，不再是待办来源 |
| **T4 pulse 偏移化** | 本文件 T4 卡（含「设计张力」开放问题） | **已落地**：`PULSE_OFFSETS` 偏移语义 + `buildRenderParams()` 导出纯函数 + 契约层 `pulseIntensity`（main `fb2f37c`）；张力段已被 Q1 裁决关闭 | ❌ 不要重做。`tests/pulse-offsets.test.ts` 守护 |
| **T12 pratfall + 累瘫变体** | T12 卡 | **已落地**：`pratfall()`+`isPratfallGesture()`+五段时序≤90s+10min 冷却+`drawWhiskers()`（main `1557490`）；`resolveProneVariant()` 趴窝变体（main `e23845e`，Q10 边界 energy<2.5 待确认） | ❌ 不要重做。`tests/pratfall.test.ts`/`emotion-tiers.test.ts` 守护 |
| **T13 金渐层花纹 + T14 真实感** | T13 卡 | **已落地**：`coatPatternParams()`/`irisTone()`/`drawCoatPattern()`/黑眼线环/尾尖耳背 tipping（main `14c0bc2`/`d59d47d`/`3efdb0b`）；三灯位+毛边+噪点+次级运动（main `ff4bb27`） | ❌ 不要重做。`tests/coat-pattern.test.ts`/`secondary-motion.test.ts` 守护 |

### 1.2 ✅ 真正待做（已逐项 grep 确认缺口存在）

| 缺口 | 实测证据 |
|:--|:--|
| **pulse 仍是覆盖语义** | `pet.ts:366 buildParams()` 内：`eyeOpen: pp.eyeOpen ?? ep.eyeOpen`、`mouthCurve: pp.mouthCurve ?? ep.mouthCurve`、`tremble: pp.tremble ?? ep.tremble`（`??` = 覆盖，非叠加）。`PULSE_PARAMS` 仍在 `:51` |
| **键盘感知未实现** | `grep -rn "powerMonitor\|getSystemIdleTime" src/` → **0 结果** |
| **周报未分级** | `core/types.ts` 的 `WeeklyReportPayload` 无 `presentation` 字段；`coordinator.ts:622` 只有 `requireAck: now.getDay() === 5`，周一至周四仍走同一个模态卷轴 |
| **`injure()` 是死 API** | 仅 `pet.ts:262` 定义处 + `app.ts:394` 注释「当前无调用方」。用户 T12 裁决：从领域层除名 |
| ~~R7 无测试守护~~ | ✅ **已由并行会话补上**：`tests/emotion-tiers.test.ts` 6 条性质断言（暖区间 / 无 [180,320] 冷病态档 / sat·lum 单调不增 / blissful-burnt 可辨差值 / hue 跨度 ≤20），且做了变异验证（hue→250 触发 3 条失败）。`WARM_HUE_MIN=30`/`WARM_HUE_MAX=46` 已导出为常量 |
| **排练/命名/镜像/ambient 通道均不存在** | `grep -rn "命名\|镜像\|灵魂\|排练\|ambient\|瞌睡\|calibration" src/` → 仅命中无关代码（`app.ts:160` 的「镜像」指 AdjustWindow 本地镜像，与情绪镜像无关）。用户裁决中当作既有机制引用的这些概念**全部是新建项** |

### 1.3 文档过期项（T0 处理）

- `STRUCTURE_MAP.md` §0：称「测试用例 **40**（core 24 + hittest 9 + coordinator 7）」→ 实测 **90**（core 37 / coordinator 16 / hittest 15 / weather-source 13 / geo 9），且测试文件是 **5 个**不是 3 个。
- `STRUCTURE_MAP.md` §0：称「TypeScript 源文件 17 / 源码总行数 4087」→ 实测 **18 个文件 / 6560 行**（`find src -name '*.ts' | wc -l` = 18，`find src -name '*.ts' -exec cat {} + | wc -l` = 6560）。
- `STRUCTURE_MAP.md` §1 目录树：**缺 `src/weather/geo.ts`**。
- `STRUCTURE_MAP.md` §3.8：`BaseTier` 接口**缺 `lum` 字段**。
- `STRUCTURE_MAP.md` §3.13/§3.16：`Coordinator` 缺 `checkReportDue()` / `confirmReport()` / `commitAdjust()` / `adjustDraft()` / `expireAdjustWindow()`；`PetRenderer` 缺 `injure()` / `pettingUntil`，多列已删的 `say()` / `drawBubble()`。
- `DESIGN.md` §3.1：配色表格数据过期（见 1.1）。
- `DESIGN.md` §5.2 用的术语是 `commitAdjust()` / `adjustDraft()`，而 §11 M0 与 STRUCTURE_MAP 用 `confirmSlide()` / `requestSlide()`——**两套命名指同一状态机**，需在 T0 统一说明，否则后续会话会找不到函数。

---

## 2. 任务总表与执行顺序

| # | 任务 | 里程碑 | 依赖 | 预估改动面 | 是否需裁决 |
|:--|:--|:--|:--|:--|:--|
| ~~T0~~ | ~~修订过期文档（🔴 DESIGN v1.2 自相矛盾 + STRUCTURE_MAP 全量未同步）~~ | 横切 | — | — | ✅ **已完成**（DESIGN **v1.4**：文档同步 + R10/R11 红线措辞经用户批准修订；STRUCTURE_MAP 已重构为 L1+L2 双层并同步） |
| ~~T1~~ | ~~尾巴通道 `drawTail()`~~ | M1 | — | — | ✅ **已完成** |
| ~~T2~~ | ~~耳朵升级为情绪通道~~ | M1 | — | — | ✅ **已完成** |
| ~~T3~~ | ~~配色回归测试守护（R7）~~ | M1 | — | — | ✅ **已完成**（`emotion-tiers.test.ts` 6 例 + 变异验证） |
| ~~**T4**~~ | ~~pulse 覆盖语义 → 偏移 + 档位调制~~ | M2 | 独立 | `pet.ts` + 快照测试 | ✅ **已裁决+已交付**（Q1：废门槛+四段查表；main `fb2f37c`） |
| ~~**T12**~~ | ~~`injure()` 除名 + `pratfall()` + base 低档「累瘫」变体~~ | M2 | 独立 | `pet.ts`（含新增 `drawWhiskers`） | ✅ **已裁决+已交付**（Q9 强意图手势 / Q10 ⚠️ 部分裁决 energy<2.5 待确认；main `1557490`/`e23845e`） |
| **T5** | 键盘感知（陪伴/巡游双姿态） | **M3**（2026-10-22 改序自 M2） | **T8（猫叼纸）+ T1 ✅** | `main/index.ts` + `coordinator.ts` + `pet.ts` + IPC | Q2 已裁决 · 🔴 **G3 权限冲突 BLOCKED**（打字节奏耦合 vs R16，见 T5 卡） |
| **T6** | 周报呈现分级 `presentation: 'note' \| 'scroll'` | M3 | 独立 | `types.ts` + `coordinator.ts` + `app.ts` | 否 |
| **T7** | 角落便签容器（非模态 + 热区处理） | M3 | T6 | `index.html` + `styles.css` + `app.ts` | **Q3** 停留时长 |
| **T8** | 猫叼纸身体语言（R20） | M3 | T7 + T1 ✅ | `pet.ts` + `app.ts` | 否 |
| **T9** | 晨间基线因果文案强化 | M3 | 独立 | `coordinator.ts` + `app.ts` | 否 |
| **T11** | 排练模式（情绪猜谜）—— **用户裁决从 M4 提前到 M1**。建议拆 **T11a**（排练引擎+答题器+校准，零依赖 ✅ 可立即开工）/ **T11b**（触发时机+跳过+ambient 提示） | **M1** | T11b 🔴 **3 项前置全不存在**：命名仪式 / 首次镜像 / ambient 通道；`emotionCalibration` 亦需新建 | 新 UI + 新存储 | **Q12** 答题带边界对齐 · **Q13** 拆分与降级 |
| **T10** | 变体池（确定性哈希渲染偏移） | M4 | T4 + T11（校准加成同管线） | `pet.ts` + 新模块 | **Q4** 分组维度 |
| **T13** | 金渐层花纹图层 + 绿眼睛色相迁移 | M4 | T10（共享参数管线）· T1/T2 ✅ | `pet.ts`（新增 `drawCoatPattern`） | ✅ **已交付**（main `14c0bc2`/`d59d47d`/`3efdb0b`；Q11 尺寸基准仍 ⏳ 待澄清） |
| **T14** | 真实感渲染升级（路线 D：三灯位光影/多层程序化毛发/噪点质感/次级运动） | M4 | T13 ✅ | `pet.ts` | ✅ **已交付**（main `ff4bb27`；虚假感三反指标：无纯黑描边/统一光源/次级延迟） |

**推荐主线（v2）**：

```
第一梯队（零依赖，可立即开工，互不冲突）
  ~~T0 文档对齐~~ ✅ · ~~T3 配色守护测试~~ ✅ · T6 周报分级 · T9 晨间基线文案
第二梯队（改 pet.ts 参数管线，必须串行以免冲突）
  ~~T4 pulse 偏移化~~ ✅ → ~~T12 pratfall + 累瘫变体~~ ✅
第三梯队（需先裁决 Q2）
  （空——T5 已改序移入第四梯队末，见下）
第四梯队（M3 便签链，需先裁决 Q3；🔴 2026-10-22 改序：T5 移到 T8 之后）
  T7 角落便签 → T8 猫叼纸动作 → **T5 键盘感知（🔴 G3 BLOCKED）**
  重排理由（裁决照录，防未来会话改回去当 bug 修）：①**首因锚定**——键盘感知的全部产品主张是「陪伴姿态」，缺尾巴先上线会把读数锚定在「猫坐那儿仅此而已」，感知通道第一次亮相必须是完全体；②**信任时刻不可贱卖**——Input Monitoring 权限弹窗是产品与用户最高成本的信任交换，不能拿半成品回报去换；③**无下游阻塞**——T5 是感知增强项，零连带成本。
  第三梯队补位说明：T4/T12 车道已解锁且零依赖，提前至第二梯队并已交付。
第五梯队（渲染管线增强，需先裁决 Q4/Q11/Q12/Q13）
  T11 排练模式 → T10 变体池 → ~~T13 花纹图层~~ ✅（已交付，Q11 仍 ⏳）→ ~~T14 真实感渲染~~ ✅
```

**为什么 T11 虽被用户提前到 M1，却仍排在第五梯队**：裁决的提前理由是「排练只需要 base 六档动画
（M0 已有），不依赖天气/pulse/AI 变体」—— 这条**对渲染依赖的判断是成立的**，但 T11 真正的阻塞不在
渲染层，而在它引用的 4 项前置（命名仪式 / 首次镜像 / ambient 通道 / `emotionCalibration`）
**一项都不存在**（见 T11 卡的前置表）。在这 4 项建成前，T11 只能降级为「首次启动即触发」，
那会失去裁决自己的 IKEA 锚点逻辑（先有依恋再有互相了解）。因此顺序上仍排后，
但**裁决登记为 M1 优先级**，前置一补齐即可插队。这是 Q13 要请用户定的。

**为什么 T10 变体池现在依赖 T11**：T11 的 `emotionCalibration` 与 T10 的变体偏移
**都是渲染参数偏移**，会进同一条合成管线。先做 T10 再做 T11，会需要在 T11 里重新调整
T10 已定的钳制边界；反过来则可一次定稿管线顺序
（`base → pulse偏移 → 变体偏移 → 校准加成 → 呼噜 → 钳制`）。

---

## 3. 逐条提示词（复制即用）

> 每条提示词都是**自包含**的：接收者无需读本次对话即可开工。所有提示词共用同一份前置约束（§3.0），复制时请**连同 §3.0 一起粘贴**。

### 3.0 共用前置约束（每条任务都要带上）

```text
项目：/Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet（Electron + TypeScript + node:sqlite 桌面精力宠物）

开工前必读（按序）：
1. energy-pet/DESIGN.md —— 设计契约 v1.1，§10 红线总表 R1–R20 是不可协商项，违反即不得合入
2. energy-pet/STRUCTURE_MAP.md —— 目录树、18 个文件的接口存根、12 条设计不变式
3. energy-pet/TASKS.md §1.1「勿重做清单」—— 有 4 项文档说要做但代码已完成，别重复实现

环境（重要，踩过的坑）：
- shell cwd 不持久，几乎每条命令都要先 cd /Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet &&
- 本机会话 shell 带 ELECTRON_RUN_AS_NODE=1，直接 npx electron . 会以纯 Node 执行而报错。
  自检模板：env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . \
            --selfcheck /tmp/x.png --no-sandbox --disable-gpu --user-data-dir=/tmp/ep-check
  （--user-data-dir 起隔离实例可绕行单实例锁，不必杀用户正在跑的实例；截图目录必须先 mkdir -p，否则只报 capture failed）
- 改完 src 必须 npm run build 再自检，否则跑的是旧 dist（会误判「改了没生效」）
- 启动前先 pgrep -x Electron 并看 crash.log 尾部；被单实例锁拒绝不是故障
- 停止：pkill -f 'energy-pet/node_modules/electron'，kill 后 sleep 3 确认再启

验证门（每条任务收尾必跑，顺序不可换）：
  npm run build && npx tsc --noEmit && npm test
当前基线 106/106 绿（core 37 / coordinator 16 / hittest 15 / weather-source 13 / pose 10 / geo 9 /
emotion-tiers 6，共 7 个测试文件）。测试数不得下降；tsconfig 开了 strict + noUnusedLocals/Parameters。
⚠️ 有并行会话在同时改这个项目，基线会上升——开工前先跑一次 npm test 取当前值作为你的下限。

测试写法陷阱：
- 冻结时钟唯一正确姿势是 new Date(Date.now())，不是裸 new Date()（裸构造不吃 mock）；
  配合 t.mock.timers.enable({ apis: ['Date'], now: T })
- queryRange(start, end) 是半开区间 [start, end)。含「此刻」事件时上界必须传 now + 1，
  否则同毫秒写入的记录被静默漏掉

设计术语对照（文档里两套命名指同一状态机，别找错函数）：
- 事件后调节窗口 = adjustDraft() / commitAdjust() / expireAdjustWindow()（DESIGN §5.2 用语）
- 滑动确认卡   = requestSlide() / confirmSlide() / cancelSlide()（STRUCTURE_MAP 用语）
- 常量：ADJUST_WINDOW_MS = 7000、ADJUST_WINDOW_HARD_MAX_MS = 60000

绝对红线（本次任务无论怎么改都不许破）：
R1 宠物本体永不出现文字（无气泡、无 say()，已删干净，不得复活）
R3 任何状态下都不隐藏 HUD 10 格
R6 渲染层禁止读 composite 查精灵（composite/headline/MODIFIER_LABEL 仅供叙事文案）
R7 低精力配色不得走向蓝紫（hue 保持暖区间，已落地，别改回去）
R10 连点只有正向反馈（呼噜），永不触发受伤；拖动永不计入连点
R16 键盘感知只用 powerMonitor.getSystemIdleTime()，禁 hook 库、禁 TCC 权限、禁记录按键
R17 精力跨天连续，禁止午夜归零
R18 完全离线，禁止引入任何需要网络的推理/渲染依赖

收尾要求：
- 若本次改动使 DESIGN.md 或 STRUCTURE_MAP.md 的任一条款过期，同轮修订文档（契约要求：不留悬空条款）
- 在回复里列出：改了哪些文件、新增/修改了哪些测试、验证门实际输出、还有哪些未决问题
```

---

### T0 · 修订过期文档 — ✅ 已完成（2026-10-22 11:3x 文档同步 + 11:49 红线修订）

> ✅ **执行结果**：条目 **A–P 全部完成**（速查表见下）。DESIGN.md 升 **v1.3**、
> STRUCTURE_MAP.md **全量同步**（含新增 §3.11b `geo.ts` 存根、§5.4 孤立死代码清单）。
> **src 一行未改**（严格符合「仅 .md」约束），11:3x 复测行数/锚点/测试数与文档记录完全一致。
>
> ✅ **原「唯一遗留」已解除（11:49）**：R10/R11 红线措辞冲突经**用户批准**修订，DESIGN.md 升 **v1.4**。
> R11 的「`injure()` 仅可由领域事件触发」这句**悬空许可已从契约中消除**（它邀请实现者去做已被 T12 裁决
> 原则性否决的事）。⚠️ 但 **src 仍未动**：`injure()`（`pet.ts:262`）与其 `:238` 旧注释待 **T12** 实现时
> 随改名一并清除。详见 DESIGN.md §5.4 末、§12 变更日志 v1.4 行，与本文件 §6 变更日志 v5 条。
>
> 下方原始提示词与 v3 重算说明**保留作存档**，不要再执行。

<details>
<summary>原始提示词（存档，勿执行）</summary>

> **⚠️ v3 重算**：并行会话已把 DESIGN.md 升到 **v1.2**，条目 **L / M 已完成**（§3 附件通道表的
> 耳朵行与尾巴行已改为 ✅ M1、§11 M1 标题已标 ✅ 已完成），**A 只做了一半**。
> **STRUCTURE_MAP.md 完全没动**（仍是 11:46 的 v1.0 版本：17 文件 / 4087 行 / 40 测试 / 仍有 `say(text` /
> `grep -c "resolveTailPose|resolveEarPose|drawTail"` = **0**）⇒ **C–K、O、P 全部待做**。
> 🔴 **A 的半成品状态造成了 DESIGN.md v1.2 内部自相矛盾**，这是本任务最高优先级：
> §3.1 的裁决段已写「M1 落地：`BASE_TIERS` 增 `lum` 列…」，但**同一节上方第 101–102 行的旧数据块仍写着**
> 「精力 5.5→4.5: hue 168→190（青绿，偏离）」「3.5→0: hue 210→288（蓝→紫，严重偏离）」；
> 且 §3 五通道表第 80 行通道 5「色」仍标 **⚠️ 偏离设定**。
> 一份文档同时声称「已落地暖区间」和「严重偏离蓝紫」，违反契约自己的「不允许留悬空条款」。

```text
任务：修订 energy-pet 的两份权威文档，消除已确认的过期条款。只改 .md，不改任何 src 代码。
（条目 A–P 共 16 项。L / M 已由并行会话完成，A 只做了一半，其余待做 —— 开工前请逐条重新核实，
不要盲信本清单，因为并行会话可能又推进了。）

背景：本项目约定「代码与文档不一致时以代码为准并立即修订文档，不允许留悬空条款」（DESIGN.md 开头）。
上一轮实现跑在了文档前面，现累积了下列过期项，需要一次性对齐。请先自己 grep/read 核实每一项
（不要盲信下面的结论），确认后再改文档。

🔴 最高优先级：A 与 B —— DESIGN.md v1.2 当前**内部自相矛盾**（§3.1 裁决段说已落地暖区间，
同节上方数据块说严重偏离蓝紫；§3 通道 5 仍标 ⚠️ 偏离设定）。

需修订的条目：

A. DESIGN.md §3.1「配色偏离 🔴→M1」—— **裁决段已更新（v1.2），但旧数据块残留，必须清除**。
   实测 src/emotion/engine.ts 的 BASE_TIERS：hue = 46/44/42/40/38/37/36/35/34/33（全程暖区间，
   符合金渐层设定），lum 列 = 80/78/76/74/72/70/67/63/58/52，
   且 WARM_HUE_MIN=30 / WARM_HUE_MAX=46 已导出为常量（engine.ts:40-41）。
   ⚠️ 残留位置：DESIGN.md 第 100–102 行的代码块仍写着
   「精力 5.5 → 4.5: hue 168 → 190 sat 62 → 52（青绿，偏离）」
   「精力 3.5 → 0 : hue 210 → 288 sat 44 → 24（蓝 → 紫，严重偏离）」
   ⇒ 必须替换为实测值，并把「偏离/严重偏离」的措辞改为「✅ 已纠偏」。
   同时该节标题「配色偏离 🔴→M1」应改为「配色纠偏 🔴（M1 已完成）」之类不留悬空的表述；
   节首「当前 BASE_TIERS 的实际走向：」这句引导语也要改（它引出的是旧数据）。
   保留：偏离的**历史叙述**与心理学论证（蓝紫=病态语义 / RSD 人群）有长期价值，
   建议改写为「v1.1 前曾偏离为 …，M1 已纠偏为 …」的过去式，而不是直接删除。
   R7 红线本身保留不动（它现在是防倒退的守护条款）。

B. DESIGN.md §3 五通道对照表 —— 通道 5「色」的现状列**仍是**「⚠️ **偏离设定**」、缺口列「见 3.1」
   （实测在 DESIGN.md 第 80 行）⇒ 改为 ✅、缺口列改「无」。
   ⚠️ 这是 v1.2 遗漏项：同文档的附件通道表（耳朵/尾巴行）已改 ✅，五通道表却漏改，
   两表状态不一致。

C. STRUCTURE_MAP.md §0 覆盖范围表格（🔴 整份文件未同步，下列数值已实测，可直接采用，
   但仍请自行复核一遍，因为并行会话可能又加了文件）：
   - TypeScript 源文件 17 → 18（漏了 src/weather/geo.ts）
   - 测试文件 3 → **7**（tests/ 下实为 core / coordinator / hittest / weather-source / geo /
     **pose** / **emotion-tiers**）
   - 测试用例 40 → **106**（core 37 / coordinator 16 / hittest 15 / weather-source 13 /
     pose 10 / geo 9 / emotion-tiers 6）
   - 源码总行数 4087 → 用 `find src -name '*.ts' -exec cat {} + | wc -l` 重新统计
     （09:07 实测 6560，但 pet.ts 09:35 又改过，须重测）
   - §0 末尾那条「⚠️ 与 overview.md 的差异：该文档称 30/30，实测 40」需重写为当前事实
   - pet.ts / app.ts 的行数（§0 称 704 / 681）也已过期，请用 wc -l 重新统计

D. STRUCTURE_MAP.md §1 目录树：补 src/weather/geo.ts 条目（IP 定位 + 7 天缓存 + 降级链）。

E. STRUCTURE_MAP.md §3.8 BaseTier 接口：补 lum: number 字段及注释（明度基线，R7 用）。

F. STRUCTURE_MAP.md §3.16 PetRenderer 存根：
   - 删除 say(text, ms?) / drawBubble() / bubbleText / bubbleUntil / wrapText()（源码已无，R1 已落地）
   - 补 injure()（显式受伤 API，当前无调用方）、poke() 的连点→呼噜语义、
     PETTING_WINDOW_MS(2500) / PETTING_CLICKS(3) / PETTING_BOOST_MS(2000) 三个常量、pettingUntil 私有字段
   - RenderParams 补 lum 字段
   - PULSE_PARAMS 存根旁标注：当前仍是覆盖语义（??），M2/T4 将改为 PULSE_OFFSETS 加权叠加

G. STRUCTURE_MAP.md §3.13 Coordinator 存根：补 checkReportDue() / confirmReport() / weeklyReport()、
   调节窗口相关方法（adjustDraft / commitAdjust / expireAdjustWindow，按源码实际名称写）、
   REPORT_CHECK_MS(60s) / REPORT_TRIGGER_HOUR(17) / REPORT_TRIGGER_MINUTE(30) /
   REPORT_LAST_DATE_META('last_report_date') 常量、reportModal 私有字段。

H. STRUCTURE_MAP.md §3.1 types.ts 存根：补 WeeklyReportPayload（含 report / aiSuggestions /
   decisions / requireAck / dateStr）与 RecommendationEvidence。

I. DESIGN.md §5.2 与 STRUCTURE_MAP 的术语分裂：在 DESIGN.md §5.2 加一句注明
   「本文档用 adjustDraft/commitAdjust 指代事件后调节窗口；STRUCTURE_MAP 用 requestSlide/confirmSlide
   指代滑动确认卡，两者是同一状态机的不同视角」，避免后续会话按错名字找不到函数。
   （先读源码确认这两组函数是否都存在、各自职责，再据实写，不要照抄我这句话。）

J. DESIGN.md §11 M0 清单：补记「天气 IP 定位（weather/geo.ts）」「周报 17:30 弹窗（checkReportDue）」
   已完成——这两项当前只在 M0 里含糊提到天气，未反映 reportModal 链路。

K. DESIGN.md §12 变更日志：追加一行 v1.2（日期用今天），说明本轮为文档对齐、无代码行为变更。

L. 🆕 DESIGN.md §3「附件通道」表的**耳朵行与尾巴行**（T1/T2 已完成，文档仍写着缺口）：
   - 耳朵行现写「`drawEar()` 存在，但只是"小触角"，摆动仅由 `breathPhase` 驱动 → 🔴 未编码情绪」
     ⇒ 改为已实现，并记录实际方案：`resolveEarPose(p)` 返回 `pose ∈ [-1,1]`，
     三态 = 前倾(pose>0) / 自然外张(0) / 飞机耳(pose<0：外张+下压+缩短+耳廓内暖色收淡)，
     呼吸摆动降为 0.03 rad「活着」的底噪；缺口列改「无」
   - 尾巴行现写「**完全不存在**（pet.ts 全文无 tail 绘制代码）→ 🔴 金渐层选型的最大缺口。M1」
     ⇒ 改为已实现，记录 `TailPose` 接口 / `resolveTailPose(p)` / `drawTail()`（身体后图层）/
     `tailTip` 已接入 petBounds 命中区扩展；缺口列改「无」
   - 五通道对照表的通道 5「色」现状列从「⚠️ 偏离设定」改为 ✅，缺口列改「无」（与 A/B 项一致）

M. 🆕 DESIGN.md §11 M1 里程碑表：尾巴行 / 耳朵行 / 配色行**三行全部标记完成**
   （M1 只剩「团子形态：保持现状不做品种化」这一条本来就是「不做」的约定）。
   若 M1 四项均已闭环，请在 M1 标题后标注 ✅ 并说明剩余项转入 T3（配色回归测试）。

N. 🆕 DESIGN.md §5.4「⚠️ 未决债务」段：该段描述 X 眼「被打晕」语义擦 R11 边、
   「在 `injure()` 无调用方的现状下此债务不产生用户可见影响，故本轮不改造」。
   用户已于 2026-10-22 裁决（见 TASKS.md T12 卡）：不接线 + `injure()` 除名改名 `pratfall()` +
   X 眼重做为「呆滞放空 + 折弯胡须」+「累瘫」并入 base 低档。
   ⇒ 请把该段从「暂不修复，仅登记」改写为「已裁决，见 TASKS.md T12」，
   并把三条否决理由（语义重复 / 时长与语义错配含影子计数器论证 / RSD 流失引信）
   固化进 DESIGN.md —— 这是原则性裁决，只留在 TASKS.md 会在未来丢失。
   🔴 同时需要修订 R10 与 R11 的措辞：R11 现写「`injure()` 仅可由领域事件触发，不可由手势触发」，
   而裁决是「领域层除名、永不接线」⇒ 该条款的「仅可由领域事件触发」已成为悬空许可
   （它暗示领域事件触发是合法路径，而裁决恰恰否决了这条路径）。
   建议改为：「跌倒态（`pratfall()`）是纯喜剧彩蛋，**永不**由任何用户行为序列触发；
   "累瘫"的正当表达载体是 base 低精力档，不是惩罚态」。
   ⚠️ 修订红线需用户确认（🔴 红线变更门槛最高），**T0 执行时先只登记该冲突，不要自行改 R10/R11 原文**。

O. 🆕 STRUCTURE_MAP.md §3.16 PetRenderer 存根：补 `resolveEarPose()` / `resolveTailPose()` 两个
   **导出纯函数**（注意它们是 `pet.ts` 里少数导出的纯函数，与 `TailPose` 接口一起构成可测边界）、
   `drawTail()` / 新版 `drawEar(ctx,x,y,side,pose,breathPhase,p,bodyR)` 签名、`tailTip` 私有字段、
   以及 `petBounds()` 已纳入尾巴边界的说明（这是命中区正确性的关键，§3.4 hittest 章节也应交叉引用）。

P. 🆕 STRUCTURE_MAP.md §0 测试统计：测试文件 3 → **7**（新增 `tests/pose.test.ts` +
   `tests/emotion-tiers.test.ts`），用例 40 → **106**。
   ⚠️ 与 C 项重叠 —— C 是整表重算，P 只强调测试两行；执行时合并处理即可，勿改两遍。

约束：
- 不许为了让文档好看而删掉仍然有效的红线条款（R1–R20 全部保留）
- 不许在文档里写「计划做」的事为「已完成」；已完成的必须有 grep 证据
- 所有数字（行数、用例数、hue 值、常量值）必须实测后填写，不得沿用旧值或估算

收尾：给出 diff 摘要（每份文档改了哪几节），并列出你在核实过程中发现的、上面没提到的其他不一致项。
```

</details>

---

#### T0 执行结果（2026-10-22 11:3x）

**条目状态速查（A–P 全部完成）**

| 条目 | 内容 | 状态 |
|:--|:--|:--|
| A | DESIGN §3.1 配色节 | ✅ 旧数据块（原第 100–102 行）整节重写为实测 10 档表（hue 46→33 / sat 96→24 / lum 80→52），措辞改过去式「v1.1 前曾偏离…M1 已纠偏」，节标题「配色偏离 🔴→M1」→「配色纠偏 🔴（M1 已完成 ✅）」。色彩心理学论证保留为历史叙述 |
| B | DESIGN §3 五通道表通道 5「色」 | ✅ 「⚠️ 偏离设定」→ ✅，参数列补 `lum`，与附件通道表一致 |
| C | STRUCTURE_MAP §0 | ✅ 18 文件 / 6572 行 / 7 测试文件 / 106 用例 + 基线演进 40→89→90→100→106 |
| D | STRUCTURE_MAP §1 目录树 | ✅ 全部行数实测刷新 + 补 `geo.ts` |
| E | STRUCTURE_MAP §3.8 | ✅ `BaseTier` 补 `lum` + `WARM_HUE_MIN/MAX` + R7 守护测试说明 |
| F/O | STRUCTURE_MAP §3.16 PetRenderer | ✅ 删 `say()/drawBubble()/bubbleText/wrapText()`（grep 0 命中），补 `TailPose`/`resolveTailPose`/`resolveEarPose`/PETTING 三常量/`injure()` 除名裁决注/`poke()` 呼噜/`drag*`/`petBounds()` 纳入尾梢与耳尖(-1.8R)/`RenderParams.lum`/PULSE_PARAMS 覆盖语义警示/新版 `drawEar`·`drawTail` 签名/绘制顺序/已踩坑记录 |
| G | STRUCTURE_MAP §3.13 Coordinator | ✅ 两套状态机分节、REPORT_* 常量、`checkReportDue()/confirmReport()/reportModal`、`geoEnabled` 三条件、start/stop 定时器不变式 |
| H | STRUCTURE_MAP §3.1 | ✅ 补 `RecommendationEvidence`/`WeeklyReportPayload`（含 `presentation` 缺口注）、`InsightRecommendation` 补 `evidence`、`AppState` 补 `adjustWindow`/`reportModal` |
| I | DESIGN §5.2 术语 | ✅ 补两套独立状态机澄清表 —— ⚠️ **据实纠正了本清单条目 I 的错误说法**（详见下「新发现」①） |
| J | DESIGN §11 M0 | ✅ 补 17:30 定时触发链路（`checkReportDue`/`REPORT_*`）；修正 geo/sensor 数据源为实测 |
| K | DESIGN 文件头 + §12 | ✅ 升 v1.3（含实测数）+ 变更日志追加 v1.3 行 |
| L | DESIGN §3 附件通道表 | ✅（v1.2 已完成，本轮复核一致） |
| M | DESIGN §11 M1 里程碑表 | ✅（v1.2 已完成）+ v1.3 追加 T11 阻塞状态与 M4 两行更新 |
| N | DESIGN §5.4 未决债务 + R10/R11 | ✅ 债务改写为「已裁决除名」+ 固化三条否决理由；同步 §5.3 第 4 条 / §3 绷带行 / §11 M2。🔴 **R10/R11 措辞冲突按约束只登记，未改 §10 原文** |
| P | STRUCTURE_MAP §0 测试统计 | ✅ 与 C 合并处理，未重复改动 |
| 🆕 | STRUCTURE_MAP §3.11 / §3.11b / §5 / §6 | ✅ §3.11 `sensor.ts` 重写；**新增 §3.11b `geo.ts` 存根**（首版完全漏计）；§5 逐条重测（更正 3 处过期结论）；**新增 §5.4 孤立死代码/已废弃通道**；§6 补 R7 与 pulse 警示 + 验证命令 40→106 |

**diff 摘要**

- **DESIGN.md → v1.3**（9 节）：文件头 · §3 五通道表 · §3.1 配色节 · **§3.3 花纹图层不变式（新增）** · §5.2 术语澄清 · §5.3 第 4 条 · §5.4 未决债务 · §11 M0/M1/M2/M4 · §12 变更日志
- **STRUCTURE_MAP.md**（12 节）：§0 · §1 · §2（2.1/2.2/2.3）· §3.1 · §3.8 · §3.11 · **§3.11b（新增）** · §3.13 · §3.16 · §3.17 · §4（不变式 12→17）· §5（含**新增 §5.4**）· §6
  > 🔴 **重要：本轮完成后，并行会话把 STRUCTURE_MAP.md 重构为「渐进式披露」双层结构**（2100+ 行 → **278 行 L1 入口** + `docs/structure/*.md` 20 份 L2 存根）。
  > **T0 的全部成果已完整迁移并核实存活**（逐项 grep 验证）：
  > - 上面提到的 §3.x 各模块存根 → `docs/structure/<模块>.md`（1:1 映射，如 §3.16 → `renderer-pet.md`）；L1 §3 索引表保留「原§」列做编号映射
  > - **§3.11b `geo.ts` 存根**（本轮新增）→ `docs/structure/weather-geo.md`，且已进入 L1 §3 索引表
  > - **§5.1–5.4 问题清单**（含本轮新增的 §5.4 全部 16 项发现）→ `docs/structure/known-issues.md`，**编号原样保留**
  > - §2.3 四条主链路（含 geoTimer 1500ms 细节）→ `docs/structure/data-flows.md`
  > - §4 的 17 条不变式、§0 统计、§6 修改指引 → 留在 L1 本体
  > ⚠️ 因此**后续会话查存根要去 `docs/structure/`，不要再在 STRUCTURE_MAP.md 里找 §3.x 全文**。
  > 唯一被重构回退的点已修复：§6「加 pulse 反应」行的锚点从 `DESIGN §矛盾C`（不可达）改回 `DESIGN.md §4.3（矛盾 C 裁决）`。
  > L1 §3 索引表的 18 个模块行数快照已逐个与实测比对，**100% 一致**（src 6572 行 / 18 文件）。
- **src 一行未改**（严格符合「仅 .md」约束）。11:3x 复测：pet.ts 1081 / app.ts 1265 / coordinator 653 / main 693 / src 6572 / **106 pass**，与写入文档的数字完全一致

**🔴 新发现的不一致项**（清单未提到，已全部写入 STRUCTURE_MAP §5.4）

1. **本清单条目 I 的说法是错的**：它称 `commitAdjust` 与 `confirmSlide` 是「两套命名指同一状态机」。实测是**两套独立状态机、职责互斥** —— ①事件后调节窗口（`openAdjustWindow/adjustDraft/commitAdjust/cancelAdjust/expireAdjustWindow`，负责 task-complete/recovery，7s 静置 + 60s 硬上限）②滑动卡（`requestSlide/previewSlide/confirmSlide/cancelSlide`，负责 morning-baseline/manual-adjust）。`requestSlide()` 对 task-complete/recovery **直接返回 null**，正是「写入点唯一」的保障。已据实写入而非照抄清单
2. **`EventBus.once()` 根本不存在**：旧清单把它列为死代码，实为把 `main/index.ts` 的 3 处 Electron `win`/`webContents.once()` 误归给 EventBus（bus.ts 只有 `constructor`/`clear`/`listenerCount`）
3. **`clampRange` 只剩一份**：旧清单称 task/recovery 各一份，实测 `task/center.ts` 已无此函数 ⇒ 不再是重复定义
4. **`applyOverlay()` 已有调用方**（`app.ts:1175`），不再是死代码
5. **面板 tab 系统已整体拆除但 CSS 残留**：`.panel-tabs`（`styles.css:242/247/259/263`）容器在 index.html **0 命中**；`.tab-page` 只剩 `index.html:116` 一个孤立 div（无兄弟页无切换逻辑 ⇒ `active` 恒真，规则等价于无条件 `display:block`）；app.ts 无任何 `data-tab`/`data-page` 处理
6. **7 组孤立 CSS 规则**：`.rec-grid`(283) / `.rec-card` 系列(288–307) / `.rec-card .hist`(307) / `.report-nums`(403–425) / `.spark`(426–446)。恢复项已改径向 `.rp-chip`、周报已改 `rm-*`。⚠️ 删 `.rec-card` 时注意 `.ico`/`.nm`/`.dt` 类名被 `.rp-chip` **复用**（`styles.css:896/898/906`），只能删带 `.rec-card` 前缀的规则
7. **`preload.recoveryTake` 已 `@deprecated` 且主进程恒返回 null**（`preload/index.ts:83-85`）—— 🔴 最危险的一类死代码：**调得到但静默无操作**，返回的 null 还会被上层误读为「已有调节进行中」并 toast 错误提示。旧存根的 `renderRecoveries` 描述正是照它写的（已更正为 `recoveryStartAdjust`）
8. **`renderRecoveries()` 旧存根全错**：渲染目标是径向菜单 `rpRing`(#rp-ring) 里的 `.rp-chip`，**不是** `rec-grid`（该 id 不存在）。已按实测重写，补录**内容签名守卫**（`lastRecoverySig`）这条不变式 —— 缺它则每次 applyState 都重放弹出动画，表现为「菜单一直闪」
9. **`dock-weather` 实测为纯静默刷新**：只调 `weatherRefresh()` 更新 HUD 图标，**不弹 toast 也不弹气泡**（需求 4）。旧存根写「刷新 + toast 来源」已过期
10. **`setupPanel()` 的 open/close 命中区时序**：open 走 `scheduleHotReport()` + `setTimeout(reportHotRects, 320)`（等 .28s 过渡），close **必须同步立即** `reportHotRects()`（不走 200ms 节流），否则光标停在旧面板区时表现为「面板关了那块还挡鼠标」
11. **`drawPulseAura` 配色表逃逸类型检查**：`pet.ts:874` 声明为 `Record<string, string>` 而非 `Record<PulseReaction, string>`，新增 pulse 漏配色会静默落到默认灰紫 `rgba(160,160,200,0.4)`，TS 不报错、106 个测试也不覆盖 ⇒ 建议并入 T4
12. **`loadReport()/renderReport()/reportCache` 三件套全部不存在**（grep 0 命中）：周报是**推模型**（主进程 `checkReportDue` → `state.reportModal` → `applyReportModal()`，`app.ts:983`），旧存根按拉模型写的
13. **DOM id 数从 45 → 72**：旧存根漏计 27 个，且列了 8 个不存在的 id（`hud-bar` 已改名 `hud-bar-track`、`dock-adjust`、`dock-say`、`report-nums`/`report-spark`/`report-narrative`/`report-refresh`、`rec-grid`）。🔴 已做**机械化交叉验证**：HTML 72 个 ↔ app.ts `$()` 强引用 69 个，**0 缺失**（无启动即抛 `missing #id` 风险）；差集 3 个中 `dock`(CSS 6 处)/`stage`(CSS 2 处) 为活，仅 `panel-title` 是 CSS/JS 双零命中的未样式化 id
14. **`boot()` 的 setup 函数名旧存根写错**：实测为 `setupHitTest/setupDrag/setupSlide/setupHudSlider/setupAdjustCard/setupDurationCard/setupPanel/setupReportModal`（不存在 `setupRecoveryPop`）；`initHudCells()` 不在 `boot()` 内（模块顶层 `:85` 执行）
15. **`hud-num.textContent` 是 6 处不是 4 处**（578/611/639/686/1179/1212）—— 影响 T11 的改动面评估
16. **交叉引用有 5 处悬空**：`§3.2.2`/`§3.2.3` 实为 DESIGN §3.2 的**编号列表第 2/3 条**（该节无三级子节），已改为可达形式；两份文档 §x.y 引用现已机械化校验 **0 悬空**

**遗留（需用户裁决，T0 未自行处理）**

- ✅ **R10/R11 措辞冲突 —— 已于 2026-10-22 11:49 经用户批准修订（DESIGN.md v1.4）**：R11 原文「`injure()` 仅可由领域事件触发」的**悬空许可已消除**，改为「跌倒态是纯喜剧彩蛋，**永不**由任何用户行为序列触发（手势、连点、拖动、拒绝计数均不可）；"累瘫"的正当表达载体是 base 低精力档，不是惩罚态。喜剧叙事属性保留：无血、无泪、无控诉文案，8s 自愈，不落库、不改精力」。R10 术语「受伤」→「跌倒态」。**仅改 .md，src 零改动**（`injure()` 与 `pet.ts:238` 旧注释待 T12 实现时随改名一并清除）。⚠️ 核实修正：落点列**未**写 `pratfall()`（该符号在 src 尚不存在，`grep -rn pratfall src/` = 0），改为「现 `injure()`(`pet.ts:262`)，T12 改名 `pratfall()`」，避免制造新的悬空引用
- 🟡 §5.4 的死 CSS / deprecated IPC 清理：本轮**只登记不删**（T0 不改 src）。②两条是有意保留的兼容层，删除需评估外部调用方；①③④ 属低风险清理，建议并入 T4（`drawPulseAura` 类型收紧）/ T13（tab 与 rec-* 系列 CSS）

---

### T1 · 尾巴通道 `drawTail()` — ✅ 已完成（2026-10-22 核对确认）

> **实测已落地**：`pet.ts:80 TailPose` 接口 · `:101 resolveTailPose()` 导出纯函数 ·
> `:681 drawTail()`（身体后图层）· `:184 tailTip` 私有字段 · `:344-351` 尾巴已接入命中区
> （用 `tailTip` 扩展 petBounds 的左右下边界）。
> **测试**：`tests/pose.test.ts` 5 例 —— lift 单调性 / burnt 拖地 vs blissful 竖起 /
> 愉悦叠加抬升与摆幅 / 恐惧=高频小摆「抖」与开心的「摇」区分 / 输出硬边界防 NaN。
> 下面的原始提示词**保留作设计依据存档**（尾巴的三受驱量与层级约定仍是后续改动的参考），
> **不要再执行**。
> ✅ **文档已同步**：DESIGN.md **v1.2** 已把 §3 附件通道表的尾巴行改为「✅ M1 已新增」、
> §11 M1 标题标「✅ 已完成（v1.2）」、§12 变更日志补 v1.2 行 ⇒ T0 的 **L/M 条目已完成**。
> ⏳ 仍需补的是 **STRUCTURE_MAP.md**（完全未同步，`grep -c "resolveTailPose\|drawTail"` = 0）⇒ T0 条目 O。

<details>
<summary>原始提示词（存档，勿执行）</summary>

```text
任务：为 energy-pet 的宠物渲染器新增尾巴，作为独立情绪通道。这是 M1 的最大缺口——
金渐层选型下尾巴完全不存在（grep 'tail' src/renderer/pet.ts 返回 0 结果）。

设计依据：DESIGN.md §3「附件通道」表明确记载「尾巴：完全不存在（pet.ts 全文无 tail 绘制代码）→
🔴 金渐层选型的最大缺口。M1」；§11 M1 里程碑表要求：「新增 drawTail()，作为独立情绪通道：
摆动频率/幅度/垂落角度由 energy + mouthCurve 驱动」。

已定路线（用户裁决，不得偏离）：程序化 Canvas，不引入任何素材/图片管线；保持现有团子形态，
不做完整品种化骨骼重构。尾巴必须是 Canvas 路径绘制，与身体同一套 hsl 配色（p.hue / p.sat / p.lum）。

实现要求：
1. 新增 private drawTail(ctx, x, y, bodyR, p: RenderParams, t: number): void，
   签名风格与既有 drawEar/drawEyes/drawMouth 保持一致。
2. 三个受情绪驱动的量（这是「独立情绪通道」的实质，不能只做装饰性摆动）：
   - 摆动频率：高精力快而轻快，低精力慢而无力。建议由 p.breath 或 energy 派生，
     与既有节律通道（breath 1.6s→6.5s）协调，不要引入新的独立时钟。
   - 摆动幅度：高精力大幅（愉悦摇尾），低精力接近静止。可参考 bounce 的档位跨度（7px→0.5px）。
   - 垂落角度：低精力时尾巴下垂（无力），高精力时上翘。这是最能读出状态的一维，优先做好。
   - 额外：mouthCurve 为正（愉悦）时尾尖可轻微上卷；tremble 高时叠加细微抖动（焦虑）。
3. 绘制层级：必须在身体之前绘制（尾巴在身后），即在 render() 里 body 渐变填充之前调用。
   先读 pet.ts:449 render() 的绘制顺序注释（影子 → pulse 光环 → 身体 → 脸 → 天气 overlay → 粒子），
   把尾巴插在「影子之后、身体之前」，并更新该注释。
4. 锚点：身体是底部平的团子形（render() 里 moveTo(-bodyR, 0) 起手），尾巴应从身体右下或左下
   侧后方伸出，不要穿模到身体正面。请实际跑 selfcheck 截图确认视觉位置。
5. 动画连续性：所有参数变化必须经既有的 lerp 平滑（loop() 里 k = 1 - exp(-dt*6)），
   尾巴用的驱动量若来自 current（插值后）而非 target，表情切换才不会生硬。
6. 🔴 不许破 R6：尾巴不得读 composite / headline / MODIFIER_LABEL 决定形态。
   只能读 RenderParams 的连续量。
7. 🔴 不许破 R1：尾巴不得携带任何文字。
8. 与既有状态的交互需明确处理：
   - 甩墙受伤态（injure() 的三段动画，pet.ts:137 附近）期间尾巴形态 —— 建议随身体一起旋转、
     受伤期间停止摆动（垂死状），但不要新增受伤专属视觉元素（R11 绷带语义当前是未决债务，别扩大）
   - 抚摸呼噜态（pettingUntil）期间 —— 建议尾尖轻快摆动增强愉悦感，这是正向反馈的一部分
   - setPreview(energy) 拖动预览时尾巴必须实时跟随（它读 current 参数即可自动满足）

验证：
1. npm run build && npx tsc --noEmit && npm test（当前基线不得下降；开工前先跑一次取当前值，并行会话会推进它）
2. 新增单测：由于 pet.ts 在渲染进程、依赖 Canvas，纯函数部分才可测。请把「尾巴参数计算」
   抽成一个可导出的纯函数（例：tailParams(p: {energy, mouthCurve, tremble, breath}) →
   {swingFreq, swingAmp, droopAngle}），放在 pet.ts 或 emotion/engine.ts，并对它写单测：
   断言 energy=10 与 energy=0 时 droopAngle 符号相反、swingAmp 单调递减、
   tremble 高时抖动分量增大。这是本任务的测试交付物。
3. selfcheck 截图至少 3 张：energy≈10 / energy≈5 / energy≈0（可用 --user-data-dir 隔离实例 +
   注入不同精力值，或直接改 INITIAL_ENERGY 临时验证后改回），目视确认尾巴位置不穿模、垂落方向正确。
4. 手动：拖动 HUD 滑块从 0 到 10，确认尾巴连续变化无跳变。

收尾：修订 DESIGN.md §3 附件通道表（尾巴行从「完全不存在」改为已实现 + 参数说明）、
§11 M1 里程碑表（尾巴行标记完成）、STRUCTURE_MAP.md §3.16（补 drawTail / tailParams 存根）。
```

</details>

---

### T2 · 耳朵升级为情绪通道 — ✅ 已完成（2026-10-22 核对确认）

> **实测已落地**：`pet.ts:124 resolveEarPose(p)` 导出纯函数（返回 `pose ∈ [-1,1]`，
> 输入 `{mouthCurve, tremble, eyeOpen}`）· `drawEar()` 签名已改为
> `(ctx, x, y, side, pose, breathPhase, p, bodyR)`，实现圆角三角猫耳 + 耳内暖粉。
> **三态齐全**：`pose > 0` 收拢前倾（开心/警觉/被抚摸）· `pose = 0` 自然外张 ·
> `pose < 0` **飞机耳**（外张 + 下压 + 缩短 `lenScale = 1 - splay*0.28` + 耳廓内暖色收淡，
> 即「血色褪去」的疲惫隐喻）。呼吸摆动已降到 `0.03 rad`，注释明确其为「活着」的底噪而非信息。
> **测试**：`tests/pose.test.ts` 5 例 —— 开心前倾/不悦后压/中性≈自然位 · 恐惧强力后压成飞机耳 ·
> 眼皮耷拉→耳朵同向耷拉（读取一致性）· 输出恒在 [-1,1] · ear+tail 抚摸呼噜同时驱动
> 耳朵前倾与尾巴摇（正向反馈一致）。
> 下面的原始提示词**保留作设计依据存档**，**不要再执行**。
> ✅ **文档已同步**：DESIGN.md v1.2 已把 §3 附件通道表的耳朵行改为「✅ M1 已升级」
> （含 `resolveEarPose()`、pose∈[-1,1] 三态、呼吸降为 0.03rad 底噪），并新增 **§3.2 姿态解算不变式**
> （5 条：纯函数 / 无语义冲突 / 摆不抵消抬升 / 几何入命中区）⇒ T0 的 **L/M 条目已完成**。
> ⏳ 仍需补的是 **STRUCTURE_MAP.md**（完全未同步，`grep -c "resolveEarPose"` = 0）⇒ T0 条目 O。
> ⚠️ **实现与原提示词的一处偏差（属改良，记录备查）**：原提示词建议抽 `earParams(p) →
> {tilt, splay, innerScale}`；实际实现是 `resolveEarPose()` 返回**单个** `pose` 标量，
> 由 `drawEar()` 内部派生 `splay`/`angle`/`lenScale`。更简洁，且与 `resolveTailPose()`
> 返回结构化 `TailPose` 形成对照 —— 后续改动请沿用各自现状，不要统一成一种风格而制造 churn。
> 📌 **v1.2 记录的两条实战教训值得后续任务复用**（出自并行会话的迭代）：
> ① 抚摸呼噜压低 `eyeOpen`（眯眼享受）会被耳朵的 droop 项**误读为疲惫** ⇒ droop 按
> `(1 - max(0, joy))` 门控。**多通道读同一输入时方向必须一致**（DESIGN §3.2.2）。
> T4（pulse 偏移化）、T11（校准加成）、T13（花纹）都会遇到同类问题。
> ② **截图是最好的测试**：尾巴首版 swing 随脊柱放大抵消根部仰角，测试全绿但截图里塌成水平鱼鳍；
> 耳朵首版天线剪影读不出飞机耳差异；耳内色 `hue+24` 在暖金下是黄绿「新芽」（改 `hue+330` 成暖粉）。
> **纯函数单测只能守语义边界，视觉形态必须 selfcheck 截图 + 裁剪放大肉眼验收。**

<details>
<summary>原始提示词（存档，勿执行）</summary>

```text
任务：把 energy-pet 宠物的耳朵从「随呼吸摆的小触角」升级为独立情绪编码通道。

设计依据：DESIGN.md §3 附件通道表 —— 「耳朵：drawEar() 存在，但只是"小触角"，摆动仅由
breathPhase 驱动 → 🔴 未编码情绪。设计稿要求耳朵是独立情绪通道（飞机耳/后压/前倾）。M1」；
§11 M1 表 —— 「drawEar() 从"随呼吸摆的触角"升级为情绪编码通道（飞机耳/后压/前倾），
输入 = mouthCurve + tremble」。

现状（实测）：pet.ts:593 private drawEar(ctx, x, y, angle, p)，两处调用在 render() 内：
  this.drawEar(ctx, -bodyR * 0.42, -bodyR * 1.34, -0.35 + breathPhase * 0.08, p);
  this.drawEar(ctx,  bodyR * 0.42, -bodyR * 1.34,  0.35 - breathPhase * 0.08, p);
angle 只含固定基线 ±0.35 + 呼吸微摆 ±0.08，与情绪无关。drawEar 内部用
ctx.strokeStyle = hsl(p.hue p.sat% 42%) + lineWidth 4 画两条线（所以看起来是"触角"）。

实现要求：
1. 形态升级：从两条描边线改为有面积的猫耳三角（两条贝塞尔边 + 闭合填充），
   配色沿用身体渐变体系（外层 hsl(p.hue p.sat% ...)，内耳可用更低明度或更粉暖的固定色）。
   保持团子比例，耳朵不要做得比头大——已定路线是「保持团子形态，不做品种化骨骼重构」。
2. 三态情绪编码（核心交付）：
   - 前倾（警觉/愉悦）：mouthCurve 明显为正 或 energy 高 → 耳朵朝前上方立起
   - 后压（不安/低落）：mouthCurve 明显为负 或 energy 低 → 耳朵向后贴（这是猫的经典安抚信号）
   - 飞机耳（焦虑）：tremble 高（对应 drained/exhausted/burnt 的 0.15/0.35/0.6）或
     pulse = anxious/restless 时 → 两耳向两侧平展压低
   请抽一个可导出纯函数 earParams(p) → {tilt, splay, innerScale}（与 T1 的 tailParams 同风格），
   由它集中表达上述映射，drawEar 只负责绘制。
3. 左右耳必须有镜像对称但方向相反的角度（现状已如此：-0.35 / +0.35），
   情绪驱动量叠加到该基线之上，不要破坏对称性。
4. 呼吸微摆保留（它是活着的证据），但幅度要让位于情绪角度：情绪项为主，breathPhase 项为辅。
5. 与抚摸呼噜态（pettingUntil）交互：呼噜时耳朵应放松后压+微眯（猫被摸舒服时的耳朵），
   这是正向反馈的一部分，优先级高于 energy 派生的角度。
6. 🔴 不许破 R6：只读 RenderParams 连续量，禁止读 composite 查精灵。
   注意 pulse 信息目前不在 RenderParams 里（只有插值后的 mouthCurve/tremble），
   若确需 pulse 反应标识，走 RenderParams 新增字段的路径，不要引入 composite。
7. 甩墙受伤态（injure()）期间：耳朵随身体旋转即可，不新增专属形态。

验证：
1. npm run build && npx tsc --noEmit && npm test（当前基线不得下降；开工前先跑一次取当前值，并行会话会推进它）
2. 新增单测覆盖 earParams()：断言 mouthCurve = +1 / 0 / -1 三档 tilt 单调递减；
   tremble = 0.6 时 splay 显著大于 tremble = 0；能量高低对 tilt 的影响方向与 mouthCurve 一致。
3. selfcheck 截图 3 张（高/中/低精力），目视确认耳朵角度差异肉眼可辨（若看不出差别，
   说明情绪项幅度太小，需调参——「读得出大概状态」是情绪通道的设计目标）。
4. 手动：点击宠物触发抚摸呼噜，确认耳朵有放松反应。

收尾：修订 DESIGN.md §3 附件通道表（耳朵行）、§11 M1 表（耳朵行标记完成）、
STRUCTURE_MAP.md §3.16（drawEar 签名变更 + earParams 存根）。

注意：T1（尾巴）与本任务可并行，但两者都会改 render() 与新增纯函数，若并行请约定
「T1 只动身体之前的绘制层，T2 只动耳朵绘制层」以减少冲突；串行则先 T1 后 T2。
（⚠️ 此条已作废：T1/T2 均已完成。）
```

</details>

---

### T3 · 配色回归测试守护（R7 防倒退）— ✅ 已完成（并行会话，2026-10-22 09:42）

> **实测已落地**：`tests/emotion-tiers.test.ts`（6 例，09:42 写入）——
> hue 全程暖区间 / 无任一档落入冷病态区间 [180,320] / sat 单调不增 / lum 单调不增 /
> blissful-burnt 可辨差值（sat≥40、lum≥20）/ hue 跨度 ≤20。
> **变异验证已做**（记忆记录）：临时 hue 46→250 精确触发 3 条失败，恢复后全绿 ——
> 这正是原提示词要求的「未验证过的守护测试等于没有测试」。
> `WARM_HUE_MIN=30`/`WARM_HUE_MAX=46` 已导出为 `emotion/engine.ts:40-41` 常量。
> DESIGN.md v1.2 §3.1 已补守护句。**下面的原始提示词折叠存档，不要再执行。**

<details>
<summary>原始提示词（存档，勿执行）</summary>

```text
任务：为已落地的配色纠偏补回归测试，防止 R7 在未来改动中被无声破坏。只加测试，不改 src。

背景：DESIGN.md §3.1 曾要求把低精力档 hue 从蓝紫（210→288）收回暖区间（30–46），靠 sat + lum
表达疲惫。该项**已实现**（BASE_TIERS 实测 hue = 46/44/42/40/38/37/36/35/34/33，
sat = 96/94/92/88/78/66/54/42/32/24，lum = 80/78/76/74/72/70/67/63/58/52）。
但 tests/ 下 grep 'hue|sat' 返回 0 结果——**没有任何测试守护这组值**。
R7 是红线（「低精力配色不得走向蓝紫」），无测试守护的红线等于没有防线。

设计依据：R7 的心理学理由见 DESIGN.md §3.1 —— 蓝紫色自带「抑郁/病态」语义，而目标用户画像是
ADHD/INFP + RSD 敏感人群，低精力时把宠物染成蓝紫等于用非语言信号说「你病了」。

实现要求（在 tests/core.test.ts 新增，或另建 tests/emotion-tiers.test.ts）：
1. 遍历 BASE_TIERS 全部 10 档，断言 hue 落在暖区间 [30, 50]（给出明确上下界并在注释里写明
   依据：金渐层的金色色相范围）。任何一档越界即失败，错误信息要指出是哪一档、实际值多少。
2. 断言 sat 随档位从高精力到低精力**单调不增**（允许相等，不允许回升）——「去饱和表达疲惫」。
3. 断言 lum 同样单调不增——「轻微降明度」。
4. 断言最疲惫档（burnt）与最高档（blissful）的 sat 差值 >= 40、lum 差值 >= 20，
   即「疲惫必须在视觉上可辨」，防止把纠偏做成「全档一个色」。
5. 断言 hue 的总跨度 <= 20（46→33 实测跨度 13），守护「色相保持暖区间」而非「色相大幅变化」——
   疲惫的表达职责在通道 1/2/4（瘫软、眼皮下垂、呼吸变慢、颤抖），不在色相。
6. 额外守护：断言没有任何一档的 hue 落在 [180, 320]（青→蓝→紫→品红的冷/病态区间）。
   这条是最直接的 R7 断言，写成独立 test 便于失败时一眼看懂。

注意：
- 请先读 src/emotion/engine.ts 确认 BASE_TIERS 的实际导出名与字段，不要照抄我给的数值
  （数值可能在你开工前已被别的任务微调）。测试要断言的是**性质**（单调性、区间、跨度），
  不是硬编码具体数字——这样后续调色不会造成测试脆断，但走向蓝紫会立刻被抓到。
- 测试用例名用中文，与既有风格一致（例：'BASE_TIERS: hue 全程暖区间，低精力不走向蓝紫（R7）'）。

验证：npm test 应从 90 增至 90 + 新增用例数，全绿。
临时把某一档 hue 改成 250 验证测试确实会失败（然后改回）——
「未验证过的守护测试等于没有测试」。

收尾：修订 DESIGN.md §3.1，在该节末尾加一句「回归测试：<用例名> 守护此条」，
与 §4.4 里 charged 守护测试的写法保持一致格式。
```

</details>

---

### T4 · pulse 覆盖语义 → 偏移 + 档位调制

```text
任务：把 energy-pet 的 pulse 情绪层从「覆盖 base」改为「base 的偏移量，且偏移幅度受精力档位调制」。
这是 DESIGN.md 已裁决但尚未实现的 M2 改造项（矛盾 C）。

设计依据（DESIGN.md §4.3 原文，务必先完整读一遍）：
矛盾：设计稿把 pulse 描述为「独立的情绪层」，但 PULSE_PARAMS 在代码里是覆盖语义
（pp.mouthCurve ?? ep.mouthCurve）—— grateful pulse 会让 exhausted（mouthCurve -0.6）
直接跳到 +0.5，表情断层，且「精疲力竭却因为一次恢复就大笑」不真实。

裁决：pulse 是 base 的偏移量，且偏移幅度受档位调制。
  final = base + pulse_offset × modulation(tier)
- modulation 随精力档位递减：高精力时 pulse 表达充分（状态好，情绪反应外放），
  低精力时 pulse 被压制（累到没力气大喜大悲）。
- 效果：exhausted + grateful 不再是「大笑」，而是「苦中作乐」——嘴角从 -0.6 抬到 -0.2 左右。
  这比覆盖语义诚实得多，也更符合目标用户的真实体验（他们不会因为休息了 15 分钟就从崩溃切换到狂喜）。
- ~~PULSE_THRESHOLD = 3 保持不变（pulse 只在低精力区激活，与 energyBand 的 low 档对齐）。~~
  **已于 2026-10-22 Q1 裁决废除：门槛火化、全档激活。**

> 🔴 **原设计张力段已于 2026-10-22 Q1 裁决关闭，勿重开。** 旧文曾留开放问题（「请你自己判断并给出方案……若你认为需要调整 PULSE_THRESHOLD……」）；裁决结论：废除门槛 + 四段查表（>=8→0.25 / >=6→0.5 / >=4→0.75 / else→1.0）+ 0-3 区间内部不再细分 + empathy 恒 1.0。实现已交付（main `fb2f37c`），本卡其余文字仅作历史记录。

现状（实测）：
- src/renderer/pet.ts:51 const PULSE_PARAMS: Record<PulseReaction, Partial<{mouthCurve, tremble, eyeOpen}>>
  值：none{} / anxious{tremble:0.3, mouthCurve:-0.25} / guilty{mouthCurve:-0.4, eyeOpen:0.7} /
      numb{eyeOpen:0.1, mouthCurve:-0.15} / restless{tremble:0.45} /
      grateful{mouthCurve:0.5} / determined{mouthCurve:0.3, eyeOpen:1.0}
- src/renderer/pet.ts:355 buildParams() 内三处 ?? 覆盖：
    eyeOpen: pp.eyeOpen ?? ep.eyeOpen,
    mouthCurve: pp.mouthCurve ?? ep.mouthCurve,
    tremble: pp.tremble ?? ep.tremble,
  （注意：现有 PULSE_PARAMS 的数值是按「绝对目标值」设计的，例如 guilty 的 eyeOpen:0.7、
   determined 的 eyeOpen:1.0，直接当偏移量用会爆表。改语义时**必须重新设计这组数值为偏移量**，
   不能只改运算符。）

实现要求：
1. PULSE_PARAMS 改名为 PULSE_OFFSETS（DESIGN.md 明确要求的命名）。
2. ~~新增可导出纯函数 pulseModulation(tier 或 energy) → number（0..1），集中表达调制曲线。~~
   **G10 签名统一（2026-10-22）**：契约层真名为 `intensity(energy: number): number`（四段查表）
   + `pulseIntensity(reaction, energy): number`（含 empathy 豁免），位于 `src/emotion/pulse-contract.ts`。
   🔴 参数定死 `energy`（旧文「tier 或 energy」是参数未定的模糊表述；按离散 tier 无法表达 empathy 豁免）。
3. buildParams() 改为加权叠加，并对结果做合理钳制：
   mouthCurve ∈ [-1, 1]、eyeOpen ∈ [0, 1]、tremble >= 0（上限参考 burnt 档的 0.6，
   可适度超出但不要出现视觉抽搐）。钳制是必要的——偏移叠加后越界会让脸画崩。
4. 特别处理 anxious/restless 的 tremble：这两个是「增加颤抖」，与 grateful/determined 的
   「改善嘴型」方向不同。tremble 用叠加合理；eyeOpen 的偏移要注意 numb（原值 0.1 是绝对值，
   语义是「眼睛几乎闭上」）——作为偏移量应改成负值（例如 -0.2），否则语义反转。
   请逐个 reaction 重新推导偏移值，并在注释里写明每个数值的意图。
5. 抚摸呼噜（pettingUntil）与 pulse 的叠加顺序：现有 loop() 里呼噜加成是独立的衰减因子。
   请确认三者（base + pulse偏移 + 呼噜加成）叠加后仍在钳制范围内，且呼噜不会把 pulse 的
   负面表达完全抹掉（呼噜是 +0.6 嘴型，numb/anxious 时叠加后不应变成大笑）。
   注意呼噜的 tremble 是「与焦虑的高幅 tremble 取 max 而非覆盖」（DESIGN.md §5.3），保持这个规则。

验证：
1. npm run build && npx tsc --noEmit && npm test
2. 更新受影响的既有测试：grep tests/ 找 pulse 相关断言（tests/core.test.ts 有 resolve/tierFor/
   extractPulseSignals/resolvePulse/PULSE_RULES 的用例）。注意 emotion/engine.ts 的 resolve()
   **不改语义**（它只产出 EmotionState，覆盖/偏移是渲染层的事），所以 engine 侧测试大概率不用动；
   真正要新增测试的是 pet.ts 侧的纯函数。
3. 新增单测覆盖 buildParams 的可测部分（若 buildParams 是私有方法，请把参数合成逻辑抽成
   可导出纯函数 composeParams(energy, base, pulse, pulseActive)，与 T1/T2 的 tailParams/earParams
   同风格）：
   - 核心断言（DESIGN.md 点名的效果）：exhausted + grateful 的 mouthCurve 应约等于 -0.2
     （从 -0.6 抬起，但**不得为正**）。这是「苦中作乐而非大笑」的可执行判据，必须写成独立用例。
   - 断言同一 pulse 在 energy=2.5 与 energy=0.2 时的表达强度不同（modulation 生效）
   - 断言所有组合下 mouthCurve ∈ [-1,1]、eyeOpen ∈ [0,1]（穷举 10 档 × 7 reaction）
   - 断言 pulseActive = false 时结果等于纯 base（无偏移）
4. selfcheck 截图：低精力 + grateful 状态，目视确认是「嘴角微抬但仍疲惫」而非大笑。

收尾：~~修订 DESIGN.md §4.3……STRUCTURE_MAP.md §3.16（PULSE_PARAMS → PULSE_OFFSETS，补 pulseModulation / composeParams）。~~
**已交付**：DESIGN.md v1.5 §4.3 已同步；🔴 原引用的 `STRUCTURE_MAP.md §3.16` 已失效（渐进式披露重构后接口存根全部迁出）→ 对应存根新家为 `docs/structure/renderer-pet.md`。
```

---

### T5 · 键盘感知（陪伴/巡游双姿态）

> 🔴 **2026-10-22 改序裁决**：T5 从 M2 移到 **M3 的 T8 之后**（依赖链 T6→T7→T8→T5），不接受降级实施。
> 理由三条照录：①首因锚定（感知通道第一次亮相必须完全体）；②信任时刻不可贱卖（Input Monitoring
> 权限弹窗是最高成本信任交换）；③无下游阻塞（T5 零连带成本）。后果如实写明：T5 从「第二梯队可立即
> 开工」大幅推后到 M3 末尾。
> 🔴 **G3 冲突登记 ⇒ T5 实现 BLOCKED**：裁决配套要求「尾摆节奏含打字节奏耦合」，与 R16 直接冲突——
> R16 禁止 TCC 输入监控权限、禁止一切键盘 hook 库，唯一允许 `powerMonitor.getSystemIdleTime()`
> 且它只返回一个整数 ⇒ **架构上得不到打字速度**。待用户裁决：(a) idle 秒数分档降级驱动尾摆节奏
> （合规但非真实打字速度）；(b) 显式批准修订 R16（红线变更，门槛最高）。
> **验收前提（裁决配套）**：陪伴姿态以五通道齐全为前提——耳角 + 尾摆（含打字节奏耦合）+ 瞳孔细缝 +
> 呼吸起伏，四者缺一不验收。降级方案（仅耳角+瞳孔+呼吸、tail rhythm 参数位预留 hook）走**例外审批**，
> 不是默认路径。

```text
任务：实现 energy-pet 的键盘感知 —— 心流状态外显化。这是 DESIGN.md §8 的 M2 交付项，
当前完全未实现（grep -rn 'powerMonitor|getSystemIdleTime' src/ 返回 0 结果）。

设计意图（DESIGN.md §8 原文）：敲键盘时宠物进入陪伴姿态（趴伏、靠近、尾巴慢摆），
停敲后宠物起身巡游。让用户「看见」自己正在专注，而不是靠意志力感觉。

🔴 R16 权限红线（§8.2 全文，违反即产品失效，无例外）：
- 唯一允许的实现：import { powerMonitor } from 'electron';
  const idleSeconds = powerMonitor.getSystemIdleTime();  // 系统级空闲秒数
- 轮询间隔 >= 5s（这是姿态切换，不是实时反馈，高频只增加功耗）
- 禁止使用 globalShortcut、uiohook-napi、node-global-key-listener、CGEventTap、任何键盘 hook 库
- 禁止申请 macOS 辅助功能（Accessibility）或输入监控（Input Monitoring）权限（TCC）。
  一旦申请，用户会在系统设置里看到「energy-pet 想要监控你的键盘输入」——对一个精力管理工具，
  这个弹窗足以摧毁全部信任，无论实际是否记录
- 禁止记录、缓存、传输任何按键内容或按键序列。getSystemIdleTime() 只返回一个整数，
  这个性质必须保持
- 禁止用 powerMonitor 的其他能力做超出「活跃/离开」二分的推断
  （例：用 on('lock-screen') 推断作息并写入周报）
理由：getSystemIdleTime() 的信息量恰好够用，且在架构上不可能泄露按键内容。
选择它不是因为方便，而是因为它是唯一能满足需求又不引入隐私债务的 API。

⚠️ 依赖说明：本任务建议在 T1（尾巴）之后做。「尾巴慢摆」是陪伴姿态的组成部分，
尾巴不存在时陪伴姿态少一半表达。若 T1 未完成，请先做 T1。

待用户裁决（Q2）——开工前先问，不要自己定：
- 活跃阈值（idleSeconds < X 判为「敲键盘中」）与离键阈值（idleSeconds > Y 判为「离开」）的具体秒数。
  建议默认：活跃 < 30s，离开 > 180s，中间为不确定区（保持上一姿态，避免边界抖动）。
  请把这个建议报给用户确认。
- 姿态切换是否需要迟滞（hysteresis）防止在阈值附近反复横跳 —— 强烈建议要，
  否则用户会看到宠物不停地起立趴下，很烦。

实现要求：
1. 主进程侧（src/main/index.ts 或新模块）：setInterval >= 5000ms 读 getSystemIdleTime()，
   映射为 posture: 'accompany' | 'roam'（或你认为更合适的命名），仅在**状态实际变化时**
   通过既有 state:update 推送链路通知渲染层（不要每 5s 无脑推送 —— pushState 有 JSON 去重，
   但姿态字段应纳入 AppState 才能享受去重）。
2. AppState 类型（src/core/types.ts）新增 posture 字段。注意 pushState() 的去重是
   JSON 比对（lastUpdated 归零后比），新字段会自动参与，无需改去重逻辑。
3. 定时器必须纳入 coordinator 的生命周期管理：start() 里创建，stop() 里清理。
   🔴 踩过的坑：coordinator.start() 里所有 setTimeout/setInterval 必须在 stop() 单独清理，
   否则 db 关闭后触发查询会报 "database is not open"。现有代码里 timers 数组管 setInterval，
   adjustTimer/insightStartupTimer/geoTimer 是单独字段——请按同样的模式加，别漏。
4. 渲染侧（src/renderer/pet.ts）：两个姿态的视觉差异
   - 陪伴姿态（accompany）：趴伏（身体 squish 增加、重心下移、bodyR 略扁）、
     尾巴慢摆（若 T1 已完成）、眼睛半阖但清醒（不是睡眠）、呼吸放缓
   - 巡游姿态（roam）：起身（恢复挺拔）、可在窗口内小范围缓慢水平移动
     （🔴 移动必须限制在窗口内，且不得改变 petBounds() 上报的命中区正确性 ——
     命中区上报链路是 click-through 的核心，宠物移动后 petBounds 必须跟着变，
     否则会出现「点得到看不见的猫」或「看得见的猫点不到」。参考 PLAN-5issues.md §0 记录的
     热区死锁事故：dock 与宠物热区之间出现穿透死区导致按钮永远点不到）
   - 姿态切换必须经 lerp 平滑，不许瞬移（除非是巡游的位移本身）
5. 🔴 姿态不得影响精力值、不得写入事件流、不得出现在周报里。
   它是纯渲染层状态，与 R16「禁止用 powerMonitor 做超二分推断」一致。
   若你认为「专注时长」值得记录，**先停下来问用户**——那会引入新的隐私语义。
6. 🔴 不许破 R3：任何姿态下 HUD 10 格必须完整显示。
7. 巡游若涉及窗口内移动，注意 render() 的 px/py 计算与 petBounds() 的一致性，
   以及甩墙受伤态（injure()）期间应暂停巡游（受伤时不该乱跑）。

验证：
1. npm run build && npx tsc --noEmit && npm test（当前基线不得下降；开工前先跑一次取当前值，并行会话会推进它）
2. 新增单测：把「idleSeconds → posture」的映射（含迟滞逻辑）抽成可导出纯函数
   resolvePosture(idleSeconds, prevPosture) → posture，对它写单测：
   断言迟滞生效（在两个阈值之间时保持 prevPosture）、边界值行为、
   以及**同一 idleSeconds 连续调用结果稳定**（不抖动）。
3. selfcheck 无法直接模拟系统空闲时间（getSystemIdleTime 读真实系统状态）。
   请在 selfcheck 模式下允许注入假 posture（例：--selfcheck-posture=accompany），
   分别截图两个姿态目视确认。注入代码必须只在 selfcheck 分支生效，不得影响生产路径。
4. 真实验证：启动应用，连续敲键盘 30s 观察是否进入陪伴姿态；离开键盘 3 分钟观察是否切换巡游。
   同时用 pgrep / 系统设置确认**没有弹出任何 TCC 权限请求**（这是 R16 的硬验收项）。
5. 功耗检查：确认轮询间隔 >= 5s（grep 常量定义），且未变化时不推送。

收尾：修订 DESIGN.md §8.2 末尾的「⚪ 现状：powerMonitor 未被使用，键盘感知尚未实现。M2 交付项」
改为已落地 + 实际阈值取值 + 迟滞设计说明；§11 M2 表标记完成；
STRUCTURE_MAP.md §3.1（AppState 补 posture）、§3.14（补轮询定时器）、§3.16（补姿态渲染）。
```

---

### T6 · 周报呈现分级 `presentation: 'note' | 'scroll'`

```text
任务：把 energy-pet 的每日报告从「每天都是模态卷轴」改为「按星期分级呈现」。
这是 DESIGN.md §6.2 的 M3 改造项（矛盾 D，v1.1 已定稿），当前未实现。

设计依据（DESIGN.md §6.2 原文，务必完整读）：
矛盾：设计稿同时要求「零打断」和「每日清单 + 周报卷轴」。当前实现是每天 17:30 弹一次模态周报
（checkReportDue()，60s 轮询 + 启动补弹 + meta.last_report_date 防重复），仅周五 requireAck。
周一至周四虽然可随手关闭，但仍是抢焦点的模态弹窗——与「零打断」直接冲突。

裁决：数据源统一，呈现形态按星期分级。
| 触点 | 形态 | 数据源 | 模态性 | 生命周期 |
| 日清单（周一~周四 17:30） | 猫叼来清单放在屏幕角落（sticky note） | weeklyReport() 滚动 7 天 |
  非模态、可忽略：不抢焦点、不阻塞点击、不占据宠物区域 | 淡入 → 停留 → 自动淡出；用户可无视 |
| 周报卷轴（周五 17:30） | 羊皮纸卷轴（现有 #report-modal） | weeklyReport() 滚动 7 天 |
  模态 + requireAck 不可关闭 | 常驻至点「已确认」|

三条必须一起理解的要点：
1. 每天都调 weeklyReport()（滚动 7 天），不只是周五。日清单与周报共用同一份滚动窗口数据，
   差别只在呈现强度。理由：ADHD 用户的回顾不能等「攒够一周」——每天的角落便签是低成本的
   持续可见性，让「这周的走势」始终在视野边缘，而不是周五突然面对一堆陌生数字。
2. 「猫叼来清单」不是文案装饰，是叙事框架。清单的出现必须读作猫的动作（它把纸叼过来放在角落），
   而不是系统通知。这条与 §1 命题一致：信息由宠物带来，宠物不汇报数据——纸是它叼来的东西，
   不是它说的话。实现上意味着便签出现时应有对应的身体语言（叼/放的动作或朝向），
   而非凭空浮现一个 UI 面板。M3 落地时不得省略这一半。→ 这一半是 T8，本任务只做数据与分级。
3. 周五的 requireAck 保留，不可关闭。理由（用户原话）：一周工作日结束了，看一下一周的情况，
   不然会忘记。这是全产品唯一一处刻意的强制停顿，它存在的意义正是对抗「会忘记」。
   它承载预测-校准回路（§7）的证据展示与默认值决策，需要用户真正读完。一周一次的价格可接受。

🔴 R12：禁止给日清单便签加 requireAck。便签一旦被强制确认，就变成了每天一次的模态弹窗，
「零打断」命题作废。

现状（实测）：
- src/core/types.ts:200-216 WeeklyReportPayload = { report, aiSuggestions, decisions, requireAck, dateStr }
  —— 无 presentation 字段
- src/main/coordinator.ts:588 checkReportDue()：
    if (this.reportModal) return;
    const now = new Date(Date.now());   // 注意这个写法是为了测试可冻结时钟，不要改成裸 new Date()
    const hhmm = now.getHours() * 60 + now.getMinutes();
    if (hhmm < REPORT_TRIGGER_HOUR * 60 + REPORT_TRIGGER_MINUTE) return;
    const dateStr = localDateStr(now);
    if (this.log.getMeta(REPORT_LAST_DATE_META) === dateStr) return;
    ... 组装 report / aiSuggestions / decisions ...
    this.reportModal = { report, aiSuggestions, decisions, requireAck: now.getDay() === 5, dateStr };
    this.log.setMeta(REPORT_LAST_DATE_META, dateStr);
    this.bus.emit('state:dirty');
- 常量：REPORT_CHECK_MS = 60_000、REPORT_TRIGGER_HOUR = 17、REPORT_TRIGGER_MINUTE = 30、
  REPORT_LAST_DATE_META = 'last_report_date'
- src/renderer/app.ts:983 applyReportModal(p)，:1048 $('rm-close').style.display = p.requireAck ? 'none' : ''，
  :1050 reportModal.classList.add('show')，:1104-1105 rm-ack / rm-close 绑定 closeIt

本任务范围（只做分级，不做便签 UI —— 那是 T7）：
1. WeeklyReportPayload 新增 presentation: 'note' | 'scroll'，由 now.getDay() === 5 决定
   （周五 = 'scroll'，周一~周四 = 'note'）。
2. 🔴 requireAck 必须与 presentation === 'scroll' **绑定**，不再是独立的 getDay() === 5 判断。
   写成 requireAck: presentation === 'scroll'，让「只有卷轴可强制确认」在类型和代码上同时成立
   （R12 的技术保障）。
3. 数据源保持不变：两种 presentation 都用同一个 weeklyReport(now)（滚动 7 天）。
   aiSuggestions / decisions 也照旧组装 —— 便签同样需要这些数据（§6.2 要点 1）。
4. 启动补弹逻辑保留，且**补弹形态跟随当天星期**（DESIGN.md §6.2 明确要求）。
   即：周五 18:00 开机 → 补弹卷轴；周三 18:00 开机 → 补弹便签。
   现有 checkReportDue() 在 start() 同步调用一次已实现补弹，确认新字段在补弹路径上同样正确。
5. meta last_report_date 防重复逻辑保持不变（一天只弹一次，不区分形态）。
6. confirmReport() 保持不变（两种形态都通过它清空 reportModal）。
   但便签是「自动淡出」，需要在渲染层淡出后调用 confirmReport() 通知主进程清空 —— 
   本任务先在 app.ts 里保持现有 closeIt 路径可用，T7 再加自动淡出。
7. app.ts 的 applyReportModal() 本任务只需**兼容新字段**（读 p.presentation 但不改渲染分支，
   仍走卷轴），保证 T6 单独合入时行为不变、测试全绿。真正的便签渲染在 T7。
   —— 若你更倾向一次做完 T6+T7，请先征得用户同意（T7 涉及新 DOM + CSS + 热区，改动面大得多）。

验证：
1. npm run build && npx tsc --noEmit && npm test
2. 更新/新增 tests/coordinator.test.ts 用例（该文件现有 16 个用例，含周报相关）：
   - 周三 17:30 → presentation === 'note' 且 requireAck === false
   - 周五 17:30 → presentation === 'scroll' 且 requireAck === true
   - 🔴 穷举周一~周日，断言 presentation === 'note' 时 requireAck 恒为 false（R12 守护）
   - 未到 17:30 → 不弹（reportModal 为 null）
   - 同日重复调用 → 只弹一次（meta 防重复）
   - 补弹：17:30 之后启动 → 当日仍弹，且形态跟随当天星期
   🔴 冻结时钟必须用 new Date(Date.now()) + t.mock.timers.enable({ apis: ['Date'], now: T })。
   裸 new Date() 不吃 mock，会导致测试依赖真实系统时间而偶发失败。
   构造不同星期请选具体日期。**已用 date 命令核实的可用锚点**：
   2026-10-21 = Wednesday（周三 → 期望 note）、2026-10-23 = Friday（周五 → 期望 scroll）。
   注意 coordinator 的星期判定用 now.getDay()（0=周日…5=周五），写断言时按此对齐。
3. 本任务不改渲染行为，selfcheck 截图应与改动前一致（可作为无回归的证据）。

收尾：修订 DESIGN.md §6.2 的「⚪ 现状」段（当前写的是「周一至周四仍走模态卷轴…M3 改造项」，
其中前两条 bullet 已落地，后两条 —— 便签容器与叼纸身体语言 —— 仍未做，请据实分条标注）、
§11 M3 表（周报仅周五模态行标记完成）、STRUCTURE_MAP.md §3.1（WeeklyReportPayload 补 presentation）。
```

---

### T7 · 角落便签容器（非模态）

```text
任务：为 energy-pet 实现「日清单便签」的非模态角落容器。这是 DESIGN.md §6.2 的 M3 改造项，
承接 T6（presentation 字段已就位）。

前置：T6 必须已完成（WeeklyReportPayload.presentation: 'note' | 'scroll' 已存在，
coordinator 已能按星期产出正确形态）。开工前先 grep 确认 presentation 字段存在。

设计依据（DESIGN.md §6.2 表格，日清单行）：
形态 = 猫叼来清单放在屏幕角落（sticky note）
模态性 = 非模态、可忽略：不抢焦点、不阻塞点击、不占据宠物区域
生命周期 = 淡入 → 停留 → 自动淡出；用户可无视
🔴 R12：禁止给日清单便签加 requireAck。便签一旦被强制确认，就变成每天一次的模态弹窗，
「零打断」命题作废。

DESIGN.md §6.2「⚪ 现状」段落已列明本任务的三个技术要点（原文）：
- 新增角落便签容器与 CSS。非模态 ⇒ 不参与 hotRects 上报（或仅在悬停时上报），
  否则会在屏幕角落制造一块吃鼠标的透明区。
- 启动补弹逻辑保留，补弹形态跟随当天星期。（T6 已做）
- 补猫叼纸的身体语言（pet.ts 侧的一次性动作）。（这是 T8，本任务不做）

待用户裁决（Q3）——开工前先问：
- 便签停留时长（建议 20–30s 后自动淡出）
- 淡出后是否可从某处重新唤出（建议：不可。便签的定位是「视野边缘的低成本可见性」，
  可重新唤出就需要一个常驻入口，反而增加界面负担；周五卷轴才是完整回顾的入口）
- 便签在窗口内的具体位置（窗口 400×620，宠物在底部中央 y≈488–602，
  建议便签放左上或右上，避开宠物区与 dock）

实现要求：
1. src/renderer/index.html 新增便签容器（例 #daily-note），id 命名与既有风格一致
   （既有 45 个 id：stage/pet-wrap/pet-canvas/energy-hud/.../report-modal/rm-*/dock/dock-*）。
   注意 app.ts 的 $() 帮助函数找不到元素会直接 throw Error(`missing #${id}`)，
   所以新增 id 必须同时在 html 与 app.ts 的 DOM 引用区登记。
2. src/renderer/styles.css：
   - 便签视觉：sticky note 风格（微黄纸底、轻微旋转、柔和阴影、手写感字体）。
     项目 CSP 禁外链字体，请用 macOS 内置字体（既有周报已用 Kaiti SC / STKaiti，可复用同一路子）
   - 🔴 非模态的三个 CSS 硬要求：不得有遮罩层（no backdrop/overlay）、
     不得抢焦点（容器不设 tabindex，不自动 focus 任何子元素）、
     pointer-events 默认 none（这样它不阻塞点击）
   - 淡入淡出走 CSS transition/animation，与既有 .show / .leaving 类的模式保持一致
     （既有代码用 explicitHidden() 判定「含 .leaving 视为隐藏」来立刻回收命中区，请复用该约定）
3. 🔴 命中区处理（本任务最容易出事故的地方）：
   便签 pointer-events: none ⇒ 不应进 collectHotRects()。请确认 app.ts:collectHotRects() 的
   收集列表里没有它，且 hittable() 的 pointer-events 检查会正确过滤它。
   背景事故（PLAN-5issues.md §0 有完整记录）：曾因 dock 热区与 CSS 显隐互相打架，
   在 dock 与宠物之间形成 y448–488 的穿透死区，导致光标物理上到不了按钮、点击全无响应。
   本任务若错误上报一块 300×200 的便签热区，会在屏幕角落制造一块吃鼠标的透明区，
   用户点桌面会点到看不见的便签上——同类事故，务必避免。
   若最终决定「悬停时可交互」（例如便签上有「知道了」按钮），则必须只在悬停态上报，
   且要保证从宠物移动到便签的路径上热区连续（不留穿透死区）。
   建议：本任务先做纯展示 + 自动淡出，不加任何按钮，彻底回避该风险。
4. src/renderer/app.ts：
   - applyReportModal(p)（现 :983）按 p.presentation 分派：'note' → 走便签路径，
     'scroll' → 走现有 #report-modal 卷轴路径（不动）
   - 便签路径：淡入 → setTimeout(停留时长) → 淡出 → 淡出完成后调 window.pet 的
     confirmReport 等价 IPC 通知主进程清空 reportModal（🔴 必须清空，否则 coordinator 的
     if (this.reportModal) return 会让当天不再弹，且 AppState 里残留过期 payload）。
     请先 grep preload/index.ts 确认该 IPC 的实际方法名。
   - 定时器必须可清理：若在淡出前收到新的 state 推送或应用退出，不要留下悬空 setTimeout。
     项目有踩坑记录（db 关闭后定时器触发查询报 "database is not open"），
     渲染层虽不碰 db，但同类「组件已销毁而定时器仍触发」的 bug 要防。
5. 内容渲染：便签空间有限，不要照搬卷轴的全部内容。建议只放
   「今日/近 7 天走势的一句话 + 迷你柱状图（既有 report-spark 可复用样式）+ 最多 1–2 条 AI 建议标题」。
   完整内容（证据计数、叙事段落、历史决策）留给周五卷轴。
   🔴 R13：AI 推荐文案只陈述用户动作，绝不评价（"你调低了" ✅ / "你总是低估" ❌）。
   便签若显示建议，直接复用后端给的 message 字段，不要自己改写文案。
6. 🔴 R3：便签不得遮挡或替代 HUD 10 格。若位置有重叠，调整便签位置而不是隐藏 HUD。

验证：
1. npm run build && npx tsc --noEmit && npm test（当前基线不得下降；开工前先跑一次取当前值，并行会话会推进它）
2. 新增/更新测试：coordinator 侧的 presentation 用例 T6 已覆盖；
   渲染层若无可测纯函数，至少把「停留时长 / 淡出时长」定义为导出常量以便断言。
3. selfcheck 截图 2 张：presentation='note'（便签形态）与 presentation='scroll'（卷轴形态）。
   可用 --user-data-dir 隔离实例 + 注入假 reportModal payload 触发（selfcheck 分支注入，
   不影响生产路径）。
4. 🔴 命中区实证（本任务的核心验收项，沿用 PLAN-5issues.md §0 的探针方法论）：
   在 selfcheck 模式回读 window.__hotRects（app.ts 已提供该调试钩子），断言：
   - 便签显示期间，hotRects 中**不含**便签矩形（或仅含悬停态的）
   - 宠物本体热区仍然存在且坐标正确
   - dock 热区仍然存在（不被便签挤掉）
   - 便签显示时，合成 click 派发到便签区域外的桌面位置仍能穿透
5. 手动：临时把 REPORT_TRIGGER_HOUR/MINUTE 调到近 1 分钟后（或改系统时间），
   周三形态触发 → 确认便签淡入、不抢焦点（可以同时点击宠物和 dock）、到时自动淡出、
   淡出后当天不再重复弹。测完把常量改回 17:30。

收尾：修订 DESIGN.md §6.2「⚪ 现状」段（便签容器一项标记完成，注明实际停留时长与热区处理方式）、
§11 M3 表（日清单便签行标记完成）、STRUCTURE_MAP.md §3.17（补 DOM id 清单 + 便签渲染函数）。
```

---

### T8 · 猫叼纸身体语言（R20）

```text
任务：让 energy-pet 的日清单便签「读作猫叼来的纸」，而不是凭空浮现的系统通知。
这是 DESIGN.md 的 🔴 R20 与 §6.2 要点 2，M3 交付项。

前置：T1（尾巴）+ T7（便签容器）必须已完成。便签容器不存在时无从配合。
⚠️ T5 现依赖本任务（2026-10-22 裁决重排），本任务延期会连带延期 T5。

设计依据（DESIGN.md §6.2 要点 2 原文）：
「猫叼来清单」不是文案装饰，是叙事框架。清单的出现必须读作**猫的动作**
（它把纸叼过来放在角落），而不是系统通知。这条与 §1 命题一致：信息由宠物带来，
宠物不汇报数据——纸是它叼来的东西，不是它说的话。实现上意味着便签出现时应有对应的
身体语言（叼/放的动作或朝向），而非凭空浮现一个 UI 面板。M3 落地时不得省略这一半。

🔴 R20（红线总表原文）：日清单必须读作「猫叼来的纸」，不是系统通知——
便签出现须伴随宠物身体语言。落点：§6.2 / M3。

🔴 R1 同时约束：宠物本体永不出现文字。所以「叼来的纸」上的字属于**便签这个 UI 元素**，
不属于宠物身体。宠物不得因此长出气泡或任何文字。这条边界要守住 —— 
纸是它叼来的物件（DOM 元素），不是它说的话（Canvas 文字）。

已定路线：程序化 Canvas，不引入素材管线。叼纸动作必须用 Canvas 路径绘制，
不得引入图片/GIF/精灵表。

实现要求：
1. 在 src/renderer/pet.ts 新增一次性动作 API（例：carryNote(targetX, targetY) 或
   deliverNote()），风格参考既有的一次性动作 poke() / celebrate() / injure()
   （它们都是设置一个 private 时间戳/相位机，由 loop() 驱动衰减）。
2. 动作分解建议（三段，总时长与便签淡入节奏配合）：
   a. 叼起：宠物转头/身体朝向便签目标位置，嘴边出现一张小纸片（Canvas 绘制的矩形 + 折角，
      米白色，可有 1–2 条灰色横线暗示文字但**不可有真实文字**，R1）
   b. 运送：若 T5（巡游）已实现，宠物可从当前位置缓慢移动到便签附近；
      若未实现，用「身体朝向 + 重心前倾」表达走向即可，不要为此任务临时加移动能力
      （移动会牵动 petBounds/命中区，风险大）
   c. 放下：纸片从嘴边「脱离」并淡出（此时 DOM 便签淡入接管），宠物头回正，
      可有一个轻微的「呼一口气」起伏（表示事情办完了）
3. 🔴 命中区一致性（踩过的坑）：若动作涉及宠物位移，petBounds() 必须同步返回新位置，
   否则出现「看得见的猫点不到」或「点得到看不见的猫」。
   参考 PLAN-5issues.md §0 的热区死锁事故。建议本动作**不产生位移**（只做朝向与纸片动画），
   彻底回避该风险；位移留给 T5 的巡游统一处理。
4. 与便签生命周期的时序耦合：由 app.ts 在 presentation === 'note' 时先调 pet.carryNote()，
   动作进行到「放下」阶段再让 DOM 便签淡入。请给出明确的时间常量（例：动作总时长 1200ms，
   便签在 800ms 时开始淡入），并在注释里写明两者的配合关系。
5. 与其他状态叠加时的优先级：
   - 甩墙受伤态（injure()）期间：受伤的猫不该叼纸，建议跳过动作、便签直接淡入（降级但不缺失）
   - 抚摸呼噜态（pettingUntil）期间：可共存（一边呼噜一边叼纸很可爱），但纸片动作优先
   - 低精力（burnt，energy≈0）：动作应显得吃力缓慢（这本身是共情表达），但**仍要完成**——
     🔴 不许因为精力低就不送便签，那会让用户在状态最差时失去信息通道（违反 §1 推论 2 的精神）
6. 纸片绘制不得读取 composite（🔴 R6）。

验证：
1. npm run build && npx tsc --noEmit && npm test（当前基线不得下降；开工前先跑一次取当前值，并行会话会推进它）
2. 新增单测：把动作的时序抽成可导出纯函数（例：noteCarryPhase(elapsedMs) →
   'pick' | 'carry' | 'drop' | 'done'），断言各阶段的时间边界、总时长、
   以及 elapsed 超过总时长后恒返回 'done'（防止无限循环）。
3. selfcheck 截图序列：动作的 pick / carry / drop 三帧各一张（可在 selfcheck 模式注入
   固定 elapsed 值定格），目视确认纸片位置合理、不穿模、无文字。
4. 手动：临时把 REPORT_TRIGGER_HOUR/MINUTE 调到近 1 分钟，周三形态触发，
   完整观察「猫叼纸 → 放下 → 便签淡入 → 停留 → 淡出」的时序是否连贯、
   是否读作「猫送来的」而非「系统弹的」。测完改回 17:30。
5. 🔴 验收判据（请自问并在回复中回答）：如果把宠物的动作关掉、只留便签淡入，
   观感是否明显变差？若答案是「差不多」，说明动作幅度太小，未满足 R20，需调参。

收尾：修订 DESIGN.md §6.2「⚪ 现状」段（猫叼纸身体语言一项标记完成 + 时序常量说明）、
§11 M3 表（便签伴随身体语言行标记完成）、§10 R20 落点列补实际函数名、
STRUCTURE_MAP.md §3.16（补 carryNote / noteCarryPhase 存根）。
```

---

### T9 · 晨间基线因果文案强化

```text
任务：强化 energy-pet 晨间基线卡对「昨日收尾 → 今日起点」的因果呈现。
DESIGN.md §11 M3 表列为「保持跨天连续语义，优化文案对"昨日收尾 → 今日起点"的因果呈现」。
这是 M3 里体量最小、风险最低的一项，适合作为 M3 收尾。

设计依据（DESIGN.md §6.1 全文，务必先读）：
精力值跨天连续，不在午夜归零。
- fold() 的不变式：energy = fold(events)，从 INITIAL_ENERGY = 7 起全量重放，无每日重置逻辑
- 晨间基线卡（buildMorningSlide()）的起点是昨日收尾精力（yesterdayCloseEnergy() ← daily_snapshots 表），
  文案明示：「昨天收尾在 N 分。滑动设定今日初始精力」
- 用户滑动确认 → ledger.setEnergy() 写入 energy.set 事件，actual_delta = target - baseEnergy。
  取消也算完成（morningDone = true），不强制
🟡 为什么违反游戏化先例却是对的：几乎所有养成类产品都在午夜重置状态，因为重置制造
「新的一天」的仪式感并驱动日活。但真实精力不重置——熬夜到两点，第二天不会满血。
若这里归零，产品就在教用户一个错误的自我模型，而用户会在第三天发现「它不懂我」并卸载。
对 ADHD 用户，一个说谎的仪表比没有仪表更糟。
代价是失去了「每日重置」的日活钩子。替代方案是晨间基线卡本身——它既是仪式，
也是唯一合法的每日校准点。
🔴 R17：精力跨天连续，禁止午夜归零。落点 fold()。

现状：文案已是「昨天收尾在 N 分。滑动设定今日初始精力」（请先 grep 核实实际字符串与所在文件）。
本任务是**优化**，不是从零实现。

实现要求：
1. 先读源码定位实际文案：grep -rn "昨天收尾\|晨间基线\|morning-baseline" src/，
   找到 buildMorningSlide()（coordinator.ts 私有方法）与 app.ts 的 showSlide() 里
   morning-baseline 分支（现有逻辑：predicted 行改显 baseEnergy，标签改「昨日收尾」，
   卡片加 .morning 类）。
2. 强化的方向（请自行判断具体措辞，以下是意图而非定稿）：
   - 让「因果」显性：不只是报一个数字，而是让用户看到「昨天的你」与「今天的你」是连续的。
     例如点明昨天的收尾是怎么来的（若昨日有明显的高消耗事件，可提及；
     但 🔴 R13 语气红线：只陈述事实，绝不评价 —— 
     「昨天你在 15 点那件事上花了 2.3 分」✅ / 「昨天你效率太低」❌）
   - 无昨日快照时（新用户或首次启动）的降级文案要自然，不要出现「昨天收尾在 null 分」。
     现有 morningBaselineStart() = yesterdayCloseEnergy() ?? INITIAL_ENERGY，
     这两种情况应给不同文案（首次 vs 有历史）。
   - 取消也算完成、不强制的语义，可在文案上不施压（不要出现「请设定」这类命令式措辞）。
3. 🔴 R1：宠物本体不得出现这些文字。文案只能出现在滑动确认卡（用户主动展开的面板/卡片）
   或系统托盘 tooltip。这是 §1 命题允许的两个文字位置。
4. 🔴 R17：本任务**只改文案与呈现**，绝不改 fold() 逻辑、不引入任何每日重置。
   若发现任何形如「跨天归零」的代码，先报告用户，不要自行改。
5. 若需展示「昨日高消耗事件」，注意 queryRange 的半开区间陷阱：
   [start, end)，含「此刻」事件时上界必须传 now + 1。
   另注意 daily_snapshots 表由 session.ended 事件触发 upsertDailySnapshot，
   若昨日未正常退出（崩溃/强杀）可能没有快照 —— 降级路径必须覆盖。

验证：
1. npm run build && npx tsc --noEmit && npm test（当前基线不得下降；开工前先跑一次取当前值，并行会话会推进它）
2. 新增测试覆盖三种情形的文案分支：
   - 有昨日快照（例：昨日收尾 4.2）→ 文案含该数值且明示「昨天」
   - 无昨日快照（首次启动）→ 文案不提「昨天收尾」，改述为初始状态
   - 用户取消 → morningDone 仍置 true，不强制（这条应已有测试，确认未回归）
3. selfcheck 截图：晨间基线卡形态（.morning 类），确认文案完整、不截断、不溢出卡片。
4. 手动：用隔离 userData（--user-data-dir=/tmp/xxx）起一个全新实例，
   确认首次启动的文案合理；再造一条昨日快照确认历史文案。

收尾：修订 DESIGN.md §6.1（把实际文案原文记录进去，便于后续会话知道当前措辞）、
§11 M3 表（晨间基线强化标记完成）、STRUCTURE_MAP.md §3.13（buildMorningSlide 说明更新）。
```

---

### T10 · 变体池（确定性哈希渲染偏移）

```text
任务：为 energy-pet 实现 L2 的离线替代方案 —— 本地变体池伪随机渲染，让宠物「每天有一点
新鲜的、但可预期的它」。DESIGN.md §9.1，M4 交付项。

设计依据（DESIGN.md §9 全文，务必先读）：
设计稿规划了 L2（AI 生成渲染参数）。裁决：先用本地变体池伪随机，不接入任何 LLM/网络。

§9.1 变体池方案：
- 变体 = RenderParams 的一组预设偏移组合（例：耳朵角度基线、尾巴摆动相位、粒子色相偏移、
  呼吸节奏微调）
- 选择函数必须是确定性哈希：seed = hash(localDateStr + variantGroupId)，
  同一天同一组渲染结果一致
- 理由：若每次启动都随机，用户会觉得「它今天不一样了」→ 破坏宠物的同一性
  （continuity of identity）。确定性哈希给出的是「每天有一点新鲜的、但可预期的它」

§9.2 为什么先不接 LLM：
1. 产品定位是完全离线（node:sqlite、本地天气缓存、离线批处理）。接 LLM 引入网络依赖，
   破坏「永不断线」的承诺
2. 渲染参数是连续量，LLM 生成的数值需要大量钳制与平滑处理才能不突兀，投入产出比低于手工变体池
3. 变体池足以验证「外观有变化」这个假设是否真的提升留存。先验证假设，再投入基础设施
⚪ M4 才考虑真接入，且必须保留变体池作为离线降级路径。

🔴 R18：完全离线，禁止引入任何需要网络的推理/渲染依赖。本任务不得引入 npm 包（哈希请自己写，
用简单的 FNV-1a 或 djb2 即可，几十行代码，无需依赖）。

前置：T1（尾巴）+ T2（耳朵）+ T4（pulse 偏移化）建议已完成 —— 变体池的偏移维度
（耳朵角度基线、尾巴摆动相位）需要这些通道先存在。若未完成，变体池只能作用于
呼吸节奏与粒子色相，表达力大打折扣，请先与用户确认是否降级实施。

待用户裁决（Q4）：variantGroupId 怎么分组？
可选方案：
  a. 单一组（全局一个 seed）—— 最简单，一天一个整体外观
  b. 按通道分组（ear / tail / breath / particle 各一个 groupId）—— 组合数更多，
     变化更细腻，但需要定义每个通道的偏移边界防止叠加后失真
  c. 按精力档分组 —— 不同精力档有不同变体池（低精力时变化更收敛，避免疲惫的猫还花哨）
建议 b，并把 c 作为约束（低精力档的偏移幅度乘以衰减系数）。请报给用户确认。

实现要求：
1. 新增模块 src/renderer/variants.ts（或你认为更合适的位置；注意它需要在渲染进程，
   且 emotion/engine.ts 是唯一跨进程复用的 L2 模块，不要污染它）。
   导出：hashSeed(str: string): number（确定性，无随机）、
   pickVariant(groupId: string, dateStr: string): VariantOffsets、
   VariantOffsets 类型定义。
2. dateStr 必须用本地时区日期（复用 storage/sqlite.ts 已导出的 localDateStr(d: Date)，
   它被 ledger/insight 共用；注意渲染进程 import 主进程模块的边界 —— 
   若 localDateStr 在渲染进程不可用，请自己实现一份并注释说明为何重复
   （项目已有同类先例：HotRect 与 clampRange 都是有意的重复定义，见 STRUCTURE_MAP §5.3）。
3. 🔴 同一性保障（这是设计理由的核心，必须有测试守护）：
   - 同一天 + 同一 groupId → 偏移完全相同（多次调用、多次启动都一致）
   - 不同天 → 偏移不同（但仍在预设边界内）
   - 偏移量必须有硬上下界，且叠加到 base 后仍满足所有既有钳制
     （mouthCurve ∈ [-1,1]、eyeOpen ∈ [0,1]、hue 仍在暖区间 [30,50] —— 🔴 R7 不得因变体池被破坏！
     粒子色相偏移可以放宽，但身体主色 hue 不许偏移出暖区间）
4. 🔴 变体池不得读取或影响 composite（R6）。它只作用于 RenderParams 的连续量。
5. 🔴 变体池不得影响精力计算、不得写入事件流（纯渲染层，与呼噜/受伤态同一性质）。
6. 偏移的作用点：接在 composeParams（T4 产出）之后、最终钳制之前。
   请确保顺序是 base → pulse 偏移 → 变体偏移 → 呼噜加成 → 钳制，并在注释里写明这个管线。
7. 跨天切换时机：宠物是常驻应用，会跨越午夜。变体应在**日期变化时**平滑过渡而非瞬间跳变
   （否则用户会在 00:00 看到猫突然变形）。建议：检测到 dateStr 变化后，用既有的 lerp 机制
   在几秒内过渡到新偏移。这一点容易被忽略，但直接影响「同一性」的体验。

验证：
1. npm run build && npx tsc --noEmit && npm test
2. 新增单测（这是本任务的主要交付物，变体池是纯函数、极易测）：
   - hashSeed 确定性：同一输入 1000 次调用结果相同
   - hashSeed 分布：不同输入的结果有足够离散度（例：对 30 个连续日期字符串求哈希，
     断言结果的最低位/取模分布不是常数，防止写了个假哈希）
   - pickVariant 同日稳定：同一 (groupId, dateStr) 多次调用返回深度相等的对象
   - pickVariant 跨日变化：连续 7 天的偏移至少有 N 个维度不同
   - 边界守护：穷举所有 groupId × 30 天，断言每个偏移分量都在声明的上下界内
   - 🔴 R7 守护：断言身体 hue 偏移叠加后仍落在 [30, 50]
3. selfcheck 截图：注入两个不同 dateStr，对比截图确认外观有可辨差异但仍是「同一只猫」
   （若差异大到认不出是同一只，说明偏移幅度太大，需收紧）。
4. 手动：连续启动两次确认外观一致（同一性）；临时把 dateStr 改成明天再启动，
   确认外观变化；跨过 00:00 观察是否平滑过渡。

收尾：修订 DESIGN.md §9.1（补实际实现说明：模块路径、分组方案、偏移边界表、跨天过渡策略）、
§11 M4 表（变体池行标记完成）、STRUCTURE_MAP.md §1 目录树 + §3 存根清单（新增 variants 模块）、
§2.2 import 关系表。
```

---

### T11 · 排练模式（情绪猜谜）—— 用户已裁决，但依赖 4 项不存在的前置

> **裁决核心（用户原话要点）**：猜谜是「排练模式」，与账本脱钩。题目不猜「现在」，猜「表演」——
> 猫进入排练模式，演出一个与账本脱钩的档位，用户猜「它演的这档是几分」。
> 这样 HUD 显示什么都不影响答题（HUD 显示 7 分、猫演 2 分是排练设定，不是故障），R3 无需破例。
>
> **这个思路是对的，且优于我原先的 Q7 提案。** 我原先建议「onboarding 期间临时遮蔽 HUD 数值」，
> 那是在破坏 R3；用户的方案是让谜底与 live 状态解耦，从根上消解冲突 —— R3 字面与精神双满足。

#### ⚠️ 裁决 vs 代码事实：4 项前置依赖不存在

裁决把以下机制当作**既有设施**引用，但实测全部不存在。它们必须先建，否则 T11 无法按裁决的时序落地。

| 裁决引用的概念 | 实测 | 影响 |
|:--|:--|:--|
| **「命名仪式」**（T11 触发时机 = 命名仪式之后） | `grep -rn "命名" src/` 仅命中 `task/center.ts:77` 的 `'未命名任务'`（任务标题兜底），**无任何宠物命名功能** | 🔴 **硬阻塞**。触发时机无锚点 |
| **「首次正式镜像」**（T11 时机 = 命名之后、首次镜像之前） | `app.ts:160` 的「镜像」指 AdjustWindow 本地镜像，与情绪镜像无关；**无情绪镜像机制** | 🔴 **硬阻塞**。时序右边界无锚点 |
| **「ambient 通道」**（跳过者第 3 天由猫叼问号小卡提示） | `grep -rn "ambient\|瞌睡\|doze\|深夜\|night" src/` → **0 结果** | 🟡 需新建。注意 T7 的角落便签是同一形态，可复用 |
| **`emotionCalibration`**（校准输出落点） | `grep -rn "calibration" src/` → **0 结果** | 🟡 需新建存储 |

#### ⚠️ 第二处冲突：档位数与答题带不对齐（R19 同类陷阱）

裁决写「排练只需要 base **六档**动画（M0 已有）」、「覆盖**五档带**（10-8 / 7-6 / 5-4 / 3-2 / 1-0）」、
T13 验收写「**六档**截图序列」。实测：

- `BASE_TIERS` 是 **10 档**，边界 = `9.5 / 8.5 / 7.5 / 6.5 / 5.5 / 4.5 / 3.5 / 2.5 / 1.5 / -1`
- 裁决的五档带边界 = `8 / 6 / 4 / 2 / 0`

**两组边界不重合。** 例：猫演 `cheerful`（min 7.5，实际取 energy 8.0）→ 落在裁决的「10-8」带；
但 `cheerful` 的名义区间是 7.5–8.5，横跨「10-8」与「7-6」两带。用户答 7 分（「7-6」带）算对还是算错？

🔴 **这正是 R19 `charged` 事故的同一个坑**：`energyBand` 门槛 6.5 与 overlay 门槛 8 错位，
导致精力 7 + 雷阵雨时头顶挂闪电却叙事「被点燃」，图文互相打脸。DESIGN.md §4.4 由此提炼的规则是
「为某个格子新增语义前，必须论证边界对齐」。此处同理 —— **答题带边界必须与 BASE_TIERS 边界对齐，
或明确定义容差吸收错位**，否则排练会教出错误的读图能力（这比不教更糟，因为 §1 推论 3 明确
onboarding 的职责就是建立读图能力）。

另：「±1 档内 → 点头盖爪印」的「档」指 **1 个 BASE_TIER（1 分）** 还是 **1 个答题带（2 分）**？
两者容差相差一倍，直接影响难度。

#### 实现要求（前置补齐后）

1. **排练态定义**：新增独立于账本的渲染入口，例 `pet.rehearse(tierIndex)` —— 直接用指定档位的
   `BASE_TIERS` 参数驱动 `RenderParams`，**完全绕过** `energy` / `fold()` / `EmotionState`。
   🔴 排练期间账本写入为零（用户验收项）：不得调用 `adjustDraft` / `commitAdjust` / `setEnergy` /
   `append()` 中任何一个。
2. **HUD 替换为答题选择器**（裁决第 3 点）：排练期间 `#hud-cells` 的 10 格变为可点击答题件，
   点格子作答。中心通道以交互件形态在场 ⇒ R3 满足。排练结束立即恢复常规 HUD。
   🔴 **注意裁决漏了一处**：HUD 除 10 格外还有 **`#hud-num`（数字读数）**，实测
   `app.ts:578/611/639/686` 四处写 `hudNum.textContent = energy.toFixed(1)`。
   若排练期间 `hud-num` 仍显示 live 精力值，就**直接违反验收项「答题时屏幕任何位置不出现
   当前真实精力值」**，且用户可以「live 7.0 → 猜 7」作弊（虽然排练是脱钩的，但数字的存在
   会让用户误以为谜底就是它）。必须同步抑制 `hud-num`（隐藏或改为显示答题进度）。
   `#hud-tier`（档位文字标签，实测 `index.html:33`）同理必须抑制 —— 它会直接写出「平稳」等答案。
   `#hud-weather` 也应抑制（天气与排练无关，留着是噪声）。
3. **题量与时序**（裁决第 2 点）：5 轮，每轮 ≤6s，全程 ≤30s。末轮固定 8-10 档（高光收尾），
   接慢眨 + 呼噜。反馈：±1 档内 → 点头盖爪印；偏差大 → 猫把该档**加大幅度重演一次**
   （这就是教学本身，不是惩罚）。🔴 无分数、无对错记录外显。
4. **校准输出**（裁决第 4 点）：五轮的系统性偏差写入本地 `emotionCalibration`，
   对应档位的表情参数幅度加成（错得越离谱的档，动画越夸张）。
   话术是「猫更懂你了」，不是测试结果。
   ⚠️ 存储位置需定：`meta` 表（`getMeta`/`setMeta` 已有）还是新表？建议 meta（单值 JSON，
   无需索引）。🔴 这是渲染偏好，**不是领域事实** —— 不得写入事件流（否则污染 `fold()`），
   也不得进周报。
   ⚠️ 与 T10 变体池的关系需想清楚：两者都是「渲染参数偏移」。若叠加，须确保
   `base → pulse偏移 → 变体偏移 → 校准加成 → 呼噜 → 钳制` 管线不越界（尤其 R7 的 hue 暖区间）。
5. **触发时机与跳过**（裁决第 1 点）：命名仪式之后、首次正式镜像之前。「直接开始」常驻可见，
   跳过不锁任何功能，设置页有永久重玩入口。跳过者仅在约第 3 天由猫叼一张带问号的角落小卡
   提示一次（ambient 形态），此后永不再提。
   🔴 依赖「命名仪式」「首次镜像」「ambient 通道」三项 —— **均不存在，见上表**。
   若这三项短期不做，本任务只能降级为「首次启动即触发」，那会失去裁决的 IKEA 锚点逻辑
   （先有依恋再有互相了解），请先与用户确认降级还是先建前置。

#### 建议拆分（Q13 的落地方案）

上面 5 项要求里，**只有第 5 项依赖不存在的前置**。1–4 项（排练引擎 / HUD 答题器 / 校准存储）
零外部依赖，可立即按用户裁决的 M1 优先级开工。因此建议拆为两张卡：

| 子任务 | 范围 | 依赖 | 可否立即开工 |
|:--|:--|:--|:--|
| **T11a** | 排练引擎 `pet.rehearse(tierIndex)` + HUD 10 格答题选择器 + `hud-num`/`hud-tier`/`hud-weather` 抑制 + 5 轮时序 + 反馈（点头盖爪印 / 加大幅度重演）+ `emotionCalibration` 存储与参数加成 | 无（`BASE_TIERS` 已在） | ✅ **可立即开工**，符合裁决的 M1 提前意图 |
| **T11b** | 触发时机（命名仪式后 / 首次镜像前）+「直接开始」跳过 + 设置页重玩入口 + 第 3 天 ambient 问号小卡提示一次 | 🔴 命名仪式 / 首次镜像 / ambient 通道（**三项均需先新建**） | ❌ 阻塞 |

这样裁决「提前到 M1」的实质意图（**在情绪通道被真实使用前就教会读图**）由 T11a 承载，
不被前置缺失拖累；而 IKEA 锚点逻辑（先依恋后了解）由 T11b 在前置补齐后实现。
**入口暂用「首次启动即触发 + 可跳过」，T11b 完成后改为正式时机** —— 这是可接受的临时降级，
因为跳过路径本身已保证不锁功能。

#### 验收（用户给定 + 我补的）

- 排练期间账本写入为零（断言 `events` 表行数排练前后不变）
- 🔴 答题时屏幕任何位置不出现当前真实精力值 —— **必须同时覆盖 `hud-num` / `hud-tier` / `hud-weather`**，
  不只 10 格
- 跳过路径 ≤1 次点击
- 5 轮总时长 ≤30s
- 补：答题带与 `BASE_TIERS` 边界对齐关系有测试守护（防 R19 同类错位）
- 补：`emotionCalibration` 加成叠加后仍满足全部钳制（`mouthCurve ∈ [-1,1]`、`eyeOpen ∈ [0,1]`、
  hue ∈ [30,50] 即 R7）

---

### T12 · `injure()` 除名 + `pratfall()` + base 低档「累瘫」变体 —— 用户已裁决

> **裁决核心（用户原话要点）**：不接线，且从领域层除名。「累瘫」视觉并入 base 0-1 档。
> 三条否决理由：① **语义重复** —— 镜子已经会说这句话了，「你一直没休息」的最终状态就是低精力，
> 低精力 → 趴窝已在播；injure() 不提供新信息，只在既有事实上叠加「看，猫都被你累瘫了」——
> 那是强调，不是反映。② **时长与语义错配** —— R11 要求 8s 自愈、不落库；一个 8 秒复原、
> 系统里不留痕的状态承载不了「多日行为模式」的叙事重量；而要数出「连续拒绝 N 次」就得维护
> 一个不落库的影子计数器 —— 暗中监视用户的拒绝行为，这本身违背产品的信任姿态。
> ③ **RSD 人群的流失引信** —— 「因为你做了/没做 X，宠物受伤」是 Finch 用 no-punishment 设计
> 刻意避开、并被社区反复验证为护城河的东西。视觉即文案 —— 不需要一句控诉文字，
> 猫瘫倒的画面在「你刚拒绝休息建议」的上下文里自动读作控诉。
>
> **三条理由都成立，尤其第 ②条的影子计数器论证 —— 那是我没想到的角度。**
> 我原先把 Q5 建议为「暂不接线」，理由是「接线需先做视觉重设计，顺序颠倒会先露出控诉画面」
> （只是排序问题）；用户的否决是**原则性的**（接线本身就不该做），比我的建议强一档。

#### ⚠️ 裁决 vs 代码事实：3 处需修正

| 裁决表述 | 实测事实 | 处置 |
|:--|:--|:--|
| 「`injure()` 从**领域 API** 删除」；验收「**领域层** grep injure 零命中」 | `injure()` 定义在 `src/renderer/pet.ts:262`，**从来不在领域层**（领域层 = core / ledger / storage / task / recovery / insight）。`grep -rn injure src/` 全部命中在 `renderer/pet.ts`（6 处）+ `renderer/app.ts:394`（注释） | 验收标准需重述为「**全项目** grep `injure` 零命中」。原表述会 trivially pass（领域层本来就是 0），失去守护作用 |
| 「甩墙/绷带彩蛋降级为 **renderer 层局部函数**，改名 `pratfall()`」 | 它**已经是** renderer 层局部方法（`private` 于 `PetRenderer`），已是「局部函数」 | 实际改动只有：改名 `injure` → `pratfall`、`private injury` → 相应改名、去掉「未来接线到领域事件」的注释（`:238` / `:259` 两处）、并把触发方式明确为纯手势 |
| X 眼眩晕重做为「呆滞放空 + **折弯胡须**」 | `grep -n "whisker\|胡须" src/renderer/pet.ts` → **0 结果。猫没有胡须** | 🔴 **隐含新增范围**：必须先建 `drawWhiskers()`。这是新增部件，不是改造既有部件 |

#### ⚠️ 第四处：`pratfall()` 的触发手势与 R10 直接冲突

裁决说 pratfall「**纯手势触发**、纯喜剧时序」。但 🔴 **R10 原文**：
「拖动永不计入连点；连点只有正向反馈（呼噜），永不触发受伤。**禁止以任何形式恢复
"连点/拖动 → 惩罚"映射（含调高阈值后恢复）**」。

`injure()` 当前的存在理由恰恰是「与手势彻底解耦」（`app.ts:394` 注释、`pet.ts:238` 注释都在强调这点），
这是 v1.1 推翻 v1.0「放宽连点阈值」裁决的结果。若 pratfall 改回纯手势触发，
就是**把 v1.1 刚废除的东西换个名字恢复** —— 即使视觉改成喜剧、名字去掉惩罚化，
「连点猫 → 猫摔墙」这个映射本身仍是 §5.3 判定为不可接受的误伤源
（ADHD 用户思考时连点 5 次是抚摸）。

**必须请用户明确三选一**（登记为 Q9，见 §5）：
- **(a) pratfall 不接任何手势**，仅保留为调试/彩蛋入口（例：托盘菜单「看它摔一跤」）。
  最安全，R10 零风险，但彩蛋几乎无人发现。
- **(b) 用「与抚摸不冲突的手势」触发** —— 实测此路比预想更糟。`poke()` 实现：
  ```
  this.clickTimes.push(now);
  this.clickTimes = this.clickTimes.filter(ts => now - ts <= PETTING_WINDOW_MS);
  if (this.clickTimes.length >= PETTING_CLICKS) { this.clickTimes = []; this.pettingUntil = ...; }
  ```
  即**每次点击都进计数，满 3 次清空并触发呼噜**。若 pratfall 挂双击：
  ① 「摸 3 下」会变成「第 2 下摔墙 + 第 3 下呼噜」—— 两个反馈在同一手势序列里打架；
  ② 双击已消耗 2/3 计数，使后续单击的呼噜时机不可预测；
  ③ 想摸 2 下的用户得到的是猫摔墙，这正是 §5.3 判定为不可接受的误伤。
  长按走 `dragStart` 路径，同属「手势 → 跌倒」映射，R10 同样禁止。
- **(c) 彻底删除甩墙/绷带**，只保留 base 低档「累瘫」变体。最符合裁决第 ①③条的精神
  （既然「累瘫」已并入镜子，摔墙这个喜剧动作的信息价值就更低了）。

我的建议是 **(a) 或 (c)**。**(b) 的任何变体都会重蹈 v1.0 的覆辙。**

#### 实现要求

1. **`injure()` → `pratfall()`**：改名 + 去掉「未来接线领域事件」的注释 + 按 Q9 结果决定触发方式。
   R11 三判据（拟物卡通 / 8s 自愈 / 不指向用户）平移为 pratfall 的验收标准。
   🔴 保持不落库、不改精力、不进周报（`private injury` 的纯本地性质是 R11 的技术保障，不得改变）。
2. **X 眼眩晕重做**：新增 `drawWhiskers()`（🔴 隐含新范围，见上表），
   把 pratfall 的脸从「X 眼 + 波浪嘴 + 十字贴布」改为「呆滞放空（半闭无神眼，**不是 X**）
   + 折弯胡须」。X 眼的「被打晕」语义是 v1.1 登记的未决债务，本次一并清偿。
   额头绷带 / 侧脸十字贴布按 R11「拟物卡通」判据可保留（它们是汤姆猫式卡通惯例）。
3. **base 低档「累瘫」变体**（裁决第 2 个处置项，这是本任务的正向交付）：
   把「眼皮沉重、融化式瘫软、缓慢起伏」并入 base 最低档，成为镜子的正当词汇。
   ⚠️ **档位边界需澄清**（登记为 Q10）：裁决写「base **0-1** 档」，但实测 `BASE_TIERS` 最低两档是
   `exhausted`（min **1.5**，label「疲惫」）与 `burnt`（min **-1**，label「枯竭」）。
   能量量程是 0–10（`ENERGY_MAX = 10`），所以「0-1 档」实际只覆盖 `burnt`。
   是要 ① 只改 `burnt`（energy < 1.5），② 改 `exhausted` + `burnt` 两档（energy < 2.5），
   还是 ③ 新增一个 energy < 1.0 的更低档？现有 `EMOTION_PARAMS` 的 `squish` 已是
   `exhausted 0.2 / burnt 0.3`，「融化式瘫软」需要更大的 squish + 新的轮廓绘制路径。
4. **未来提醒的合法载体**（裁决第 3 个处置项）：若真需要「你太久没休息」的提醒，
   走既有 ambient 通道（深夜打瞌睡脉冲、猫自己去角落睡），**永不新建惩罚态**。
   🔴 ambient 通道当前不存在（见 T11 前置表），此项登记为未来任务，不在 T12 范围内。

#### 验收（用户给定 + 修正）

- 🔴 **全项目** `grep -rn "injure" src/` 零命中（原裁决写「领域层」，会 trivially pass）
- 任何用户行为序列（含连续拒绝恢复 10 次）不触发跌倒态
- base 低档新变体通过「融化感」对比测试（与相邻档「蔫」的区分度可辨）
- 补：`pratfall()` 触发路径经 Q9 裁决后，有测试断言「连点 N 次（N ≥ 3）不触发 pratfall」
  （R10 守护，防未来有人把手势接回去）

---

### T13 · 金渐层花纹图层 —— 用户已裁决

> ✅ **已交付（2026-10-23，main `14c0bc2`/`d59d47d`/`3efdb0b`）**：`coatPatternParams(sat,lum)`/`irisTone(energy)`
> 导出纯函数（禁独立常量）+ `drawCoatPattern()`（鞍状 tipping 裁剪进身体轮廓，耳背/背脊/尾尖分布，面腹素净）
> + 虹膜色相迁移（暖翠绿→琥珀翠→蜜琥珀，绿≤30%）+ 黑眼线环（品种签名）+ `drawWhiskers()` 常驻胡须。
> 守护：`tests/coat-pattern.test.ts`（10 档单调收敛/绿≤30/永不全灰）+ emotion-tiers 既有 R7 六条。
> 🔴 **美术参考合规（裁决 5）**：如需"真实金渐层"校准，仅可用 Dreamstime 金渐层插画页 / pngimg 英短 PNG
> 做**色值与斑纹分布的肉眼参考**——不入代码、不入仓库、不再分发（规避授权）；一切视觉程序化原创。
> ⏳ 仍待裁决：Q11 尺寸基准（64px 不对应实测 104–116px）；「灵魂出窍彩蛋」分支前置不存在（grep=0），拆独立任务。

> **裁决核心（用户原话要点）**：花纹是受同一参数管线的图层，不是画上去的贴图。
> ① **R7 联动**：黑毛尖渐变做成独立花纹图层，其 `patternOpacity`/`patternContrast` 由 `sat`/`lum`
> 同一参数驱动 —— 精力降，花纹对比度单调收敛，低档时猫整体褪成均匀的浅金灰
> （「毛色失去光泽」恰是真实病弱猫的第一视觉信号，语义自洽）。**禁止花纹走独立常量。**
> ② **分布规则**：渐变集中在耳背、背脊线、尾尖（真实金渐层分布），面部与腹部保持素净 ——
> 表情是第一信息通道，脸上加花纹是给读图加噪声；腹部是拖拽形变最大区域，花纹在那里拉伸会出伪影。
> ③ **绿眼睛三条子规则**：色相随精力迁移（8-10 暖翠绿 → 4-7 琥珀翠 → 0-3 蜜琥珀，绿分量 ≤30%），
> 绿永不在低档主导；眼睛永不全灰（眼神光是「生命迹象」通道，瞳孔高光随精力缩放，
> 0-1 档保留最小微光 + 安详半闭眼；灵魂出窍彩蛋期间肉身眼睛也是闭着的安详态，不是空洞态 ——
> **镜子可以显示没电，不能显示死亡**）；64px 可读性（花纹不得糊成泥、不得干扰表情辨识，
> 辨识标准：只看剪影+脸能正确归档）。
>
> **①②③ 的实现约束都精确且可直接落地**，尤其「禁止花纹走独立常量」和「面部/腹部素净」两条
> —— 前者是 R7 的技术保障，后者守住了 §1 推论 3 的读图优先级。

#### ⚠️ 裁决 vs 代码事实：3 处需澄清

| 裁决表述 | 实测事实 | 处置 |
|:--|:--|:--|
| 「**64px** 可读性：按桌面实际渲染尺寸测试」 | **64px 不对应任何实际渲染尺寸**。实测：窗口 `WIN_WIDTH=400 × WIN_HEIGHT=620`；`bodyR = Math.min(52 + p.energy * 0.6, H * 0.32)`（`pet.ts:320/485`）⇒ 身体半径 **52–58px**，身体直径 **104–116px**，含耳朵/尾巴的整体约 **110–150px**。托盘图标是 **16px 纯色圆点**（`main/index.ts:512 buildTrayIcon()`，`size = 16`，画的是暖黄圆点，**不是猫**） | 🔴 需澄清目标尺寸（登记为 Q11）。若意图是「托盘图标要变成迷你猫」，那是一个**独立新功能**（当前托盘图标与宠物渲染完全无关），范围远超花纹 |
| 「**六档**截图序列」（验收） | `BASE_TIERS` 是 **10 档**（边界 9.5/8.5/…/1.5/-1） | 与 T11 同类问题。建议按 **10 档全量**截图（`patternContrast` 单调性本就是逐档断言，10 档更严），或明确指定哪 6 档 |
| 「**灵魂出窍**彩蛋期间肉身眼睛也是闭着的安详态」 | `grep -rn "灵魂\|soul" src/` → **0 结果，该彩蛋不存在** | 🟡 引用了一个未实现的彩蛋。眼睛规则本身可独立落地；「灵魂出窍期间」这一分支在前置建成前无从验证。若该彩蛋在计划中，应先登记为独立任务 |

#### 实现要求

1. **花纹图层**：新增 `drawCoatPattern(ctx, bodyR, p, ...)`，在身体渐变填充之后、脸之前绘制
   （先读 `pet.ts` render() 的绘制顺序注释确认层级）。分布区：**耳背、背脊线、尾尖**
   （`drawEar` / 身体顶部贝塞尔 / `drawTail` 三处），🔴 **面部与腹部素净**。
2. 🔴 **参数管线**（R7 联动的技术保障）：`patternOpacity` / `patternContrast` **必须由
   `p.sat` / `p.lum` 派生**，禁止引入独立常量或独立档位表。
   实测 `BASE_TIERS`：`sat = 96/94/92/88/78/66/54/42/32/24`、`lum = 80/78/76/74/72/70/67/63/58/52`
   —— 两者均已单调递减，直接映射即可自然满足「精力降 → 花纹对比度单调收敛」。
   低档时猫整体褪成均匀浅金灰。
3. **眼睛色相迁移**：现状 `drawEyes()` 用固定 `#2b2b3a`（深蓝黑）画眼线/瞳孔 +
   `rgba(255,255,255,0.9)` 高光 + `hsl(p.hue p.sat% max(40,p.lum)%)`（即身体同色）。
   **当前没有绿色眼睛** —— 裁决的「绿眼睛」是**新增**，不是改造。需新增虹膜色相通道，
   按裁决迁移：8-10 档暖翠绿 → 4-7 档琥珀翠 → 0-3 档蜜琥珀（绿分量 ≤30%）。
   🔴 眼睛永不全灰；0-1 档保留最小微光 + 安详半闭眼。
   🔴 与 R7 的一致性：虹膜色相迁移**不受 R7 约束**（R7 管的是身体主色 hue ∈ [30,50]），
   但「绿分量 ≤30%」是裁决自设的约束，须写成可测断言。
4. **腹部素净的理由要守住**：腹部是拖拽形变最大区域（`dragStretch` 黏性形变），
   花纹在那里拉伸会出伪影。🔴 若未来调整形变逻辑，不得顺带把花纹铺到腹部。

#### 验收（用户给定 + 修正）

- **10 档**（非 6 档）截图序列，花纹对比度随档位**单调不增**（写成断言，不只目视）
- 任何档位绿分量不压过金
- 面部区域在实际渲染尺寸下表情辨识率不低于无花纹基线
  （辨识标准：只看剪影 + 脸能正确归档）
- 🔴 尺寸基准待 Q11 澄清后填写；若按实测，应为「身体直径 104–116px」而非 64px
- 补：`patternOpacity`/`patternContrast` 无独立常量（grep 断言或代码审查项）
- 补：花纹叠加后 `hue` 仍在 [30,50]（🔴 R7 不得因花纹被破坏）

---

### 条件项备忘：锁定态 HUD（M3）

`DESIGN.md` §11 M3 表：若引入锁定功能，必须验证 10 格完整显示（§2.3 / 🔴 R3）。
当前项目**无锁定功能**，故无对应任务。若未来引入，必须同步验证 HUD 10 格仍完整显示
（R3：禁止在任何状态下隐藏中心通道 —— 锁定态、低精力态、跌倒态都必须保留 10 格显示）。
⚠️ 注意 T11 排练模式会把 10 格变成**答题交互件**，这在 R3 下是合法的（中心通道以交互件形态在场），
但若未来锁定态与排练态同时存在，需确认两者的 HUD 形态不冲突。

---

## 4. 验证门与回归清单

### 4.1 每条任务的收尾三连（顺序不可换）

```bash
cd /Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet && npm run build
cd /Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet && npx tsc --noEmit
cd /Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet && npm test
```

必须先 build 再自检，否则跑的是旧 dist（会误判「改了没生效」）。

### 4.2 涉及渲染/交互的任务额外跑

```bash
mkdir -p /tmp/ep-shots
cd /Users/zcy/WorkBuddy/2026-10-20-14-36-36/energy-pet && \
  env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . \
  --selfcheck /tmp/ep-shots/t1.png --no-sandbox --disable-gpu --user-data-dir=/tmp/ep-check
```

`--user-data-dir` 起隔离实例可绕行单实例锁，不必杀用户正在跑的实例。
截图目录必须先 `mkdir -p`，否则只报 capture failed（ENOENT 被吞）。

### 4.3 全量手动回归清单（M1 或 M3 整组做完后跑一次）

第 1–23 项为既有功能回归；**第 24–36 项（加粗）为 T11/T12/T13 三条裁决的新增验收项**，
在对应任务完成前无法执行，但应在开工前就读一遍 —— 它们定义了「做完长什么样」。
标 🔴 的是红线级验收，任一不通过则改动不得合入。

| # | 场景 | 预期 | 关联红线 |
|:--|:--|:--|:--|
| 1 | 光标从桌面移向 dock 各按钮 | 全部可点，无穿透死区 | 不变式 9/10 |
| 2 | 单击宠物 | 压平回弹 + 少量粒子，**无文字气泡** | R1 |
| 3 | 2500ms 内连点 3 次 | 呼噜：嘴型上扬 + 眯眼 + 低幅 purr + 暖金粒子 ×10，**绝不甩墙** | R10 |
| 4 | 拖拽宠物 | 黏性形变 + 松手弹性回弹，**不计入连点、不触发受伤** | R10 |
| 5 | 拖动 HUD 滑块（无调节窗口） | 表情实时跟随，松手**回弹**到真实值，无「是否保存」提示 | R8 |
| 6 | 完成任务 → 7s 窗口内拖动 → 静置 | 拖动重置计时，静置 7s 后转 confirming 弹卡，**不自动落库/不自动丢弃** | R9 |
| 7 | 任意状态下观察 HUD | **10 格始终完整显示**（低精力/受伤/锁定均不隐藏） | R3 |
| 8 | 精力 < 8 + 晴/阴 | 头顶**无任何**正向天气元素 | R4 |
| 9 | 精力 ≥ 8 + 雨/雷 | 头顶 none（状态好不需外部归因） | R4 |
| 10 | 精力 < 8 + 雨/雷 | 头顶 rain-drop / storm-bolt（归因外化） | R4 |
| 11 | 精力 7 + 雷阵雨 | composite === 'content'，周报文案**不含**「反而被点燃」 | R19 |
| 12 | 精力从 10 滑到 0 | 身体色相**始终暖金**（不出现青/蓝/紫），靠去饱和+降明度变疲惫 | R7 |
| 13 | 精力 0（burnt） | 瘫软 + 眼皮下垂 + 呼吸 6.5s + 微弱颤抖，尾巴拖地，耳朵飞机耳后压 | §3 五通道 ✅ 已实现 |
| 14 | exhausted + grateful | 嘴角从 -0.6 抬到约 -0.2（**苦中作乐，不是大笑**） | §4.3 |
| 15 | 周三 17:30 | 猫叼纸 → 角落便签淡入 → 停留 → 自动淡出；**不抢焦点、可同时点宠物** | R12/R20 |
| 16 | 周五 17:30 | 羊皮纸卷轴模态，**无关闭按钮**，必须点「已确认」 | R12 |
| 17 | 便签显示期间点桌面空白处 | 点击**穿透到桌面**（便签不吃鼠标） | 不变式 9 |
| 18 | 敲键盘 30s / 离键 3min | 陪伴姿态 ↔ 巡游姿态切换，**系统设置里无 TCC 权限请求** | R16 |
| 19 | 连续两次启动（同日） | 外观**完全一致**（变体池同一性） | §9.1 |
| 20 | 跨午夜常驻 | 变体平滑过渡，**不瞬间变形** | §9.1 |
| 21 | 旧库（含 rec_water 等孤儿事件）启动 | 不崩，孤儿数据只读跳过 | — |
| 22 | 断网启动 | 天气走 fallback，应用**不崩不阻塞** | R18 / 不变式 8 |
| 23 | 应用退出后 | 无残留定时器报错（"database is not open"） | 踩坑记录 |
| **24** | **排练模式期间查库** | **`events` 表行数排练前后完全不变**（账本写入为零） | T11 验收 |
| **25** | **排练答题时扫视全屏幕** | **任何位置都不出现真实精力值** —— 必须逐一确认 `hud-num`（数字读数）/ `hud-tier`（档位文字）/ `hud-weather` 三处均已抑制，不只是 10 格 | T11 验收 🔴 |
| **26** | **排练时点「直接开始」跳过** | **≤1 次点击**即退出；跳过后**不锁任何功能**；设置页有永久重玩入口 | T11 验收 |
| **27** | **5 轮排练计时** | **总时长 ≤30s**，每轮 ≤6s；末轮为 8-10 档高光收尾 + 慢眨 + 呼噜 | T11 验收 |
| **28** | **全项目 `grep -rn "injure" src/`** | **零命中**（已改名 `pratfall`）。注意：原裁决写「领域层」，而 `injure()` 从来就在 renderer 层，按领域层查会 trivially pass | T12 验收 🔴 |
| **29** | **连续拒绝恢复建议 10 次** | **不触发跌倒态**（任何用户行为序列都不得触发）；且无影子计数器落库 | T12 验收 🔴 |
| **30** | **连点 ≥3 次** | 只出呼噜，**绝不触发 pratfall**（已由 `tests/pratfall.test.ts` 连点断言纯函数守护，Q9 裁决落地） | R10 🔴 |
| **37** | `grep -rn "PULSE_THRESHOLD" src/ tests/` | 零命中（门槛已火化，Q1 裁决） | Q1 |
| **38** | intensity 查表空隙点 | `intensity(3.5)/intensity(5.5)/intensity(7.5)` 均有定义（G4：下界包含查表，浮点精力不跳变） | Q1/G4 |
| **39** | empathy 豁免机制桩测试 | `tests/pulse-intensity.test.ts` 桩断言存在且通过（G1 机制部分；词典仍待用户） | Q1/G1 |
| **31** | **base 最低档 vs 相邻档** | 「融化式瘫软」与相邻档的「蔫」**区分度可辨**（融化感对比测试） | T12 验收 |
| **32** | **pratfall 的脸** | **呆滞放空（半闭无神眼，不是 X 眼）+ 折弯胡须**；无血、无泪、无控诉文案；8s 自愈不留痕 | R11 |
| **33** | **10 档花纹截图序列** | `patternContrast` 随档位**单调不增**；低档整体褪成均匀浅金灰 | T13 验收 / R7 |
| **34** | **任何档位看眼睛** | **绿分量不压过金**；0-1 档为蜜琥珀（绿 ≤30%）+ 最小微光 + 安详半闭眼，**眼睛永不全灰** | T13 验收 🔴 |
| **35** | **面部与腹部** | **保持素净无花纹**（表情是第一信息通道；腹部是拖拽形变最大区，花纹会拉伸出伪影） | T13 裁决② |
| **36** | **只看剪影 + 脸归档** | 表情辨识率**不低于无花纹基线**（尺寸基准待 Q11 澄清） | T13 验收 |

### 4.4 停止/重启实例的正确姿势

```bash
pgrep -fl 'energy-pet/node_modules/electron'   # 先看有没有在跑的（ps 在沙箱被禁）
pkill -f 'energy-pet/node_modules/electron'
sleep 3                                        # kill 后必须等，否则新实例被单实例锁拒绝
```

`start.sh` 报的 pid 未必是最终存活者（单实例锁会拒绝后启动者）。被锁拒绝**不是故障**。

---

## 5. 待裁决项汇总（开工前问用户）

| # | 问题 | 阻塞的任务 | 我的建议 | 状态 |
|:--|:--|:--|:--|:--|
| Q1 | pulse 调制曲线：`PULSE_THRESHOLD = 3` 意味着 pulse 只在 energy < 3 激活，而裁决要求「modulation 随档位递减」——若 modulation 在 low 档趋近 0，pulse 就不可见了。modulation 的定义域是全量程还是低精力区内部？ | T4 | 在**低精力区内部**细分（energy 2.9 vs 0.2 的表达强度差异），不跨全量程递减。不改 `PULSE_THRESHOLD` | ✅ **已裁决（2026-10-22，推翻本行旧建议）**：门槛废除、全档激活；调制用四段查表 `intensity(energy)`：>=8→0.25 / >=6→0.5 / >=4→0.75 / else→1.0；**0-3 区间内部不再细分**（「低精力区内部细分」方案被明确否决）；empathy-bound 恒 1.0。已交付 main `fb2f37c` |
| Q2 | 键盘感知的活跃阈值 / 离键阈值具体秒数？ | T5 | 活跃 < 30s，离开 > 180s，中间为不确定区（保持上一姿态，迟滞防抖动） | ⏳ 待裁决 |
| Q3 | 便签停留时长？淡出后能否重新唤出？便签在窗口内的位置？ | T7 | 停留 25s；**不可**重新唤出（可唤出就需常驻入口，反增负担，周五卷轴才是完整回顾入口）；放右上角，避开宠物区（y≈488–602）与 dock | ⏳ 待裁决 |
| Q4 | 变体池 `variantGroupId` 分组维度：单一组 / 按通道分组 / 按精力档分组？ | T10 | 按通道分组（ear/tail/breath/particle），并叠加「低精力档偏移幅度衰减」约束 | ⏳ 待裁决 |
| ~~Q5~~ | ~~是否给 `injure()` 接线到领域事件？~~ | T12 | — | ✅ **已裁决（2026-10-22）：不接线，且从领域层除名，「累瘫」并入 base 低档。三条理由见 T12 卡** |
| Q6 | 是否引入「锁定态」功能？ | M3 条件项 | 暂不引入。若引入，必须同步验证 HUD 10 格完整显示（R3） | ⏳ 待裁决 |
| ~~Q7~~ | ~~T11 情绪猜谜是否与 HUD 10 格同时出现？~~ | T11 | — | ✅ **已裁决（2026-10-22）：猜谜是「排练模式」，谜底与 live 账本脱钩，HUD 替换为答题选择器 ⇒ R3 无需破例。比我原提案（遮蔽 HUD）更优** |
| Q8 | T6 与 T7 是一次做完还是分两次？ | T6/T7 | 分两次。T6 只加字段不改渲染（零风险、测试可覆盖），T7 涉及新 DOM + CSS + 命中区（本项目最高风险区，见热区死锁事故） | ⏳ 待裁决 |
| **Q9** | 🔴 **`pratfall()` 的触发手势与 R10 冲突**。裁决说 pratfall「纯手势触发」，但 R10 明令「禁止以任何形式恢复"连点/拖动 → 惩罚"映射（含调高阈值后恢复）」，而 v1.1 刚为此废除了连点甩墙。三选一：**(a)** 不接手势，仅留调试/彩蛋入口（托盘菜单）；**(b)** 用某个「与抚摸不冲突的手势」——**实测比预想更糟**：`poke()` 每次都 `clickTimes.push(now)`，达 `PETTING_CLICKS(3)` 时**清空数组**并触发呼噜。若 pratfall 挂双击，则「摸 3 下」= 第 2 下摔墙 + 第 3 下呼噜，两个反馈在同一手势序列里打架；且双击已消耗 2/3 计数，使后续单击的呼噜时机变得不可预测。长按走 `dragStart` 路径，同属手势映射；**(c)** 彻底删除甩墙/绷带，只保留 base 低档「累瘫」变体 | T12 | **(a) 或 (c)**。**(b) 的任何变体都会重蹈 v1.0 覆辙** —— 换名字、改视觉都不能改变「手势 → 跌倒」这个映射本身的误伤性质，且实测会与呼噜计数互相干扰 | ✅ **已裁决（2026-10-22）**：强意图手势——拖拽超距（`PRATFALL_DRAG_MIN_PX=240` 路径总长）+ 3s 内方向反转 ≥3 次（`isPratfallGesture()` 纯函数）；单击/连点/普通拖拽物理上不可命中（`tests/pratfall.test.ts` 六断言守护 R10）。已交付 main `1557490` |
| **Q10** | T12「累瘫」并入 base「**0-1 档**」，但 `BASE_TIERS` 最低两档是 `exhausted`(min **1.5**) 与 `burnt`(min **-1**)，量程 0–10 ⇒「0-1 档」实际只覆盖 `burnt`。要 ① 只改 `burnt`(energy<1.5)、② 改 `exhausted`+`burnt` 两档(energy<2.5)、还是 ③ 新增 energy<1.0 的更低档？现有 `squish` 已是 exhausted 0.2 / burnt 0.3，「融化式瘫软」需更大 squish + 新轮廓路径 | T12 | **② 改两档**（energy<2.5），幅度分档递进：exhausted 是「快撑不住」的摇晃瘫软，burnt 是「融化摊平」。③ 会动 `BASE_TIERS` 结构与 `tierFor()` 边界，牵连 10 档全量断言与 HUD 每档 1 分的对应关系（`HUD_CELL_COUNT = ENERGY_MAX`），代价过大 | ⚠️ **部分裁决（2026-10-22）**：按建议 ② 实现 energy<2.5（exhausted+burnt 两档，`LOW_TIER_PRONE_MAX=2.5`），已交付 main `e23845e`；裁决原文「0-1 档」与实现边界的差异**待用户最终确认** |
| **Q11** | 🔴 T13 裁决写「**64px** 可读性，按桌面实际渲染尺寸测试」，但 **64px 不对应任何实际渲染尺寸**。实测：窗口 400×620，`bodyR = min(52 + energy*0.6, H*0.32)` ⇒ 身体半径 **52–58px**、直径 **104–116px**、含耳尾整体约 **110–150px**；托盘图标是 **16px 纯色圆点**（`buildTrayIcon()`，`size=16`，画暖黄圆点，**不是猫**）。64px 从何而来？若意图是「托盘图标要变成迷你猫」，那是**独立新功能**（当前托盘与宠物渲染完全无关），范围远超花纹 | T13 | 按**实测尺寸 104–116px**（身体直径）作为可读性基准。若确实需要 64px 场景，请指明是哪一个（缩略图？托盘迷你猫？），后者应拆成独立任务 | ⏳ **需澄清** |
| **Q12** | 🔴 T11 答题带边界与 `BASE_TIERS` 边界**不对齐**（R19 `charged` 事故的同一类坑）。裁决给五档带 `10-8/7-6/5-4/3-2/1-0`（边界 8/6/4/2/0），实测档位边界是 `9.5/8.5/7.5/6.5/5.5/4.5/3.5/2.5/1.5/-1`。例：猫演 `cheerful`(min 7.5) 落在「10-8」带，但其名义区间 7.5–8.5 横跨两带 ⇒ 用户答 7 分算对还是错？另「±1 档内点头」的「档」指 **1 个 BASE_TIER(1分)** 还是 **1 个答题带(2分)**？容差相差一倍 | T11 | **答题带直接采用 `BASE_TIERS` 的 10 档**（每档 1 分，与 HUD 10 格天然一一对应，用户点第 N 格 = 猜第 N 档，零错位）。「±1 档」= ±1 个 BASE_TIER。若坚持五档带，必须显式定义容差吸收 8/6/4/2 与 x.5 边界的错位，并写测试守护 | ⏳ **需优先裁决** |
| **Q13** | 🔴 T11 被裁决从 M4 提前到 M1，理由是「排练只需 base 六档动画（M0 已有），不依赖天气/pulse/AI 变体」——**对渲染依赖的判断成立**，但 T11 真正的阻塞不在渲染层：裁决当作既有设施引用的 **4 项前置一项都不存在**（命名仪式 / 首次正式镜像 / ambient 通道 / `emotionCalibration`，实测 grep 全部 0 结果）。在这 4 项建成前，T11 只能降级为「首次启动即触发」，那会失去裁决自己的 IKEA 锚点逻辑（先有依恋再有互相了解）。是先建 4 项前置，还是接受降级？ | T11 | **先把 T11 拆成 T11a（排练引擎 + HUD 答题器 + 校准存储，无前置依赖）与 T11b（触发时机 + 跳过 + 第 3 天 ambient 提示，依赖命名仪式/镜像/ambient）**。T11a 可立即按 M1 优先级开工，T11b 待前置。**注意**：裁决还引用了「六档」（实测 10 档）与「灵魂出窍彩蛋」（不存在），同属此类偏差 | ⏳ **需优先裁决** |

> **裁决偏差速查（本轮核对发现，全部已在对应任务卡内展开）**
>
> | 裁决表述 | 代码事实 | 严重度 |
> |:--|:--|:--|
> | pratfall「纯手势触发」 | 与 🔴 R10 直接冲突（v1.1 刚为此废除连点甩墙） | 🔴 需裁决 Q9 |
> | 答题带「10-8/7-6/5-4/3-2/1-0」 | `BASE_TIERS` 是 10 档，边界为 x.5，两组边界错位（R19 同类坑） | 🔴 需裁决 Q12 |
> | 「base **六档**动画（M0 已有）」·「**六档**截图序列」 | 实测 **10 档** | 🟡 数字修正 |
> | 「**64px** 按桌面实际渲染尺寸」 | 实测身体直径 **104–116px**；托盘是 16px 圆点（非猫） | 🔴 需澄清 Q11 |
> | 「命名仪式之后、首次正式镜像之前」 | 两者均**不存在**（grep 0 结果） | 🔴 硬阻塞 Q13 |
> | 「ambient 通道」「深夜打瞌睡脉冲」「猫自己去角落睡」 | **不存在**（grep 0 结果） | 🟡 需新建，可复用 T7 便签形态 |
> | 「`emotionCalibration`」 | **不存在**（grep 0 结果） | 🟡 需新建存储 |
> | 「灵魂出窍彩蛋期间肉身眼睛…」 | 该彩蛋**不存在** | 🟡 引用未实现项 |
> | 「折弯胡须」 | 猫**没有胡须**（grep 0 结果）⇒ 隐含新增 `drawWhiskers()` | 🟡 范围扩张 |
> | 「从**领域 API** 删除 injure」·验收「**领域层** grep 零命中」 | `injure()` 从来在 `renderer/pet.ts`，**不在领域层** ⇒ 原验收标准会 trivially pass | 🟡 验收标准需重述 |
> | 「绿眼睛色相迁移」 | 当前眼睛是固定 `#2b2b3a` + 身体同色，**没有绿色** ⇒ 是新增而非改造 | ⚪ 事实澄清 |
> | HUD 只需处理「10 格」 | HUD 另有 **`hud-num`（数字读数）** / `hud-tier`（档位文字）/ `hud-weather`，四处写 `energy.toFixed(1)` ⇒ 不抑制则**直接违反 T11 验收「屏幕任何位置不出现真实精力值」** | 🔴 裁决遗漏，已补入 T11 |

---

## 6. 变更日志

| 日期 | 变更 |
|:--|:--|
| 2026-10-22 | 首版。基于源码实测核对生成：确认 4 项「文档说要做但代码已完成」（M1 配色纠偏 R7 / R1 气泡删除 / R19 charged 删除 / PLAN-5issues 需求 1–5），剔除出待办；确认 6 项真实缺口（尾巴 0 结果 / 耳朵仅呼吸驱动 / pulse 覆盖语义 / powerMonitor 0 结果 / 周报无 presentation / injure 无调用方）；产出 T0–T13 共 14 条任务，其中 10 条可直接执行、3 条挂起待裁决、1 条为文档修订。附 23 项手动回归清单与 8 个待裁决项 |
| 2026-10-22 | **v2**。① 落地用户 T11/T12/T13 三条裁决：三项从「挂起待裁决」升级为**正式任务卡**（Q5/Q7 标记已裁决），每卡附「裁决 vs 代码事实」冲突核对表 + 处置 + 修正后的验收标准。② 同步代码进展：**T1 尾巴 / T2 耳朵已完成**（`resolveTailPose()` / `resolveEarPose()` / `drawTail()` / `drawEar()` 三态飞机耳 + `tests/pose.test.ts` 10 例），移入勿重做清单，原提示词折叠存档；基线 **90 → 100**。③ 核对出 **12 处裁决与代码事实的偏差**（见 §5 速查表），其中 4 处为 🔴 硬冲突/硬阻塞：pratfall 手势触发违反 R10（Q9）、答题带边界与 `BASE_TIERS` 错位即 R19 同类坑（Q12）、64px 不对应任何实际渲染尺寸（Q11）、T11 的 4 项前置全不存在（Q13）；另发现裁决遗漏 `hud-num`/`hud-tier` 数字读数会直接违反 T11 自身验收。④ 新增 Q9–Q13 待裁决项，回归清单从 23 项扩至 **36 项**（新增排练/跌倒/花纹三组验收）。⑤ 重排主线为五梯队，说明 T11 虽裁决提前到 M1 但仍排第五梯队的原因（阻塞在前置而非渲染），并新增 T10 依赖 T11 的管线顺序理由 |
| 2026-10-22 | **v3**（09:59）。① 🔴 **检测到并行会话已完成 M1 全组**：T1 尾巴 + T2 耳朵 + **T3 配色守护**（`tests/emotion-tiers.test.ts` 6 例，含变异验证 hue→250 触发 3 条失败），DESIGN.md 已升 **v1.2** 并新增 §3.2 姿态解算不变式。基线 **100 → 106**（7 个测试文件）。三项全部移入勿重做清单。② **发现 v1.2 两处遗漏造成 DESIGN.md 内部自相矛盾**：§3.1 裁决段已写「M1 落地增 lum 列」，但同节第 100–102 行**旧数据块仍写「hue 210→288 蓝→紫 严重偏离」**；§3 五通道表通道 5「色」**仍标 ⚠️ 偏离设定**，而同文档附件通道表（耳朵/尾巴）已改 ✅ ⇒ 升为 T0 最高优先级（条目 A/B）。③ 发现 **STRUCTURE_MAP.md 完全未同步**（仍 11:46 的 v1.0：17 文件/4087 行/40 测试/仍有 `say(text`/`grep resolveTailPose` = 0）⇒ T0 条目 C–K、O、P 全部待做。④ T0 新增「条目状态速查表」（A 半成品 / B 未做 / C–K 待做 / L·M 已完成 / N·O·P 待做），并标注 O↔F、P↔C 的重叠关系避免重复改。⑤ T2 卡补录并行会话的**两条实战教训**：多通道读同一输入方向必须一致（抚摸眯眼被 droop 误读为疲惫 → 按 `(1-joy)` 门控）；**纯函数单测只能守语义边界，视觉形态必须 selfcheck 截图 + 裁剪放大肉眼验收**（尾巴首版塌成水平鱼鳍、耳内色 hue+24 是黄绿「新芽」）。⑥ 全文基线数字统一改为「开工前先跑一次取当前值」，并加**并行会话警示**（v2 写完 16 分钟内即被超越） |
| 2026-10-22 | **v4**（11:3x）— **T0 执行完毕**。① **DESIGN.md 升 v1.3**：条目 A（§3.1 旧数据块整节重写为实测 10 档表 + 措辞改过去式 + 节标题改「配色纠偏 🔴（M1 已完成 ✅）」）、B（§3 通道 5 改 ✅ 并补 `lum`）、N（§5.4 债务改「已裁决除名」+ 固化三条否决理由 + 同步 §5.3 第 4 条/§3 绷带行/§11 M2）、I（§5.2 补两套独立状态机术语澄清表）、J（§11 M0 补 17:30 定时触发链路 + 修正 geo/sensor 数据源）、K（文件头 + §12 变更日志）全部落地；新增 **§3.3 花纹图层不变式**（T13 裁决）；M1 标题改「✅ 四项闭环 + ⏳ T11 阻塞」、M4 两行更新。② **STRUCTURE_MAP.md 全量同步**：§0（18 文件/6572 行/7 测试文件/106 用例 + 基线演进 40→89→90→100→106）、§1 目录树行数全实测、§2（L2 六→7 模块 + `sensor→geo` 依赖注记 + import 表补 geo.ts + 启动链路补 3 个 setInterval 与 geoTimer 1500ms 链）、§3.1/§3.8/§3.11 重写、**新增 §3.11b `geo.ts` 存根**（首版完全漏计）、§3.13/§3.16/§3.17 重写、§4 不变式 12→**17 条**、§5 逐条重测（更正 3 处过期结论）、**新增 §5.4 孤立死代码/已废弃通道**、§6 修改指引补 R7 与 pulse 警示 + 验证命令 40→106。③ 🔴 **R10/R11 措辞冲突按约束只登记未改 §10 原文**，仍待用户确认。④ **纠正本文件 v3 的条目 I 说法**：`adjustDraft/commitAdjust` 与 `requestSlide/confirmSlide` 实测是**两套独立状态机、职责互斥**（`requestSlide()` 对 task-complete/recovery 直接返回 null），**不是**「同一状态机的不同视角」。⑤ **核实中发现的新不一致项**（已全部写入 STRUCTURE_MAP §5.4）：面板 tab 系统已拆除但 `.panel-tabs`/`.tab-page` CSS 残留（`.tab-page` 只剩 1 个孤立 div，active 恒真）；`.rec-grid`/`.rec-card`/`.hist`/`.report-nums`/`.spark` 共 7 组孤立 CSS 规则（恢复项已改径向 `.rp-chip`、周报已改 `rm-*`）；`preload.recoveryTake` 已 `@deprecated` 且**主进程恒返回 null**（调用静默无操作，旧存根正是照它写的）；`drawPulseAura` 配色表用 `Record<string,string>` **逃逸类型检查**；`panel-title` 为 CSS/JS 双零命中的未样式化 id。⑥ **交叉引用机械化校验**：修掉 5 处悬空引用（`§3.2.2`/`§3.2.3` 实为 DESIGN §3.2 的第 2/3 条列表项，已改为可达形式），两份文档 §x.y 引用现 **0 悬空**。⑦ **DOM id 全量交叉验证**：HTML 72 个 id ↔ app.ts `$()` 强引用 69 个，**0 缺失**（无启动即抛 `missing #id` 风险）。⑧ **src 未改动**（T0 只动 .md）；11:3x 复测行数/锚点/测试数与文档记录**完全一致**（pet.ts 1081 / app.ts 1265 / coordinator 653 / main 693 / src 6572 / 106 pass） |
| 2026-10-22 | **v5**（11:49）— **🔴 R10/R11 红线措辞修订（用户批准）**。① **用户裁决**：批准把 R11 改为「跌倒态是纯喜剧彩蛋，**永不**由任何用户行为序列触发（手势、连点、拖动、拒绝计数均不可）；"累瘫"的正当表达载体是 base 低精力档，不是惩罚态」。**消除的悬空许可**：原措辞「`injure()` 仅可由领域事件触发」把领域事件确立为合法路径，而 T12 裁决恰恰**原则性否决**了这条路径（影子计数器=暗中监视 / RSD 流失引信）⇒ 它在邀请实现者去做已被否决的事。② **DESIGN.md 升 v1.4**：§10 表 R10/R11 两行重写（R10「永不触发受伤」→「永不触发跌倒态」，术语统一）；§5.4 末登记段从「🔴 待用户确认」改为「✅ 已修订」并附批准时间与新措辞全文；文件头升版 + 配套文档行更新为 L1+L2 双层结构；§12 追加 v1.4 行。③ **保留原 R11 的六项有效约束**（无血/无泪/无控诉文案/8s 自愈/不落库/不改精力）——它们描述跌倒态的**喜剧属性与账本隔离**，与「谁能触发它」是两个独立维度，裁决只否决后者，故未随措辞替换而丢失。④ 🔴 **落点列刻意不写 `pratfall()`**：核实发现该符号在 src 中**尚不存在**（`grep -rn pratfall src/` = **0**），当前真实符号是 `injure()`（`pet.ts:262`，无调用方）+ `drawBandage()`（`:834`）。红线落点必须可 grep 核对才可执行，故写为「现 `injure()`，T12 改名 `pratfall()`」——避免用一个未存在的符号替换另一个悬空引用。⑤ **术语统一 + 新增术语锚点**：§5.4 加锚点说明「跌倒态 = 源码 `injure()` / `private injury` 相位机 / `drawBandage()` = 旧文档称的受伤态 = T12 计划的 `pratfall()`，四者同一事物」；当前生效条款（§4 R3 说明 / §5.3 第4条 / §5.4 视觉语言与技术保障 / §7 现状 / §11 M2 行）统一改「跌倒态」；**历史论证与变更日志保留原词**（矛盾B 论证、三条否决理由中「连续拒绝 N 次 → 受伤态」是被否决方案的名称、v1.0–v1.3 日志，均不可篡改）。⑥ **同步 L1/L2**：STRUCTURE_MAP §4 不变式 17 改写（并注明 `pratfall()` 尚不存在）、§5 摘要 §5.1 条补「红线措辞已 v1.4 修订，剩源码注释未跟进」；`docs/structure/known-issues.md` §5.1 的 `pet.ts:238` 行同步；`docs/structure/renderer-pet.md` 的 `injure()` 注记补 v1.4 修订说明。⑦ 🐛 **修掉上轮 v4 编辑的残留**：上轮恢复被截断的 v3 行时，v4 行尾**残留了 v3 的后半段**（行字节 2440→修正后 1670 字符；`grep -oE` 只核对了首尾关键词，未发现中段拼接）。本轮用 Python 按唯一锚点精确截断，并验证 v3 行字节数未变（1626）。**教训**：超长 markdown 表格行的完整性检查不能只看首尾，要比对 `length($0)` 与预期，或用 pipe 计数（表格行应为 4）。⑧ **src 仍零改动**：`injure()` 与 `pet.ts:238` 旧注释待 **T12** 实现时随改名一并清除；11:4x 复测 **106/106 pass**，src 6572 行 / 18 文件不变 |
