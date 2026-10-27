# emotion/pulse-contract.ts —— pulse 强度契约层（🔴 冲突仲裁点）

> 存根约定同目录其他文档。源码真源：`src/emotion/pulse-contract.ts`（main `ac0a094` 起）。
> 🔴 **语义冲突以本文件为准**：全项目关于「脉冲多强、谁被豁免」的唯一真源；
> 取代旧的「按 tier 调制」说法（G10 签名统一，2026-10-22）。

## 接口签名（照抄源码）

```ts
export type PulseBinding = 'energy' | 'empathy';

/** 每个 pulse 反应的归类。empathy 类不受 intensity 调制（恒 1.0）。 */
export const PULSE_BINDING: Record<PulseReaction, PulseBinding>;
// 现值：6 个既有 reaction 全部 'energy'；empathy 槽位保留为空

/** 四段查表（下界包含，全量程覆盖）。返回值 ∈ {0.25, 0.5, 0.75, 1.0} */
export function intensity(energy: number): number;

/** 唯一入口：按 binding 决定是否施加 intensity。empathy 恒 1.0。 */
export function pulseIntensity(reaction: PulseReaction, energy: number): number;

/** intensity 的全部合法取值 */
export const INTENSITY_LEVELS: readonly [0.25, 0.5, 0.75, 1.0];
```

## 三条必须知道的事

1. 🔴 **查表采用下界包含**（`>=8 / >=6 / >=4 / else`），因为精力是 step=0.5 的浮点值：
   裁决原文字面区间 [8,10]/[6,7]/[4,5]/[0,3] 在 3.5/5.5/7.5 处有**空隙**（G4），
   照字面实现会让高频取值掉进兜底分支产生跳变。方向：**高精力压缩、低精力全幅**。
2. **empathy 集合当前为空**（G1）：负面词词典待用户裁决；A 车道只交付了豁免**机制**
   （分类表 + 旁路 + 桩测试），词典填充后 empathy-bound 反应自动恒 1.0。
3. **0-3 区间内部不再细分**（裁决明确否决「低精力区内部细分」补丁方案）——
   `tests/pulse-intensity.test.ts` 有 `intensity(2.9) === intensity(0.2) === 1.0` 的正面守护，
   防止有人后续在这里插 ramp。

## 消费方

- `src/renderer/pet.ts` `buildRenderParams()`：`k = pulseActive ? pulseIntensity(pulse, energy) : 0`
- 🔴 禁止在 pulse 触发路径上加任何能量阈值比较（门槛已废除，全档激活）
- 守护测试：`tests/pulse-intensity.test.ts`（契约级）/ `tests/pulse-offsets.test.ts`（渲染级）
