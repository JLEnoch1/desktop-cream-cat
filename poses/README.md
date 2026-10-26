# 姿势包（poses/）

每个 `.json` 文件 = 一个（或一组）自定义姿势。放进本目录即被 700ms 防抖热加载，
右键桌面猫 →「摆个姿势」即可看到并播放。完整文档见项目 `docs/pose-plugins.md`。

## 快速上手

```json
{
  "id": "my-pose",          // 唯一 id（小写字母/数字/连字符；缺省用文件名）
  "name": "我的姿势",        // 菜单显示名（≤20 字符）
  "duration": 2.5,           // 播放时长秒（0.5–30，默认 2）
  "text": "喵~",             // 气泡文案（≤80 字符，可省略）
  "expression": "happy",     // 皮肤表情插播名（可省略；无该素材静默跳过）
  "useState": "sleep",       // 复用皮肤哪个状态的帧（可省略，默认 idle）
  "pose": {                  // 姿态覆盖（全部可选，数值自动钳制）
    "sx": 1.1, "sy": 0.9, "rot": 0,
    "eyes": "closed",        // open | blink | happy | closed | wide
    "mouth": "o",            // w | o | line
    "pawL": 0, "pawR": 1, "splay": 0,
    "tailAmp": 1.5, "tailWrap": false, "headTilt": 0.2,
    "earL": 0, "earR": 0, "legsOn": false, "zzz": false, "blush": true
  },
  "anim": {                  // 二级动画（正弦扰动，可省略）
    "swayAmp": 0.05, "swayFreq": 3,
    "bounceAmp": 0.04, "bounceFreq": 2
  }
}
```

一个文件也可以写多个姿势：顶层数组 `[{...}, {...}]`，或 `{ "poses": [{...}] }`。

## 规则

- 坏 JSON / 非法字段：跳过该文件或该字段，其余照常生效（控制台 `[pose]` 告警）。
- `id` 重复：文件名排序先到先得，后来者忽略。
- 播放中拖拽/甩出猫可随时打断姿势。
- 暂停猫期间菜单触发不生效（先「唤醒猫」）。
