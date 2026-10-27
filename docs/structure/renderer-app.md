# `src/renderer/app.ts` — 渲染进程主控

> 模块存根（原 STRUCTURE_MAP §3.17）· 层级 **L4** · 测试：—（--selfcheck 截图验收）
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
```ts
/**
 * 职责边界：串联 PetRenderer / 滑动确认 / 面板 / 推荐卡 / hitTest。
 * 数据流：主进程 pushState(AppState) → 本模块 diff 渲染。
 * 写操作全部经 window.pet.* IPC → Coordinator → DecisionLog。
 * 模块无导出（export {}），以 IIFE 形式由 esbuild 打包。
 */

declare global {
  interface Window { pet: import('../preload/index.js').PetApi }
}

/* ── 错误黑匣子：window 'error' / 'unhandledrejection' → pet.reportError → 主进程 crash.log ── */

/* ── DOM 引用（$ / $<T> 帮助函数：找不到元素直接抛 Error(`missing #${id}`)）──
   ✅ **已机械化交叉验证**：app.ts 引用的 id 在 index.html **全部存在**（0 缺失，无启动即崩风险）。
   HTML 侧实测 72 个 id（全量分组表见本节末）。差集 3 个未被 `$()` 强引用：
   `dock`（CSS 6 处选择器）· `stage`（CSS 2 处）· `panel-title`（CSS/JS 双 0 命中）→ 判定见 §5.4④

   宠物/HUD：pet-wrap / pet-canvas / energy-hud / hud-num / **hud-cells** / **hud-bar-track**
             / hud-tier / hud-weather / hud-slider / hud-adjust-badge / hud-adjust-count
   滑动卡②：slide-card / s-title / s-sub / s-value / s-delta / s-predicted / s-predicted-row
             / s-base-mark / s-slider / s-min / s-mid / s-max / s-note / s-confirm / s-cancel
   调节窗口①：adjust-card / a-sub / a-current / a-default / a-default-mark / a-slider / a-delta
             / a-note / a-confirm / a-cancel
   时长卡：duration-card / d-sub / d-est / d-minutes / d-confirm / d-cancel
   径向菜单：recovery-pop / rp-ring / version-slot
   周报模态：report-modal / rm-close / rm-ack / rm-note / rm-range / rm-list
             / rm-ai / rm-ai-sec / rm-dec / rm-dec-sec
   面板/任务：panel / panel-sub / panel-close / task-list / task-title / task-cost
             / task-minutes / task-add-btn
   dock/全局：dock / dock-panel / dock-recovery / dock-weather / dock-quit / rec-stack / toast
   ❌ 旧存根此处列的 `hud-bar` · `rec-grid` · `report-nums` · `report-spark` · `report-narrative`
      **全部不存在**，勿再引用（详见本节末「已剔除」注记与 §5.4）   */

/* ── HUD 双通道（🔴 R2/R3 的渲染侧落点）── */
const hudNum = $('hud-num');        // 数字读数 energy.toFixed(1)
const hudCells = $('hud-cells');    // 10 格离散条
const hudTier = $('hud-tier');      // 档位文字 label
const hudWeather = $('hud-weather');
const HUD_CELL_COUNT = ENERGY_MAX;  // = 10
function initHudCells(): void;      // ⟨建 10 个 .hud-cell，boot 时调用一次⟩
function renderHudCells(v: number): void;  // ⟨按 v 点亮对应格数⟩
// 🔴 **T11 排练模式的关键冲突点**：hud-num / hud-tier 在 **6 处**直写真实精力
//    （实测 `hudNum.textContent` 命中 app.ts **578 / 611 / 639 / 686 / 1179 / 1212**，
//     `hudTier.textContent` 命中 580 / 613 / 641 / 688 / 1184）。
//    ⚠️ 早期笔记记为"4 处"，v1.3 实测为 6 处 —— **改前先重新 grep**。
//    T11 验收要求「答题时屏幕任何位置不出现真实精力值」⇒ 6 处全部必须抑制，
//    只留 10 格（且改造成答题选择器）。**R3 禁止隐藏 10 格本身**。

