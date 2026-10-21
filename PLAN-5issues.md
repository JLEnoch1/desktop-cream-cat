# 桌宠 5 项功能修复与变更 · 实现计划

> 状态：**待确认**（确认后开工）
> 基线：`tsc --noEmit` 通过 · 50/50 测试全绿 · esbuild 三路打包成功
> 原则：所有改动不破坏既有功能；事件流唯一事实源、写入点唯一（commitAdjust）等 12 条设计不变式全部保留

---

## 0. 问题 2 根因已实证（探针复现，非猜测）

用 `--selfcheck` + 注入探针在真实 Electron 环境复现，关键数据：

```
hotRects（主进程实际持有的热区）= [
  {x:135, y:488, w:137, h:114},   ← 宠物本体 petBounds（y 488–602）
  {x:35,  y:104, w:330, h:308}    ← 晨间滑动卡
]
dock 几何位置 = {x:99, y:414, w:202, h:34}   ← y 414–448
dock 计算样式 opacity = "0"（初始与模拟悬停后均为 0）
合成 click 派发 → panelOpen=true, toast="刷新天气…"  ← JS 处理器与 IPC 链路完全正常
```

**根因链（双向死锁）**：

1. dock 显隐由 CSS `#stage:hover #dock {opacity:1}` 驱动，而 `#stage` 是 `pointer-events:none`，`:hover` 只能由 `pointer-events:auto` 的子元素（宠物 pet-wrap）触发。
2. 主进程 click-through 判定只认 `collectHotRects()` 上报的矩形：宠物热区 = **petBounds（y488–602）**，不是 pet-wrap 盒子（y384–614）。
3. dock（y414–448）与宠物热区（y488–602）之间存在 **y448–488 的穿透死区**：光标从宠物移向 dock 必经此带 → 主进程判定不在热区 → `setIgnoreMouseEvents(true)` → 渲染进程收不到 mousemove → `#stage:hover` 失效 → dock 淡出。
4. 反向同理：dock opacity=0 时被 `hittable()` 过滤、不进热区 → 光标从桌面直接接近 dock 位置 → 窗口穿透 → dock 永远不会显示。

结论：**「任务面板」「刷新天气」按钮的 JS 绑定和 IPC 都是好的，坏在光标物理上到不了它们**——热区与 CSS 显隐互相打架。这正好解释了用户看到的「点击无响应」。

**修复方案（二选一，待确认）**：

- **方案 A（推荐）：dock 常驻可见 + 常驻热区**。去掉 `#stage:hover` 门控，dock 始终 opacity:1，`collectHotRects` 始终收集。桌宠 dock 常驻是常见形态，彻底消除死锁，改动最小、最可靠。
- 方案 B：保留悬停显隐，但上报「桥接热区」——dock 可见时额外上报一个覆盖 dock 底缘到宠物本体顶缘（y448–488）的矩形，使热区连续。视觉更克制，但状态机复杂（显隐过渡期热区抖动），回归风险高于 A。

---

## 1. 改动矩阵（文件 × 需求）

| 文件 | 需求1 触碰 | 需求2 面板/恢复 | 需求3 精力条 | 需求4 天气 | 需求5 周报 |
|---|---|---|---|---|---|
| `src/renderer/pet.ts` | ●气泡移除/形变/压平/甩墙绷带 | | ○10格联动 | | |
| `src/renderer/app.ts` | ●say调用清理 | ●dock重排/恢复弹窗 | ●HUD重写/锁定 | ●toast移除 | ●tab移除/弹窗 |
| `src/renderer/index.html` | | ●dock/恢复面板结构 | ●HUD 10格结构 | | ●周报弹窗结构/删tab |
| `src/renderer/styles.css` | ●绷带/甩墙动画 | ●恢复弹窗样式 | ●10格样式/去hover | | ●铅笔手绘风 |
| `src/main/coordinator.ts` | | ●恢复项联动 | ●计时规则(拖动暂停) | | ●17:30定时器 |
| `src/main/index.ts` | | | | | ●IPC+推送 |
| `src/preload/index.ts` | | | | | ●桥接 |
| `src/core/types.ts` | | | ○ | | ●ReportModal类型 |
| `src/recovery/deck.ts` | | ●DEFAULT_ITEMS换6项 | | | |
| `src/task/center.ts` | | | ●默认+4 | | |
| `src/insight/engine.ts` | | | | | ●弹窗数据聚合 |
| `src/storage/sqlite.ts` | | | | | ●meta读写/决策历史查询 |
| `tests/*.test.ts` | | ○ | ○ | | ○ |

●=主要改动 ○=连带改动

---

## 2. 逐项计划

### 需求 1 · 触碰交互（纯渲染层，不落库、不影响精力）

