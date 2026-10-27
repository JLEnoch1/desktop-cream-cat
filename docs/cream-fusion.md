# 奶油猫 × 精力桌宠 · 融合设计（v2.0）

> 2026-10-26 裁决：desktop-pet 的 **UI 奶油猫设计与交互** 完全替换 energy-pet 的旧设计
> （程序化金渐层 `renderer/pet.ts` + 深色玻璃面板 `app.ts`）；energy-pet 的**功能模块**
> （事件溯源精力账本 / 三层情绪 / 任务 / 恢复项 / 天气+IP 定位 / 洞察周报 / 滑动卡 / 调节窗口）
> 原样嫁接到奶油猫设计之上；desktop-pet 的 **web 下载页**（site/）与打包分发一并移植。
> 来源工程：`/Users/zcy/Desktop/desktop-pet`（只读参考，不改动）。

## 0. 产品形态

一只奶油猫住在桌面底边：自己散步、舔毛、打盹、跳上窗口顶边踱步；你拖它、甩它、摸它、
敲键盘它抬爪陪你打节拍（Bongo Cat）。**它的活力与心情由你的精力账本驱动**：
精力高 → 活泼好动、被摸时撒爱心；精力低 → 懒得动、倒头就睡、气泡提醒你休息；
天气变化 → 头顶挂奶油线稿小天气（晴/云/雨/雷，按 `resolveWeatherOverlay` 门槛）；
完成任务/恢复精力 → 猫有对应表情与气泡；每天 17:30 猫提醒你收周报。

所有确认类 UI（晨间基线滑动卡、事件后调节窗、任务时长卡、周报弹窗、AI 推荐卡、
任务面板、恢复扇形菜单）以**奶油纸感卡片**（白底 + 墨线描边 + ui-rounded 圆体）
呈现在独立的 UI 窗口中，按需出现、用完即隐 —— 桌面平时只有猫。

## 1. 双窗口架构（核心决策）

| 窗口 | 尺寸/行为 | 内容 | click-through |
|---|---|---|---|
| `catWin` | 360×380，**随 FSM 行走移动**（渲染层拥有 px/py，`cat:moveWindow` → setPosition） | canvas 奶油猫（图像皮肤/程序化回退）+ 气泡 + 天气 overlay + pulse 光晕 | 主进程 50ms 轮询光标 × 猫体 hotRect（窗口坐标恒定，猫画在固定锚点） |
| `uiWin` | 400×620，锚定主屏右下角，**按需 show/hide** | 奶油卡片流：滑动卡/时长卡/调节卡/周报/推荐/任务面板/恢复扇形 + HUD 精力条 | 沿用 hotRect 轮询（`win:hotRects`，data-interactive 采集） |

为什么双窗口：奶油猫交互的本体是「窗口即猫、满屏行走、站上窗口顶边」——窗口必须小而随动；
精力管理的卡片流需要稳定的展示空间与焦点。合成一个窗口则二者互相牵制（行走时卡片乱飞、
大窗口挡住顶边吸附）。双窗口让两套已验证的机制各自原样保留。

窗口出现时机：`pendingSlide / adjustWindow / reportModal / recommendations / mode=panel /
恢复菜单` 任一非空 → show；全部关闭且 mode=pet → hide。猫窗口常驻。

## 2. 目录布局（energy-pet 内）

```
src/
  core/ storage/ ledger/ emotion/ task/ recovery/ weather/ insight/   ← 领域层零改动
  main/
    coordinator.ts        ← 零改动（AppState/滑动卡/调节窗/周报调度照旧）
    index.ts              ← 重写：双窗口装配 + 托盘 + 自启 + 崩溃自愈 + selfcheck
    skins.ts              ← 移植 desktop-pet 皮肤管线（漫水抠图/切帧缓存/resolveSkin/watch）
    cell-split.ts         ← 移植 lib/cell-split.js（纯函数，node 单测）
    ledges.ts             ← 移植 lib/ledges.js（纯函数，node 单测）
    native.ts             ← 移植 keytap/winlist helper 生命周期（swiftc 编译 + stdout 行协议）
    autolaunch.ts         ← 移植 首次运行自启 + marker + 菜单开关
  preload/index.ts        ← 重写：window.pet（领域 API，照旧）+ window.cat（壳层 API）
  renderer/
    cat/  cat.html cat.css cat-app.ts cat-fsm.ts sprite-skin.ts fallback-cat.ts mood.ts
    ui/   ui.html  ui.css  ui-app.ts
skins/default/            ← 奶油猫素材（jpg + skin.json，.cache 运行时再生）
native/*.swift            ← keytap / winlist
site/                     ← 下载页（奶油纸感，双平台按钮）+ downloads/ 固定文件名
scripts/                  ← build.mjs（4 入口）/ build-helper.sh / make-icon.swift /
                             serve-site.mjs / sync-downloads.mjs / release.sh
tests/                    ← 领域测试保留；删旧渲染层测试；新增 cell-split/ledges/sprite-skin/mood
```

