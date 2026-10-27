const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, dialog, powerMonitor } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const adapter = require('./platform');
const schema = require('./config/schema');
const catalog = require('./config/catalog');
const music = require('./music/index'); // not './music': that's the renderer's music.js
const layout = require('./layout');
const snap = require('./snap');
const { buildModel, findApp, appForWindow, badgeFor, badgeGrew, pingText, pingApps, allApps, hour12From } = require('./model');
const session = require('./session');
const { initUpdater } = require('./updater');
const edits = require('./features/edits');
const calendar = require('./features/calendar');
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
const PANELS = { clock: 'Clock', socials: 'Socials', music: 'Music' };
const HIDE_ITEM = () => ({ label: 'Hide at the edge (hover or hold Alt)', type: 'checkbox', checked: !!config.panels.autoHide, click: (i) => setPanel('autoHide', i.checked) });

let config;
let configBroken = false; // config.json didn't load: run on the starter config and never save over it
let provider = null; // music provider (src/music), null = 'none'
let icons = {};
let pings = {};
let lastPing = {};
let badges = null; // taskbar badges by AppID; null until the first scan
let overlay, dock, musicWin, toast, cue, tray, toastTimer;
let clockHour12; // the OS clock's 12/24-hour setting (adapter.timeFormat); undefined = follow the locale
let foregroundAtOpen = 0;
let holdOpen = false; // keep the tray up through our own focus changes (context menu, DND minimizing)
let pushPaused = false;

const log = (...a) => (process.env.CUBBY_DEBUG || SMOKE) && console.log(new Date().toISOString().slice(11, 23), ...a);

// Always-on event log next to the config (cubby.log, rolled to cubby.old.log at 1 MB). The
// blank-after-sleep bug (docs/10) happens while nobody watches, in the installed build, where
// console output goes nowhere. Rare events only: power, displays, repairs, window health.
const EVENTS = path.join(DATA, 'cubby.log');
function ev(...a) {
  log(...a);
  if (SMOKE) return;
  try {
    if ((fs.statSync(EVENTS, { throwIfNoEntry: false })?.size || 0) > 1e6) fs.renameSync(EVENTS, path.join(DATA, 'cubby.old.log'));
    fs.appendFileSync(EVENTS, `${new Date().toISOString()} ${a.join(' ')}\n`);
  } catch {}
}

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
    const t = adapter.iconTarget(findApp(rc, a.id) || { launch: a.appId ? { appId: a.appId } : { exe: a.exePath } });
    if (t && icons[t]) byId[a.id] = icons[t];
    else if (t) wantIcon(t);
  }
  const tints = Object.fromEntries(allApps(rc).filter((a) => a.tint).map((a) => [a.id, a.tint]));
  return { ...model, icons: byId, tints, socialMode: config.socialMode, panels: config.panels, clock: { hour12: clockHour12 }, nextEvent: calendar.next(), keys: keyLabels(), voice: voiceHints(), labels: { closeAll: config.labels.closeAll, closeVerb: schema.closeVerb(config.labels.closeAll) }, deleteKey: { confirm: config.deleteKey?.confirm !== false, quit: quitOnDelete() }, layouts: layouts.map(snap.describe), recent: mru, tabOrder: config.switcher.tabOrder };
}

const quitOnDelete = () => process.platform === 'darwin' && config.deleteKey?.macQuit !== false;

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

