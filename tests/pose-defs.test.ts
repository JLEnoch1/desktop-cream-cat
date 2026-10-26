/**
 * pose-defs 单测 —— 自定义姿势定义的解析与校验（纯函数，零 electron）。
 *
 * 覆盖：三种文件形态（单对象/数组/{poses:[]}）、坏 JSON 永不抛错、
 * 白名单丢未知键、数值钳制（防手滑 99 倍猫）、枚举非法丢字段不丢条目、
 * id/name 兜底与截断、slugify。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePosesJson, sanitizePose, slugify, POSE_LIMITS } from '../src/main/pose-defs.js';

test('sanitizePose: 完整合法定义逐字段透传', () => {
  const def = sanitizePose({
    id: 'My Pose!',
    name: '  伸懒腰  ',
    duration: 2.5,
    text: ' 喵呜~ ',
    expression: 'happy',
    useState: 'sleep',
    pose: { sx: 1.16, sy: 0.88, eyes: 'closed', mouth: 'o', pawL: 1, tailWrap: true, blush: false },
    anim: { swayAmp: 0.02, swayFreq: 1.2, bounceAmp: 0.05, bounceFreq: 5 },
  }, 'file-fallback');
  assert.ok(def);
  assert.equal(def.id, 'my-pose'); // slug 化
  assert.equal(def.name, '伸懒腰'); // trim
  assert.equal(def.duration, 2.5);
  assert.equal(def.text, '喵呜~');
  assert.equal(def.expression, 'happy');
  assert.equal(def.useState, 'sleep');
  assert.deepEqual(def.pose, { sx: 1.16, sy: 0.88, eyes: 'closed', mouth: 'o', pawL: 1, tailWrap: true, blush: false });
  assert.deepEqual(def.anim, { swayAmp: 0.02, swayFreq: 1.2, bounceAmp: 0.05, bounceFreq: 5 });
});

test('sanitizePose: 数值全部钳制在安全范围（手滑 99 倍猫不炸渲染）', () => {
  const def = sanitizePose({
    id: 'clamp',
    duration: 999,
    pose: { sx: 99, sy: -3, rot: 40, pawL: 7, pawR: -1, splay: 1e9, tailAmp: 100, headTilt: -9, earL: 2, earR: -0.5 },
    anim: { swayAmp: 5, swayFreq: 0, bounceAmp: -1, bounceFreq: 1000 },
  }, 'x');
  assert.ok(def);
  assert.equal(def.duration, POSE_LIMITS.duration[1]); // 30
  const p = def.pose!;
  assert.equal(p.sx, POSE_LIMITS.sx[1]);      // 3
  assert.equal(p.sy, POSE_LIMITS.sy[0]);      // 0.3
  assert.equal(p.rot, POSE_LIMITS.rot[1]);    // 1.5
  assert.equal(p.pawL, 1);
  assert.equal(p.pawR, 0);
  assert.equal(p.splay, 1);
  assert.equal(p.tailAmp, 4);
  assert.equal(p.headTilt, -1);
  assert.equal(p.earL, 1);
  assert.equal(p.earR, 0);
  const a = def.anim!;
  assert.equal(a.swayAmp, POSE_LIMITS.swayAmp[1]);   // 0.35
  assert.equal(a.bounceAmp, 0);                       // -1 → 0
  assert.equal(a.bounceFreq, POSE_LIMITS.freq[1]);   // 8
  assert.equal(a.swayFreq, POSE_LIMITS.freq[0]);     // 0 → 钳到下限 0.1（钳制而非丢弃）
});

test('sanitizePose: 非法枚举丢字段不丢条目；未知键直接忽略', () => {
  const def = sanitizePose({
    id: 'enum',
    pose: { eyes: 'angry', mouth: 'w', futureKey: 123, legsOn: 'yes' },
    whatever: true,
  }, 'x');
  assert.ok(def);
  assert.equal(def.pose?.eyes, undefined);   // 非法枚举丢弃
  assert.equal(def.pose?.mouth, 'w');        // 合法保留
  assert.equal('futureKey' in (def.pose ?? {}), false);
  assert.equal(def.pose?.legsOn, undefined); // 非布尔丢弃
  assert.equal('whatever' in def, false);
});

test('sanitizePose: id/name/duration 兜底；非对象整条拒绝', () => {
  const def = sanitizePose({ pose: { blush: true } }, '文件名Fallback');
  assert.ok(def);
  assert.equal(def.id, 'fallback'); // slug(文件名) 兜底（中文被清洗掉后取 fallback 的 ASCII 部分）
  assert.equal(def.name, def.id);   // name 缺省 = id
  assert.equal(def.duration, 2);    // 默认 2s
  assert.equal(sanitizePose(null, 'x'), null);
  assert.equal(sanitizePose('str', 'x'), null);
  assert.equal(sanitizePose([1, 2], 'x'), null);
});

test('parsePosesJson: 单对象 / 数组 / {poses:[]} 三种形态', () => {
  const single = parsePosesJson('{"id":"a","name":"甲"}', 'f');
  assert.equal(single.poses.length, 1);
  assert.equal(single.poses[0]!.id, 'a');
  assert.equal(single.warnings.length, 0);

  const arr = parsePosesJson('[{"id":"a"},{"id":"b"}]', 'f');
  assert.equal(arr.poses.length, 2);
  assert.deepEqual(arr.poses.map((p) => p.id), ['a', 'b']);

  const wrapped = parsePosesJson('{"poses":[{"id":"c"}]}', 'f');
  assert.equal(wrapped.poses.length, 1);
  assert.equal(wrapped.poses[0]!.id, 'c');
});

test('parsePosesJson: 数组条目缺 id 用「文件名-序号」兜底', () => {
  const r = parsePosesJson('[{"name":"甲"},{"name":"乙"}]', 'my-pack');
  assert.deepEqual(r.poses.map((p) => p.id), ['my-pack-1', 'my-pack-2']);
});

test('parsePosesJson: 坏 JSON / 坏条目 → warnings + 跳过，永不抛错', () => {
  const bad = parsePosesJson('{oops', 'f');
  assert.equal(bad.poses.length, 0);
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0]!, /JSON 解析失败/);

  const mixed = parsePosesJson('[{"id":"ok"},42,null]', 'f');
  assert.equal(mixed.poses.length, 1);
  assert.equal(mixed.poses[0]!.id, 'ok');
  assert.equal(mixed.warnings.length, 2); // 42 与 null 各一条
});

test('slugify: 大小写/空白/非法字符/空值', () => {
  assert.equal(slugify('  Hello World  '), 'hello-world');
  assert.equal(slugify('姿势Pack_1'), 'pack-1'); // 非 ASCII 清洗
  assert.equal(slugify('---'), '');
  assert.equal(slugify(undefined), '');
  assert.equal(slugify('a'.repeat(60)).length, POSE_LIMITS.idLen);
});
