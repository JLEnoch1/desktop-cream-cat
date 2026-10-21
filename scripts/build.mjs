/**
 * 构建脚本 —— esbuild 三路打包：
 *   main     → dist/main/index.js       (cjs, electron 主进程)
 *   preload  → dist/preload/index.js    (cjs, sandbox:false)
 *   renderer → dist/renderer/renderer.js (iife) + 复制 index.html / styles.css
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

// ── 渲染进程 ──
await build({
  ...common,
  entryPoints: [join(root, 'src/renderer/app.ts')],
  outfile: join(dist, 'renderer/renderer.js'),
  platform: 'browser',
  format: 'iife',
});

// ── 静态资源 ──
cpSync(join(root, 'src/renderer/index.html'), join(dist, 'renderer/index.html'));
cpSync(join(root, 'src/renderer/styles.css'), join(dist, 'renderer/styles.css'));

console.log('[build] done →', dist);
