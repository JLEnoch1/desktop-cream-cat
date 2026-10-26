/**
 * 自定义姿势定义 —— 解析与校验（纯函数层，零 electron/fs 依赖，可 node 单测）。
 *
 * 输入是用户手写的 JSON（poses/*.json），一律按「不可信」处理：
 *  - 白名单字段：未知键直接丢弃（向前兼容，旧版 app 读到新键也不炸）
 *  - 数值钳制：所有幅度/缩放/时长都夹在安全范围（防手滑写出 99 倍猫）
 *  - 枚举校验：eyes/mouth 非法值丢弃该字段而不是整条姿势
 *  - 永不抛错：坏 JSON / 坏条目 → warnings + 跳过，好条目照常生效
 *
 * 文件系统扫描与目录热重载在 pose-plugins.ts（electron 侧）。
 */

import type { CustomPoseDef, PoseAnim, PoseOverrides } from '../core/types.js';

export interface PoseParseResult {
  poses: CustomPoseDef[];
  warnings: string[];
}

/** 数值钳制表（与 CustomPoseDef 注释同源） */
export const POSE_LIMITS = {
  duration: [0.5, 30] as const,
  sx: [0.3, 3] as const,
  sy: [0.3, 3] as const,
  rot: [-1.5, 1.5] as const,
  paw: [0, 1] as const,
  splay: [0, 1] as const,
  tailAmp: [0, 4] as const,
  headTilt: [-1, 1] as const,
  ear: [0, 1] as const,
  swayAmp: [0, 0.35] as const,
  bounceAmp: [0, 0.35] as const,
  freq: [0.1, 8] as const,
  nameLen: 20,
  textLen: 80,
  expressionLen: 40,
  idLen: 40,
};

const EYES = new Set(['open', 'blink', 'happy', 'closed', 'wide']);
const MOUTH = new Set(['w', 'o', 'line']);
const USE_STATE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

/** 任意字符串 → slug id（小写字母数字连字符；空结果由调用方兜底） */
export function slugify(v: unknown, maxLen = POSE_LIMITS.idLen): string {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

function num(v: unknown, lo: number, hi: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
}

function sanitizeOverrides(raw: unknown): PoseOverrides | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const pose: PoseOverrides = {};
  const putNum = (key: 'sx' | 'sy' | 'rot' | 'pawL' | 'pawR' | 'splay' | 'tailAmp' | 'headTilt' | 'earL' | 'earR', lo: number, hi: number): void => {
    const v = num(src[key], lo, hi);
    if (v != null) pose[key] = v;
  };
  putNum('sx', ...POSE_LIMITS.sx);
  putNum('sy', ...POSE_LIMITS.sy);
  putNum('rot', ...POSE_LIMITS.rot);
  putNum('pawL', ...POSE_LIMITS.paw);
  putNum('pawR', ...POSE_LIMITS.paw);
  putNum('splay', ...POSE_LIMITS.splay);
  putNum('tailAmp', ...POSE_LIMITS.tailAmp);
  putNum('headTilt', ...POSE_LIMITS.headTilt);
  putNum('earL', ...POSE_LIMITS.ear);
  putNum('earR', ...POSE_LIMITS.ear);
  if (typeof src.eyes === 'string' && EYES.has(src.eyes)) pose.eyes = src.eyes as PoseOverrides['eyes'];
  if (typeof src.mouth === 'string' && MOUTH.has(src.mouth)) pose.mouth = src.mouth as PoseOverrides['mouth'];
  if (typeof src.legsOn === 'boolean') pose.legsOn = src.legsOn;
  if (typeof src.tailWrap === 'boolean') pose.tailWrap = src.tailWrap;
  if (typeof src.zzz === 'boolean') pose.zzz = src.zzz;
  if (typeof src.blush === 'boolean') pose.blush = src.blush;
  return Object.keys(pose).length ? pose : null;
}

function sanitizeAnim(raw: unknown): PoseAnim | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const anim: PoseAnim = {};
  const swayAmp = num(src.swayAmp, ...POSE_LIMITS.swayAmp);
  if (swayAmp != null) anim.swayAmp = swayAmp;
  const swayFreq = num(src.swayFreq, ...POSE_LIMITS.freq);
  if (swayFreq != null) anim.swayFreq = swayFreq;
  const bounceAmp = num(src.bounceAmp, ...POSE_LIMITS.bounceAmp);
  if (bounceAmp != null) anim.bounceAmp = bounceAmp;
  const bounceFreq = num(src.bounceFreq, ...POSE_LIMITS.freq);
  if (bounceFreq != null) anim.bounceFreq = bounceFreq;
  return Object.keys(anim).length ? anim : null;
}

/**
 * 单条姿势定义校验。返回 null = 整条无效（非对象/数组）。
 * 字段级问题只丢字段不丢条目；id 缺省/非法回落 fallbackId（通常是文件名）。
 */
export function sanitizePose(raw: unknown, fallbackId: string): CustomPoseDef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = slugify(o.id) || slugify(fallbackId) || 'pose';
  const nameRaw = typeof o.name === 'string' ? o.name.trim() : '';
  const name = (nameRaw || id).slice(0, POSE_LIMITS.nameLen);
  const def: CustomPoseDef = {
    id,
    name,
    duration: num(o.duration, ...POSE_LIMITS.duration) ?? 2,
  };
  if (typeof o.text === 'string' && o.text.trim()) def.text = o.text.trim().slice(0, POSE_LIMITS.textLen);
  if (typeof o.expression === 'string' && o.expression.trim()) def.expression = o.expression.trim().slice(0, POSE_LIMITS.expressionLen);
  if (typeof o.useState === 'string' && USE_STATE_RE.test(o.useState)) def.useState = o.useState;
  const pose = sanitizeOverrides(o.pose);
  if (pose) def.pose = pose;
  const anim = sanitizeAnim(o.anim);
  if (anim) def.anim = anim;
  return def;
}

/**
 * 解析一个姿势 JSON 文件内容。接受三种形态：
 * 单对象 | 数组 | { "poses": [...] }。坏 JSON → 空结果 + warning，永不抛错。
 */
export function parsePosesJson(text: string, fallbackId: string): PoseParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { poses: [], warnings: [`JSON 解析失败：${(e as Error).message}`] };
  }
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { poses?: unknown }).poses)
      ? ((data as { poses: unknown[] }).poses)
      : [data];
  const poses: CustomPoseDef[] = [];
  const warnings: string[] = [];
  list.forEach((raw, i) => {
    const suffix = list.length > 1 ? `-${i + 1}` : '';
    const def = sanitizePose(raw, `${fallbackId}${suffix}`);
    if (def) poses.push(def);
    else warnings.push(`第 ${i + 1} 条不是对象，已跳过`);
  });
  return { poses, warnings };
}
