const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, dialog, powerMonitor } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const adapter = require('./platform');
const schema = require('./config/schema');
const catalog = require('./config/catalog');
const music = require('./music/index'); // not './music': that's the renderer's music.js
const layout = require('./layout');
const { buildModel, findApp, appForWindow, badgeFor, badgeGrew, pingText, pingApps, allApps } = require('./model');
const session = require('./session');
const { initUpdater } = require('./updater');
const edits = require('./features/edits');
const pkg = require('../package.json');

// --smoke: isolated self-test. Its own temp userData (set before the single-instance lock, which
// is per userData dir) so it never touches a running Cubby or the real config.
const SMOKE = process.argv.includes('--smoke');
if (SMOKE) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cubby-smoke-')));
if (!app.requestSingleInstanceLock()) app.exit(0);
// Same as package.json build.appId, but not read from there: electron-builder strips "build" from
// the packaged package.json, so pkg.build is undefined in an installed copy.
const APP_ID = 'app.cubby.desktop';
app.setAppUserModelId(APP_ID); // names the startup entry (else "electron.app.Electron")

const DATA = app.getPath('userData');
const CONFIG = path.join(DATA, 'config.json');
const ICONS = path.join(DATA, 'icons.json');
const STARTER = path.join(__dirname, 'default-config.json');
const MODES = { dnd: 'Do Not Disturb', ping: 'Ping Me' };
const PANELS = { socials: 'Socials', music: 'Music' };

let config;
let configBroken = false; // config.json didn't load: run on the starter config and never save over it
let provider = null; // music provider (src/music), null = 'none'
let icons = {};
let pings = {};
let lastPing = {};
let badges = null; // taskbar badges by AppID; null until the first scan
let overlay, dock, musicWin, toast, cue, tray, toastTimer;
let foregroundAtOpen = 0;
let holdOpen = false; // keep the tray up through our own focus changes (context menu, DND minimizing)
let pushPaused = false;

const log = (...a) => (process.env.CUBBY_DEBUG || SMOKE) && console.log(new Date().toISOString().slice(11, 23), ...a);

function loadConfig() {
  if (!fs.existsSync(CONFIG)) fs.copyFileSync(STARTER, CONFIG);
  try {
    const text = fs.readFileSync(CONFIG, 'utf8');
    const r = schema.load(text);
    if (r.errors.length) throw new Error(r.errors.join('\n'));
    config = r.config;
    configBroken = false;
    if (r.migrated) {
      const backup = path.join(DATA, 'config.v1.backup.json');
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);
      saveConfig();
      log('config migrated to v2; original kept in', backup);
    } else if (r.upgraded) {
      saveConfig();
      log('config upgraded: side panels follow the focused window');
    }
  } catch (e) {
    // Don't overwrite a hand-edited config that has a typo; run on the starter and say so.
    const msg = `${e.message}\n\nUsing defaults until it's fixed.\n${CONFIG}`;
    if (SMOKE) console.error('smoke: config invalid:', msg);
    else dialog.showErrorBox('Cubby: config.json is invalid', msg);
    config = schema.load(fs.readFileSync(STARTER, 'utf8')).config;
    configBroken = true;
  }
  provider = music.get(config.music.provider, adapter);
  try { icons = JSON.parse(fs.readFileSync(ICONS, 'utf8')); } catch { icons = {}; }
}
// false = not written (config.json didn't load, so it's left for the user to fix).
function saveConfig() {
  if (configBroken) { log('config.json is invalid; not saving over it'); return false; }
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
  return true;
}
// config with every app resolved through the catalog; what the model, session and lookups use.
const runtime = () => catalog.resolveConfig(config, provider);

const keyLabels = () => Object.fromEntries(schema.KEY_NAMES.map((k) => [k, schema.keyLabel(config.keys[k])]));
function voiceHints() {
  const v = config.voice;
  if (!v.enabled) return null;
  const [open, close] = [v.commands.openAll[0], v.commands.closeAll[0]];
  return { wake: v.wakeWord, openAll: `${v.wakeWord} ${open}`, closeAll: `${v.wakeWord} ${close}`, followUp: `say “${open}” or “${close}”` };
}

function snapshot() {
  const rc = runtime();
  const model = buildModel(adapter.listWindows({ excludePid: process.pid }), rc, pings, badges || {});
  if (model.music) model.music.nowPlaying = provider.nowPlaying(model.music);
  const byId = {};
  for (const a of [...model.groups.flatMap((g) => g.apps), model.music].filter(Boolean)) {
    const t = adapter.iconTarget(findApp(rc, a.id) || { launch: { exe: a.exePath } });
    if (t && icons[t]) byId[a.id] = icons[t];
    else if (t) wantIcon(t);
  }
  const tints = Object.fromEntries(allApps(rc).filter((a) => a.tint).map((a) => [a.id, a.tint]));
  return { ...model, icons: byId, tints, socialMode: config.socialMode, panels: config.panels, keys: keyLabels(), voice: voiceHints(), labels: { closeAll: config.labels.closeAll, closeVerb: schema.closeVerb(config.labels.closeAll) } };
}

