/**
 * 奶油猫皮肤管线（移植自 desktop-pet main.js）。
 *
 * 职责：
 *  - 把 JPEG 里的「假棋盘格」背景用漫水抠图转成真透明 PNG（.cache/）
 *  - skin.json v1/v2 解析：宫格大图按 alpha 连通域自动切帧（cell-split）
 *  - manifest.json 增量缓存：源图不变不重切
 *  - 目录 watch → 热重载通知
 *
 * 打包态皮肤目录在 userData/skins（应用目录只读），首次运行从内置皮肤释放副本。
 */

import { app, nativeImage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { splitCells, splitGrid, type GridSpec } from './cell-split.js';

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** 运行期皮肤目录：打包后 = userData/skins（可写、用户可替换）；开发态 = <root>/skins */
export const SKINS_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'skins')
  : path.join(__dirname, '..', '..', 'skins');

/** 内置皮肤目录（打包后位于 app 资源内，只读） */
const BUNDLED_SKINS_DIR = path.join(__dirname, '..', '..', 'skins');

export interface SkinStateAssets {
  frames: string[];
  fps?: number;
  anim?: unknown;
}

export interface SkinExpressionAssets {
  frames: string[];
  fps: number;
  once: boolean;
  hold: number;
}

export interface ResolvedSkin {
  id: string;
  name: string;
  fps: number;
  assets: {
    states: Record<string, SkinStateAssets>;
    expressions: Record<string, SkinExpressionAssets>;
  };
}

interface SheetSpec {
  grid?: GridSpec;
}

interface SkinJsonV2 {
  version?: number;
  name?: string;
  fps?: number;
  sheets?: Record<string, SheetSpec>;
  states?: Record<string, unknown>;
  expressions?: Record<string, { frames?: unknown; fps?: number; once?: boolean; hold?: number }>;
  /* v1 平铺字段 */
  idle?: unknown; walk?: unknown; tap?: unknown; sleep?: unknown;
  drag?: unknown; pet?: unknown; thrown?: unknown; groom?: unknown;
}

