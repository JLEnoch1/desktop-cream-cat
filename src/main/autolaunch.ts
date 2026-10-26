/**
 * 开机自启（移植自 desktop-pet main.js）。
 *
 * 首次运行（打包态）默认打开自启并落 `.autolaunch-initialized` 标记，
 * 之后完全尊重用户的手动开关——用户关掉后不会被下次启动重新打开。
 * 开发态不碰本机登录项。
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

const isMac = process.platform === 'darwin';

const AUTOLAUNCH_MARKER = path.join(app.getPath('userData'), '.autolaunch-initialized');

export function autoLaunchOn(): boolean {
  try { return !!app.getLoginItemSettings().openAtLogin; } catch { return false; }
}

export function setAutoLaunch(enabled: boolean): boolean {
  try {
    // 不传 openAsHidden：应用是 LSUIElement（无 Dock 图标），登录启动天然无窗口抢占；
    // 且 Electron 44 的 Settings 类型已不含该字段。
    app.setLoginItemSettings(
      isMac
        ? { openAtLogin: enabled }
        : { openAtLogin: enabled, path: process.execPath, args: [] as string[] },
    );
    fs.mkdirSync(path.dirname(AUTOLAUNCH_MARKER), { recursive: true });
    fs.writeFileSync(AUTOLAUNCH_MARKER, `${enabled ? 'on' : 'off'} ${new Date().toISOString()}\n`);
    console.log(`[boot] 开机自启 → ${enabled ? '开' : '关'}`);
    return true;
  } catch (e) {
    console.error('[boot] 设置开机自启失败:', (e as Error).message);
    return false;
  }
}

/** 安装后首次启动：默认开机自启（无任何引导弹窗）；开发态不碰本机登录项 */
export function bootstrapAutoLaunch(): void {
  if (!app.isPackaged) return;
  try {
    if (fs.existsSync(AUTOLAUNCH_MARKER)) return;
    if (!autoLaunchOn()) setAutoLaunch(true);
    else fs.writeFileSync(AUTOLAUNCH_MARKER, `on ${new Date().toISOString()}\n`);
  } catch (e) {
    console.error('[boot] 初始化开机自启失败:', (e as Error).message);
  }
}