// After a monitor is plugged in or unplugged, Electron can keep a window's old display scale:
// Windows has it at the right size, but Electron and the page lay it out for the previous
// monitor (10-21: the switcher's content was 2067 DIP in a 1240 DIP window, 2.5x vs 1.5x), so it
// draws oversized and cropped. Re-setting bounds cures it only sometimes; a fresh start always
// does. So Cubby restarts itself when it sees it: never while the switcher is open, not in its
// first 30s, and at most once per 10 min (the time of the last one rides along in argv).
const STARTED = Date.now();
const SCALE_FLAG = '--scale-restart=';
const CRASH_FLAG = '--crash-restart=';
const flagTime = (f) => Number(process.argv.find((a) => a.startsWith(f))?.slice(f.length)) || 0;
const lastScaleRestart = flagTime(SCALE_FLAG);
const lastCrashRestart = flagTime(CRASH_FLAG);
let restarting = false; // also set once quitting starts any other way (updater, Quit)
let unhookKeys = null; // set by installHook
// 10-23: right after waking with a monitor unplugged, app.exit closed the windows but the process
// never ended. Its timers kept hitting destroyed windows ("Object has been destroyed"), and the
// relaunched copy waited on it forever. So if it's still here after 3s, kill it outright.
// The hook goes first: while it's installed, Alt+Tab reaches neither Cubby nor Windows.
function quit() {
  restarting = true;
  if (unhookKeys) unhookKeys();
  unhookKeys = null;
  app.exit(0);
  setTimeout(() => { ev('exit stuck'); process.kill(process.pid); }, 3000);
}
function restart(reason) {
  if (restarting) return;
  restarting = true;
  ev('restart', reason);
  const flag = { scale: SCALE_FLAG, crash: CRASH_FLAG }[reason];
  const args = process.argv.slice(1).filter((a) => !flag || !a.startsWith(flag));
  app.relaunch({ args: flag ? [...args, `${flag}${Date.now()}`] : args });
  quit();
}
// An error Cubby didn't expect (or a crashed or frozen window) leaves it half-working with its hook
// still taking Alt+Tab, so neither switcher works. Restart instead. A second crash within a minute of
// that restart gives up and quits, which hands Alt+Tab back to Windows.
function crashed(what) {
  if (restarting) return; // timers hitting windows that are already closing
  ev('crash', String(what).split('\n').slice(0, 4).join(' | '));
  if (SMOKE) { console.error('smoke: crash', what); app.exit(1); return; }
  if (Date.now() - lastCrashRestart > 60000) return restart('crash');
  restarting = true;
  if (unhookKeys) unhookKeys(); // before the dialog holds the main thread
  unhookKeys = null;
  dialog.showErrorBox('Cubby stopped', 'Cubby ran into an error twice in a row and closed, so the app switcher key is back to your system\'s own. Start Cubby again to bring it back. Details are in cubby.log.');
  quit();
}
process.on('uncaughtException', (e) => crashed(e?.stack || e));
function checkScale() {
  // Nor right after a wake: the displays are still settling, and that's when exit got stuck (10-23, 10-24).
  if (restarting || Date.now() - STARTED < 30000 || Date.now() - wakeAt < 15000 || overlay.isVisible()) return;
  const bad = Object.entries(cubbyWindows()).filter(([, w]) => !sameRect(w.getContentBounds(), w.getBounds()));
  if (!bad.length) return;
  if (Date.now() - lastScaleRestart < 600000) return; // restarted for this recently and it didn't help
  ev('missized', bad.map(([n, w]) => `${n}=${w.getBounds().width}/${w.getContentBounds().width}`).join(' '));
  restart('scale');
}
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
  // "Previous" is the window you were in before, from the activation history (a raised split-screen
  // partner or an always-on-top window you never used doesn't count). Without history, the z-order.
  const wins = adapter.listWindows({ excludePid: process.pid });
  const ok = (h) => h !== foregroundAtOpen && wins.some((w) => w.hwnd === h && !w.minimized);
  const previous = mru.find(ok) || wins.find((w) => ok(w.hwnd))?.hwnd || 0;
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

