/**
 * 构建脚本 —— esbuild 四路打包（v2.0 奶油猫融合版）：
 *   main        → dist/main/index.js          (cjs, electron 主进程)
 *   preload     → dist/preload/index.js       (cjs, sandbox:false)
 *   renderer 猫 → dist/renderer/cat/cat.js    (iife) + cat.html/cat.css
 *   renderer UI → dist/renderer/ui/ui.js      (iife) + ui.html/ui.css
 */

import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: 'es2022',
};

// ── 主进程 ──
await build({
  ...common,
  entryPoints: [join(root, 'src/main/index.ts')],
  outfile: join(dist, 'main/index.js'),
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

// ── preload ──
await build({
  ...common,
  entryPoints: [join(root, 'src/preload/index.ts')],
  outfile: join(dist, 'preload/index.js'),
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

// ── 渲染进程：猫窗口 ──
await build({
  ...common,
  entryPoints: [join(root, 'src/renderer/cat/cat-app.ts')],
  outfile: join(dist, 'renderer/cat/cat.js'),
  platform: 'browser',
  format: 'iife',
});

// ── 渲染进程：UI 卡片窗口 ──
await build({
  ...common,
  entryPoints: [join(root, 'src/renderer/ui/ui-app.ts')],
  outfile: join(dist, 'renderer/ui/ui.js'),
  platform: 'browser',
  format: 'iife',
});

// ── 静态资源 ──
cpSync(join(root, 'src/renderer/cat/cat.html'), join(dist, 'renderer/cat/cat.html'));
cpSync(join(root, 'src/renderer/cat/cat.css'), join(dist, 'renderer/cat/cat.css'));
cpSync(join(root, 'src/renderer/ui/ui.html'), join(dist, 'renderer/ui/ui.html'));
cpSync(join(root, 'src/renderer/ui/ui.css'), join(dist, 'renderer/ui/ui.css'));

console.log('[build] done →', dist);