/* ── 模块级状态（实测 app.ts:149-171）── */
let pet: PetRenderer;
let state: AppState | null = null;
let slide: PendingSlide | null = null;
let previewDebounce: ReturnType<typeof setTimeout> | null;
let shownRecIds = new Set<string>();        // 已建卡的推荐 id，用于增量建卡/删卡
let shownReportDate: string | null = null;  // 🆕 当前显示的周报弹窗日期（YYYY-MM-DD）；
                                            //    null = 未显示。用于检测主进程推送的新弹窗
let lastRecoverySig = '';                   // 🆕 表情菜单内容签名：未变则跳过重建 chip
                                            //    （避免每次 applyState 重放弹出动画）
let hudVisible = false;
/* ① 事件后调节窗口的渲染侧镜像（🆕 旧存根完全遗漏）*/
let adjustWin: AdjustWindow | null = null;  // 主进程 AdjustWindow 的本地镜像；
                                            // null = 无窗口（HUD 滑块只预览，R8）
let adjustCountdown: ReturnType<typeof setInterval> | null;  // remainingMs 每秒递减，
                                            // 到 0 切 confirming 视图（R9）
let durationReq: TaskDurationRequest | null; // 待确认时长的任务（流程第一步）
let hudPreviewing = false;   // HUD 滑块「平时拖动」的预览态：松手回弹到滑动前的值
let hudRestEnergy = 0;       // 滑动前记录的真实精力（回弹目标）
// ❌ 旧存根列的 `activeTab`（初值 'recovery'）与 `reportCache: WeeklyReport | null` **均不存在**
//    （grep 0 命中）：周报改推模型后无需本地缓存，见 applyReportModal()

/* ── 工具 ── */
function toast(msg: string, ms?: number): void;   // 默认 2200ms
function fmtDelta(v: number): string;             // ⟨0.5 步长取整，正数加 '+' 前缀⟩
const WEATHER_ICON: Record<string, string>;       // sunny☀️ cloudy☁️ rain🌧️ thunderstorm⛈️
function escapeHtml(s: string): string;           // ⟨& < > " ' 五字符转义，防注入⟩

/* ── 命中区上报（click-through 渲染侧核心）── */
type HotRect = { x: number; y: number; w: number; h: number };   // 本地定义，未 import core/hittest
function collectHotRects(): HotRect[];
// ⟨唯一命中来源。收集顺序：宠物主体(petBounds 而非整个 canvas) → #dock/#panel/#slide-card
//   → #rec-stack 的实际子卡片（跳过空容器，避免整块区域不可穿透）；按 x,y,w,h 去重。
//   内部两个判定函数：
//     explicitHidden(el) —— slide-card 无 .show / panel 无 .open / 含 .leaving 视为隐藏
//       （关闭动画期 computed opacity 仍 >0，但命中区必须立刻回收，否则残留挡桌面）
//     hittable(el) —— display/visibility/opacity 查祖先链；pointer-events 只查元素自身
//       （子元素可用 auto 覆盖祖先 none，#stage 正是 none + [data-interactive]{auto}）⟩
function setupHitTest(): void;
// ⟨ResizeObserver + MutationObserver(class/style 属性过滤) → 200ms 节流上报；
//   setInterval 1500ms 兜底校对（CSS 过渡完成后尺寸可能有偏差）；
//   mousemove 只做「变化检测」：dock 悬停态翻转时排两次上报（进入立即 + 450ms 后复核）；
//   另一路 mousemove 控制 HUD 悬停显隐（elementFromPoint 判 #pet-wrap）；
//   调试钩子 window.__hotRects 供 --selfcheck 读取；
//   末尾立即 report() 保证首帧即可交互⟩