// ---- Disable / uninstall (tray menu, Settings > Startup) --------------------------
// Disable: Cubby closes and stops starting at login until it's opened again (startup re-applies
// config.startAtLogin, so opening it is the whole undo). Uninstall: Windows runs Cubby's own
// uninstaller (settings stay in %APPDATA%\Cubby); macOS has none, so Finder shows the app to trash.
const AT_LOGIN = process.platform === 'darwin' ? 'at login' : 'with Windows';
async function disableCubby() {
  const { response } = await dialog.showMessageBox({ type: 'question', title: 'Disable Cubby', message: 'Turn Cubby off?', buttons: ['Disable', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
    detail: `Cubby closes, your app switcher key goes back to the system's own, and Cubby won't start ${AT_LOGIN}. Open Cubby again any time to turn it back on.` });
  if (response !== 0) return;
  applyLoginItem(false);
  quit();
}
async function uninstallCubby() {
  const mac = process.platform === 'darwin';
  const uninstaller = path.join(path.dirname(process.execPath), 'Uninstall Cubby.exe');
  if (!app.isPackaged || (!mac && !fs.existsSync(uninstaller))) {
    dialog.showMessageBox({ type: 'info', title: 'Uninstall Cubby', message: "This copy of Cubby wasn't installed, so there's nothing to uninstall.", detail: mac ? '' : 'Installed copies are removed in Settings > Apps > Installed apps.' });
    return;
  }
  const { response } = await dialog.showMessageBox({ type: 'warning', title: 'Uninstall Cubby', message: 'Uninstall Cubby?', buttons: [mac ? 'Show in Finder' : 'Uninstall', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    detail: mac ? 'Cubby will quit and Finder will show it: drag it to the Trash. Your settings stay in ~/Library/Application Support/Cubby; delete that folder to remove them too.'
      : 'Cubby will close and remove itself from this PC. Your settings stay in %APPDATA%\\Cubby, so reinstalling picks up where you left off; delete that folder to remove them too.' });
  if (response !== 0) return;
  applyLoginItem(false);
  if (mac) shell.showItemInFolder(path.resolve(process.execPath, '../../..')); // Cubby.app
  else spawn(uninstaller, [], { detached: true, stdio: 'ignore' }).unref();
  quit();
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
  const l = config.switcher.raiseSnapPartners && layouts.find((x) => x.members.some((m) => m.hwnd === hwnd));
  if (l) return activateLayout(l.id, hwnd);
  focusSafely(hwnd);
  hideOverlay();
}

// The low-level hook runs on this thread, and Windows silently drops it if it waits over ~1s, e.g.
// while restoring a hung app's window. No API says whether that happened, so reinstall after a slow one.
// ponytail: guessed from elapsed time; a hook on its own thread would remove the problem.
function focusSafely(hwnd) {
  const t = Date.now();
  adapter.focus(hwnd);
  if (Date.now() - t > 800) { ev('slow focus', Date.now() - t); installHook(); }
}

// ---- Split screen (src/snap.js) ------------------------------------------------
// Windows shows each snap layout as an extra Alt+Tab entry that brings all of its windows back, with
// no API to read them, so Cubby records what you see: whenever the focused window is snapped and the
// snapped windows in view tile its display, that's a layout. mru: activation history, newest first.
// Saved so a restart (monitor change, crash) keeps them: window handles outlive Cubby, and prune
// drops any that no longer match.
const LAYOUTS = path.join(DATA, 'layouts.json');
let layouts = [];
try { layouts = JSON.parse(fs.readFileSync(LAYOUTS, 'utf8')); } catch {}
if (!Array.isArray(layouts)) layouts = [];
let layoutSeq = Math.max(0, ...layouts.map((l) => l.id));
let lastSnapWins = []; // the last look, to tell a fresh snap from a window that was already there
const snappedAt = new Map(); // hwnd -> when it was last snapped into place
const mru = [];
const raisedOnly = new Set(); // partners activated to bring a layout back: not "used", so not in mru
function snapWindows() {
  return adapter.listWindows({ excludePid: process.pid }).map((w) => ({ hwnd: w.hwnd, minimized: w.minimized, arranged: !w.minimized && adapter.isArranged(w.hwnd), rect: adapter.windowRect(w.hwnd) }));
}
function trackLayouts(hwnd) {
  if (process.platform !== 'win32') return; // Snap layouts are Windows-only (mac's isArranged is always false)
  const before = JSON.stringify(layouts);
  const wins = snapWindows();
  for (const w of snap.justSnapped(lastSnapWins, wins)) snappedAt.set(w.hwnd, Date.now());
  layouts = snap.prune(layouts, wins);
  lastSnapWins = wins;
  const seen = hwnd && wins.find((w) => w.hwnd === hwnd)?.arranged && snap.visibleLayout(wins, screen.getAllDisplays(), hwnd);
  if (snap.worth(layouts, wins, seen, snappedAt, Date.now())) layouts = snap.remember(layouts, seen, layoutSeq + 1, Date.now());
  if (JSON.stringify(layouts) !== before) {
    layoutSeq = Math.max(layoutSeq, ...layouts.map((l) => l.id));
    try { fs.writeFileSync(LAYOUTS, JSON.stringify(layouts)); } catch {}
  }
}
// Partners first, then the one to focus: the window you asked for, else the member you used last.
// raise() activates (Windows refuses anything quieter), so partners stay out of the history.
function activateLayout(id, focusHwnd) {
  const l = layouts.find((x) => x.id === id);
  if (!l) return push();
  const live = l.members.map((m) => m.hwnd).filter((h) => adapter.isWindow(h));
  const target = focusHwnd || mru.find((h) => live.includes(h)) || live[0];
  for (const h of live) if (h !== target) { raisedOnly.add(h); adapter.raise(h); }
  focusSafely(target);
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

// The bar's heights in px (dock.html): border + padding, the clock, the line between, and the
// socials (open-tray button + one 44px slot per ping app, 8px apart, a line after the button).
const PANEL_GAP = 10;
const STRIP = { frame: 18, clock: 98, split: 17, socials: (n) => (n + 1) * 52 - 3 };
function panelItems(all = false) {
  const items = [];
  // One bar for the clock and the socials (dock.html), split by a line: its heights add up.
  const clock = all || config.panels.clock;
  const socials = all || config.panels.socials;
  if (clock || socials) items.push({ key: 'strip', width: 66, height: STRIP.frame + (clock ? STRIP.clock : 0) + (clock && socials ? STRIP.split : 0) + (socials ? STRIP.socials(pingIds().length) : 0) });
  if (provider && (all || config.panels.music)) items.push({ key: 'music', width: 280, height: 176 }); // full expanded width; collapsed it's a 64px column
  // The bar's window also covers the 10px gap above the music card (transparent), so when both are
  // hidden at the edge their lines join into one. Stacked with no gap of their own.
  if (items.length === 2) items[0].height += PANEL_GAP;
  return items;
}

function layoutPanels(d = panelDisplay()) {
  panelDisplayId = d.id;
  const wins = { strip: dock, music: musicWin };
  const rects = layout.panelStack(d, panelItems(), 0);
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

// ---- Hidden side bar (panels.autoHide) ----------------------------------------------
// Tucked off the right edge with a thin line left showing (it glows for pings / music playing).
// It slides out while the cursor is at that edge or on the bar, while Alt is held, while the tray
// is open, and for a moment after a music key. Polled: the cursor is outside our windows.
let tucked = false;
let altHeld = false;
let altTimer;
let peekUntil = 0;
let lastNear = 0;
let musicHit = false;
function onAlt(down) {
  clearTimeout(altTimer);
  if (down) altTimer = setTimeout(() => { altHeld = true; edgeTick(); }, 150); // a quick Alt+F4 / Alt+key doesn't flash it
  else { altHeld = false; edgeTick(); }
}
function edgeTick() {
  const shown = [dock, musicWin].filter((w) => w.isVisible());
  const d = screen.getAllDisplays().find((x) => x.id === panelDisplayId);
  let want = false;
  if (config.panels.autoHide && shown.length && d) {
    const p = screen.getCursorScreenPoint();
    const rs = shown.map((w) => w.getBounds());
    const top = Math.min(...rs.map((r) => r.y)) - 24;
    const bottom = Math.max(...rs.map((r) => r.y + r.height)) + 24;
    const atEdge = p.x >= d.workArea.x + d.workArea.width - 8 && p.x < d.bounds.x + d.bounds.width && p.y >= top && p.y <= bottom;
    const onBar = !tucked && ((dock.isVisible() && layout.contains(dock.getBounds(), p)) || musicHit);
    if (atEdge || onBar) lastNear = Date.now();
    want = !(altHeld || overlay.isVisible() || Date.now() < peekUntil || Date.now() - lastNear < 700);
  }
  if (want === tucked) return;
  tucked = want;
  for (const w of [dock, musicWin]) w.webContents.send('tuck', tucked);
  dock.setIgnoreMouseEvents(tucked); // tucked: clicks go to whatever is under the bar
  if (tucked) { musicHit = false; musicWin.setIgnoreMouseEvents(true, { forward: true }); }
  // After a click-through change Windows keeps showing the old frame of these transparent windows
  // until a repaint is forced (the slide finished in the page but the bar stayed on screen).
  // Every frame through the 0.22s slide, so it animates instead of jumping.
  const t0 = Date.now();
  const paint = setInterval(() => { for (const w of [dock, musicWin]) w.webContents.invalidate(); if (Date.now() - t0 > 320) clearInterval(paint); }, 16);
}

// The clock shows time the way the OS clock does (12/24-hour). Re-read on wake in case it changed.
function readClockFormat() {
  adapter.timeFormat().then((f) => { if (hour12From(f) !== clockHour12) { clockHour12 = hour12From(f); push(); } });
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
  peekUntil = Date.now() + 3000; // a tucked bar slides out to show the new track
  edgeTick();
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
  if (w && w.pid !== process.pid && !raisedOnly.delete(hwnd)) {
    const i = mru.indexOf(hwnd);
    if (i >= 0) mru.splice(i, 1);
    mru.unshift(hwnd);
    mru.length = Math.min(mru.length, 100);
    trackLayouts(hwnd);
  }
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
  if (groupOf) items.push({ label: 'Nicknames…', click: () => overlay.webContents.send('edits:nicknames', { id: info.id }) }, { label: 'Remove from Cubby', click: () => edits.moveApp(info, null) });
  if (hwnd) items.push({ type: 'separator' }, { label: 'Close window', click: () => { adapter.close(hwnd); setTimeout(push, 400); } });
  holdOpen = true;
  Menu.buildFromTemplate(items).popup({ window: overlay, callback: () => { holdOpen = false; overlay.focus(); } });
}

// Delete key on a row. hwnds come from the renderer: numbers only. Mac quits the app (polite), falling back to close.
function closeRow(hwnds) {
  if (!Array.isArray(hwnds) || !hwnds.every(Number.isFinite)) return;
  const wins = adapter.listWindows({ excludePid: process.pid });
  const quit = quitOnDelete();
  const quitByPid = new Map();
  const results = hwnds.flatMap((hwnd) => {
    const w = wins.find((x) => x.hwnd === hwnd);
    if (!w) return []; // unknown or our own window: leave it
    if (quit && !quitByPid.has(w.pid)) quitByPid.set(w.pid, adapter.quitApp(w, { force: false }));
    if (quit && quitByPid.get(w.pid)) return [{ hwnd, quit: true }];
    adapter.close(hwnd);
    return [{ hwnd, quit: false }];
  });
  log('close-row', results);
  setTimeout(push, 400);
}

// ---- Keyboard hook (re)install -------------------------------------------------

let keysPaused = false; // setup is recording a new combo: let every key reach its window
function installHook() {
  if (unhookKeys) unhookKeys();
  unhookKeys = null;
  if (keysPaused) return null;
  const k = config.keys;
  const binds = { [k.search]: onSearchKey };
  if (provider) Object.assign(binds, { [k.musicPrev]: () => mediaPress('prev'), [k.musicPlay]: () => mediaPress('play'), [k.musicNext]: () => mediaPress('next') });
  unhookKeys = adapter.hookKeys({ switchKey: k.switch, takeSwitch: () => !!config.keys.takeOverSystemSwitcher, onSwitch: onHotkey, onRelease: onAltUp, onAlt, onTap, binds });
  return unhookKeys;
}

// macOS: the helper reports whether its event tap exists (it retries every 5s until macOS allows it).
// Say so once per run, after setup, instead of the keys silently doing nothing.
let tapWarned = false;
function onTap(m) {
  if (m.ok || tapWarned || !config.setupComplete) return;
  tapWarned = true;
  dialog.showMessageBox({ type: 'warning', message: `${schema.keyLabel(config.keys.switch)} and ${schema.keyLabel(config.keys.search)} aren't reaching Cubby yet`, detail: 'macOS refused Cubby\'s keyboard tap. In System Settings > Privacy & Security, turn Cubby on under Accessibility and Input Monitoring. If it already looks on, remove it with the minus button and add it again (each new build needs a fresh grant). Cubby picks it up within a few seconds.' });
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

function afterWake(why) {
  ev(why);
  installHook();
  readClockFormat();
  setTimeout(relayoutAll, 2000); // displays take a moment to settle after resume
  setTimeout(() => windowHealth(why), 5000);
  wakeAt = Date.now();
  refreshAfterWake();
}

// After sleep, Windows can drop the windows' drawing surface: they stay shown and keep working, the
// pages say visible and get frames, yet nothing reaches the screen. Measured on broken instances
// (docs/10): invalidate() doesn't bring it back, a page reload does, but only once the display is
// back, which can be seconds after resume (10-15: resume, reload, THEN display removed/added).
// So every wake event (resume, unlock, a display coming back soon after) restarts a 3s timer and
// the reload runs when they've stopped. An open switcher is never reloaded under the user.
let wakeAt = 0;
let wakeTimer;
function refreshAfterWake() {
  if (process.platform !== 'win32') return; // only seen on Windows; on mac it'd flash the cue every unlock
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(function go() {
    if (overlay.isVisible()) { wakeTimer = setTimeout(go, 1000); return; }
    cue.webContents.once('did-finish-load', () => showCue({ mode: 'heard', label: 'Cubby refreshed', sub: 'Ready after sleep' }, 2000));
    repair('reload');
  }, 3000);
}

// Window health (docs/10): ask each page whether Chromium thinks it's visible and whether it still
// gets animation frames. A shown window answering "hidden" or with stalled frames isn't painting.
// Hidden windows normally answer hidden/stalled; only shown ones count as bad.
const cubbyWindows = () => ({ overlay, dock, music: musicWin, toast, cue });
const FRAME_PROBE = `new Promise((r) => { const t = performance.now();
  requestAnimationFrame(() => r([document.visibilityState, Math.round(performance.now() - t)]));
  setTimeout(() => r([document.visibilityState, -1]), 1000); })`;
async function windowHealth(why, { onlyIfBad = false } = {}) {
  let bad = false;
  const parts = await Promise.all(Object.entries(cubbyWindows()).map(async ([name, w]) => {
    // A page reloaded mid-probe never answers, hence the timeout ('?' = no answer).
    const [vis, raf] = await Promise.race([w.webContents.executeJavaScript(FRAME_PROBE), new Promise((r) => setTimeout(r, 2000, ['?', -1]))]).catch(() => ['?', -1]);
    const shown = w.isVisible();
    if (shown && (vis !== 'visible' || raf < 0)) bad = true;
    return `${name}=${shown ? 'shown' : 'hidden'}/${vis}/${raf < 0 ? 'stalled' : `${raf}ms`}`;
  }));
  if (bad || !onlyIfBad) ev('health', why, bad ? 'BAD' : 'ok', parts.join(' '));
}

// Tray > Troubleshoot: cures for a blank Cubby, cheapest first, each followed by a health line so
// the log shows which one worked.
const REPAIRS = {
  repaint: ['Repaint windows', () => { for (const w of Object.values(cubbyWindows())) w.webContents.invalidate(); }],
  reshow: ['Re-show side panels', () => { for (const w of [dock, musicWin]) if (w.isVisible()) { w.hide(); w.showInactive(); } }],
  reload: ['Reload windows', () => { for (const w of Object.values(cubbyWindows())) w.webContents.reload(); }],
};
function repair(k) {
  ev('repair', k);
  REPAIRS[k][1]();
  setTimeout(() => windowHealth(`after-${k}`), 2000);
}
// Panels that slipped under ordinary windows (still "visible" and "topmost", but buried) go back on
// top. Checked every second, so it doesn't matter which event (wake, screen on, unlock) buried them.
function keepPanelsOnTop() {
  for (const w of [dock, musicWin, toast]) {
    if (w.isVisible() && adapter.keepOnTop(adapter.handleOf(w))) ev('lifted', w.getTitle());
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
    HIDE_ITEM(),
    { type: 'separator' },
    { label: 'Settings…', click: () => ipcMain.emit('open-setup', {}, 'settings') },
    { label: 'Set up Cubby…', click: () => ipcMain.emit('open-setup', {}, 'wizard') },
    { label: 'Edit config.json…', click: () => shell.openPath(CONFIG) },
    { label: 'Reload config', click: () => { loadConfig(); setSocialMode(config.socialMode); applyConfig(); } },
    { label: 'Troubleshoot', submenu: [
      { label: 'Check windows', click: () => windowHealth('manual') },
      ...Object.entries(REPAIRS).map(([k, [label]]) => ({ label, click: () => repair(k) })),
      { type: 'separator' },
      { label: 'Open log', click: () => shell.openPath(EVENTS) },
    ] },
    { label: 'Refresh Cubby', click: () => restart('manual') },
    { label: 'Disable Cubby…', click: disableCubby },
    { label: 'Uninstall Cubby…', click: uninstallCubby },
    { label: 'Quit Cubby', click: quit },
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
    cursorDisplay, pauseKeys, applyLoginItem, disableCubby, uninstallCubby, hour12: () => clockHour12,
    iconOf: (id) => { const a = findApp(runtime(), id); return a ? icons[adapter.iconTarget(a)] : undefined; },
  };
  for (const f of [edits, require('./features/setup'), calendar]) f.register(ctx);
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
    const stack = layout.panelStack(d, panelItems(true), 0);
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
  ev('start', pkg.version, `${screen.getAllDisplays().length} display(s)`);
  readClockFormat();
  powerMonitor.on('resume', () => afterWake('resume'));
  powerMonitor.on('unlock-screen', () => afterWake('unlock'));
  powerMonitor.on('suspend', () => ev('suspend'));
  powerMonitor.on('lock-screen', () => ev('lock'));
  app.on('child-process-gone', (_, d) => ev('process gone', d.type, d.reason, d.exitCode));
  app.on('before-quit', () => { restarting = true; }); // the updater's quitAndInstall: its window teardown isn't a crash
  for (const [name, w] of Object.entries(cubbyWindows())) {
    // A second's grace: when Cubby itself is being ended (Task Manager kills all its processes), a page
    // can go a moment before main does, and that must not relaunch it.
    w.webContents.on('render-process-gone', (_, d) => { ev('renderer gone', name, d.reason); if (d.reason !== 'clean-exit') setTimeout(() => crashed(`${name} renderer ${d.reason}`), 1000); });
    // Frozen pages: give it 5s to come back (a busy moment after wake), then restart.
    let frozen;
    w.on('unresponsive', () => { ev('unresponsive', name); frozen = frozen || setTimeout(() => crashed(`${name} unresponsive`), 5000); });
    w.on('responsive', () => { clearTimeout(frozen); frozen = null; });
  }
  // Activation history starts from the stacking order, which is close to most recently used (Alt+Tab's own old rule).
  mru.push(...adapter.listWindows({ excludePid: process.pid }).map((w) => w.hwnd));
  setInterval(installHook, 60000);
  // The screen can go off and on with no power event at all (docs/07 E3), so also check the shown
  // panels every 5 minutes; logged only when one isn't painting.
  setInterval(() => windowHealth('periodic', { onlyIfBad: true }), 5 * 60000);
  let relayout;
  const relayoutSoon = (e) => {
    ev('display', e);
    clearTimeout(relayout);
    relayout = setTimeout(relayoutAll, 500);
    // A display (re)attaching within 2 min of a wake is part of waking: push the refresh after it.
    if (e !== 'metrics' && Date.now() - wakeAt < 120000) refreshAfterWake();
  };
  screen.on('display-metrics-changed', () => relayoutSoon('metrics'));
  screen.on('display-added', () => relayoutSoon('added'));
  screen.on('display-removed', () => relayoutSoon('removed'));
  tray.setToolTip('Cubby');
  tray.on('click', () => showOverlay());
  buildTrayMenu();

  ipcMain.on('activate', (_, hwnd) => activate(hwnd));
  ipcMain.on('activate-layout', (_, id) => activateLayout(id));
  ipcMain.on('launch', (_, id, l) => { const a = findApp(runtime(), id)?.launch || l; if (a) adapter.launch(a); hideOverlay(); });
  ipcMain.on('context', (_, info) => appContext(info));
  ipcMain.on('side-menu', (_, at) => {
    const items = Object.entries(PANELS).filter(([k]) => k !== 'music' || provider)
      .map(([k, label]) => ({ label, type: 'checkbox', checked: !!config.panels[k], click: (i) => setPanel(k, i.checked) }));
    items.push({ type: 'separator' }, HIDE_ITEM());
    holdOpen = true;
    Menu.buildFromTemplate(items).popup({ window: overlay, x: at?.x, y: at?.y, callback: () => { holdOpen = false; overlay.focus(); } });
  });
  ipcMain.on('media', (_, k) => mediaPress(k));
  ipcMain.on('social-mode', (_, m) => setSocialMode(m));
  ipcMain.on('panel', (_, k, on) => setPanel(k, on));
ipcMain.on('voice', (_, on) => setVoice(!!on));
  ipcMain.on('music-hit', (_, hit) => { musicHit = hit; musicWin.setIgnoreMouseEvents(!hit, { forward: true }); });
  setInterval(edgeTick, 100);
  for (const w of [dock, musicWin]) w.webContents.on('did-finish-load', () => w.webContents.send('tuck', tucked)); // a reload (wake repair) starts untucked
  ipcMain.on('hide', dismiss);
  ipcMain.on('open-tray', () => showOverlay());
  ipcMain.on('open-all', openAll);
  ipcMain.on('close-all', closeAll);
  ipcMain.on('close-row', (_, p) => closeRow(p?.hwnds));
  ipcMain.on('toast-click', (_, hwnd) => { toast.hide(); if (hwnd) activate(hwnd); });
  ipcMain.on('toast-close', () => toast.hide());

  setInterval(() => { trackLayouts(adapter.foreground()); push(); followPanels(); keepPanelsOnTop(); checkScale(); }, 1000); // followPanels also catches a window dragged to another display
  initUpdater(log);
  const stopBadges = adapter.startBadgeWatcher(onBadges);
  app.on('will-quit', stopBadges);
  musicWin.webContents.once('did-finish-load', () => layoutPanels()); // the 1s push fills whichever loads later
  registerFeatures();
  if (Date.now() - lastScaleRestart < 60000) cue.webContents.once('did-finish-load', () => showCue({ mode: 'heard', label: 'Cubby refreshed', sub: 'Resized for this screen' }, 2000));
  if (process.argv.includes('--show')) overlay.webContents.once('did-finish-load', () => showOverlay());
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', stopVoice);
