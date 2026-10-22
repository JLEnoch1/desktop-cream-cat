# `src/renderer/pet.ts` — Canvas 渲染器（1081 行）

> 模块存根（原 STRUCTURE_MAP §3.16）· 层级 **L3** · 测试：tests/pose.test.ts（10 例）
> 抽取：2026-10-22 v1.3 全量实测轮 · 约定：`⟨返回含义⟩` 为注释补充，非源码内容；其余签名与源码逐字一致。`private` 成员仅在影响理解职责边界时列出名称，省略实现。
> ⚠️ 多会话并行改动，行号/行数会失效，引用前以当前源码为准
> [地图入口](../../STRUCTURE_MAP.md) · [数据流](data-flows.md) · [问题清单](known-issues.md)

---
```ts
/**
 * 职责边界：三层图层合成，与 EmotionEngine 三层一一对应。
 *   body 层    base 情绪驱动主体（体型/配色/眼睛/嘴/呼吸/弹跳/眨眼/**耳朵/尾巴**）
 *   weather 层 独立精灵锚定头顶，不参与表情状态机（R5）
 *   pulse 层   低精力瞬时反应特效（光环/符号）
 * RAF 驱动 60fps；所有状态变化经 lerp 平滑插值，表情切换不生硬。
 *
 * 🔴 R1：宠物本体永不出现文字。**`say()` / `drawBubble()` / `bubbleText` / `bubbleUntil`
 *    已于 v1.1 全部删除**，不得复活（本文件首版存根曾列出它们，v1.3 已清除）。
 */

export interface PetRenderOptions {
  canvas: HTMLCanvasElement;
  dpr?: number;   // 默认 min(devicePixelRatio, 2)
}

interface RenderParams {   // 模块内私有：插值后的连续量
  energy: number; hue: number; sat: number;
  lum: number;     // 🆕 v1.2 明度基线（R7）：bodyGrad 三段与眼皮遮罩都参数化读它，
                   //    原硬编码 lightness 78/64/48 已废除
  breath: number;    // 呼吸周期 s
  bounce: number;    // 弹跳幅度 px
  blink: number;     // 眨眼间隔 s
  eyeOpen: number;   // 0–1 眼睛开合
  mouthCurve: number; // -1 哭 … +1 大笑
  squish: number;    // 疲惫时身体压扁程度
  tremble: number;   // 颤抖强度
}

const EMOTION_PARAMS: Record<BaseEmotion, {
  mouthCurve: number; eyeOpen: number; squish: number; tremble: number;
}>;   // 10 档 base → 嘴型/眼开合/压扁/颤抖

const PULSE_PARAMS: Record<PulseReaction, Partial<{
  mouthCurve: number; tremble: number; eyeOpen: number;
}>>;  // ⚠️ **当前仍是覆盖语义**（buildParams 内三处 `PULSE_PARAMS[..] ?? EMOTION_PARAMS[..]`），
      //    pulse 会**抹掉** base 的档位差异。M2/T4 将改为 `PULSE_OFFSETS` + `pulseModulation(tier)`
      //    加权叠加（DESIGN.md §4.3 矛盾 C）。⚠️ Q1：modulation 应在低精力区**内部**细分，
      //    不跨全量程递减，否则 pulse 在 low 档趋近 0 = 功能被关掉。勿自改 PULSE_THRESHOLD=3。

/* ── 🆕 v1.2 姿态解算：导出的纯函数（pet.ts 里少数可单测的边界，见 tests/pose.test.ts） ── */

export interface TailPose {
  lift: number;    // -0.6 垂到地面(burnt) … 1.1 高高竖起(blissful)
  amp: number;     // 摆动幅度（弧度）
  speed: number;   // 摆动角速度（rad/s）
  len: number;     // 长度系数（×bodyR）
}

/** 尾巴姿态解算（DESIGN.md §3.2 不变式 1/2/3）。
 *  只读 RenderParams 已有的连续量（energy/mouthCurve/tremble），不引入新状态、**无随机数**。
 *  语义：精力高→竖起欢快摆；精力低→垂落几乎不动；愉悦叠一层抬升与摆幅；
 *       颤抖→小幅高频「抖」，与开心的大幅「摇」区分。
 *  实测 lift = -0.45 + e*1.45 + max(0,joy)*0.28 - tremble*0.22，钳制 [-0.6, 1.1]；
 *  len = 1.28 + e*0.22 */
export function resolveTailPose(p: { energy: number; mouthCurve: number; tremble: number }): TailPose;

/** 耳朵姿态解算，返回 [-1,1]：+1 前倾(警觉/开心) / 0 自然 / -1 飞机耳(疲惫·害怕·低落)。
 *  🔴 已踩坑（DESIGN.md §3.2 第 2 条）：抚摸时 loop() 会压低 eyeOpen（舒服到眯眼），若无条件把"眼皮低"
 *     读作疲惫，mouthCurve≈1 的开心猫会被压成飞机耳 ⇒ droop 项按 `(1 - max(0,joy))` 门控。
 *     **多通道读同一输入时方向必须一致**。 */
export function resolveEarPose(p: { mouthCurve: number; tremble: number; eyeOpen: number }): number;

/* ── 触碰交互常量（纯渲染层，不落库、不写事件流） ── */
const PETTING_WINDOW_MS = 2500;   // 连点判定窗口
const PETTING_CLICKS   = 3;       // 满 3 次 → 呼噜（DESIGN.md [问题清单 §5.3](known-issues.md) v1.1 裁决）
const PETTING_BOOST_MS = 2000;    // 呼噜加成时长，线性衰减
const INJURY_FLY_MS = 350; const INJURY_HOLD_MS = 8000; const INJURY_RETURN_MS = 500;
// 🔴 旧常量 RAPID_CLICK_WINDOW_MS / RAPID_CLICK_COUNT（连点→甩墙）**已删除**，禁止复活（R10）。

export class PetRenderer {
  constructor(opts: PetRenderOptions);
    // ⟨取 2d context，失败抛 Error('PetRenderer: 2d context unavailable')；
    //   初始 target/current = buildParams(10, 'steady', 'none', false)；resize() 后立即 loop()⟩

  /* ── 对外 API ── */
  applyEmotion(state: EmotionState): void;
    // ⟨主路径：AppState 推送时调用，设置 target 与 overlay/pulse/pulseActive⟩
  setPreview(energy: number): void;
    // ⟨滑块预览：按投影精力实时驱动表情；pulseActive = energy < PULSE_THRESHOLD，
    //   未激活时 pulse 传 'none'⟩
  clearPreview(state: EmotionState): void;      // ⟨等价于 applyEmotion(state)⟩
  applyOverlay(overlay: WeatherOverlay): void;

  poke(): void;
    // ⟨点击戳一下：挤压反馈 + **4 颗**粒子（首版存根写 6 颗，实测 4）。
    //   **连点 → 呼噜**（R10 唯一合法反馈路径）：push 到 clickTimes，
    //   过滤出 PETTING_WINDOW_MS 内的点击，满 PETTING_CLICKS 次则清空并设
    //   pettingUntil = now + PETTING_BOOST_MS，额外 10 颗 hue=38 暖金粒子。
    //   呼噜表现：嘴型 +0.6、眯眼（下限 0.25，"醒着且享受"）、低幅 purr 震颤
    //   （与焦虑 tremble 取 max 而非覆盖）、2s 线性衰减。**不落库**。⟩
  injure(): void;
    // 🔴 **2026-10-22 裁决：删除并从领域层除名**（DESIGN.md §5.4 / TASKS.md T12）。
    //   当前实现：三段相位机 fly(350ms) → hold(8000ms) → return(500ms)，X 眼 + 绷带 +
    //   旋转 90° 贴墙 + 弹性复位；触发时打断呼噜并清空 clickTimes。
    //   **无任何调用方**（`grep -rn 'injure()' src/` 仅定义处与注释）。
    //   裁决处置（T12 待实现）：本方法删除，甩墙降级为 renderer 层 `pratfall()` 纯喜剧彩蛋，
    //   **永不**由任何用户行为序列触发；"累瘫"改由 base 低档表达。
    //   ⚠️ `pratfall()` 尚不存在（`grep -rn pratfall src/` = 0），是 T12 的计划改名。
    //   ⚠️ 源码注释仍写"未来若要接线，触发源必须是领域事件"——该预留已被裁决否决，
    //   属**悬空许可**，登记于 [问题清单 §5.1](known-issues.md)（T0/v1.4 只改 .md，不动源码）。
    //   📌 DESIGN.md 红线 R10/R11 措辞已于 **v1.4** 修订（用户 11:49 批准）："仅可由领域事件
    //   触发"的悬空许可已从契约消除，R11 现为"跌倒态永不由任何用户行为序列触发"。
  dragStart(): void; dragMoveBy(dx: number, dy: number): void; dragEnd(): void;
    // ⟨黏性形变（dragStretch / dragVel）。🔴 R10：拖动路径**不 push clickTimes**，
    //   与 poke() 是两条独立入口，拖动永不计入连点。⟩
  celebrate(): void;                            // ⟨庆祝：18 颗 hue=48 粒子⟩
  resize(): void;                               // ⟨按 CSS 尺寸 × dpr 重设画布像素⟩
  petBounds(): { x: number; y: number; w: number; h: number };
    // ⟨宠物主体实际可视包围盒（canvas CSS 坐标）。🆕 v1.2 已纳入**尾巴与耳朵**几何：
    //   - 尾梢坐标 this.tailTip（每帧 render 末尾按 injRot/scale 换算后写入）
    //   - 耳尖上界从 -1.42R 扩到 **-1.8R**
    //   实测宽度 137 → 182。🔴 这是命中区正确性的关键（看得见的部位必须点得到），
    //   [core-hittest.md](core-hittest.md) 的 collectHotRects 依赖它 ⇒ **改尾巴/耳朵几何必须同步复核此处**。
    //   为何不用整个 canvas 盒子：canvas 占满 pet-wrap，本体只在底部中央一小块，
    //   直接上报会造成「画布比可点击范围大」的错位观感⟩
  destroy(): void;                              // ⟨cancelAnimationFrame⟩

  /* ── 私有 ── */
  private canvas / ctx / dpr / raf / startTime;
  private lastBlink / blinking / blinkProgress;
  private target: RenderParams;    // 目标参数（由情绪状态决定）
  private current: RenderParams;   // 当前参数（向 target 平滑插值）
  private overlay: WeatherOverlay; private pulse: PulseReaction; private pulseActive: boolean;
  private pokeTime: number;
  private dragVel / dragStretch; private draggingNow: boolean; private lastDragMove: number;
  private clickTimes: number[];    // 🆕 连点计数（PETTING_WINDOW_MS 内的时间戳）
  private tailTip = { x: 0, y: 0 };// 🆕 尾梢画布坐标，petBounds() 用它把尾巴纳入命中区
  private pettingUntil = 0;        // 🆕 呼噜加成到期时刻（performance.now 基准）；0 = 无加成
  private injury: { phase: 'fly'|'hold'|'return'; start: number; dir: 1|-1 } | null;
  private particles: { x,y,vx,vy,life,maxLife,hue,size }[];
  // ❌ 已删除：bubbleText / bubbleUntil（R1 气泡系统）

  private buildParams(energy, base, pulse, pulseActive): RenderParams;
    // ⟨BASE_TIERS 按 emotion 查档（未命中回退 tierFor(energy)）；
    //   eyeOpen/mouthCurve/tremble 取 PULSE_PARAMS ?? EMOTION_PARAMS（**覆盖**语义，见上）⟩
  private loop: () => void;
    // ⟨RAF 回调。插值系数 k = 1 - exp(-dt*6)（帧率无关近似）；
    //   眨眼按 blink * (0.7 + random*0.6) 秒随机调度；
    //   呼噜加成在此按剩余时间线性衰减（petting 因子）：压低 eyeOpen、抬 mouthCurve⟩
  private render(t: number, now: number): void;
    // 🆕 v1.2 **绘制顺序**（图层序不可随意调整）：
    //   影子 → pulse 光环 → **尾巴 drawTail()（身体后图层）** → 记录 this.tailTip
    //   → 身体：ctx.translate(px,py) / rotate(injRot) / scale(squish×breath) 内
    //       **先 drawEar() ×2（基部被头部轮廓遮住，只露三角尖）**
    //       → bodyGrad 填充团子轮廓 → 高光
    //       → 脸：drawEyes ×2 + drawMouth + 绷带[若 injured] + 腮红[开心且未受伤]
    //   → 天气 overlay（锚定 py - bodyR*1.75）→ 粒子
    //   bodyR = min(52 + energy*0.6, H*0.32)（体型随画布高度自适应，小窗不裁切 overlay）
    //   bodyGrad 三段均用 p.lum（R7）：min(92, L+14) / L / max(34, L-16)，末段 sat 也降 12（下限 20）
  private drawEar(ctx, x, y, side, pose, breathPhase, p: RenderParams, bodyR): void;
    // 🆕 v1.2 签名（首版存根 `drawEar(ctx,x,y,angle,p)` **已失效**）：天线升级为圆角三角猫耳。
    //   side ∈ {-1,1}；pose 来自 resolveEarPose()。
    //   angle = side*(0.22 - pose*0.38 + splay*0.5) + side*breathPhase*0.03，
    //   splay = max(0,-pose) = 飞机耳程度（外张 + 下压 + 缩短 + 耳廓内暖色收淡）；
    //   呼吸摆动仅 0.03rad 底噪（"活着"的信号，**不编码情绪**）。
    //   锚点 (∓bodyR*0.46, -bodyR*1.26)。
    //   ⚠️ 已踩坑：耳内色 hue+24 在暖金下是黄绿"新芽"，已改 **hue+330**（暖粉）。
  private drawTail(ctx, bodyR, p: RenderParams, t): { x: number; y: number };
    // 🆕 v1.2。锥形脊柱 N=10 段 + 尾梢圆头；返回尾梢局部坐标（render 换算后存 tailTip）。
    //   pose = resolveTailPose(p)；sway = sin(t*pose.speed)*pose.amp；L = bodyR*pose.len。
    //   🔴 已踩坑（DESIGN.md §3.2 第 3 条）：swing 原随脊柱位置放大（0.3→1.4×）到能抵消根部仰角，
    //      **单测全绿但截图里整条尾巴塌成水平鱼鳍** ⇒ 改加性扰动（根 0.25× / 梢 0.45×）。
    //   造型：梢部恒定上勾 0.55rad 成「?」尾钩（不随情绪归零）；
    //   垂尾（pose.lift<0）贴地钳制 floorY = bodyR*0.22，不穿影子线。
  private drawEyes(ctx, x, y, bodyR, p, now, injured = false): void;
    // ⟨open<0.15 画闭眼弧线（开心向上弯/累时向下垂）；否则睁眼+眼神光；
    //   eyeOpen<0.7 叠加上眼皮遮罩表现疲惫（遮罩参数化读 p.lum）；
    //   injured=true → 眩晕 X 眼（🔴 已裁决改"呆滞放空"，见 T12）；
    //   ⚠️ 眼色当前为固定 `#2b2b3a`，**无绿色** ⇒ T13 绿眼睛是新增工作⟩
  private drawMouth(ctx, x, y, bodyR, p, injured = false): void;
    // ⟨curve>0.65 张嘴大笑+舌头；否则二次贝塞尔由 curve 控制弯向；injured → 波浪嘴⟩
  private drawBandage(ctx, bodyR, p): void;
    // ⟨额头斜贴绷带 + 侧脸十字贴布。🔴 仅 injure() 路径调用，而 injure() 已裁决除名
    //   ⇒ 本方法随 T12 一并处置（"累瘫"改由 base 低档表达，不需绷带）⟩
  private drawPulseAura(x, y, bodyR, t): void;
    // ⟨6 种 pulse 各有专属光环颜色；anxious💧 / restless〰️ / grateful✨ 附加符号⟩
  private drawWeatherOverlay(x, y, t, _petHue: number): void;
    // ⟨4 种精灵：sunbeam(旋转光芒) / cloud-puff / rain-drop(循环雨丝) / storm-bolt(周期闪电)；
    //   锚定头顶右侧 x+44~46，各有独立浮动相位⟩
  private spawnParticles(n: number, hue: number): void;
  private updateParticles(ctx: CanvasRenderingContext2D): void;   // ⟨五角星形状，重力 120⟩
  // ❌ 已删除：drawBubble(ctx,x,y,text,fade)（R1）
}

// 模块级工具（导出 lerp）
function lerp(a: number, b: number, t: number): number;
function roundRect(ctx, x, y, w, h, r: number): void;      // 私有
export { lerp };
// ❌ 已删除：wrapText(ctx, text, maxW)（R1 气泡系统，首版存根仍列出）
```

> **本文件尚不存在的视觉元素**（T12/T13 需新增，勿误以为已有）：
> `drawWhiskers()` 胡须（裁决要求"折弯胡须"，实测 `grep -i whisker src/` = **0**）·
> 绿色眼睛（T13，当前固定 `#2b2b3a`）· 金渐层花纹图层 `patternOpacity`/`patternContrast`
> （T13，须由 `sat`/`lum` 算出，**禁独立常量**，见 DESIGN.md §3.3）。
>
> 🔴 **视觉形态必须截图验收**：纯函数单测（`tests/pose.test.ts`）只能守语义边界，
> 守不住"读不读得出来"。尾巴鱼鳍、天线耳朵、黄绿内耳三个缺陷都是单测全绿但截图暴露的。
> 自检模板见 [地图 §6](../../STRUCTURE_MAP.md) / MEMORY.md（`--selfcheck` + `--user-data-dir=/tmp/xxx` 绕行单实例锁）。