**涉及文件**：`pet.ts`、`app.ts`

**改动点**：

1. **移除文字气泡系统**：删除 `PetRenderer.say()/drawBubble()/bubbleText/bubbleUntil/wrapText`；清理 `app.ts` 全部 9 处 `pet.say()` 调用（点击宠物、dock-say、滑动确认、调节窗口提示、推荐卡、晨间问候、低电量提示、hideSlide、enterAdjusting）。触碰宠物改为仅触发情绪表情变化（`poke()` → 表情反应）。
   - dock-say（💬）按钮随气泡系统一并移除（其唯一功能就是弹气泡）。
   - **toast 保留**（面板操作反馈如「任务已添加」，属面板 UI 而非宠物文字气泡）——待确认。
2. **拖拽黏性形变**：`setupDrag` 期间向 pet.ts 传入拖拽速度向量；身体按速度方向拉伸/挤压（scaleX/scaleY 偏移 + 顶部控制点滞后），松手后 spring 弹性回弹（lerp 系数调低模拟黏性）。
3. **单击压平**：`poke()` 改为压平动画（squishY 瞬时 →0.55，0.4s 回弹），保留少量粒子。
4. **连点甩墙 + 绷带受伤**：1.2s 内点击 ≥4 次触发——宠物飞向最近侧墙（窗口左/右缘），平铺贴墙（极致 squash + 旋转 90°），进入受伤态：绷带精灵（十字绷带 + 眩晕眼）持续 8s，期间免疫连点惩罚，到时弹性恢复原位。状态机纯本地（`injuredUntil`），不写事件流。

**风险**：甩墙动画坐标需限制在 canvas 内（窗口 400×620）；形变参数与现有呼吸/弹跳插值叠加需防抖动。
**验证**：`--selfcheck` 截图各状态；手动场景（单击/拖拽/连点）。

### 需求 2 · 任务面板按钮修复 + 精力恢复入口

**涉及文件**：`index.html`、`styles.css`、`app.ts`、`deck.ts`、`coordinator.ts`

**改动点**：

1. **修复点击无响应**：按 §0 方案 A/B 执行（待确认）。
2. **dock 重排**：`[⚡精力恢复] [🎛️任务面板] [🌤️刷新天气] [⏻退出]`。删除 dock-adjust（🎚️临时调节，需求 3）与 dock-say（💬，需求 1）。
3. **精力恢复弹窗**：点击 ⚡ 弹出 6 选项面板（新 `#recovery-pop`，纳入热区收集）：
   | 选项 | id | icon | 默认恢复 | 建议时长 |
   |---|---|---|---|---|
   | 午睡 | rec_nap | 😴 | +1.5 | 20min |
   | 冥想 | rec_meditate | 🧘 | +1.2 | 10min |
   | 下午茶 | rec_tea | 🍵 | +1.0 | 15min |
   | 发呆 | rec_zoneout | 😶 | +0.6 | 5min |
   | 打球 | rec_ball | 🏀 | +2.0 | 30min |
   | 健身 | rec_gym | 💪 | +2.5 | 45min |
   （默认值待确认；id 沿用 rec_nap 以最大兼容旧库/测试）
4. **选中即走现有调节窗口流程**：`recoveryStartAdjust(itemId)` → 草稿 = base + 默认值 → 7s 微调 → 确认落库（完全复用 commitAdjust 唯一写入点，predicted/actual 双记录继续为 AI 推荐供数）。
5. **面板「恢复」tab 移除**（功能迁至 dock），面板只剩「任务」——待确认。
6. `DEFAULT_ITEMS` 替换为新 6 项；`seedIfEmpty` 自动为新项写初始版本历史。旧库中 rec_water 等孤儿事件不影响 fold（按 actual_delta 计算），历史数据只读不改写。

**风险**：旧库用户的恢复项版本历史/推荐卡引用旧 itemId——读取侧需容错（推荐卡 itemId 找不到时跳过）。
**验证**：探针式 selfcheck 断言 dock 热区存在且 opacity=1；coordinator 测试更新 rec_nap 默认值断言；手动点击全链路。

### 需求 3 · 精力条（HUD 重做）

**涉及文件**：`index.html`、`styles.css`、`app.ts`、`coordinator.ts`、`task/center.ts`

**改动点**：