// Icons come from the platform (shell-rendered on Windows), keyed by launch target, so closed and
// Store apps get real icons too. Cached in icons.json; one batch per miss-burst.
const iconWanted = new Set();
const iconTried = new Set();
let iconTimer;
function wantIcon(t) {
  if (iconTried.has(t)) return;
  iconTried.add(t);
  iconWanted.add(t);
  clearTimeout(iconTimer);
  iconTimer = setTimeout(async () => {
    const batch = [...iconWanted];
    iconWanted.clear();
    Object.assign(icons, await adapter.renderIcons(batch));
    try { fs.writeFileSync(ICONS, JSON.stringify(icons)); } catch {}
    push();
  }, 50);
}

function push() {
  if (pushPaused) return;
  const visible = [overlay, dock, musicWin].filter((w) => w && w.isVisible());
  if (!visible.length) return;
  const s = snapshot();
  for (const w of visible) w.webContents.send('model', s);
}

function makeWindow(file, opts) {
  const w = new BrowserWindow({
    show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, ...opts,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  w.setAlwaysOnTop(true, 'pop-up-menu');
  w.loadFile(path.join(__dirname, file));
  w.webContents.on('console-message', (e) => log(file, e.message));
  return w;
}

// setBounds onto a monitor with a different scale factor can land at the wrong size on the first
// call (Electron converts with the old monitor's DPI), so read it back and apply once more.
// 1 DIP off is just physical-pixel rounding (691 DIP at 2.5x = 1727.5 px reads back as 692), not that bug.
const sameRect = (a, b) => ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 1);
function place(w, { x, y, width, height }) {
  const r = { x, y, width, height };
  w.setBounds(r);
  if (sameRect(w.getBounds(), r)) return true;
  log('re-place', JSON.stringify(w.getBounds()), '->', JSON.stringify(r));
  w.setBounds(r);
  return sameRect(w.getBounds(), r);
}
const cursorDisplay = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

function showOverlay({ altSession = false } = {}) {
  foregroundAtOpen = adapter.foreground();
  place(overlay, layout.overlayBounds(cursorDisplay()));
  // Window lists are most recently used first: the first other window is "previous".
  const previous = adapter.listWindows({ excludePid: process.pid }).find((w) => w.hwnd !== foregroundAtOpen && !w.minimized)?.hwnd || 0;
  overlay.webContents.send('open', { ...snapshot(), foreground: foregroundAtOpen, previous, altSession });
  overlay.show();
  overlay.focus();
  ensureOverlayFocus();
  setTimeout(ensureOverlayFocus, 120); // activation can settle a moment after show()
}

// Windows sometimes refuses focus right after the hook swallowed the hotkey: the tray shows but
// keystrokes (Esc, typing) keep going to the app underneath. Check, and take focus properly.
function ensureOverlayFocus() {
  if (!overlay.isVisible()) return;
  const self = adapter.handleOf(overlay);
  if (adapter.foreground() === self) return;
  const ok = adapter.forceForeground ? adapter.forceForeground(self) : (app.focus({ steal: true }), true);
  log('focus rescue', ok);
  overlay.webContents.focus();
  // Once we are really in front, make Electron agree, or keys (Esc) never reach the page.
  setTimeout(() => {
    if (!overlay.isVisible() || overlay.isFocused()) return;
    log('focus resync');
    overlay.focus();
    overlay.webContents.focus();
  }, 60);
}
const hideOverlay = () => overlay.isVisible() && overlay.hide();

// Esc, the search key again, or a click on the backdrop. Hiding the focused tray leaves Windows'
// focus on the hidden window (typing goes nowhere), so hand it back to where the tray was opened.
function dismiss() {
  if (!overlay.isVisible()) return;
  const self = adapter.handleOf(overlay);
  const back = adapter.foreground() === self ? foregroundAtOpen : 0;
  hideOverlay();
  if (back && back !== self && adapter.isWindow(back)) adapter.focus(back);
}

// Two keys (config.keys), two jobs:
//   switch (Alt+Tab) -> "switch session": repeat cycles, letting go of the modifier switches (quick tap = previous app).
//   search (Alt+~)   -> tray stays open for typing until Enter/click/Esc.
// Pressing search mid-switch (modifier still held) converts the session to search.
let altSession = false;
function onHotkey(back = false) {
  log('hotkey', overlay.isVisible());
  if (overlay.isVisible()) overlay.webContents.send('cycle', back ? -1 : 1);
  else showOverlay({ altSession: true });
  altSession = true;
}

function onSearchKey() {
  log('search key', overlay.isVisible());
  if (overlay.isVisible() && !altSession) return dismiss(); // toggle: search key again closes
  altSession = false;
  if (overlay.isVisible()) overlay.webContents.send('search');
  else showOverlay();
}

function onAltUp() {
  if (altSession && overlay.isVisible()) overlay.webContents.send('alt-up');
  altSession = false;
}

// Login item (HKCU Run on Windows). Unpackaged, electron.exe needs the project path or it opens its default app.
function applyLoginItem(on) {
  if (SMOKE) return;
  const args = app.isPackaged ? [] : [app.getAppPath()];
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args });
  adapter.removeStaleLoginItems(APP_ID, [process.execPath, ...args]);
}

