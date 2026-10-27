const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
app.disableHardwareAcceleration();
const errors = [];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false });
  win.webContents.on('console-message', (e, level, message) => { if (level >= 2 && !message.includes('Electron Security Warning')) errors.push('console: ' + message); });
  win.webContents.on('did-fail-load', (e, code, desc, url) => errors.push(`fail ${code} ${desc} ${url}`));
  await win.loadFile(path.join(OUT, '..', '..', 'site', 'index.html'));
  await new Promise(r => setTimeout(r, 1500));
  const info = await win.webContents.executeJavaScript(`(async () => {
    const imgs = [...document.images];
    // 步态雪碧图：background-image 存在且可加载、竖排比例 ≥20:1（24 帧）
    const sheets = [...document.querySelectorAll('.walksheet')];
    const sheetCheck = await Promise.all(sheets.map(el => {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg.match(/url\\("?(.*?)"?\\)/);
      if (!m) return Promise.resolve({ ok: false, why: 'no-bg' });
      return new Promise(res => {
        const im = new Image();
        im.onload = () => res({ ok: im.naturalWidth > 0 && im.naturalHeight >= im.naturalWidth * 20, w: im.naturalWidth, h: im.naturalHeight, file: decodeURIComponent(m[1]).split('/').pop() });
        im.onerror = () => res({ ok: false, why: 'load-fail', file: decodeURIComponent(m[1]).split('/').pop() });
        im.src = m[1];
      });
    }));
    return {
      imgTotal: imgs.length,
      broken: imgs.filter(i => !(i.complete && i.naturalWidth > 0)).map(i => i.getAttribute('src')),
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      scrollH: document.documentElement.scrollHeight,
      poseCards: document.querySelectorAll('.pose-card').length,
      featCards: document.querySelectorAll('.feat-card').length,
      uiCells: document.querySelectorAll('.ui-cell').length,
      mSheets: document.querySelectorAll('.m-sheet').length,
      anchorsOk: ['#poses','#ui','#studio','#download'].every(s => !!document.querySelector(s)),
      offsets: ['#poses','#ui','#studio','.foot'].map(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return [sel, Math.round(r.top + scrollY), Math.round(r.bottom + scrollY)]; }),
      navHrefs: [...document.querySelectorAll('.topnav a')].map(a => a.getAttribute('href')),
      removedOk: !document.querySelector('.catwalk') && !document.querySelector('#features') && !document.querySelector('.cw-cat'),
      walkSheets: sheets.length,
      sheetOk: sheetCheck.length === 1 && sheetCheck.every(s => s.ok),
      sheetDetail: sheetCheck,
      staleRefs: [...document.querySelectorAll('[src*="cat-walk-"],[src*="walkside"]')].map(e => e.getAttribute('src')),
    };
  })()`);
  console.log('INFO ' + JSON.stringify(info));
  const cap = async (w, file) => {
    win.setContentSize(w, 900);
    await new Promise(r => setTimeout(r, 700));
    const h = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
    const hh = Math.min(h, 14000);
    win.setContentSize(w, hh);
    await new Promise(r => setTimeout(r, 900));
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, file), shot.toPNG());
    const s = shot.getSize();
    console.log(`SHOT ${file} ${s.width}x${s.height} (page ${w}x${hh})`);
    return h;
  };
  await cap(1440, 'site-desktop-full.png');
  await win.loadFile(path.join(OUT, '..', '..', 'site', 'index.html'));
  await new Promise(r => setTimeout(r, 900));
  await cap(430, 'site-mobile-full.png');
  if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exitCode = 2; }
  else console.log('NO-CONSOLE-ERRORS');
  app.quit();
});