1. **删除「临时调节」按钮**（dock-adjust）。coordinator 的 `manual-adjust` 能力保留（晨间基线仍走 slide 状态机，测试依赖），仅删 UI 入口。
2. **任务完成默认恢复 +4**：`TaskCenter.requestComplete` 的 predicted 由 `clamp(-estCost,-5,2)` 改为 `+4`（语义反转：完成任务 = 成就感回血）。任务面板每行同步显示「完成 +4」。**estCost 字段与创建表单去留待确认**（建议保留为参考信息，不再驱动 predicted）。
3. **锁定规则重构**（coordinator）：
   - 调节窗口打开 → 可拖动；**拖动中（adjustDraft 调用时）暂停/重置倒计时**；
   - 停止拖动后 7s 无操作 → `expireAdjustWindow` → confirming（锁定）→ 弹确认窗确认最终恢复分值（现有流程）；
   - 防无限延长兜底：窗口总时长上限 60s，超时强制 confirming。
4. **HUD 10 格显示**：`#hud-bar` 由连续进度条改为 10 个格子（每格 1 分，量程 0–10 天然对应）；填充格数 = floor(energy)，当前格按小数部分比例填充。锁定态（常态 + confirming）纯只读 10 格；调节窗口期间格子可点选/拖动。
5. **触碰样式不变**：移除 `#energy-hud:hover` 的 thumb 放大/透明度变化等全部 hover 视觉反馈。

**风险**：计时规则反转（fix-report 明确「不随微调延长」，新需求要求「拖动暂停计时」）——coordinator 测试 `remainingMs=7000`、`draftEnergy` 等断言需更新；HUD 结构重写波及 applyState 的 5 处 DOM 同步。
**验证**：coordinator 单测新增「拖动暂停计时/60s 兜底」用例；selfcheck 截图 10 格形态；手动拖拽→静置 7s→锁定→确认全链路。

### 需求 4 · 天气实时化 + 移除气泡弹窗

**涉及文件**：`app.ts`、`sensor.ts`（可选）、`coordinator.ts`（可选）

**现状核实**：天气链路**本来就是实时的**——Open-Meteo API 已验证可达（curl 实测返回 34°C / weather_code=1），启动即刷新 + 30min 定时 + live/cache/fallback 三级降级。用户感知「不实时」的可能原因：① 坐标硬编码深圳（22.5431, 114.0579），非用户所在地；② 刷新后弹 toast 文字（需求要求移除）。

**改动点**：

1. **移除天气 toast**：dock-weather 点击后静默刷新，结果仅通过 HUD 天气图标 + 宠物头顶 overlay 精灵呈现（`weatherRefresh` IPC 保留，返回值不再弹 toast）。
2. **实时性增强（待确认是否需要）**：
   - 选项 a：保持深圳默认坐标（零风险）；
   - 选项 b：启动时 IP 定位（如 ip-api.com，免费无 key）获取用户城市坐标，失败回退深圳——让「实时」同时是「本地」。
3. 刷新间隔 30min 维持（TTL 内不重复请求，避免 API 滥用）。

**风险**：选项 b 引入新网络依赖，需走降级链（定位失败 = 现状）。
**验证**：断网启动 → fallback 图标；联网启动 → live 图标 + HUD 温度；点击刷新无 toast。

### 需求 5 · 周报改每日 17:30 弹窗

**涉及文件**：`types.ts`、`sqlite.ts`、`insight/engine.ts`、`coordinator.ts`、`index.ts`、`preload/index.ts`、`app.ts`、`index.html`、`styles.css`

**改动点**：

1. **取消随时查看入口**：移除面板「周报」tab、`report-refresh` 按钮、`renderReport/loadReport` 旧渲染路径（`insight:weeklyReport` IPC 保留供弹窗复用）。
2. **17:30 定时弹窗**（coordinator）：每分钟 tick 检查 `本地时间 ≥17:30 且今日未弹`（`meta` 表持久化 `last_report_date`，重启不重复弹）→ 组装弹窗数据 → `AppState.reportModal` 新字段推送渲染层。错过 17:30（如 18:00 开机）当日仍补弹一次。
3. **周五重点确认**：周五的弹窗带 `requireAck: true`——必须点「我已知悉」才关闭；周一至周四可点任意处/关闭按钮收起。周五内容追加整周汇总段（复用 weeklyReport 统计）。
4. **弹窗内容 = 铅笔手绘风清单**（新 `#report-modal`，纳入热区）：
   - **AI 推荐默认值**：pending recommendations（同一恢复项 ≥3 次 actual≠predicted 触发，现有 detectRecommendations 机制不变），每条带 接受/修改/拒绝（复用 recommendationResolve）；
   - **历史决策**：recommendation.accepted/modified/rejected 事件流（新增 `DecisionLog.resolvedRecommendations()` 查询），显示「何时·哪项·建议值→处置」；
   - **用户已确认的变更**：recovery_versions 中 reason 为「采纳 AI 推荐校准 / 用户修改后采纳」的条目（现有版本历史，新查询聚合）。