function setStartAtLogin(on) {
  config.startAtLogin = on;
  saveConfig();
  applyLoginItem(on);
  buildTrayMenu();
}

// Switcher takeover, toggleable from the tray menu so the system switcher is one click away.
function setTakeOver(on) {
  config.keys.takeOverSystemSwitcher = on;
  saveConfig();
  buildTrayMenu();
}

function activate(hwnd) {
  if (!adapter.isWindow(hwnd)) return push();
  adapter.focus(hwnd);
  hideOverlay();
}

// ---- Open All / Close All (panel buttons + voice) ------------------------------

function openAll() {
  log('open-all', session.openAll(runtime(), adapter.launch));
  hideOverlay();
}

async function closeAll() {
  hideOverlay();
  const r = await session.closeAll(runtime());
  log('close-all', r);
  if (r.waiting.length) notify({ id: 'cubby', headline: 'Still open', title: `${r.waiting.join(', ')}: probably asking to save` });
  push();
}

// ---- Voice: offline recognizer from the platform (config.voice) --------------------
// The wake word alone opens a 5s listening window (logo cue mid-screen); a command phrase then
// runs it. "<wake> <command>" works in one go. Each command has its own confidence threshold:
// close is higher than open, since a misfire there closes everything. A false wake only shows the cue.
const WAKE_MS = 5000;
let stopVoiceProc = null;
let voice = null;
let listeningUntil = 0;
let cueTimer;

function voiceTable() {
  const v = config.voice;
  const norm = (s) => s.trim().toLowerCase();
  const wake = norm(v.wakeWord);
  const cmds = { openAll: { label: 'Opening all apps', run: openAll }, closeAll: { label: `${schema.verbIng(schema.closeVerb(config.labels.closeAll))} all apps`, run: closeAll, danger: true } };
  const full = {};
  const followUp = {}; // only inside the wake window
  for (const [k, c] of Object.entries(cmds)) {
    for (const p of v.commands[k]) {
      const cmd = { ...c, min: v.thresholds[k] };
      full[`${wake} ${norm(p)}`] = cmd;
      followUp[norm(p)] = cmd;
    }
  }
  return { wake, min: v.thresholds.wake, full, followUp, phrases: [wake, ...Object.keys(full), ...Object.keys(followUp)] };
}

function showCue(state, ms) {
  place(cue, layout.cueBounds(cursorDisplay()));
  cue.webContents.send('cue', state);
  cue.showInactive();
  clearTimeout(cueTimer);
  cueTimer = setTimeout(() => { cue.hide(); listeningUntil = 0; }, ms);
}

function onVoice(line) {
  log('voice', line);
  const [grammar, raw, conf] = line.split('|');
  const text = (raw || '').toLowerCase();
  if (grammar !== 'cmd' || !voice) return;
  if (text === voice.wake) {
    if (Number(conf) < voice.min) return;
    listeningUntil = Date.now() + WAKE_MS;
    return showCue({ mode: 'listening', hint: voiceHints()?.followUp }, WAKE_MS);
  }
  const v = voice.full[text] || (Date.now() < listeningUntil && voice.followUp[text]);
  if (!v || Number(conf) < v.min) return;
  listeningUntil = 0;
  showCue({ mode: 'heard', label: v.label, danger: v.danger }, 1200);
  v.run();
}

function startVoice() {
  voice = voiceTable();
  stopVoiceProc = adapter.startVoice({ phrases: voice.phrases, wav: process.env.CUBBY_VOICE_WAV }, onVoice);
}

function stopVoice() {
  if (stopVoiceProc) stopVoiceProc();
  stopVoiceProc = null;
}

function setVoice(on) {
  config.voice.enabled = on;
  saveConfig();
  stopVoice();
  if (on) startVoice();
  buildTrayMenu();
  push();
}

// ---- Socials (apps in ping groups) -----------------------------------------------

const pingIds = () => pingApps(runtime()).map((a) => a.id);

function setSocialMode(mode) {
  config.socialMode = mode;
  saveConfig();
  if (mode === 'dnd') {
    const rc = runtime();
    const ids = new Set(pingIds());
    holdOpen = overlay.isVisible();
    for (const w of adapter.listWindows()) if (ids.has(appForWindow(rc, w)?.id)) adapter.minimize(w.hwnd);
    toast.hide();
    if (holdOpen) setTimeout(() => { adapter.focus(adapter.handleOf(overlay)); holdOpen = false; }, 200);
  }
  buildTrayMenu();
  push();
}