删除（被奶油猫设计替换）：`src/renderer/{app.ts,pet.ts,index.html,styles.css}`；
`tests/{pose,coat-pattern,pratfall,pulse-offsets,secondary-motion}.test.ts`（守护的是旧
程序化猫的纯函数）；`emotion-tiers.test.ts` 去掉 `resolveProneVariant` 引用（BASE_TIERS 守护保留）。

## 3. 状态与事件流（嫁接点）

```
Coordinator.buildState() ── state:update ──▶ uiWin（卡片流，逻辑与旧 app.ts 等价）
        │
        └─ main 提炼 CatMood { energy, emotion, weather, headline }
                    │  cat:mood（JSON 去重推送）
                    ▼
        catWin mood.ts：纯函数映射 →
          · 活力参数 activity(f)：精力→ 步频/散步概率/攀爬概率/入睡阈值（45s→12s 线性插值）
          · 表情触发：base/pulse → happy|surprise|sleepy…（皮肤 expressions，缺素材静默跳过）
          · overlay：emotion.overlay → 头顶奶油线稿天气（sunbeam/cloud-puff/rain-drop/storm-bolt）
          · pulse 光晕：pulseIntensity(reaction, energy) → 身后柔光（cream 色板）
          · 气泡文案库：按 tier/pulse/天气事件抽取

main 订阅 bus 的领域事件 → cat:react 轻量通知（reaction 名 + 可选气泡文案）：
  slide:requested(晨间)   → 猫醒来 + 「早安喵~ 滑一下告诉我今天的电量」
  adjust:opened           → 「做完啦？7 秒内可以微调～」
  adjust:committed(Δ>0)   → happy 表情 + 爱心
  recovery 确认            → happy + 「呼噜呼噜~ 舒服多了」
  weather:changed(changed) → 重推 cat:mood（头顶挂件随实时天气更新：雨=落小雨，精力≥8+晴=出太阳）；
                             仅天气语义真变（changed=true）才按新天气吐槽（雨：「下雨了,记得带伞喵」…）
  recommendation:new      → 「我发现了一个小规律,想不想看看?」
  report(17:30)           → 「周报出炉~ 瞄一眼?」
  energy 跨过 3 分下行     → 「电量低了,要不要一起休息一下?」
```

**红线继承**：精力值=fold(events)、写入唯一走 DecisionLog.append、天气永不抛错、
manual-adjust 不落库、命中区宁大勿空、低精力配色不退暖（情绪→文案/行为层同样只降活力不贬损）、
跌倒态永不由用户行为触发、 tray 菜单不动态重建（SIGABRT）、勿设 focusable:false。
新增红线：**猫窗口永不抢焦点**（showInactive；只有 uiWin panel 模式 focus）；
**卡片不阻塞猫**（uiWin 隐藏时猫照活；调节窗 7s 倒计时由主进程驱动，与窗口显隐无关）。

## 4. 交互清单（奶油猫设计语言）

- 猫本体：拖拽（按住移动窗口）、快速甩出（抛物线+落地弹跳压扁）、原地点击=摸头
  （happy 表情+爱心+按精力档抽气泡）、右键=菜单、Esc 全局=惊一下、敲键=交替抬爪(tap 表情)。
- 行走：地面散步 / 跳上窗口顶边（climb 抛物线）/ 顶边踱步·坐下·探头（perch）/ 落下（fall+压扁）。
  winlist 采集失败自动纯地面模式；菜单可关。
- 右键菜单（动态 popup，非托盘）：精力一句话（禁用项展示 headline+数值）/ 任务面板 /
  恢复一下 / 本周报告 / 临时调节·预览 / —— / 暂停·唤醒 / 现在睡觉 / 窗口顶边散步✓ /
  重新加载皮肤 / 打开皮肤文件夹 / —— / 开机自启✓ / 敲键监听状态 / 打开敲键权限设置… / —— / 退出。
- 托盘（静态菜单，安全）：打开·收起面板 / 刷新天气 / 猫回地面 / 退出；tooltip=精力+headline。
- uiWin 卡片流交互逻辑与旧版等价（滑动预览回弹、7s 微调+确认弹窗、时长先行、周报周五必须确认、
  推荐三态处置），只换奶油纸感皮肤。

## 5. 分发（site/ + electron-builder）

- `npm run build:app`（esbuild 4 入口）→ `npm run build:mac|build:win`（electron-builder：
  mac universal dmg + LSUIElement、win x64 nsis oneClick+runAfterFinish）→ `npm run site:sync`
  固定文件名 `CreamCat-macOS.dmg` / `CreamCat-Windows.exe`。
- 首次运行（打包态）：释放内置皮肤到 userData/skins + 写开机自启（.autolaunch-initialized
  marker，之后尊重用户开关）。asar:false 保持皮肤可直接替换。
- site/index.html：奶油纸感设计原样保留，文案改为「精力桌宠」三句话（会陪你打字散步打盹 /
  精力账本让它心情可见 / 天气与周报顺带照看），双按钮 + 版本号。

## 6. 验证

```bash
npm run build && npm run typecheck && npm test     # 领域+新纯函数测试全绿
--selfcheck 截图：catWin（猫+皮肤）与 uiWin（晨间滑动卡）各一张
./smoke.sh 真机冒烟：行走/拖拽/甩出/摸头/右键菜单/卡片流
```