5. **手绘风实现**：纯 CSS（CSP 禁外链字体）——楷体（Kaiti SC/STKaiti，macOS 内置）+ 手绘感边框（不规则 border-radius + 虚线）+ 纸张底色 + 铅笔灰墨色；清单逐项 ✓ 勾选样式。

**风险**：`meta` 表已有但无通用读写 API（需加 `getMeta/setMeta`）；recommendations 表现有 `pendingRecommendations()` 只查 pending，历史决策需从事件流查（不改表结构）；弹窗与 slide/adjust 卡片同屏冲突——弹窗 z-index 最高且出现时收起其他卡片。
**验证**：注入假时钟单测（17:30 触发/当日不重复/周五 requireAck/错过补弹）；手动改系统时间或临时把触发时间调近验证 UI；selfcheck 截图手绘风弹窗。

---

## 3. 测试与回归验证

**自动化**（每完成一项跑一轮）：
```bash
npm run typecheck   # strict + noUnusedLocals
npm test            # 现有 50 用例（预计需更新 ~8 处断言）+ 新增用例
npm run build       # esbuild 三路打包
```

**预计需更新的现有断言**：rec_nap 默认值（draftEnergy 8.5→新值）、任务 predicted（-2.5→+4）、manual-adjust UI 相关（能力保留，测试不动）、新增：拖动暂停计时、60s 兜底、17:30 弹窗、10 格渲染。

**Electron 实证**（沿用本轮探针方法论）：
- `--selfcheck`：热区回读（dock 必须在列）+ 各状态截图（常态/拖拽形变/压平/甩墙绷带/10格/恢复弹窗/周报弹窗）
- `--selftest-click`：25 次 ignore 切换无 SIGABRT
- 隔离 userData（`--user-data-dir=/tmp/...`）跑探针，不污染用户真实 DB；**用户当前有一个实例在运行（pid 16703），验证时需注意单实例锁**

**手动回归清单**：
| # | 场景 | 预期 |
|---|---|---|
| 1 | 光标从桌面移向 dock 各按钮 | 全部可点，无穿透死区 |
| 2 | 点击宠物（单击/拖拽/1.2s内连点4次） | 压平 / 黏性形变回弹 / 甩墙平铺+绷带8s |
| 3 | 触碰宠物 | 无任何文字气泡，仅表情变化 |
| 4 | dock ⚡ → 选「午睡」→ 微调 → 确认 | recovery.taken 落库，predicted=默认值，actual=确认值 |
| 5 | 完成任务 → 确认时长 → 拖动中停顿 → 7s | 拖动时倒计时暂停，静置 7s 后锁定弹确认窗，默认草稿 = base+4 |
| 6 | 平时触碰精力条 | 10 格显示，hover 无样式变化，不可写 |
| 7 | 点击 🌤️ | 静默刷新，无 toast，HUD 图标更新 |
| 8 | 17:30（或补弹） | 手绘风周报弹窗；周五必须点「我已知悉」 |
| 9 | 旧库（含 rec_water 事件/推荐）启动 | 不崩，孤儿数据只读跳过 |
| 10 | 面板收起后点宠物周围透明区 | 点击穿透到桌面（热区不残留） |

---

## 4. 待确认决策点

| # | 问题 | 我的建议 |
|---|---|---|
| Q1 | dock 修复方案：A 常驻可见 / B 悬停+热区桥接？ | **A**（可靠、改动小） |
| Q2 | 「完成一个事件默认恢复 4 分」= 任务完成 predicted 由 -estCost 反转为 +4？estCost 创建表单是否保留？ | 是，反转 +4；estCost 保留为参考展示 |
| Q3 | 精力恢复 6 项的默认值/时长（§2 表格）是否认可？面板「恢复」tab 是否移除（功能迁 dock）？ | 认可表格；移除恢复 tab |
| Q4 | 天气「实时」是否需要 IP 定位到用户城市（选项 b），还是保持深圳默认（选项 a）？ | **b**（带降级，失败回退现状） |
| Q5 | 气泡移除范围：宠物头顶气泡全删；面板 toast（操作反馈）保留？ | 保留 toast |
| Q6 | 甩墙受伤时长 8s、连点阈值 1.2s 内 4 次，是否认可？ | 认可（可调参数集中定义） |

---

## 5. 实施顺序（确认后）

1. 需求 2（dock 修复 + 恢复入口）——先打通「点得到」，其余 UI 改动才有验证基础
2. 需求 1（触碰交互）——纯渲染层，独立
3. 需求 3（精力条 + 任务默认 +4 + 锁定规则）
4. 需求 4（天气）
5. 需求 5（周报弹窗）——体量最大，放最后
6. 全量回归：typecheck + 测试 + selfcheck 截图 + 手动清单

每步完成即跑 typecheck + 测试，小步提交，不堆积未验证代码。
