// First-run setup wizard and Settings page (plan §5, setup.html). One window, two modes:
//   'wizard'   linear steps, opens by itself while config.setupComplete is false
//   'settings' the same sections as a sidebar, saved with one button
// Opened by the tray ("Set up Cubby…" / "Settings…") with ipcMain.emit('open-setup', {}, mode), or by a
// renderer with cubby.send('open-setup', mode). The renderer edits a draft; only this file writes config.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { matches } = require('../model');

// The welcome step's permission rows (macOS) -> the mac adapter's permission names.
const PANES = { accessibility: 'accessibility', screen: 'screenRecording', input: 'inputMonitoring', microphone: 'microphone', speech: 'speech' };
// Music providers the setup offers; `available` is decided by what src/music registers.
const PROVIDERS = [
  { name: 'spotify', label: 'Spotify', note: 'Now playing and controls for the Spotify app.', platforms: ['win32', 'darwin'] },
  { name: 'apple-music', label: 'Apple Music', note: 'Now playing and controls for the Music app.', platforms: ['darwin'] },
  { name: 'system', label: 'System media', note: 'Any player, including browser tabs.', platforms: ['win32', 'darwin'] },
  { name: 'none', label: 'None', note: 'Hide the music strip, the music panel and the music keys.', platforms: ['win32', 'darwin'] },
];

const slug = (s) => String(s).toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
const clone = (o) => JSON.parse(JSON.stringify(o));
const launchKey = (l) => String(l?.appId || l?.bundleId || '').toLowerCase();
const isUrl = (s) => /^[a-z][\w+.-]*:\/\//i.test(s);
const prettyName = (exe) => { const b = path.win32.basename(exe, '.exe'); return b.charAt(0).toUpperCase() + b.slice(1); };

// ---- Pure helpers (tested in test/setup.test.js) ---------------------------------

// Setup window: 980x680 DIP, centered in the work area of the display the cursor is on.
function setupBounds(d) {
  const wa = d.workArea;
  const width = Math.min(980, wa.width, Math.max(360, wa.width - 48));
  const height = Math.min(680, wa.height, Math.max(360, wa.height - 48));
  return { x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height };
}

// "Show side panels on" choices. `setting` is what goes into config.panels.display: the label
// when it's unique (survives re-plugging), else the id.
function displayOptions(displays, primaryId) {
  const labels = displays.map((d) => d.label || '');
  return displays.map((d, i) => ({
    setting: d.label && labels.filter((l) => l === d.label).length === 1 ? d.label : String(d.id),
    label: d.label || `Display ${i + 1}`,
    primary: d.id === primaryId,
    width: Math.round(d.bounds.width * d.scaleFactor), // physical pixels
    height: Math.round(d.bounds.height * d.scaleFactor),
  }));
}

// Windows AppID of a classic app is its exe path ("{GUID}\Foo\foo.exe"); that gives match.exe for free.
const exeFromAppId = (id) => (/\.exe$/i.test(id) && !isUrl(id) ? path.win32.basename(id).toLowerCase() : null);

