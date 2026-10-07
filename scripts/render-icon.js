// Renders assets/logo.svg to assets/icon.png (1024x1024, transparent corners) and build/icon.png.
// Run with Electron so no image dependency is needed: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const ROOT = path.join(__dirname, '..');

// One device pixel per CSS pixel, whatever the screen's scaling is.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(ROOT, 'assets', 'logo.svg'), 'utf8');
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', `<svg style="display:block;width:${SIZE}px;height:${SIZE}px" `)}</body></html>`;
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400)); // let the offscreen surface paint once
  let img = await win.webContents.capturePage();
  if (img.getSize().width !== SIZE) img = img.resize({ width: SIZE, height: SIZE, quality: 'best' });
  const png = img.toPNG();
  for (const out of [path.join(ROOT, 'assets', 'icon.png'), path.join(ROOT, 'build', 'icon.png')]) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, png);
    console.log(`wrote ${path.relative(ROOT, out)} (${png.length} bytes)`);
  }
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
