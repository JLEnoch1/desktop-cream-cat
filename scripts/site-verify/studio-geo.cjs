/* #studio 区块几何/样式审计：mock 快速跑完生成后测量桌面与移动端布局。
 * 运行：cd energy-pet && env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/site-verify/studio-geo.cjs
 */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PORT = 4396;
app.disableHardwareAcceleration();
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve-site.mjs'), String(PORT)], {
    env: { ...process.env, CAT_SKIN_MOCK: '1', ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/cat-skin/status`)).ok) break; } catch {}
    await sleep(250);
  }
  const win = new BrowserWindow({ width: 1440, height: 1000, show: false });
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message);
  });
  await win.loadURL(`http://127.0.0.1:${PORT}/`);
  await sleep(900);

  // 注入参考 + 跑完 mock 生成
  await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = 'assets/poses/cat-idle.webp';
    await new Promise(r => img.onload = r);
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,c.width,c.height); x.drawImage(img,0,0);
    window.__catStudio.addRef(c.toDataURL('image/jpeg',.9),'geo');
    document.querySelector('#stu-go').click();
  })()`);
  for (let i = 0; i < 90; i++) {
    const done = await win.webContents.executeJavaScript(`document.querySelectorAll('.stu-card.is-done').length`);
    if (done === 19) break;
    await sleep(500);
  }
  await sleep(400);

  const geo = await win.webContents.executeJavaScript(`(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return {w:Math.round(b.width),h:Math.round(b.height),vis:b.width>0&&b.height>0,border:cs.borderTopStyle,bg:cs.backgroundColor,display:cs.display}; };
    const grid = document.querySelector('#stu-grid'); const gb = grid.getBoundingClientRect();
    const cards = [...grid.children].map(c => { const b = c.getBoundingClientRect(); const im = c.querySelector('img'); return {w:Math.round(b.width), top:Math.round(b.top), imgOk: im && im.naturalWidth > 1 && getComputedStyle(im).display !== 'none'}; });
    const rows = new Set(cards.map(c => c.top)).size;
    const sec = document.querySelector('#studio').getBoundingClientRect();
    return {
      section: {w:Math.round(sec.width),h:Math.round(sec.height)},
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panel: r('#stu-panel'), drop: r('#stu-drop'), go: r('#stu-go'),
      opts: r('#stu-opts'), optPills: document.querySelectorAll('.stu-opt').length,
      optCheckedBg: getComputedStyle(document.querySelector('.stu-opt:has(input:checked)')).borderTopColor,
      gridW: Math.round(gb.width), cardCount: cards.length, rows, cardW: cards[0] && cards[0].w,
      allImgsOk: cards.every(c => c.imgOk), equalW: cards.every(c => Math.abs(c.w - cards[0].w) <= 1),
      step3: r('#stu-step3'), installLis: document.querySelectorAll('.stu-install li').length,
      barW: r('#stu-bar-fill').w > 0, offHidden: document.querySelector('#stu-off').hidden,
      navStudio: !!document.querySelector('.topnav a[href="#studio"]'),
    };
  })()`);
  console.log('GEO-DESKTOP ' + JSON.stringify(geo, null, 1));

  // 移动端
  win.setContentSize(430, 900);
  await sleep(500);
  const geoM = await win.webContents.executeJavaScript(`(() => {
    const grid = document.querySelector('#stu-grid');
    const cards = [...grid.children].map(c => Math.round(c.getBoundingClientRect().width));
    const run = getComputedStyle(document.querySelector('.stu-run'));
    const input = document.querySelector('#stu-name').getBoundingClientRect();
    const go = document.querySelector('#stu-go').getBoundingClientRect();
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cardMin: Math.min(...cards), cardMax: Math.max(...cards),
      runDir: run.flexDirection, inputW: Math.round(input.width), goW: Math.round(go.width),
      dropVisible: document.querySelector('#stu-drop').getBoundingClientRect().height > 50,
    };
  })()`);
  console.log('GEO-MOBILE ' + JSON.stringify(geoM));
  console.log(errors.length ? 'ERRORS: ' + errors.join(' | ') : 'NO-ERRORS');
  srv.kill();
  app.quit();
});
