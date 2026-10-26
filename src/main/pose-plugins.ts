/**
 * 自定义姿势插件（姿势包）管线 —— poses/ 目录 JSON → 右键菜单「摆个姿势」。
 *
 * 与皮肤管线（skins.ts）同构：
 *  - 运行期目录：打包态 = userData/poses（可写），开发态 = <root>/poses
 *  - 打包态首次运行从内置姿势包释放副本（ensureUserPoses）
 *  - 目录 watch 700ms 防抖 → 主进程缓存刷新（菜单每次弹出时重建，天然拿到新表）
 *
 * 解析/校验是纯函数，在 pose-defs.ts（可 node 单测）。本文件只做 fs/electron。
 * 姿势不经渲染层常驻：play-pose 命令直接携带完整 def，渲染层零状态。
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePosesJson } from './pose-defs.js';
import type { CustomPoseDef } from '../core/types.js';

/** 内置姿势包目录（打包后位于 app 资源内，只读） */
const BUNDLED_POSES_DIR = path.join(__dirname, '..', '..', 'poses');

/** 运行期姿势目录：打包后 = userData/poses（可写、用户可增删）；开发态 = <root>/poses。
 *  惰性求值（函数而非常量）：避免模块加载早于 app ready 的时序坑。 */
export function posesDir(): string {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'poses')
    : BUNDLED_POSES_DIR;
}

/** 打包后首次运行：把内置姿势包释放到 userData/poses，让用户可自由增删 */
export function ensureUserPoses(): void {
  if (!app.isPackaged) return;
  try {
    const dir = posesDir();
    fs.mkdirSync(dir, { recursive: true });
    if (fs.readdirSync(dir).some((f) => !f.startsWith('.'))) return;
    if (!fs.existsSync(BUNDLED_POSES_DIR)) return;
    for (const f of fs.readdirSync(BUNDLED_POSES_DIR, { withFileTypes: true })) {
      if (f.name.startsWith('.')) continue;
      fs.cpSync(path.join(BUNDLED_POSES_DIR, f.name), path.join(dir, f.name), { recursive: true });
    }
    console.log('[pose] 已释放内置姿势包到', dir);
  } catch (e) {
    console.error('[pose] 释放内置姿势包失败:', (e as Error).message);
  }
}

/**
 * 扫描姿势目录：*.json 逐个解析（单对象/数组/{poses:[]} 三种形态），
 * id 全局去重（文件名序，先到先得）。坏文件只告警跳过，永不抛错。
 */
export function loadPoses(): CustomPoseDef[] {
  const dir = posesDir();
  if (!fs.existsSync(dir)) return [];
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  } catch (e) {
    console.error('[pose] 目录读取失败:', (e as Error).message);
    return [];
  }
  const out: CustomPoseDef[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch (e) {
      console.error('[pose] 读取失败', f, (e as Error).message);
      continue;
    }
    const { poses, warnings } = parsePosesJson(text, path.basename(f, path.extname(f)));
    for (const w of warnings) console.warn('[pose]', f, w);
    for (const p of poses) {
      if (seen.has(p.id)) {
        console.warn('[pose]', f, `id 重复：${p.id}（保留先加载的）`);
        continue;
      }
      seen.add(p.id);
      out.push(p);
    }
  }
  console.log(`[pose] 已加载 ${out.length} 个自定义姿势`);
  return out;
}

/** 姿势目录变化 → 防抖回调（主进程刷新缓存）。返回停止函数。与 watchSkins 同构。 */
export function watchPoses(onChange: () => void): () => void {
  let watcher: fs.FSWatcher | null = null;
  try {
    const dir = posesDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let t: ReturnType<typeof setTimeout> | null = null;
    watcher = fs.watch(dir, { recursive: true }, () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; onChange(); }, 700);
    });
  } catch (e) {
    console.error('[pose] 目录监听失败', (e as Error).message);
  }
  return () => { try { watcher?.close(); } catch { /* 已关闭 */ } };
}