// ---- Side panels: socials dock and/or music card on the right edge -------------------
// Four layouts: none, socials, music, both (stacked, centered vertically as one group), on the
// display picked by config.panels.display. Toasts follow the panels' display.
let panelDisplayId = null;

// 'focus' mode: the focused window's rect, or null when it shouldn't move the panels (Cubby's own
// windows: tray, panels, toast, cue, setup, menus; the desktop / taskbar; minimized or cloaked):
// then they stay where they are.
function focusRect() {
  const win = adapter.foreground();
  return win ? adapter.windowRect(win, { excludePid: process.pid }) : null;
}
const followsFocus = () => !config.panels.display || config.panels.display === 'focus';
const panelDisplay = () => layout.pickPanelDisplay(screen.getAllDisplays(), config.panels.display, {
  cursor: screen.getCursorScreenPoint(),
  focusRect: followsFocus() ? focusRect() : null,
  current: panelDisplayId,
}, screen.getPrimaryDisplay().id);

function panelItems(all = false) {
  const items = [];
  if (all || config.panels.socials) items.push({ key: 'socials', width: 64, height: (pingIds().length + 1) * 52 + 26 }); // +1: open-tray button
  if (provider && (all || config.panels.music)) items.push({ key: 'music', width: 280, height: 176 }); // full expanded width; collapsed it's a 64px column
  return items;
}

function layoutPanels(d = panelDisplay()) {
  panelDisplayId = d.id;
  const wins = { socials: dock, music: musicWin };
  const rects = layout.panelStack(d, panelItems());
  const s = rects.length ? snapshot() : null;
  for (const r of rects) {
    const w = wins[r.key];
    place(w, r);
    w.webContents.send('model', s);
    w.showInactive();
  }
  for (const [k, w] of Object.entries(wins)) if (!rects.some((r) => r.key === k)) w.hide();
  if (toast.isVisible()) place(toast, layout.toastBounds(d));
}

// Display added / removed / rearranged / rescaled, or back from sleep: put everything back on a
// display that exists, at that display's size.
function relayoutAll() {
  layoutPanels();
  if (overlay.isVisible()) place(overlay, layout.overlayBounds(screen.getDisplayMatching(overlay.getBounds())));
  if (cue.isVisible()) place(cue, layout.cueBounds(screen.getDisplayMatching(cue.getBounds())));
}

// 'mouse' / 'focus' modes: follow the cursor's / focused window's display (1s poll, and at once on
// activation), re-laying out only when it changes.
function followPanels() {
  if (config.panels.display !== 'mouse' && !followsFocus()) return;
  const d = panelDisplay();
  if (d.id !== panelDisplayId) { log('panels ->', d.id); layoutPanels(d); }
}

function setPanel(key, on) {
  config.panels[key] = on;
  saveConfig();
  layoutPanels();
  buildTrayMenu();
  push();
}

// Players react to media keys within a second; refresh soon so the panel reflects it,
// and pop the music side panel open briefly to show the new track.
function mediaPress(k) {
  if (!provider) return;
  provider.control(k);
  if (musicWin.isVisible()) musicWin.webContents.send('peek');
  setTimeout(push, 350);
  setTimeout(push, 1000);
}

// ---- Pings: taskbar flashes + taskbar badges ----------------------------------

function pingToast(a, hwnd = 0) {
  const now = Date.now();
  if (config.socialMode !== 'ping' || !pingIds().includes(a.id) || now - (lastPing[a.id] || 0) < 20000) return;
  lastPing[a.id] = now;
  const rc = runtime();
  const w = hwnd ? null : adapter.listWindows().find((x) => appForWindow(rc, x)?.id === a.id);
  notify({ id: a.id, name: a.name, title: pingText(badgeFor(a, badges || {})), hwnd: hwnd || w?.hwnd || 0, icon: icons[adapter.iconTarget(a)] });
}

function onFlash(hwnd) {
  const w = adapter.listWindows().find((x) => x.hwnd === hwnd);
  const a = w && appForWindow(runtime(), w);
  if (!a) return;
  log('flash', a.id);
  pings[a.id] = true;
  push();
  pingToast(a, hwnd);
}

// A new or grown badge on a ping-group app is a ping. The first scan only sets the baseline.
function onBadges(next) {
  const prev = badges;
  badges = next;
  log('badges', JSON.stringify(next));
  if (prev) {
    for (const a of pingApps(runtime())) {
      if (badgeGrew(badgeFor(a, prev), badgeFor(a, next))) pingToast(a);
    }
  }
  push();
}