/* ── 宠物拖拽 ── */
function setupDrag(): void;
// ⟨pet-wrap mousedown(**仅 button 0**) → 命中校验（只有落在 petBounds() 实际主体内才启动）
//   → dragStart；window mousemove → dragMove；mouseup → endDrag(treatAsClick)。
//   **moved=false 时视为点击：pet.poke()** —— 压平 + 4 粒子；连点满 3 次/2500ms → 呼噜。
//   🔴 R10：此处**永不触发跌倒**（源码注释明写"甩墙只能由 pet.pratfall() 显式调用，当前无调用方"）。
//   ⚠️ 点击路径**不调 emotionSummary**（旧存根写"poke() + emotionSummary 气泡"已过期，
//      气泡系统 R1 已删；emotionSummary 现仅供托盘 tooltip）⟩

/* ── 滑动确认卡 ── */
function showSlide(s: PendingSlide): void;
// ⟨manual-adjust 为纯预览：隐藏 confirm 按钮/备注框/事件默认行，取消文案改「关闭 · 恢复原状」；
//   morning-baseline：predicted 行改显 baseEnergy，标签改「昨日收尾」，卡片加 .morning；
//   滑块 min/max 来自 s，step=0.5，默认值 = clampSlider(baseEnergy + predicted)；
//   出现时收起面板并 setMode('pet')，避免 panel 强制交互态残留⟩
function positionBaseMark(s: PendingSlide): void;
// ⟨在滑轨标记「事件前真实精力」位置；trackPad=13（拇指半径），
//   left = calc(13px + pct * (100% - 26px))⟩
function clampSlider(v: number): number;      // ⟨钳制到 slide.[min,max] 并按 0.5 取整⟩
function updateSlideVisual(target: number): void;
// ⟨大数字显示目标精力，小字显示 Δ（0.5 步长）；pos/neg/zero 三态着色；
//   pet.setPreview(target) 本地即时反馈 + 80ms 节流走 slidePreview IPC⟩
function hideSlide(): void;
// ⟨移除 .show；恢复 state.emotion；面板未开则兜底 setMode('pet')；
//   manual 预览结束时 **toast**「还是 X 分，没变～」
//   ⚠️ 旧存根写"气泡提示"——R1 已删气泡系统，所有提示统一走 DOM `toast()`⟩
function setupSlide(): void;
// ⟨slider input → updateSlideVisual；confirm → slideConfirm(target, note) 后
//   delta>0 → pet.celebrate()，并 toast(`精力 → X（±Δ）`)；cancel → slideCancel；
//   备注框 Enter 确认 / Escape 取消⟩

/* ── 面板 ── */
function setupPanel(): void;
// ⟨**实测 app.ts:811-855**⟩
// open():  加 .open + closeRecoveryPop() + setMode('panel') + hud 移除 .show
//          + scheduleHotReport() + **setTimeout(reportHotRects, 320)**
//          ← .28s opacity 过渡结束后复核命中区（panel 模式 600ms 宽限期兜住过渡期）
// close(): 移除 .open + setMode('pet') + **同步立即 reportHotRects()**
//          ← ⚠️ 不走 200ms 节流，否则光标停在旧面板区时主进程轮询仍命中过期 rect，
//            表现为「面板关了那块还挡鼠标」（已踩坑）
// 任务添加 addTask(): title 空则 return；cost 钳 [0,5]、minutes 钳 [0,1440]；
//          taskCreate 后清空输入 + toast('任务已添加')；Enter 亦可提交
// 绑定：dock-panel（开合切换）· panel-close · task-add-btn ·
//       dock-recovery（径向表情菜单 openRecoveryPop/closeRecoveryPop 切换）·
//       dock-weather · dock-quit
//   ⚠️ **dock-weather 实测为纯静默刷新**：只调 weatherRefresh() 更新 HUD 图标，
//      **不弹 toast 也不弹气泡**（需求 4）——旧存根写"刷新 + toast 来源"已过期
//   ❌ **旧存根的 `dock-adjust` 与 `dock-say` 均不存在**
//      （`grep -c "dock-adjust\|dock-say" src/` = **0**）：
//      manual-adjust 预览卡不走 dock 按钮；"说句话"按钮随 R1 气泡系统一并废除
//   ❌ **旧存根的"report 页则 loadReport"不成立**：open() 里无任何周报拉取调用，
//      周报是**推模型**（主进程 checkReportDue → state.reportModal → applyReportModal），
//      面板打开与之无关（详见 §3.17 applyReportModal 条）
//   ❌ **旧存根的"tab 切换按 data-tab / data-page 联动 active 类"已随 tab 系统拆除**：
//      `grep -n "data-tab\|data-page\|classList.*active" src/renderer/app.ts` = **0 命中**。
//      🔴 但残留死代码未清（见 §5.4）：`styles.css:259/263` 的 `.panel-tabs button.active`
//      选择器所指的 `.panel-tabs` 容器在 index.html **0 命中**；`.tab-page` 只剩
//      `index.html:116` 一个孤立包装 div（无兄弟页、无切换逻辑，active 类恒真）

