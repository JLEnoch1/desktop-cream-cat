/**
 * 原生 helper 生命周期（移植自 desktop-pet main.js）—— macOS 专用：
 *  - keytap：CGEventTap listen-only 全局敲键（Bongo Cat），stdout 行协议 `K|U <code>`
 *  - winlist：CGWindowListCopyWindowInfo 窗口矩形采集（顶边散步），stdout JSON 行
 *
 * 开发态首次启动 swiftc 编译；打包态随 extraResources 落到 resources/native/。
 * 采集/监听失败自动降级（无敲键 / 纯地面模式），不影响主流程。
 */

import { app, screen, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import * as readline from 'node:readline';
import { filterLedges, screenTopLedge } from './ledges.js';
import type { CatLedge } from '../core/types.js';

const isMac = process.platform === 'darwin';

const helperBin = app.isPackaged
  ? path.join(process.resourcesPath, 'native', 'keytap')
  : path.join(__dirname, '..', '..', 'native', 'keytap');
const helperSrc = path.join(__dirname, '..', '..', 'native', 'keytap.swift');
const winlistBin = app.isPackaged
  ? path.join(process.resourcesPath, 'native', 'winlist')
  : path.join(__dirname, '..', '..', 'native', 'winlist');
const winlistSrc = path.join(__dirname, '..', '..', 'native', 'winlist.swift');

export type KeyAccess = 'unknown' | 'ok' | 'no-access' | 'unavailable';

export interface NativeEvents {
  onKey(d: { code: number; down: boolean }): void;
  onKeyStatus(ok: boolean): void;
  /** ledge 集合变化：新列表 + 消失的 id（猫正站在其上时需落下） */
  onLedges(ledges: CatLedge[], gone: (number | string)[]): void;
}

export class NativeHelpers {
  keyAccess: KeyAccess = 'unknown';
  ledgeWalk = true;

  private keytapProc: ReturnType<typeof spawn> | null = null;
  private winlistProc: ReturnType<typeof spawn> | null = null;
  private lastLedges: CatLedge[] = [];
  private readonly ev: NativeEvents;

  constructor(ev: NativeEvents) {
    this.ev = ev;
  }

  /* ─────────────────────────── keytap（全局敲键） ─────────────────────────── */

  /** 首次启动或源码更新时用 swiftc 编译（打包态由 build-helper 预编译进资源） */
  ensureHelper(): void {
    if (!isMac) { this.keyAccess = 'unavailable'; return; }
    if (app.isPackaged) {
      try {
        if (!fs.existsSync(helperBin)) throw new Error('缺少 native/keytap');
        fs.chmodSync(helperBin, 0o755);
        return;
      } catch (e) {
        console.error('[helper] 打包 helper 不可用:', (e as Error).message);
        this.keyAccess = 'unavailable';
        return;
      }
    }
    try {
      const srcMtime = fs.statSync(helperSrc).mtimeMs;
      if (!fs.existsSync(helperBin) || fs.statSync(helperBin).mtimeMs < srcMtime) {
        console.log('[helper] swiftc 编译 keytap…');
        execFileSync('swiftc', ['-O', helperSrc, '-o', helperBin], { stdio: 'inherit' });
        fs.chmodSync(helperBin, 0o755);
      }
    } catch (e) {
      console.error('[helper] 编译失败(敲键功能不可用):', (e as Error).message);
      this.keyAccess = 'unavailable';
    }
  }

  startKeytap(): void {
    if (!isMac || this.keytapProc) return;
    if (this.keyAccess === 'unavailable') { this.ensureHelper(); }
    if (!fs.existsSync(helperBin)) { this.keyAccess = 'unavailable'; return; }
    try {
      const p = spawn(helperBin, [], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.keytapProc = p;
      this.keyAccess = 'unknown';
      const rl = readline.createInterface({ input: p.stdout! });
      rl.on('line', (line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) return;
        if (parts[0] === 'STATUS') {
          this.keyAccess = parts[1] === 'ok' ? 'ok' : 'no-access';
          this.ev.onKeyStatus(this.keyAccess === 'ok');
          return;
        }
        if (parts[0] !== 'K' && parts[0] !== 'U') return;
        const code = Number(parts[1]);
        if (Number.isFinite(code)) this.ev.onKey({ code, down: parts[0] === 'K' });
      });
      p.stderr?.on('data', (d) => console.error('[helper]', String(d).trim()));
      p.on('exit', (c) => {
        console.log('[helper] keytap 退出 code=', c);
        this.keytapProc = null;
        this.keyAccess = c === 2 ? 'no-access' : 'unknown';
        this.ev.onKeyStatus(false); // 进程已退出，敲键必然不可用
      });
    } catch (e) {
      console.error('[helper] 启动失败:', (e as Error).message);
      this.keytapProc = null;
      this.keyAccess = 'unavailable';
    }
  }

  stopKeytap(): void {
    if (this.keytapProc) { this.keytapProc.kill(); this.keytapProc = null; }
  }

  openAccessibilitySettings(): void {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  }

  /* ─────────────────────────── winlist（窗口顶边采集） ─────────────────────────── */

  ensureWinlist(): void {
    if (!isMac) return;
    if (app.isPackaged) {
      try {
        if (!fs.existsSync(winlistBin)) throw new Error('缺少 native/winlist');
        fs.chmodSync(winlistBin, 0o755);
        return;
      } catch (e) {
        console.error('[winlist] 打包 helper 不可用:', (e as Error).message);
        return;
      }
    }
    try {
      const srcMtime = fs.statSync(winlistSrc).mtimeMs;
      if (!fs.existsSync(winlistBin) || fs.statSync(winlistBin).mtimeMs < srcMtime) {
        console.log('[winlist] swiftc 编译 winlist…');
        execFileSync('swiftc', ['-O', winlistSrc, '-o', winlistBin], { stdio: 'inherit' });
        fs.chmodSync(winlistBin, 0o755);
      }
    } catch (e) {
      console.error('[winlist] 编译失败(顶边散步不可用):', (e as Error).message);
    }
  }

  startWinlist(): void {
    if (!isMac || this.winlistProc) return;
    this.ensureWinlist();
    if (!fs.existsSync(winlistBin)) return;
    try {
      const p = spawn(winlistBin, [], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.winlistProc = p;
      const rl = readline.createInterface({ input: p.stdout! });
      let lastJson = '';
      rl.on('line', (line) => {
        if (!line || line === lastJson) return; // 1Hz diff 推送
        lastJson = line;
        try {
          const wins = JSON.parse(line) as unknown;
          this.computeLedges(wins);
        } catch { /* 半行 JSON,忽略 */ }
      });
      p.stderr?.on('data', (d) => console.error('[winlist]', String(d).trim()));
      p.on('exit', (c) => {
        console.log('[winlist] 退出 code=', c);
        this.winlistProc = null;
        this.pushLedges([]); // 采集失败 → 纯地面模式
      });
    } catch (e) {
      console.error('[winlist] 启动失败:', (e as Error).message);
      this.winlistProc = null;
      this.pushLedges([]);
    }
  }

  stopWinlist(): void {
    if (this.winlistProc) { this.winlistProc.kill(); this.winlistProc = null; }
    this.pushLedges([]);
  }

  setLedgeWalk(on: boolean): void {
    this.ledgeWalk = on;
    if (on) this.startWinlist();
    else this.stopWinlist();
  }

  /** 工作区变化（显示器/分辨率）后强制下一行窗口数据重算 ledge */
  invalidateWinlist(): void {
    // winlist 进程自身 1Hz diff;工作区变化时直接重算现有集合并推送
    this.computeLedges(this.lastWins ?? []);
  }

  private lastWins: unknown = [];

  private computeLedges(wins: unknown): void {
    this.lastWins = wins;
    const wa = screen.getPrimaryDisplay().workArea;
    const selfPid = process.pid;
    const filtered = filterLedges(wins, { workArea: { x: wa.x, y: wa.y, width: wa.width, height: wa.height }, selfPid });
    const ledges: CatLedge[] = [screenTopLedge({ workArea: { x: wa.x, y: wa.y, width: wa.width, height: wa.height } }), ...filtered];
    this.pushLedges(ledges);
  }

  private pushLedges(next: CatLedge[]): void {
    const prevIds = new Set(this.lastLedges.map((l) => l.id));
    const nextIds = new Set(next.map((l) => l.id));
    const gone = [...prevIds].filter((id) => !nextIds.has(id));
    this.lastLedges = next;
    this.ev.onLedges(next, gone);
  }

  killAll(): void {
    this.stopKeytap();
    if (this.winlistProc) { this.winlistProc.kill(); this.winlistProc = null; }
  }
}
