# 运行时数据流转（四条主链路）

> 专题文档（原 STRUCTURE_MAP §2.3）· 抽取：2026-10-22 v1.3 实测轮
> 链路端点模块的接口详情见各自存根（索引在[地图 §3](../../STRUCTURE_MAP.md)）
> ⚠️ 多会话并行改动，行号会失效，引用前以当前源码为准

---
**① 启动链路**
```
app.whenReady()  →  new Coordinator({userDataPath})
                      ├→ new DecisionLog({dbPath: <userData>/energy-pet.db})
                      │     └→ exec(SCHEMA_SQL) + rebuildEnergy()  ← 全量重放校准 fold
                      ├→ new EnergyLedger(log) / TaskCenter(log) / RecoveryDeck(log)
                      ├→ new WeatherSensor({log})  ← 构造时 fromEventLog() 恢复缓存
                      └→ new InsightEngine({log})
                 →  registerIpc() → createWindow() → coordinator.start()
                      ├→ deck.seedIfEmpty()        （写 6 条初始版本历史）
                      ├→ log.append(sessionStartedDraft())
                      ├→ weather.refresh()         （不阻塞）
                      ├→ **3 个 setInterval（全 push 进 `timers`）**：
                      │     weather(30min) / insight(10min) / **checkReportDue(60s)**
                      ├→ maybeMorningBaseline()    （弹晨间基线滑动卡）
                      ├→ insightStartupTimer = setTimeout(runInsightBatch, 3s)
                      └→ **geoEnabled 时** geoTimer = setTimeout(**1500ms**,   ← 延迟避开启动期网络争抢
                            resolveGeo(log) → weather.setLocation(lat,lon,city,province)
                            → bus.emit('geo:changed')
                            → await weather.refresh() → bus.emit('weather:changed', {source})
                            .catch(() => {})          ← 定位失败静默，不冒泡不重试)
                 ⚠️ stop() 须单独 clearTimeout(insightStartupTimer / geoTimer / adjustTimer)，
                    它们不在 `timers` 数组（那只装 setInterval）；漏清会报 "database is not open"。
```

**② 写链路（所有状态变更的唯一路径）**
```
用户操作 → window.pet.*(IPC invoke) → ipcMain.handle
        → Coordinator 方法 → 领域模块 → EventDraft 工厂（core/events）
        → DecisionLog.append(draft)                     ← 唯一写入口
              ├→ foldDraft(before, draft) 计算 energy_after
              ├→ INSERT INTO events (...)
              └→ energyCache = after
        → bus.emit('state:dirty' | 'energy:changed' | ...)
        → main/index.ts flushState() → coordinator.pushState(sendToRenderer)
              └→ JSON 去重后 webContents.send('state:update', AppState)
        → renderer/app.ts applyState(s) → pet.applyEmotion() + DOM 更新
```

**③ 滑动确认链路（predicted / actual 双记录的来源）**
```
requestSlide(kind, refId)
  ├→ kind='task-complete' → TaskCenter.requestComplete(id, ledger.current())
  ├→ kind='recovery'      → RecoveryDeck.requestTake(id, ledger.current())
  ├→ kind='morning-baseline' → buildMorningSlide()   baseEnergy = 昨日收尾 ?? INITIAL_ENERGY
  └→ kind='manual-adjust'    → buildManualSlide()    纯预览，不落库
       ↓ 返回 PendingSlide（同一时刻最多一张，已有卡返回 null）
渲染层 showSlide(s) → 滑块默认位 = clampSlider(baseEnergy + predicted)
  ├→ 拖动 input → updateSlideVisual(target)
  │     ├→ pet.setPreview(target)                    本地即时反馈
  │     └→ 80ms 节流 → slidePreview(target) IPC → previewSlide() 不落库
  └→ 确认 → slideConfirm(target, note) IPC
        → confirmSlide(target)：d = round2(clamp(target) - slide.baseEnergy)
             ├→ task-complete    → TaskCenter.confirmComplete(refId, d, note)
             ├→ recovery         → RecoveryDeck.confirmTake(refId, d, note)
             ├→ morning-baseline → ledger.setEnergy(..., '晨间基线')；morningDone = true
             └→ manual-adjust    → 直接关卡，不写任何事件
```

**④ 偏差学习链路（AI 推荐闭环）**
```
recovery.taken 事件同时记录 predicted_delta(卡片默认值) 与 actual_delta(用户确认值)
  ↓ 每 10min / 启动后 3s
InsightEngine.detectRecommendations()
  ├→ log.byType('recovery.taken', 2000)
  ├→ 按 itemId 聚合，统计 |actual-predicted| >= 0.5 的次数
  ├→ mismatch >= 3 且 !hasPendingRecommendationFor(itemId)
  └→ log.insertRecommendation(rec) → 返回新产出推荐
  ↓
Coordinator 写 recShownDraft + bus.emit('recommendation:new') → 渲染层建卡
  ↓ 用户点击
resolveRecommendation(recId, action, modifiedDelta?)
  ├→ accepted → recAcceptedDraft + deck.updateDelta(itemId, suggestedDelta, '采纳 AI 推荐校准', 'ai')
  ├→ modified → recModifiedDraft + deck.updateDelta(itemId, modifiedDelta, '用户修改后采纳', 'user')
  └→ rejected → recRejectedDraft（仅记录，不改默认值）
        ↓ updateDelta 双写：append(recoveryItemUpdatedDraft) + addRecoveryVersion()
```
