/* AI 毛发定制工坊 E2E：mock 服务 + 完整生成流程（像素风 × 姿态+部件 19 件）+ zip 下载校验
 * + 输出勾选切换行为 + 禁用态/移动端截图（画风已固定像素游戏风）。
 * 运行：cd energy-pet && env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/site-verify/studio-e2e.cjs
 */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const ROOT = path.join(OUT, '..', '..');
const PORT = 4399;
const ZIP_OUT = path.join(OUT, 'studio-skin-e2e.zip');
const TOTAL = 19; // 7 姿态 + 12 部件
app.disableHardwareAcceleration();

const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitServer(timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/cat-skin/status`);
      if (r.ok) return true;
    } catch { /* retry */ }
    await sleep(250);
  }
  return false;
}

app.whenReady().then(async () => {
  if (fs.existsSync(ZIP_OUT)) fs.unlinkSync(ZIP_OUT);
  const srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve-site.mjs'), String(PORT)], {
    env: { ...process.env, CAT_SKIN_MOCK: '1', ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
  });
  if (!(await waitServer())) { console.log('FAIL server-not-up'); srv.kill(); app.quit(); return; }

  const win = new BrowserWindow({ width: 1440, height: 1000, show: false });
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) errors.push('console: ' + message);
  });

  let zipDone = null;
  win.webContents.session.on('will-download', (e, item) => {
    item.setSavePath(ZIP_OUT);
    item.once('done', () => { zipDone = { state: 'completed', size: fs.existsSync(ZIP_OUT) ? fs.statSync(ZIP_OUT).size : 0 }; });
  });

  const info = {};
  await win.loadURL(`http://127.0.0.1:${PORT}/`);
  await sleep(1200);

  // ── 1. 服务可用态 + 默认 19 卡（姿态+部件全勾） ──
  info.offHidden = await win.webContents.executeJavaScript(`document.querySelector('#stu-off').hidden`);
  info.keyPanelHidden = await win.webContents.executeJavaScript(`document.querySelector('#stu-key').hidden && document.querySelector('#stu-keynote').hidden`);
  info.initCards = await win.webContents.executeJavaScript(`document.querySelectorAll('.stu-card').length`);
  info.goLabelInit = await win.webContents.executeJavaScript(`document.querySelector('#stu-go').textContent`);

  // ── 2. 输出勾选切换：去部件→7 卡，勾回→19 卡 ──
  info.cardsPosesOnly = await win.webContents.executeJavaScript(`(() => {
    const c = document.querySelector('#stu-opt-parts'); c.checked = false; c.dispatchEvent(new Event('change'));
    return document.querySelectorAll('.stu-card').length;
  })()`);
  info.cardsBoth = await win.webContents.executeJavaScript(`(() => {
    const c = document.querySelector('#stu-opt-parts'); c.checked = true; c.dispatchEvent(new Event('change'));
    return document.querySelectorAll('.stu-card').length;
  })()`);

  // ── 3. 注入参考图（画风已固定像素游戏风，无选择器） ──
  info.refsAdded = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'assets/poses/cat-idle.webp';
    await new Promise((r, j) => { img.onload = r; img.onerror = j; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    window.__catStudio.addRef(c.toDataURL('image/jpeg', .9), 'e2e-cat');
    return window.__catStudio.state.refs.length;
  })()`);
  info.styleFixed = await win.webContents.executeJavaScript(`window.__catStudio.state.style`);
  info.noStyleRadio = await win.webContents.executeJavaScript(`document.querySelectorAll('input[name="stu-style"]').length === 0 && !!document.querySelector('.stu-opt.is-fixed')`);
  info.goEnabled = await win.webContents.executeJavaScript(`!document.querySelector('#stu-go').disabled`);
  await win.webContents.executeJavaScript(`document.querySelector('#studio').scrollIntoView(); document.querySelector('#stu-name').value = '布丁E2E';`);
  await sleep(400);
  fs.writeFileSync(path.join(OUT, 'studio-step1.png'), (await win.webContents.capturePage()).toPNG());

  // ── 4. 触发生成，中途截图 ──
  await win.webContents.executeJavaScript(`document.querySelector('#stu-go').click()`);
  await sleep(2400);
  info.midDone = await win.webContents.executeJavaScript(`document.querySelectorAll('.stu-card.is-done').length`);
  info.midGen = await win.webContents.executeJavaScript(`document.querySelectorAll('.stu-card.is-gen').length`);
  info.progressTxt = await win.webContents.executeJavaScript(`document.querySelector('#stu-progress-txt').textContent`);
  await win.webContents.executeJavaScript(`document.querySelector('#stu-grid').scrollIntoView({block:'center'});`);
  await sleep(300);
  fs.writeFileSync(path.join(OUT, 'studio-gen.png'), (await win.webContents.capturePage()).toPNG());

  // ── 5. 等待 19 件全部完成 ──
  for (let i = 0; i < 90; i++) {
    info.doneCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.stu-card.is-done').length`);
    info.busy = await win.webContents.executeJavaScript(`window.__catStudio.state.busy`);
    if (info.doneCount === TOTAL && !info.busy) break;
    await sleep(500);
  }
  info.step3Visible = await win.webContents.executeJavaScript(`!document.querySelector('#stu-step3').hidden`);
  info.zipName = await win.webContents.executeJavaScript(`document.querySelector('#stu-zip-name').textContent`);
  await win.webContents.executeJavaScript(`document.querySelector('#studio').scrollIntoView();`);
  await sleep(500);
  fs.writeFileSync(path.join(OUT, 'studio-done.png'), (await win.webContents.capturePage()).toPNG());

  // ── 6. zip 下载 ──
  await win.webContents.executeJavaScript(`document.querySelector('#stu-zip').click()`);
  for (let i = 0; i < 20 && !zipDone; i++) await sleep(300);
  info.zip = zipDone;
  info.mainPhaseErrors = errors.slice();

  // ── 7. 画风固定像素：生成后结果完整、无画风切换 UI ──
  info.resultsIntact = await win.webContents.executeJavaScript(`({
    style: window.__catStudio.state.style,
    results: Object.keys(window.__catStudio.state.results).length,
    styleRadios: document.querySelectorAll('input[name="stu-style"]').length,
  })`);

  // ── 8. 移动端布局（重新生成一轮太慢，只测布局：直接量选项行与网格） ──
  win.setContentSize(430, 900);
  await sleep(400);
  await win.webContents.executeJavaScript(`document.querySelector('#studio').scrollIntoView();`);
  await sleep(400);
  fs.writeFileSync(path.join(OUT, 'studio-mobile.png'), (await win.webContents.capturePage()).toPNG());
  info.mobileOverflow = await win.webContents.executeJavaScript(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);

  // ── 9. file:// 禁用态 ──
  errors.length = 0;
  await win.loadFile(path.join(ROOT, 'site', 'index.html'));
  await sleep(1500);
  info.fileOffVisible = await win.webContents.executeJavaScript(`!document.querySelector('#stu-off').hidden && document.querySelector('#stu-panel').classList.contains('is-off')`);
  const fileErrs = errors.filter((e) => !/ERR_UNKNOWN_URL_SCHEME|ERR_FAILED|cat-skin/.test(e));
  fs.writeFileSync(path.join(OUT, 'studio-off.png'), (await win.webContents.capturePage()).toPNG());

  console.log('INFO ' + JSON.stringify(info, null, 1));
  console.log(fileErrs.length ? 'FILE-PHASE-ERRORS:\n' + fileErrs.join('\n') : 'FILE-PHASE-CLEAN');
  srv.kill();
  app.quit();
});