function notify(t) {
  followPanels(); // the toast goes next to the panels, so bring them up to date first
  place(toast, layout.toastBounds(panelDisplay()));
  toast.webContents.send('toast', t);
  toast.showInactive();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.hide(), 7000);
}

function onActivated(hwnd) {
  followPanels();
  if (!hwnd) return;
  const w = adapter.listWindows().find((x) => x.hwnd === hwnd);
  const a = w && appForWindow(runtime(), w);
  if (a && pings[a.id]) { delete pings[a.id]; push(); }
}

function listenShell() {
  const soon = () => setTimeout(push, 150);
  adapter.onShellEvents(overlay, { flash: onFlash, activate: onActivated, create: soon, destroy: soon });
}

// ---- Context menu: regroup apps without touching JSON ------------------------

// Moves go through features/edits (the drag-to-group path), so they're validated and undoable.
function appContext({ hwnd, ...info }) {
  const groupOf = config.groups.find((g) => g.apps.some((a) => catalog.entryId(a) === info.id));
  const items = [
    { label: 'Move to group', submenu: config.groups.filter((g) => g !== groupOf).map((g) => ({ label: g.name, click: () => edits.moveApp(info, g.id) })) },
  ];
  if (groupOf) items.push({ label: 'Remove from Cubby', click: () => edits.moveApp(info, null) });
  if (hwnd) items.push({ type: 'separator' }, { label: 'Close window', click: () => { adapter.close(hwnd); setTimeout(push, 400); } });
  holdOpen = true;
  Menu.buildFromTemplate(items).popup({ window: overlay, callback: () => { holdOpen = false; overlay.focus(); } });
}

// ---- Keyboard hook (re)install -------------------------------------------------

let unhookKeys = null;
let keysPaused = false; // setup is recording a new combo: let every key reach its window
function installHook() {
  if (unhookKeys) unhookKeys();
  unhookKeys = null;
  if (keysPaused) return null;
  const k = config.keys;
  const binds = { [k.search]: onSearchKey };
  if (provider) Object.assign(binds, { [k.musicPrev]: () => mediaPress('prev'), [k.musicPlay]: () => mediaPress('play'), [k.musicNext]: () => mediaPress('next') });
  unhookKeys = adapter.hookKeys({ switchKey: k.switch, takeSwitch: () => !!config.keys.takeOverSystemSwitcher, onSwitch: onHotkey, onRelease: onAltUp, binds });
  return unhookKeys;
}

function pauseKeys(on) {
  if (keysPaused === !!on) return;
  keysPaused = !!on;
  if (!SMOKE) installHook();
}

// After config.json changes (reload, setup, settings): re-derive everything that reads it.
// The config was replaced as a whole, so the group edit history no longer applies to it.
function applyConfig() {
  edits.clearHistory();
  provider = music.get(config.music.provider, adapter);
  if (!SMOKE) {
    installHook();
    stopVoice();
    if (config.voice.enabled) startVoice();
  }
  layoutPanels();
  buildTrayMenu();
  push();
}

function afterWake() {
  log('wake');
  installHook();
  setTimeout(relayoutAll, 2000); // displays take a moment to settle after resume
}
// Panels that slipped under ordinary windows (still "visible" and "topmost", but buried) go back on
// top. Checked every second, so it doesn't matter which event (wake, screen on, unlock) buried them.
function keepPanelsOnTop() {
  for (const w of [dock, musicWin, toast]) {
    if (w.isVisible() && adapter.keepOnTop(adapter.handleOf(w))) log('lifted', w.getTitle());
  }
}

// ---- Tray icon ---------------------------------------------------------------

function trayImage() {
  // tray-icon.png is 16 px; Electron picks tray-icon@1.5x/@2x/@2.5x/@3x for the display's scaling.
  return nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
}

function buildTrayMenu() {
  if (!tray) return;
  const L = (k) => schema.keyLabel(config.keys[k]);
  const v = config.voice;
  const say = (p) => `"${v.wakeWord.charAt(0).toUpperCase()}${v.wakeWord.slice(1)} ${p}"`;
  const panels = Object.entries(PANELS).filter(([k]) => k !== 'music' || provider);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: L('search') ? `Search apps  (${L('search')})` : 'Search apps', click: () => showOverlay() },
    ...(L('switch') ? [{ label: `Replace ${L('switch')}`, type: 'checkbox', checked: !!config.keys.takeOverSystemSwitcher, click: (i) => setTakeOver(i.checked) }] : []),
    { label: `Voice commands (${say(v.commands.openAll[0])}, ${say(v.commands.closeAll[0])})`, type: 'checkbox', checked: !!v.enabled, click: (i) => setVoice(i.checked) },
    { label: process.platform === 'darwin' ? 'Open at login' : 'Start with Windows', type: 'checkbox', checked: !!config.startAtLogin, click: (i) => setStartAtLogin(i.checked) },
    { type: 'separator' },
    ...Object.entries(MODES).map(([k, label]) => ({ label: `Socials: ${label}`, type: 'radio', checked: config.socialMode === k, click: () => setSocialMode(k) })),
    { type: 'separator' },
    ...panels.map(([k, label]) => ({ label: `Side panel: ${label}`, type: 'checkbox', checked: !!config.panels[k], click: (i) => setPanel(k, i.checked) })),
    { type: 'separator' },
    { label: 'Settings…', click: () => ipcMain.emit('open-setup', {}, 'settings') },
    { label: 'Set up Cubby…', click: () => ipcMain.emit('open-setup', {}, 'wizard') },
    { label: 'Edit config.json…', click: () => shell.openPath(CONFIG) },
    { label: 'Reload config', click: () => { loadConfig(); setSocialMode(config.socialMode); applyConfig(); } },
    { label: 'Restart Cubby', click: () => { app.relaunch(); app.exit(0); } },
    { label: 'Quit Cubby', click: () => app.exit(0) },
  ]));
}

