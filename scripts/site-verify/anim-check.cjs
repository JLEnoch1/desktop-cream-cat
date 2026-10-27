const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false });
  await win.loadFile(path.join(OUT, '..', 'energy-pet', 'site', 'index.html'));
  await new Promise(r => setTimeout(r, 900));
  win.setContentSize(1440, 900);
  await new Promise(r => setTimeout(r, 700));
  const h = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
  win.setContentSize(1440, Math.min(h, 14000));
  await new Promise(r => setTimeout(r, 900));
  const rects = await win.webContents.executeJavaScript(`(() => {
    const pick = s => { const r = document.querySelector(s).getBoundingClientRect();
      return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) }; };
    return { strip: pick('.catwalk'), card: pick('.pose-walk') };
  })()`);
  console.log('RECTS ' + JSON.stringify(rects));
  const a = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'anim-a.png'), a.toPNG());
  await new Promise(r => setTimeout(r, 250));
  const b = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'anim-b.png'), b.toPNG());
  console.log('DONE ' + JSON.stringify(a.getSize()));
  app.exit(0);
});
