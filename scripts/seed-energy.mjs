/**
 * 截图工具：向指定 userData 目录的 ledger DB 种一条 energy.set 事件，
 * 让下一次 --selfcheck 启动时以指定精力渲染（供 10 档视觉验收序列）。
 * 用法：node scripts/seed-energy.mjs <userDataDir> <energy>
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [dir, energy] = process.argv.slice(2);
if (!dir || energy === undefined) {
  console.error('usage: seed-energy.mjs <userDataDir> <energy>');
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(join(dir, 'energy-pet.db'));
// 与 src/storage/sqlite.ts SCHEMA_SQL 的最小兼容子集（app 启动时 IF NOT EXISTS 会补齐其余表）
db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, at INTEGER NOT NULL, source TEXT NOT NULL,
  predicted_delta REAL, actual_delta REAL, energy_after REAL, payload TEXT NOT NULL
);`);
const target = Number(energy);
const INITIAL = 7; // src/ledger/fold.ts INITIAL_ENERGY
db.prepare('INSERT INTO events (type, at, source, predicted_delta, actual_delta, energy_after, payload) VALUES (?,?,?,?,?,?,?)')
  .run('energy.set', Date.now(), 'user', null, target - INITIAL, target,
    JSON.stringify({ kind: 'energy.set', before: INITIAL, target, reason: 'seed for screenshot' }));
db.close();
console.log(`seeded energy=${target} → ${join(dir, 'energy-pet.db')}`);