// Everything the Apps step can offer: the catalog, installed apps and open windows, deduped.
// Candidates: { id, name, category?, entry, installed, open, detected, launchOnly? }. `entry` is what
// goes into a group: a catalog id, or an app object (without `match` when the exe is still unknown;
// finishEntries() fills that in on save). exists(path) says whether a catalog exe path is on disk.
function buildCandidates({ catalogEntries, installed, windows, exists = () => false, expand = (s) => s }) {
  const byInstalled = new Map(installed.map((i) => [launchKey(i.launch), i]));
  const used = new Set();
  const out = catalogEntries.map((c) => {
    const k = launchKey(c.launch);
    const inst = k && byInstalled.get(k);
    if (inst) used.add(k);
    const open = windows.some((w) => matches(c, w));
    const onDisk = !!c.launch?.exe && exists(expand(c.launch.exe));
    return { id: c.id, name: c.name, category: c.category || '', entry: c.id, installed: !!inst || onDisk, open, detected: !!inst || onDisk || open, launch: c.launch || null, exe: String(c.match?.exe || '').toLowerCase() };
  });
  const taken = new Set(out.map((c) => c.id));
  const unique = (id) => { let n = id; for (let i = 2; taken.has(n); i++) n = `${id}-${i}`; taken.add(n); return n; };
  const claimedExe = new Set(out.filter((c) => c.open).flatMap((c) => windows.filter((w) => w.exe === c.exe).map((w) => w.exe)));
  const custom = [];
  for (const i of installed) {
    const appId = i.launch.appId || i.launch.bundleId;
    if (!appId || used.has(launchKey(i.launch)) || isUrl(appId)) continue;
    const exe = exeFromAppId(appId);
    const cat = exe && out.find((c) => c.exe === exe);
    if (cat) { cat.installed = cat.detected = true; continue; } // same app under another Start-menu id
    const w = exe && windows.find((x) => x.exe === exe);
    if (w) claimedExe.add(exe);
    const id = unique(slug(i.name));
    const app = { id, name: i.name, launch: i.launch };
    if (exe) app.match = { exe };
    custom.push({ id, name: i.name, category: '', entry: app, installed: true, open: !!w, detected: true, launch: i.launch, launchOnly: !exe && !appId.includes('!') });
  }
  const seen = new Set();
  for (const w of windows) {
    if (claimedExe.has(w.exe) || seen.has(w.exe) || !w.exePath) continue;
    seen.add(w.exe);
    const id = unique(slug(w.exe));
    const name = prettyName(w.exe);
    custom.push({ id, name, category: '', entry: { id, name, match: { exe: w.exe }, launch: { exe: w.exePath } }, installed: false, open: true, detected: true, launch: { exe: w.exePath } });
  }
  const rank = (c) => (c.open ? 0 : c.detected ? 1 : 2);
  return [...out.map(({ exe, ...c }) => c), ...custom].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// Group entries that still lack match.exe (installed apps added without a window to learn it from).
// resolve(appId) -> exe | null (Store apps: from their manifest). Last resort: the name, so the
// entry is valid and launches; it just can't tell when the app is running.
async function finishEntries(groups, resolve) {
  for (const g of groups) {
    for (let i = 0; i < g.apps.length; i++) {
      const a = g.apps[i];
      if (typeof a === 'string' || a.match) continue;
      const appId = a.launch?.appId || '';
      const exe = exeFromAppId(appId) || (await resolve(appId)) || `${String(a.name).toLowerCase().replace(/[^a-z0-9]+/g, '')}.exe`;
      g.apps[i] = { ...a, match: { exe } };
    }
  }
  return groups;
}

const phrases = (list) => [...new Set((Array.isArray(list) ? list : []).map((p) => String(p).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean))];

// The draft from the page onto the live config. Only what setup owns is taken from the draft;
// socialMode, thresholds, per-app overrides etc. stay as they are in `current`.
function mergeDraft(current, draft) {
  const next = clone(current);
  const d = draft || {};
  if (d.keys) for (const k of [...Object.keys(current.keys), 'takeOverSystemSwitcher']) if (k in d.keys) next.keys[k] = k === 'takeOverSystemSwitcher' ? !!d.keys[k] : String(d.keys[k] || '');
  if (typeof d.startAtLogin === 'boolean') next.startAtLogin = d.startAtLogin;
  if (d.music?.provider) next.music = { ...next.music, provider: d.music.provider };
  if (Array.isArray(d.groups)) {
    next.groups = d.groups.map((g) => {
      const { pingGroup, ...rest } = g;
      return { ...rest, name: String(g.name || '').trim() || 'Group', ...(pingGroup ? { pingGroup: true } : {}), apps: Array.isArray(g.apps) ? clone(g.apps) : [] };
    });
  }
  if (d.panels) {
    for (const k of ['socials', 'music']) if (typeof d.panels[k] === 'boolean') next.panels[k] = d.panels[k];
    // A choice saved here is the user's: the one-time 'primary' -> 'focus' step never overrides it.
    if (typeof d.panels.display === 'string' && d.panels.display) Object.assign(next.panels, { display: d.panels.display, displayChosen: true });
  }
  if (next.music.provider === 'none') next.panels.music = false; // nothing to show
  if (d.voice) {
    const v = next.voice;
    if (typeof d.voice.enabled === 'boolean') v.enabled = d.voice.enabled;
    if (d.voice.engine === 'builtin') v.engine = 'builtin'; // 'vosk' arrives with its downloader
    const wake = phrases([d.voice.wakeWord])[0];
    if (wake) v.wakeWord = wake;
    for (const k of ['openAll', 'closeAll']) { const p = phrases(d.voice.commands?.[k]); if (p.length) v.commands[k] = p; }
  }
  const label = typeof d.labels?.closeAll === 'string' ? d.labels.closeAll.trim() : '';
  if (label) next.labels = { ...next.labels, closeAll: label };
  for (const k of ['confirm', 'macQuit']) if (typeof d.deleteKey?.[k] === 'boolean') next.deleteKey = { ...next.deleteKey, [k]: d.deleteKey[k] };
  next.setupComplete = true;
  return next;
}

// ---- Platform bits (Windows) ---------------------------------------------------------

// Store apps: "Family!AppId" -> the exe named in the package manifest, via PowerShell (~0.4s).
function manifestExe(appId) {
  const [family, id] = appId.split('!');
  if (process.platform !== 'win32' || !id || !/^[\w.-]+$/.test(family) || !/^[\w.-]+$/.test(id)) return Promise.resolve(null);
  const script = `$p = Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq '${family}' } | Select-Object -First 1; ` +
    `if ($p) { [xml]$m = Get-Content "$($p.InstallLocation)\\AppxManifest.xml"; ($m.Package.Applications.Application | Where-Object { $_.Id -eq '${id}' }).Executable }`;
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 15000 }, (err, out) => {
      const exe = err ? '' : String(out).trim().split(/\r?\n/)[0];
      resolve(exe ? path.win32.basename(exe).toLowerCase() : null);
    });
  });
}

