# 自定义姿势交互插件（Pose Plugins）— 用户姿势包 × 右键菜单触发

> 2026-10-26 新增。用户在 `poses/` 目录放 JSON 即可给桌面猫**自定义增加姿势**，
> 右键猫 →「摆个姿势」子菜单逐条播放；目录热重载，零重启。
> 姿势 = CatPose 参数覆盖 + 可选二级动画（摇摆/弹跳）+ 气泡文案 + 表情插播 + 皮肤帧源复用。

## 组成

| 文件 | 角色 |
| --- | --- |
| `src/main/pose-defs.ts` | 纯函数层：JSON 解析 + 白名单校验 + 数值钳制（零 electron，node 可单测） |
| `src/main/pose-plugins.ts` | fs/electron 层：`posesDir()` / `ensureUserPoses()` / `loadPoses()` / `watchPoses()`（与 skins.ts 同构） |
| `src/core/types.ts` | `CustomPoseDef` / `PoseOverrides` / `PoseAnim` 契约 + `CatCmd` 新增 `play-pose` |
| `src/renderer/cat/cat-fsm.ts` | 新 FSM 状态 `'pose'`：`playPose()` 定时播放；`applyCustomPose()` / `poseEnv()` 纯函数 |
| `src/renderer/cat/cat-app.ts` | 皮肤帧源映射（`poseSkinState`）+ `petDebug.playPose` 调试把手 |
| `src/renderer/cat/sprite-skin.ts` | **缩放单源修复**：`draw()` 尊重 `CatPose.sx/sy`（见下） |
| `src/main/index.ts` | 装配：启动加载 + watch 热重载 + 右键菜单子菜单 + `--selftest-pose` 自检 |
| `poses/*.json` + `README.md` | 内置示例姿势包（伸懒腰/扭扭舞/面包猫坐/击个掌），打包态首启释放到 `userData/poses` |

## 数据流

```
poses/*.json ──loadPoses(校验/钳制/去重)──▶ 主进程 poseDefs 缓存
      ▲ fs.watch 700ms 防抖热重载                    │ 右键菜单每次弹出重建
      │                                              ▼
用户增删 JSON ◀──「打开姿势文件夹」     点击菜单项 ──▶ cat:cmd {type:'play-pose', pose:def}
                                                     ▼
                            FSM.playPose(def)：set('pose') + 气泡 + 表情插播
                                                     ▼
                computePose() case 'pose'：基础 pose × applyCustomPose(env 包络)
                                                     ▼
                    sprite-skin（face/rot/sx/sy + useState 帧源）或 fallback-cat（全字段）
                                                     ▼
                            stT ≥ duration ──▶ set('idle')（拖拽/甩出随时打断）
```

渲染层**零常驻状态**：`play-pose` 命令直接携带完整 def，主进程是唯一姿势表持有者。

## 姿势 JSON 格式

用户侧文档随包分发：`poses/README.md`（释放进 `userData/poses`）。要点：

- 三种文件形态：单对象 / 顶层数组 / `{ "poses": [...] }`。
- 全字段可选（除语义上的 id/name，皆有兜底）：`duration` 0.5–30s 默认 2；
  `text` ≤80 字；`pose` 覆盖 `sx/sy/rot/eyes/mouth/pawL/pawR/splay/tailAmp/headTilt/tailWrap/earL/earR/legsOn/zzz/blush`；
  `anim` 提供 `swayAmp/swayFreq/bounceAmp/bounceFreq` 正弦扰动；`useState` 复用皮肤状态帧（如 `sleep`）。
- **不可信输入原则**：白名单丢未知键、数值钳制（防手滑写出 99 倍猫）、枚举非法丢字段不丢条目、
  坏 JSON 只告警跳过——`loadPoses()` 永不抛错。
- 播放手感：数值覆盖随 0.22s 淡入 / 0.28s 淡出包络插值（`poseEnv`），枚举/布尔过半程切换；
  `bounce` 联动 sx 做体积近似守恒。

## 触发面（红线合规）

- **唯一用户触发 = 右键菜单「摆个姿势」**（+ devtools `petDebug.playPose(def)` / `--selftest-pose`）。
- **刻意不接任何手势触发**（双击/长按/连点等）：DESIGN.md R10 与 Q9 裁决已论证——
  手势→动作映射与摸头计数（3 击呼噜）在同一事件序列里打架，改名改视觉都无法消除误伤性质。
  自定义姿势是「明确意图的娱乐」，菜单触发语义最干净。
- 打断规则：姿势播放中拖拽/甩出立即接管（`set()` 离开 pose 即弃 def）；`paused` 期间拒绝播放；
  睡眠中被菜单触发会醒来摆（明确意图优先）。

## sprite-skin 缩放单源修复（顺带修掉的移植缺口）

`SkinPose` 契约声明了 `sx?/sy?`、FSM 注释写明「图像皮肤主要用 face/rot/sx/sy」，
但 `draw()` 历史上从 `sx=1/sy=1` 起步自行叠算呼吸（±0.8%）与落地压扁（0.14/0.1）——
`CatPose.sx/sy`（内含 mood 驱动呼吸、squashT 压扁、姿势覆盖）被整体丢弃。
修复：`draw()` 改以 `p.sx/p.sy` 为缩放基底，删除皮肤侧重复的呼吸/压扁叠算
（FSM 通道数值几乎相同：0.16/0.12 vs 0.14/0.10，视觉基本不变，且呼吸自此随心情档变化）。
步态引擎（gaitTransform）与表情/溶解层不受影响。守护测试：`tests/pose-fsm.test.ts`
「sprite-skin: CatPose.sx/sy 单一来源直通本体缩放」。

## 运行与自检

```bash
npm run build && npx electron . --selftest-pose [截图.png]
```

`--selftest-pose`：主进程加载 `poses/` → 走右键菜单同一条 `cat:cmd` 通道播放第 1 条姿势 →
断言 FSM 进入 `pose`、气泡文案一致、峰值截图、`duration` 到点自动回 `idle` → PASS/FAILED 落 crash.log。
桌宠是真实桌面窗口，自检期间用户拖猫会合法打断姿势——内置最多 3 次重试容忍瞬态干扰。

## 验证记录（2026-10-26）

- `npm run typecheck` ✓ · `npm test` 168 用例（新增 pose-defs 8 + pose-fsm 11）全绿 ✓ · `npm run build` ✓
- `--selftest-pose` 实跑 PASS：`[pose] 已加载 4 个自定义姿势`；
  `mid={state:'pose', bubble:'喵呜——伸个大懒腰!', bubbleShown:true}`；`after=idle`。
- 像素对照实验（空姿势 vs `sx:1.35, sy:0.75` 宽体姿势，同管线各截一图）：
  宽度比 **1.323≈1.35**（抗锯齿阈值 2% 偏差）；猫体顶边 124→187 CSS px，
  与理论值 374−250×0.75=186.5 误差 **0.3%** —— `pose` 覆盖确认进入真实渲染链路。
  （首轮对照曾测得比值 1.000，暴露的正是上述 sprite-skin 丢弃 sx/sy 的移植缺口。）