/* ── 恢复项 / 任务 / 周报 / 推荐卡渲染 ── */
function renderRecoveries(items: RecoveryItem[]): void;
// ⟨**实测 app.ts:866-907 —— 旧存根全错，已重写**⟩
// 渲染目标是**径向表情菜单** `rpRing`(#rp-ring) 里的 `.rp-chip`，**不是** `rec-grid`（该 id 不存在）
// ① **内容签名守卫**：sig = items.map(id:icon:name:currentDelta:minutes).join('|')；
//    `sig === lastRecoverySig && rpRing.childElementCount === items.length` → 直接 return。
//    🔴 不变式：没有这道守卫，每次 applyState（精力/天气/任务任意变动都推送）都会重放
//       径向弹出动画，表现为「菜单一直闪」（已踩坑）
// ② 扇形布局：SPAN=150°（±75°），`ang = -SPAN/2 + SPAN/(n-1)*idx`，n===1 时 ang=0；
//    写入 CSS 变量 `--ang`。弹出顺序 `--i = round(|idx-(n-1)/2| * 2)` → **中间先出向两侧扩散**
// ③ chip.innerHTML：`.ico`(图标) + `.nm`(escapeHtml 名称) + `.dt`(fmtDelta(currentDelta))；
//    title 提示「名称 · 约 N 分钟 · 长按查看默认值历史」
// ④ 点击 → closeRecoveryPop() + **`recoveryStartAdjust(item.id)`**（进事件后调节窗口①，
//    7s 微调 → 确认弹窗）；返回 null 则 toast('已有调节进行中，请先处理')
//    ❌ 旧存根写 `recoveryTake(item.id)`：该 IPC **已 @deprecated**（preload:83 注明
//       "主进程恒返回 null"），调它等于静默无操作（见 §5.4）
// ⑤ 长按 500ms → showVersions(item)；mouseup/mouseleave 清 pressTimer⟩
function showVersions(item: RecoveryItem): Promise<void>;
// ⟨版本历史弹层 `.version-pop` 挂进 `versionSlot`(#version-slot)；
//   recoveryVersions(item.id) 取历史，最多 8 条 `.vrow`（reason · M/D + fmtDelta），
//   空则显示「暂无调整记录」；**6s 后自动 pop.remove()**⟩
function renderTasks(): void;
// ⟨open 按 createdAt 倒序 + 最近 6 条已完成；超时任务加 .overdue 与「超时」标签；
//   open 项附「完成」「放弃」按钮；空态提示文案；
//   「完成」→ taskDurationRequest 弹 #duration-card 先问实际用时（再进 7s 调节窗口）；
//   「放弃」→ taskDrop + toast('已放弃')⟩
function fmtDate(ms: number): string;   // :977 ⟨周报日期格式化⟩
function applyReportModal(p: WeeklyReportPayload | null): void;
// :983 ⟨**周报渲染的真实入口**（由 applyState 按 state.reportModal diff 调用）。
//   p=null → 关闭；否则填 rm-range/rm-list/rm-ai(+rm-ai-sec)/rm-dec(+rm-dec-sec)/rm-note，
//   并 🔴 R12：`$('rm-close').style.display = p.requireAck ? 'none' : ''`
//   —— 周五 requireAck 时**隐藏关闭按钮**，只能点 #rm-ack「已确认」⟩
function positionQuill(): void;   // :1063 ⟨金尖羽毛笔钉在卷轴末行的定位⟩
// ❌ **旧存根的 `loadReport()` / `renderReport()` / `reportCache` 变量全部不存在**
//    （`grep -n "loadReport\|renderReport\|reportCache" src/renderer/app.ts` = **0 命中**）。
//    周报不再是"面板里点刷新 → 拉数据 → 渲染"的拉模型，而是**主进程 17:30 推送**
//    `state.reportModal` → `applyReportModal()` 的推模型。因此也**没有 report-refresh 按钮**。

