/* API Key 配置面板 UX 测试：无 key 服务 → 面板出现 → 格式错即时提示 → 假 key 真探针被拒
 * → 保存失败不落存 → file:// 无服务时面板隐藏。
 * 运行：cd energy-pet && env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/site-verify/studio-key.cjs
 */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const ROOT = path.join(OUT, '..', '..');
const PORT = 4398;
app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const info = {};
const errors = [];

async function waitServer(timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/cat-skin/status`)).ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

app.whenReady().then(async () => {
  // 无 mock、无 key 的服务
  const srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve-site.mjs'), String(PORT)], {
    env: { ...process.env, DASHSCOPE_API_KEY: '', CAT_SKIN_MOCK: '', ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
  });
  if (!(await waitServer())) { console.log('FAIL server-not-up'); srv.kill(); app.quit(); return; }

  const win = new BrowserWindow({ width: 1440, height: 1000, show: false });
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning') && !/cat-skin|ERR_FAILED/.test(message)) errors.push(message);
  });
  await win.loadURL(`http://127.0.0.1:${PORT}/`);
  await sleep(1200);

  // 1. 未配置态：横幅 + Key 面板出现，步骤灰掉，keyNote 隐藏
  info.panelVisible = await win.webContents.executeJavaScript(`!document.querySelector('#stu-key').hidden`);
  info.offText = await win.webContents.executeJavaScript(`document.querySelector('#stu-off-txt').textContent.slice(0, 12)`);
  info.stepsDisabled = await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#stu-step1')).pointerEvents === 'none'`);
  info.keyPanelInteractive = await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#stu-key')).pointerEvents !== 'none'`);
  info.noteHidden = await win.webContents.executeJavaScript(`document.querySelector('#stu-keynote').hidden`);
  info.goDisabled = await win.webContents.executeJavaScript(`document.querySelector('#stu-go').disabled`);

  // 2. 格式错（非 sk- 开头）：即时本地提示，不打网络
  info.formatErr = await win.webContents.executeJavaScript(`(async () => {
    const i = document.querySelector('#stu-key-input');
    i.value = 'abc123';
    document.querySelector('#stu-key-test').click();
    await new Promise(r => setTimeout(r, 300));
    const m = document.querySelector('#stu-key-msg');
    return { kind: m.dataset.kind, text: m.textContent.slice(0, 20), hidden: m.hidden };
  })()`);

  // 3. 假 key 真探针：测试连接 → InvalidApiKey 拒绝
  info.fakeProbe = await win.webContents.executeJavaScript(`(async () => {
    const i = document.querySelector('#stu-key-input');
    i.value = 'sk-invalid000000000000';
    document.querySelector('#stu-key-test').click();
    for (let n = 0; n < 40; n++) {
      await new Promise(r => setTimeout(r, 500));
      const m = document.querySelector('#stu-key-msg');
      if (!m.hidden && m.dataset.kind !== 'run') return { kind: m.dataset.kind, text: m.textContent.slice(0, 40) };
    }
    return { kind: 'timeout', text: '' };
  })()`);

  // 4. 假 key 保存并启用 → 拒绝且不落存（status 仍 disabled，面板仍在）
  info.fakeSave = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('#stu-key-save').click();
    for (let n = 0; n < 40; n++) {
      await new Promise(r => setTimeout(r, 500));
      const m = document.querySelector('#stu-key-msg');
      if (!m.hidden && m.dataset.kind !== 'run') return { kind: m.dataset.kind, text: m.textContent.slice(0, 40) };
    }
    return { kind: 'timeout', text: '' };
  })()`);
  info.stillDisabled = await win.webContents.executeJavaScript(`(async () => {
    const s = await (await fetch('/api/cat-skin/status')).json();
    return { enabled: s.enabled, panelVisible: !document.querySelector('#stu-key').hidden };
  })()`);

  // 5. 勾选「记住」后刷新 → 因保存失败本无存储；直接验证 localStorage 为空
  info.lsEmpty = await win.webContents.executeJavaScript(`!localStorage.getItem('creamcat.studio.cfg')`);

  await win.webContents.executeJavaScript(`document.querySelector('#studio').scrollIntoView();`);
  await sleep(400);
  fs.writeFileSync(path.join(OUT, 'studio-key.png'), (await win.webContents.capturePage()).toPNG());

  // 6. file:// 无服务：横幅=未接入，Key 面板隐藏（填了也没用）
  await win.loadFile(path.join(ROOT, 'site', 'index.html'));
  await sleep(1400);
  info.fileNoPanel = await win.webContents.executeJavaScript(`document.querySelector('#stu-key').hidden && !document.querySelector('#stu-off').hidden`);
  info.fileOffText = await win.webContents.executeJavaScript(`document.querySelector('#stu-off-txt').textContent.slice(0, 7)`);

  console.log('KEY-INFO ' + JSON.stringify(info, null, 1));
  console.log(errors.length ? 'ERRORS: ' + errors.join(' | ') : 'NO-ERRORS');
  srv.kill();
  app.quit();
});