function register(ctx) {
  const { ipcMain, adapter, catalog, schema, screen, cursorDisplay } = ctx;
  const music = require('../music/index');
  const env = (s) => s.replace(/%([^%]+)%/g, (_, k) => process.env[k] || '');
  const platform = process.platform;
  const configFile = () => path.join(ctx.app.getPath('userData'), 'config.json');
  let win = null;
  let installed = null; // Get-StartApps result, cached for the session
  const iconCache = {};

  const tryOr = (fn, fallback) => { try { return fn(); } catch (e) { ctx.log('setup:', e.message); return fallback; } };
  const displays = () => screen.getAllDisplays().map((d) => ({ id: d.id, label: d.label, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor }));
  const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

  // A config.json that fails to load is never overwritten by saveConfig(): don't pop up a wizard
  // that can't save either.
  const configOnDiskBroken = () => {
    try { return schema.load(fs.readFileSync(configFile(), 'utf8')).errors.length > 0; } catch { return true; }
  };

  let want = { mode: 'settings', step: null }; // what the page should show; it asks with 'setup:ready'
  function open(mode = 'settings', step = null) {
    mode = mode === 'wizard' ? 'wizard' : 'settings';
    ctx.hideOverlay();
    if (win) { // already open: bring it up, and switch mode only if it differs (that reloads the page)
      if (win.isMinimized()) win.restore();
      const changed = want.mode !== mode;
      want = { mode, step };
      if (changed) { ctx.pauseKeys(false); win.webContents.reload(); } else send('setup:goto', want);
      win.show();
      win.focus();
      return;
    }
    want = { mode, step };
    installed = null; // re-scan the Start menu for each new window
    win = ctx.makeWindow('setup.html', {
      frame: false, transparent: false, resizable: false, skipTaskbar: false, hasShadow: true, focusable: true,
      backgroundColor: '#16161c', title: mode === 'wizard' ? 'Set up Cubby' : 'Cubby settings', ...setupBounds(cursorDisplay()),
    });
    win.setAlwaysOnTop(false); // makeWindow pins its windows above everything; this one is a normal window
    win.webContents.once('did-finish-load', () => { ctx.place(win, setupBounds(cursorDisplay())); win.show(); win.focus(); });
    win.on('closed', () => { win = null; ctx.pauseKeys(false); });
  }

  function snapshot() {
    const available = new Set(music.names());
    const config = clone(ctx.config);
    return {
      ...want, platform, config,
      firstRun: !config.setupComplete,
      displays: displayOptions(displays(), screen.getPrimaryDisplay().id),
      providers: PROVIDERS.filter((p) => p.platforms.includes(platform)).map((p) => ({ ...p, available: available.has(p.name), appRef: music.get(p.name, adapter)?.appRef || null })),
      defaults: clone(schema.DEFAULTS),
      catalog: catalog.load().map(({ id, name, category }) => ({ id, name, category: category || '' })),
    };
  }

  // Icons go through the adapter's one icon queue (one helper at a time, hung targets dropped there,
  // never retried or split here), asked for in small batches so they show up as they're ready.
  const iconsFor = (targets) => Promise.resolve().then(() => adapter.renderIcons(targets)).catch(() => ({}));

  async function sendApps() {
    if (!installed) installed = await Promise.resolve().then(() => adapter.listInstalledApps()).catch((e) => { ctx.log('setup:', e.message); return []; });
    const windows = tryOr(() => adapter.listWindows({ excludePid: process.pid }), []);
    const candidates = buildCandidates({ catalogEntries: catalog.load(), installed, windows, exists: (p) => fs.existsSync(p), expand: env });
    send('setup:apps', { candidates });
    // Icons for what the lists show: apps already in groups first, then candidates in list order.
    const wanted = new Map(); // id -> target
    const need = (id, app) => { const t = tryOr(() => adapter.iconTarget(app), null); if (t && !wanted.has(id)) wanted.set(id, t); };
    for (const g of ctx.config.groups) for (const e of g.apps) { const r = catalog.resolve(e, ctx.config.apps); if (r) need(r.id, r); }
    for (const c of candidates) need(c.id, { launch: c.launch || {} });
    const byTarget = new Map();
    for (const [id, t] of wanted) byTarget.set(t, [...(byTarget.get(t) || []), id]);
    const publish = (got) => {
      Object.assign(iconCache, got);
      const out = {};
      for (const [t, url] of Object.entries(got)) for (const id of byTarget.get(t) || []) out[id] = url;
      if (Object.keys(out).length) send('setup:icons', out);
    };
    publish(Object.fromEntries([...byTarget.keys()].filter((t) => iconCache[t]).map((t) => [t, iconCache[t]])));
    const queue = [...byTarget.keys()].filter((t) => !iconCache[t]);
    for (let batch; (batch = queue.splice(0, 16)).length && win && !win.isDestroyed();) publish(await iconsFor(batch));
  }

  async function save(draft) {
    const prev = ctx.config;
    const next = mergeDraft(prev, draft);
    await finishEntries(next.groups, manifestExe);
    const errors = schema.validate(schema.withDefaults(next));
    if (errors.length) return { ok: false, errors };
    ctx.config = next;
    if (ctx.saveConfig() === false) { // config.json on disk doesn't load, and is never saved over
      ctx.config = prev;
      return { ok: false, errors: [`Couldn't save: ${configFile()} isn't valid. Fix or delete it, then try again.`] };
    }
    // Boot leaves the login item alone until setup has run once, so the first save always applies it.
    if (!prev.setupComplete || prev.startAtLogin !== next.startAtLogin) tryOr(() => ctx.applyLoginItem(next.startAtLogin));
    ctx.applyConfig();
    return { ok: true };
  }

  const fromPage = (e) => win && !win.isDestroyed() && e.sender === win.webContents;

  ipcMain.on('open-setup', (_, mode, step) => open(mode, step));
  ipcMain.on('setup:ready', (e) => { if (fromPage(e)) send('setup:init', snapshot()); });
  ipcMain.on('setup:apps', (e) => { if (fromPage(e)) sendApps(); });
  ipcMain.on('setup:save', async (e, draft) => {
    if (!fromPage(e)) return;
    let r;
    try { r = await save(draft); } catch (err) { ctx.log('setup save failed', err.stack); r = { ok: false, errors: [`Couldn't save: ${err.message}`] }; }
    send('setup:saved', r);
  });
  ipcMain.on('setup:finish', (e) => { // Done step: close and show the tray
    if (!fromPage(e)) return;
    win.close();
    setTimeout(() => ctx.showOverlay(), 150);
  });
  ipcMain.on('setup:close', (e) => { if (fromPage(e)) win.close(); });
  ipcMain.on('setup:minimize', (e) => { if (fromPage(e)) win.minimize(); });
  ipcMain.on('setup:open-pane', (e, name) => {
    if (fromPage(e) && PANES[name]) adapter.openPermissionSettings?.(PANES[name]);
  });
  ipcMain.on('setup:permissions', async (e) => { // macOS: asked through the helper, which can also see Input Monitoring
    if (!fromPage(e) || platform !== 'darwin') return;
    const p = await Promise.resolve().then(() => adapter.permissions()).catch(() => ({}));
    const st = (v) => (v === true || v === 'granted' ? 'granted' : v === false || v === 'denied' ? 'denied' : 'unknown');
    send('setup:permissions', {
      accessibility: st(p.accessibility), screen: st(p.screenRecording), input: st(p.inputMonitoring),
      microphone: st(p.microphone) === 'granted' ? st(p.speech) : st(p.microphone), // one row for both
    });
  });
  // While the page records a new combo, the global hook would act on it (and swallow it).
  ipcMain.on('setup:recording', (e, on) => { if (fromPage(e)) ctx.pauseKeys(!!on); });

  if (!ctx.smoke && !ctx.config.setupComplete && !configOnDiskBroken()) open('wizard');
}

module.exports = { register, setupBounds, displayOptions, buildCandidates, finishEntries, mergeDraft, exeFromAppId, slug };