/** 打包后首次运行：把内置皮肤释放到 userData/skins，让用户可自由替换 */
export function ensureUserSkins(): void {
  if (!app.isPackaged) return;
  try {
    fs.mkdirSync(SKINS_DIR, { recursive: true });
    if (fs.readdirSync(SKINS_DIR).some((f) => !f.startsWith('.'))) return;
    if (!fs.existsSync(BUNDLED_SKINS_DIR)) return;
    for (const d of fs.readdirSync(BUNDLED_SKINS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      fs.cpSync(path.join(BUNDLED_SKINS_DIR, d.name), path.join(SKINS_DIR, d.name), { recursive: true });
    }
    console.log('[skin] 已释放内置皮肤到', SKINS_DIR);
  } catch (e) {
    console.error('[skin] 释放内置皮肤失败:', (e as Error).message);
  }
}

/* ─────────────────────────── 抠图 / 切帧缓存 ─────────────────────────── */

interface MattedImage {
  buf: Buffer;
  alpha: Uint8Array;
  w: number;
  h: number;
  bgCount: number;
  n: number;
}

/**
 * 漫水抠图：从中性灰白（棋盘格/浅阴影）像素出发、从四边漫水，只吃连通区域。
 * 不碰被描边包住的白色毛发，也不碰奶油色毛发（有色相）。
 */
function matteImage(src: string): MattedImage {
  let img = nativeImage.createFromPath(src);
  if (img.isEmpty()) throw new Error('无法解码图片');
  const maxSide = 720;
  const orig = img.getSize();
  if (Math.max(orig.width, orig.height) > maxSide) {
    const k = maxSide / Math.max(orig.width, orig.height);
    img = img.resize({ width: Math.max(1, Math.round(orig.width * k)), quality: 'best' });
  }
  const { width: w, height: h } = img.getSize();
  const buf = img.toBitmap(); // 与 createFromBitmap 同格式的回环（alpha 在 +3）
  const n = w * h;
  const bgLike = (p: number): boolean => {
    const i = p * 4;
    const c0 = buf[i]!;
    const c1 = buf[i + 1]!;
    const c2 = buf[i + 2]!;
    const mx = Math.max(c0, c1, c2);
    const mn = Math.min(c0, c1, c2);
    return mx - mn <= 14 && mn >= 190;
  };
  const seen = new Uint8Array(n);
  const q = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  const push = (x: number, y: number): void => {
    const p = y * w + x;
    if (!seen[p] && bgLike(p)) { seen[p] = 1; q[qt++] = p; }
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (qh < qt) {
    const p = q[qh++]!;
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  let bgCount = 0;
  const alpha = new Uint8Array(n);
  let anyFg = false;
  for (let p = 0; p < n; p++) {
    if (seen[p]) { buf[p * 4 + 3] = 0; bgCount++; }
    alpha[p] = buf[p * 4 + 3]!;
    if (alpha[p]! > 8) anyFg = true;
  }
  if (!anyFg) throw new Error('整张图都被判为背景');
  return { buf, alpha, w, h, bgCount, n };
}

interface CellBox { x: number; y: number; w: number; h: number }

/** 按 cell 裁切 bitmap 为独立 PNG；cell=null 时用全图 alpha 包围盒（单图行为） */
function cropImage(m: MattedImage, cell: CellBox | null): Electron.NativeImage {
  const pad = 2;
  let c = cell;
  if (!c) {
    let minX = m.w;
    let minY = m.h;
    let maxX = -1;
    let maxY = -1;
    for (let p = 0; p < m.n; p++) {
      if (m.alpha[p]! <= 8) continue;
      const x = p % m.w;
      const y = (p / m.w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    c = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }
  const x0 = Math.max(0, c.x - pad);
  const y0 = Math.max(0, c.y - pad);
  const x1 = Math.min(m.w, c.x + c.w + pad);
  const y1 = Math.min(m.h, c.y + c.h + pad);
  const cw = x1 - x0;
  const ch = y1 - y0;
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    out.set(m.buf.subarray(((y0 + y) * m.w + x0) * 4, ((y0 + y) * m.w + x1) * 4), y * cw * 4);
  }
  return nativeImage.createFromBitmap(Buffer.from(out.buffer), { width: cw, height: ch });
}

function matteToPng(src: string, dst: string): void {
  const m = matteImage(src);
  fs.writeFileSync(dst, cropImage(m, null).toPNG());
  console.log(`[skin] matte ${path.basename(src)} ${m.w}x${m.h} 背景=${((m.bgCount / m.n) * 100).toFixed(1)}%`);
}

interface CacheResult {
  /** 单图文件名 → 抠图产物路径 */
  built: Record<string, string>;
  /** sheet 文件名 → 切帧产物 */
  sheets: Record<string, { cells: string[]; overflow: boolean }>;
}

interface ManifestEntry {
  mtime: number;
  cells: { file: string; x?: number; y?: number; w?: number; h?: number }[];
  overflow?: boolean;
  warnings?: string[];
}

/**
 * 扫描皮肤目录：单图 → .cache/<base>.png；skin.json sheets 声明的宫格 →
 * 切帧 .cache/<base>-cell-NN.png。manifest.json 记录 src mtime 与切帧结果，
 * 源图未变且 cell 文件齐全时跳过重切（增量缓存）。
 */
function buildCacheForSkin(skinDir: string, cfg: SkinJsonV2 | null): CacheResult {
  const cacheDir = path.join(skinDir, '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const manifestPath = path.join(cacheDir, 'manifest.json');
  let manifest: Record<string, ManifestEntry> = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, ManifestEntry>; } catch { /* 首建 */ }
  const files = fs
    .readdirSync(skinDir)
    .filter((f) => IMG_EXT.has(path.extname(f).toLowerCase()));
  const sheetSpecs = cfg?.sheets ?? {};
  const built: Record<string, string> = {};
  const sheets: Record<string, { cells: string[]; overflow: boolean }> = {};
  const nextManifest: Record<string, ManifestEntry> = {};
  for (const f of files) {
    const src = path.join(skinDir, f);
    const base = path.basename(f, path.extname(f));
    const mtime = fs.statSync(src).mtimeMs;
    const spec = sheetSpecs[f] ?? sheetSpecs[base];
    const cached = manifest[f];
    const cachedPaths = cached && Array.isArray(cached.cells)
      ? cached.cells.map((c) => path.join(cacheDir, c.file))
      : null;
    const freshCells = !!(cachedPaths && cached?.mtime === mtime && cachedPaths.every((p) => fs.existsSync(p)));
    try {
      if (spec) {
        if (freshCells && cachedPaths) {
          sheets[f] = { cells: cachedPaths, overflow: !!cached?.overflow };
          nextManifest[f] = cached!; // 必须回填，否则 manifest 丢 sheet 条目导致下轮重切
        } else {
          const m = matteImage(src);
          const r = spec.grid
            ? splitGrid(m.alpha, m.w, m.h, spec.grid)
            : splitCells(m.alpha, m.w, m.h);
          if (r.overflow || !r.cells.length) {
            const out = path.join(cacheDir, `${base}.png`);
            fs.writeFileSync(out, cropImage(m, null).toPNG());
            sheets[f] = { cells: [out], overflow: true };
            nextManifest[f] = { mtime, cells: [{ file: path.basename(out) }], overflow: true, warnings: r.warnings };
            console.error(`[skin] sheet ${f} 切帧失败/组件过多，回退整图单帧`);
          } else {
            const cells = r.cells.map((c, i) => {
              const file = `${base}-cell-${String(i).padStart(2, '0')}.png`;
              fs.writeFileSync(path.join(cacheDir, file), cropImage(m, c).toPNG());
              return { file, x: c.x, y: c.y, w: c.w, h: c.h };
            });
            sheets[f] = { cells: cells.map((c) => path.join(cacheDir, c.file)), overflow: false };
            nextManifest[f] = { mtime, cells, warnings: r.warnings };
            console.log(`[skin] sheet ${f} → ${cells.length} 帧`, r.warnings.join(' | '));
          }
        }
        continue;
      }
      const out = path.join(cacheDir, `${base}.png`);
      const fresh = fs.existsSync(out) && fs.statSync(out).mtimeMs >= mtime;
      if (!fresh) matteToPng(src, out);
      built[f] = out;
      nextManifest[f] = { mtime, cells: [{ file: path.basename(out) }] };
    } catch (e) {
      console.error('[skin] 处理失败', f, (e as Error).message);
    }
  }
  try {
    // 内容不变不重写：manifest 写入会触发 watchSkins 自循环重载
    const json = JSON.stringify(nextManifest, null, 1);
    let prev: string | null = null;
    try { prev = fs.readFileSync(manifestPath, 'utf8'); } catch { /* 首建 */ }
    if (prev !== json) fs.writeFileSync(manifestPath, json);
  } catch (e) {
    console.error('[skin] manifest 写入失败', (e as Error).message);
  }
  return { built, sheets };
}

/* ─────────────────────────── skin.json 解析 ─────────────────────────── */

/**
 * skin.json v1/v2 → 统一 v2 assets:{ states:{name:{frames[],fps?,anim?}}, expressions:{...} }
 * frames 取值：string（单图/整表 sheet）| string[]（单图序列）| {sheet,cells[],frames[],fps,anim}
 * 返回 null = 没有可用皮肤（渲染层回退程序化线稿猫）。
 */
export function resolveSkin(): ResolvedSkin | null {
  if (!fs.existsSync(SKINS_DIR)) return null;
  const ids = fs
    .readdirSync(SKINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
  for (const id of ids) {
    const dir = path.join(SKINS_DIR, id);
    let cfg: SkinJsonV2 = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'skin.json'), 'utf8')) as SkinJsonV2; } catch { /* 无配置按 v1 空处理 */ }
    const { built, sheets } = buildCacheForSkin(dir, cfg);
    const names = Object.keys(built);
    if (!names.length && !Object.keys(sheets).length) continue;
    const url = (p: string | null | undefined): string | null => (p ? pathToFileURL(p).href : null);
    const findSingle = (name: unknown): string | null => {
      if (!name || typeof name !== 'string') return null;
      if (built[name]) return built[name]!;
      const hit = names.find((f) => f.toLowerCase() === name.toLowerCase());
      return hit ? built[hit]! : null;
    };
    interface FramesResult { frames: string[]; fps?: number; anim?: unknown }
    const framesOf = (v: unknown): FramesResult | null => {
      if (!v) return null;
      if (typeof v === 'string') {
        if (sheets[v]) return { frames: sheets[v]!.cells.map((c) => url(c)!).filter(Boolean) as string[] };
        const p = findSingle(v);
        return p ? { frames: [url(p)!] } : null;
      }
      if (Array.isArray(v)) {
        const frames: string[] = [];
        for (const item of v) {
          if (typeof item === 'string' && sheets[item]) frames.push(...sheets[item]!.cells.map((c) => url(c)!));
          else {
            const p = findSingle(item);
            if (p) frames.push(url(p)!);
          }
        }
        return frames.length ? { frames } : null;
      }
      if (typeof v === 'object') {
        const o = v as { sheet?: string; cells?: number[]; frames?: unknown[]; fps?: number; anim?: unknown };
        let frames: string[] = [];
        if (o.sheet && sheets[o.sheet]) {
          const all = sheets[o.sheet]!.cells;
          frames = Array.isArray(o.cells) && o.cells.length
            ? o.cells.filter((i) => i >= 0 && i < all.length).map((i) => url(all[i]!)!)
            : all.map((c) => url(c)!);
        }
        if (Array.isArray(o.frames)) {
          for (const item of o.frames) {
            if (typeof item === 'string' && sheets[item]) frames.push(...sheets[item]!.cells.map((c) => url(c)!));
            else {
              const p = findSingle(item);
              if (p) frames.push(url(p)!);
            }
          }
        }
        return frames.length ? { frames, fps: o.fps, anim: o.anim } : null;
      }
      return null;
    };
    const states: Record<string, SkinStateAssets> = {};
    const put = (name: string, f: FramesResult | null): void => {
      if (f && f.frames && f.frames.length) states[name] = { frames: f.frames, fps: f.fps, anim: f.anim };
    };
    if (cfg.version === 2 && cfg.states) {
      for (const [name, spec] of Object.entries(cfg.states)) put(name, framesOf(spec));
    } else {
      put('idle', framesOf(cfg.idle));
      put('walk', framesOf(cfg.walk));
      put('tap', framesOf(cfg.tap));
      put('sleep', framesOf(cfg.sleep));
      put('drag', framesOf(cfg.drag));
      put('pet', framesOf(cfg.pet));
      put('thrown', framesOf(cfg.thrown));
      put('groom', framesOf(cfg.groom ?? cfg.tap));
    }
    if (!states['idle'] && names.length) put('idle', framesOf(names.slice().sort()[0]));
    if (!states['idle']) continue;
    const expressions: Record<string, SkinExpressionAssets> = {};
    if (cfg.version === 2 && cfg.expressions) {
      for (const [name, spec] of Object.entries(cfg.expressions)) {
        const f = framesOf(spec);
        if (!f) continue;
        expressions[name] = {
          frames: f.frames,
          fps: spec?.fps ?? cfg.fps ?? 8,
          once: !spec || spec.once !== false,
          hold: spec?.hold ?? 0,
        };
      }
    }
    return {
      id,
      name: cfg.name ?? id,
      fps: cfg.fps ?? 8,
      assets: { states, expressions },
    };
  }
  return null;
}

/* ─────────────────────────── 目录监听 ─────────────────────────── */

/** 皮肤目录变化 → 防抖回调（渲染层热重载）。返回停止函数。 */
export function watchSkins(onChange: () => void): () => void {
  let watcher: fs.FSWatcher | null = null;
  try {
    if (!fs.existsSync(SKINS_DIR)) fs.mkdirSync(SKINS_DIR, { recursive: true });
    let t: ReturnType<typeof setTimeout> | null = null;
    watcher = fs.watch(SKINS_DIR, { recursive: true }, () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; onChange(); }, 700);
    });
  } catch (e) {
    console.error('[skin] 目录监听失败', (e as Error).message);
  }
  return () => { try { watcher?.close(); } catch { /* 已关闭 */ } };
}