// ---- Extensions ----------------------------------------------------------------
// Features (src/features/*) plug in here instead of editing main.js. ctx.config is live: read it
// each time (Reload config replaces the object); assign ctx.config = next to swap it, then
// saveConfig() + applyConfig().
function registerFeatures() {
  const ctx = {
    get config() { return config; },
    set config(c) { config = c; },
    saveConfig, push, overlay, ipcMain, adapter, catalog, layout, screen, showOverlay, hideOverlay,
    setHoldOpen: (on) => { holdOpen = on; },
    pausePush: (on) => { pushPaused = on; if (!on) push(); },
    BrowserWindow, app, log,
    // extras
    schema, runtime, applyConfig, relayout: relayoutAll, place, notify, makeWindow, smoke: SMOKE,
    cursorDisplay, pauseKeys, applyLoginItem,
  };
  for (const f of [edits, require('./features/setup')]) f.register(ctx);
}

// ---- Smoke test (npm run smoke) ---------------------------------------------------
// Loads every window hidden, renders one snapshot in each (with and without a music provider),
// computes and applies every layout on every connected display, then exits 0 / 1.
async function smoke() {
  const errors = [];
  const fail = (m) => { errors.push(m); console.error('smoke: FAIL', m); };
  // This run's userData is locked until exit, so each run clears the ones before it.
  for (const n of fs.readdirSync(os.tmpdir())) {
    const dir = path.join(os.tmpdir(), n);
    if (n.startsWith('cubby-smoke-') && dir !== DATA) try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  setTimeout(() => { console.error('smoke: timed out'); app.exit(1); }, 8000);
  const wins = { overlay, dock, music: musicWin, toast, cue };
  for (const [name, w] of Object.entries(wins)) {
    w.webContents.on('console-message', (e) => { if (e.level === 'error') fail(`${name}: ${e.message}`); });
    w.webContents.on('did-fail-load', (_, code, desc) => fail(`${name} didn't load: ${desc}`));
    w.webContents.on('render-process-gone', (_, d) => fail(`${name} renderer gone: ${d.reason}`));
  }
  await Promise.all(Object.values(wins).map((w) => w.webContents.isLoading() && new Promise((r) => w.webContents.once('did-stop-loading', r))));

  try {
    registerFeatures();
    for (const name of ['spotify', 'none']) {
      provider = music.get(name, adapter);
      const s = snapshot();
      overlay.webContents.send('open', { ...s, foreground: 0, previous: 0, altSession: name === 'none' });
      dock.webContents.send('model', s);
      if (s.music) musicWin.webContents.send('model', s);
      log(`snapshot (${name}): ${s.groups.length} groups, ${s.groups.flatMap((g) => g.apps).length} apps, music ${s.music ? s.music.name : 'off'}`);
    }
    provider = music.get(config.music.provider, adapter);
    toast.webContents.send('toast', { id: 'cubby', headline: 'Smoke test', title: 'ok' });
    cue.webContents.send('cue', { mode: 'listening', hint: `say “${config.voice.commands.openAll[0]}” or “${config.voice.commands.closeAll[0]}”` });
  } catch (e) { fail(`snapshot: ${e.stack}`); }

  // Starting to drag an app must not move any column, or the drop lands on whatever slid under the
  // cursor. The drop zones take no space: a card floating over the groups, shown during a drag only.
  try {
    place(overlay, layout.overlayBounds(screen.getPrimaryDisplay()));
    await new Promise((r) => setTimeout(r, 150));
    const r = await overlay.webContents.executeJavaScript(`(() => {
      const groups = document.getElementById('groups');
      const settle = () => document.getAnimations().forEach((a) => a.finish()); // the pop-in scales what it measures
      settle();
      const cols = () => JSON.stringify([...groups.children].map((e) => { const b = e.getBoundingClientRect(); return [e.dataset.group, Math.round(b.left), Math.round(b.width)]; }));
      const zones = document.querySelector('.zones');
      const row = document.querySelector('#groups .group .row[data-app]');
      if (!zones || !row) return { error: zones ? 'no app rows to drag' : 'no drop zones' };
      const inGrid = groups.contains(zones);
      const g = groups.getBoundingClientRect();
      const lastRight = Math.round(groups.lastElementChild.getBoundingClientRect().right);
      // No empty space kept for the zones: the columns fill the row (unless they overflow and scroll).
      // The slack is a vertical scrollbar at most; the old zones column was 150px.
      const fills = groups.scrollWidth > groups.offsetWidth || Math.abs(lastRight - g.right) <= 20;
      const hiddenBefore = getComputedStyle(zones).display === 'none';
      const b = row.getBoundingClientRect();
      const at = (x, y) => ({ bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 });
      const before = cols();
      row.dispatchEvent(new PointerEvent('pointerdown', at(b.left + 20, b.top + 10)));
      document.dispatchEvent(new PointerEvent('pointermove', at(b.left + 40, b.top + 10)));
      settle();
      const during = cols();
      const zone = zones.querySelector('[data-group="new"]');
      const z = zone.getBoundingClientRect();
      const shown = getComputedStyle(zones).display !== 'none' && getComputedStyle(zone).visibility === 'visible' && z.width > 0 && z.height > 0;
      const zx = z.left + z.width / 2, zy = z.top + z.height / 2;
      const reachable = document.elementFromPoint(zx, zy)?.closest('.group')?.dataset.group === 'new';
      const docked = z.left >= g.left && z.right <= g.right && z.top >= g.top && z.bottom <= g.bottom;
      const under = document.elementFromPoint(b.left + 40, b.top + 10)?.closest('.group')?.dataset.group;
      document.dispatchEvent(new PointerEvent('pointermove', at(zx, zy)));
      const target = document.querySelector('.group.zone.drop')?.dataset.group;
      document.dispatchEvent(new PointerEvent('pointercancel', at(0, 0)));
      const hiddenAfter = getComputedStyle(zones).display === 'none';
      return { before, during, inGrid, fills, lastRight, gridRight: Math.round(g.right), hiddenBefore, shown, reachable, docked, target, hiddenAfter, under, from: row.closest('.group').dataset.group };
    })()`);
    if (r.error) fail(`drag: ${r.error}`);
    else {
      if (r.before !== r.during) fail(`drag: columns moved when the drag started: ${r.before} -> ${r.during}`);
      if (r.inGrid || !r.fills) fail(`drag: the drop zones take space when not dragging (in the grid: ${r.inGrid}, last column ends at ${r.lastRight} of ${r.gridRight})`);
      if (!r.hiddenBefore || !r.shown || !r.hiddenAfter) fail(`drag: the "+ New group" zone should be hidden until a drag (${r.hiddenBefore}), shown during it (${r.shown}) and hidden after (${r.hiddenAfter})`);
      if (!r.docked) fail('drag: the drop zones are not inside the groups area');
      if (!r.reachable || r.target !== 'new') fail(`drag: the "+ New group" zone can't be reached under the cursor (hit ${r.reachable}, target ${r.target})`);
      if (r.under !== r.from) fail(`drag: the cursor is over "${r.under}", not the group the app was picked up from ("${r.from}")`);
      log(`drag: ${r.during}; zones docked inside the groups area (last column ends at ${r.lastRight} of ${r.gridRight})`);
    }
  } catch (e) { fail(`drag: ${e.stack}`); }

  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const inside = (r, wa) => r.x >= wa.x && r.y >= wa.y && r.x + r.width <= wa.x + wa.width && r.y + r.height <= wa.y + wa.height;
  for (const d of displays) {
    const stack = layout.panelStack(d, panelItems(true));
    const rects = [['overlay', overlay, layout.overlayBounds(d)], ['toast', toast, layout.toastBounds(d)], ['cue', cue, layout.cueBounds(d)],
      ...stack.map((r) => [r.key, r.key === 'music' ? musicWin : dock, r])];
    for (const [name, w, r] of rects) {
      if (![r.x, r.y, r.width, r.height].every(Number.isInteger)) fail(`${name} on ${d.id}: non-integer rect ${JSON.stringify(r)}`);
      if (!inside(r, d.workArea)) fail(`${name} on ${d.id}: ${JSON.stringify(r)} is outside ${JSON.stringify(d.workArea)}`);
      if (!place(w, r)) fail(`${name} on ${d.id}: asked ${JSON.stringify(r)}, got ${JSON.stringify(w.getBounds())}`);
    }
    log(`display ${d.id} ${JSON.stringify(d.bounds)} @${d.scaleFactor}x: ${rects.length} windows placed`);
  }
  for (const setting of ['focus', 'primary', 'mouse', 'no-such-display', ...displays.map((d) => d.id)]) {
    const d = layout.pickPanelDisplay(displays, setting, { cursor: screen.getCursorScreenPoint(), focusRect: focusRect(), current: panelDisplayId }, primaryId);
    if (!displays.includes(d)) fail(`pickPanelDisplay(${setting}) returned no display`);
  }
  // The focused window's rect comes back in DIP, on a display (or null: nothing that counts is focused).
  const fr = focusRect();
  if (fr && !(['x', 'y', 'width', 'height'].every((k) => Number.isFinite(fr[k])) && fr.width > 0 && fr.height > 0)) fail(`windowRect: bad rect ${JSON.stringify(fr)}`);
  log('focused window rect', JSON.stringify(fr), '->', layout.displayOfRect(displays, fr)?.id ?? 'none');

  await new Promise((r) => setTimeout(r, 400)); // let the renderers report errors
  console.log(errors.length ? `smoke: FAILED (${errors.length})` : `smoke: ok (${displays.length} displays)`);
  app.exit(errors.length ? 1 : 0);
}

// ---- Boot --------------------------------------------------------------------

app.whenReady().then(() => {
  loadConfig();
  overlay = makeWindow('overlay.html', {});
  dock = makeWindow('dock.html', { focusable: false });
  musicWin = makeWindow('music.html', { focusable: false });
  musicWin.setIgnoreMouseEvents(true, { forward: true }); // click-through except over the card (music-hit)
  toast = makeWindow('toast.html', { focusable: false });
  cue = makeWindow('listen.html', { focusable: false });
  cue.setIgnoreMouseEvents(true); // click-through
  if (SMOKE) return smoke();

  overlay.on('blur', () => { log('blur'); if (!holdOpen) hideOverlay(); });
  overlay.on('focus', () => log('focus'));
  overlay.on('show', () => log('show'));
  overlay.webContents.once('did-finish-load', listenShell);

  tray = new Tray(trayImage());
  // A fresh install registers nothing until setup has asked; setup applies the choice when it saves.
  if (config.setupComplete) applyLoginItem(config.startAtLogin);
  if (config.voice.enabled) startVoice();
  // Before setup has run, say nothing: on macOS the hook needs Accessibility, which setup asks for.
  if (!installHook() && config.setupComplete) {
    dialog.showErrorBox('Cubby', `Couldn't install the keyboard hook, so ${schema.keyLabel(config.keys.switch)} and ${schema.keyLabel(config.keys.search)} won't open Cubby. Use the tray icon or the right-edge strip.`);
  }
  // Windows silently drops low-level keyboard hooks that answer too slowly, and sleep/resume
  // is the classic trigger; there's no way to detect it. So re-install on wake/unlock and,
  // as a safety net, every minute. Everything is re-placed when the display setup changes.
  powerMonitor.on('resume', afterWake);
  powerMonitor.on('unlock-screen', afterWake);
  setInterval(installHook, 60000);
  let relayout;
  const relayoutSoon = () => { clearTimeout(relayout); relayout = setTimeout(relayoutAll, 500); };
  screen.on('display-metrics-changed', relayoutSoon);
  screen.on('display-added', relayoutSoon);
  screen.on('display-removed', relayoutSoon);
  tray.setToolTip('Cubby');
  tray.on('click', () => showOverlay());
  buildTrayMenu();

  ipcMain.on('activate', (_, hwnd) => activate(hwnd));
  ipcMain.on('launch', (_, id, l) => { const a = findApp(runtime(), id)?.launch || l; if (a) adapter.launch(a); hideOverlay(); });
  ipcMain.on('context', (_, info) => appContext(info));
  ipcMain.on('media', (_, k) => mediaPress(k));
  ipcMain.on('social-mode', (_, m) => setSocialMode(m));
  ipcMain.on('panel', (_, k, on) => setPanel(k, on));
ipcMain.on('voice', (_, on) => setVoice(!!on));
  ipcMain.on('music-hit', (_, hit) => musicWin.setIgnoreMouseEvents(!hit, { forward: true }));
  ipcMain.on('hide', dismiss);
  ipcMain.on('open-tray', () => showOverlay());
  ipcMain.on('open-all', openAll);
  ipcMain.on('close-all', closeAll);
  ipcMain.on('toast-click', (_, hwnd) => { toast.hide(); if (hwnd) adapter.focus(hwnd); });
  ipcMain.on('toast-close', () => toast.hide());

  setInterval(() => { push(); followPanels(); keepPanelsOnTop(); }, 1000); // followPanels also catches a window dragged to another display
  initUpdater(log);
  const stopBadges = adapter.startBadgeWatcher(onBadges);
  app.on('will-quit', stopBadges);
  musicWin.webContents.once('did-finish-load', () => layoutPanels()); // the 1s push fills whichever loads later
  registerFeatures();
  if (process.argv.includes('--show')) overlay.webContents.once('did-finish-load', () => showOverlay());
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', stopVoice);