function renderRecommendations(recs: InsightRecommendation[]): void;
// :1110 ⟨增量：消失的卡片加 .leaving 后 300ms 移除；新增才建卡（shownRecIds 去重）；
//   卡内 range 滑杆 min=-2 max=5 step=0.5 供「按此调整」；
//   三按钮 data-act=rejected/modified/accepted → recommendationResolve，
//     成功 toast（'已校准默认值' / '已按你的值校准' / '好的，先不动'）
//     且 act!=='rejected' → pet.celebrate()；
//   同屏最多 2 张，超出移除最旧。
//   ❌ 旧存根"建卡时气泡「我发现了一个规律…」"**已删除**（该字符串全项目 0 命中，R1）⟩

/* ── ① 事件后调节窗口的渲染侧（旧存根完全遗漏，实测 app.ts:621-731）── */
function stopCountdown(): void;                 // :621
function enterAdjusting(w: AdjustWindow): void;  // :626 ⟨7s 静置倒计时 UI（#hud-adjust-count）⟩
function enterConfirming(w: AdjustWindow): void; // :652 ⟨🔴 R9：到点只切相位，等用户表态⟩
function positionDefaultMark(w: AdjustWindow): void;  // :670 ⟨滑轨标记事件默认值位置⟩
function exitAdjust(): void;                    // :676

/* ── 时长卡 / 径向表情菜单（旧存根遗漏，实测 :733-809）── */
function showDurationCard(req: TaskDurationRequest): void;  // :733
function hideDurationCard(): void;                          // :746
function syncRingCenter(): void;      // :775 ⟨径向菜单环心对齐宠物本体⟩
function openRecoveryPop(): void;     // :784 ⟨#recovery-pop 上半环 ±75°⟩
function closeRecoveryPop(): void;    // :796

/* ── 命中区上报的调度层（旧存根遗漏）── */
function reportHotRects(): void;      // :317
function scheduleHotReport(): void;   // :328 ⟨200ms 节流⟩

/* ── 主状态渲染 ── */
function applyState(s: AppState): void;
// ⟨① 无滑动卡时 pet.applyEmotion(s.emotion)（有卡则不打断预览）
//   ② HUD：hud-num 数值 / hud-cells **10 格** / hud-bar 进度条 / hud-tier 档位 label /
//      hud-weather 图标 / 面板副标题（⚠️ 数字与档位文字共 6 处写入，见本节上方 T11 警示）
//   ③ 滑动卡 diff：refId|kind|createdAt 任一变化才 showSlide（createdAt 参与比对，
//      保证同一恢复项连续两次卡片也能正确刷新）；卡片消失且本地有 slide → hideSlide
//   ③b adjustWindow diff → 调节窗口的进度条/徽章（#hud-adjust-badge / #hud-adjust-count）
//   ④ renderRecoveries / renderTasks / renderRecommendations
//   ⑤ 晨间基线：**卡片本身就是问候，不再叠加文字提示**（源码 :1228 注释）
//   ⑥ 精力跨过 `LOW_ENERGY_TOAST_AT`(3) 向下（常量在 app.ts 本地定义，与已废除的 pulse 门槛无关） → **toast** 3200ms
//      `电量低于 3 分了，要不要休息一下？`（源码 :1230 注释明写"仅 toast，不弹文字气泡"）
//      ❌ 旧存根的"问候气泡 5s"/"低电量气泡 4.2s"时长均已不存在⟩

