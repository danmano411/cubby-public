// Renders every icon from the one source, assets/logo.svg (run with Electron, no image dependency:
// npm run icon):
//   assets/icon.png, build/icon.png   1024 px (README, mac app icon)
//   build/icon.ico                    16..256 px in one file (Windows exe, installer, Start menu)
//   src/tray-icon[@Nx].png            the tray icon at each display scale
//   src/cubes.svg                     the cubes without the tile, for the logos inside the app
// Small sizes get thicker outlines: at 32 px the 6-unit outline would be 0.2 px and the cubes would
// melt into one blob. Outline = max(6, 1.1 px at the target size), in the SVG's 1024-unit space.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'assets', 'logo.svg'), 'utf8');
const stroke = (size) => Math.max(6, Math.round((1.1 * 1024) / size));
const withStroke = (svg, w) => svg.replace(/stroke-width="6"/, `stroke-width="${w}"`);

// One device pixel per CSS pixel, whatever the screen's scaling is.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

async function render(win, svg, size) {
  win.setContentSize(size, size);
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `)}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300)); // let the offscreen surface paint once
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  if (img.getSize().width !== size) img = img.resize({ width: size, height: size, quality: 'best' });
  return img.toPNG();
}

// .ico = 6-byte header + 16-byte entry per image + the PNGs themselves (PNG-in-ICO, Vista and later).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.png)]);
}

function write(rel, data) {
  const out = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
  console.log(`wrote ${rel} (${data.length} bytes)`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });

  const big = await render(win, SRC, 1024);
  write('assets/icon.png', big);
  write('build/icon.png', big);

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const size of icoSizes) pngs.push({ size, png: await render(win, withStroke(SRC, stroke(size)), size) });
  write('build/icon.ico', ico(pngs));

  // Tray: 16 px at 100% scaling; Electron picks the @Nx file matching the display.
  for (const [suffix, size] of [['', 16], ['@1.5x', 24], ['@2x', 32], ['@2.5x', 40], ['@3x', 48]]) {
    write(`src/tray-icon${suffix}.png`, await render(win, withStroke(SRC, stroke(size)), size));
  }

  // In-app logos are 16-56 px tiles drawn by CSS (so the listening cue can still recolour its tile):
  // just the cubes, cropped to the tile, with an outline that survives 16 px.
  const cubes = withStroke(SRC, 40)
    .replace(/<rect [^>]*\/>\n?/, '')
    .replace('viewBox="0 0 1024 1024" width="1024" height="1024"', 'viewBox="64 64 896 896"')
    .replace(/<!--[\s\S]*?-->\n?/g, '');
  write('src/cubes.svg', `<!-- Generated from assets/logo.svg by scripts/render-icon.js; edit the source, not this. -->\n${cubes}`);
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
