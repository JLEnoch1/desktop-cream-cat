/**
 * 测试构建 —— 把 tests/*.ts 编译为 dist-tests/*.mjs 供 node --test 运行。
 * 领域模块（ledger/emotion/insight/...）不依赖 electron，可直接在 node 下跑。
 */

import { build } from 'esbuild';
import { globSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-tests');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const files = globSync('tests/**/*.test.ts', { cwd: root });
if (!files.length) {
  console.warn('[build-tests] no test files found');
  process.exit(0);
}

await build({
  entryPoints: files.map(f => join(root, f)),
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['electron', 'node:sqlite', 'node:test', 'node:assert'],
  logLevel: 'warning',
});

console.log(`[build-tests] compiled ${files.length} test file(s) →`, out);