/* ── 启动 ── */
function boot(): void;
// ⟨实测 app.ts:1242，顺序不可换：
//   new PetRenderer({canvas: petCanvas})
//   → setupHitTest() → setupDrag() → setupSlide() → **setupHudSlider()**
//   → **setupAdjustCard()** → **setupDurationCard()** → setupPanel() → **setupReportModal()**
//   → window.pet.onState(applyState) → getState() 首拉 → resize 监听 pet.resize()⟩
// ⚠️ `initHudCells()` **不在 boot() 内**，而是模块顶层立即执行（app.ts:85）
// document.readyState === 'loading' ? DOMContentLoaded 后 boot : 立即 boot

/* ── 旧存根遗漏的 setup 函数（v1.3 补全，实测行号）── */
function setupHudSlider(): void;      // :573 ⟨HUD 上的滑块：手动预览精力，窗口外不落库（R8）⟩
function setupAdjustCard(): void;     // :695 ⟨① 事件后 7s 调节窗口卡（#adjust-card）⟩
function setupDurationCard(): void;   // :753 ⟨任务完成第一步：先问实际用时（#duration-card）⟩
function setupReportModal(): void;    // :1095 ⟨周报模态（#report-modal）+ requireAck 时隐藏 #rm-close⟩

export {};
```

**渲染层依赖的 DOM id（`index.html` 提供，`app.ts` 通过 `$()` 强引用，缺失即抛 `Error('missing #id')`）**

实测 **72 个**（旧存根称 45 个，已严重过期）。以下为 `index.html` 全量实测清单，按子系统分组：

| 子系统 | id（实测） |
|:---|:---|
| 舞台/宠物 | `stage` `pet-wrap` `pet-canvas` |
| HUD（🔴 R2/R3） | `energy-hud` `hud-num` `hud-cells` `hud-bar-track` `hud-tier` `hud-weather` `hud-slider` `hud-adjust-badge` `hud-adjust-count` |
| 滑动卡②（晨间基线/手动预览） | `slide-card` `s-title` `s-sub` `s-value` `s-delta` `s-predicted-row` `s-predicted` `s-base-mark` `s-slider` `s-min` `s-mid` `s-max` `s-note` `s-confirm` `s-cancel` |
| 调节窗口①（事件后 7s） | `adjust-card` `a-sub` `a-current` `a-default` `a-default-mark` `a-slider` `a-delta` `a-note` `a-confirm` `a-cancel` |
| 时长卡（任务完成第一步） | `duration-card` `d-sub` `d-est` `d-minutes` `d-confirm` `d-cancel` |
| 径向表情菜单（恢复项） | `recovery-pop` `rp-ring` |
| 周报模态 | `report-modal` `rm-close` `rm-ack` `rm-note` `rm-range` `rm-list` `rm-ai` `rm-ai-sec` `rm-dec` `rm-dec-sec` |
| 面板 | `panel` `panel-title` `panel-sub` `panel-close` `version-slot` `task-list` `task-title` `task-cost` `task-minutes` `task-add-btn` |
| dock / 全局 | `dock` `dock-recovery` `dock-panel` `dock-weather` `dock-quit` · `rec-stack` `toast` |

> ❌ **旧存根列出但实测不存在**（`grep -qx` 逐个验证，全 0 命中）：
> `hud-bar`（已改名 `hud-bar-track`）· `dock-adjust` · `dock-say`（随 R1 气泡废除）·
> `report-nums` · `report-spark` · `report-narrative` · `report-refresh`
> （周报区已重构为 `rm-*` 前缀的一组 id）·
> 🔴 `rec-grid`（恢复项已从「面板网格」重构为**径向表情菜单** `recovery-pop`/`rp-ring` + `rp-chip`，
> 见 §5.4；`id="rec-grid"` 与 `class="rec-grid"` 在 index.html 均 0 命中）。
> ⚠️ 因此旧存根提到的 "`report-refresh` 绑定" 在 `boot()` 里**并不存在**。
