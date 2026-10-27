const { app, BrowserWindow } = require('electron');
const path = require('path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false });
  await win.loadFile(path.join(__dirname, '..', 'energy-pet', 'site', 'index.html'));
  await new Promise(r => setTimeout(r, 800));
  const o = await win.webContents.executeJavaScript(`JSON.stringify(
    ['#poses','#features','.foot'].map(s => {
      const el = document.querySelector(s); const r = el.getBoundingClientRect();
      return [s, Math.round(r.top + scrollY), Math.round(r.bottom + scrollY)];
    }))`);
  console.log('OFFSETS ' + o);
  app.quit();
});
