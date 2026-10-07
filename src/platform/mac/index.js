// macOS adapter (experimental; plan §3, mac column). Interface: see ../index.js.
// Everything native goes through one helper process, native/mac-helper (cubby-helper), over
// newline-delimited JSON (./helper.js). Window handles are CGWindowIDs.
// The interface answers window queries synchronously, so the window list is kept in a cache:
// polled every 500ms, plus pushed by the helper when an app activates / launches / quits.
// Frames (window.frame) are global top-left-origin points, the same space as Electron's screen API.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { createHelper } = require('./helper');
const { parseAccelerator, wire } = require('./keys');

const POLL_MS = 500;
const log = (...a) => process.env.CUBBY_DEBUG && console.log('mac:', ...a);

function helperPath() {
  const dev = path.join(__dirname, '../../../native/mac-helper/.build');
  const candidates = [
    process.env.CUBBY_HELPER,
    process.resourcesPath && path.join(process.resourcesPath, 'cubby-helper'),
    path.join(dev, 'release/cubby-helper'),
    path.join(dev, 'apple/Products/Release/cubby-helper'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
}

let helper = null;
const h = () => helper || (helper = createHelper(helperPath(), { log }));

// One-shot synchronous call (`cubby-helper --list` / `--permissions`), for answers needed before the
// long-lived helper has replied once. null on any failure (no binary, timeout).
function oneShot(flag) {
  try { return JSON.parse(execFileSync(helperPath(), [flag], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()); } catch { return null; }
}

// ---- Window cache ------------------------------------------------------------------
let wins = []; // adapter-shaped, front to back (≈ most recently used first)
let fg = 0;
let primed = false;
let polling = null;
let inFlight = false;
const shellSubs = [];

// exe = lowercased basename of the bundle path ("google chrome.app"), like Windows' "chrome.exe":
// it's what an "Other" app is keyed and matched by (match: { exe }). bundleId is matched too (catalog).
const toWin = (w) => {
  const exePath = w.path || '';
  return { hwnd: w.id, title: w.title || w.name || '', pid: w.pid, exePath, exe: path.basename(exePath).toLowerCase(),
    bundleId: w.bundleId || '', minimized: !!(w.minimized || w.hidden), frame: w.frame || null };
};

function update(r) {
  if (!r || !Array.isArray(r.windows)) return;
  const before = new Set(wins.map((w) => w.hwnd));
  const prevFg = fg;
  wins = r.windows.map(toWin);
  fg = r.foreground || 0;
  if (!primed) { primed = true; return; } // first list is the baseline, not a burst of "created"
  const after = new Set(wins.map((w) => w.hwnd));
  for (const s of shellSubs) {
    for (const id of after) if (!before.has(id)) s.create?.(id);
    for (const id of before) if (!after.has(id)) s.destroy?.(id);
    if (fg && fg !== prevFg) s.activate?.(fg);
  }
}

function refresh() {
  if (inFlight) return;
  inFlight = true;
  h().request('list').then(update, () => {}).finally(() => { inFlight = false; });
}

function startPolling() {
  if (polling) return;
  if (!primed) update(oneShot('--list')); // so the very first snapshot isn't empty
  primed = true;
  h().on('windows', update);
  refresh();
  polling = setInterval(refresh, POLL_MS);
  polling.unref?.();
}

function listWindows({ excludePid } = {}) {
  startPolling();
  return wins.filter((w) => w.pid !== excludePid).map((w) => ({ ...w }));
}

// Our own windows: focused through Electron, not AX.
const own = new Map(); // CGWindowID -> BrowserWindow
// getMediaSourceId() is "window:<CGWindowID>:0" on macOS.
function handleOf(bw) {
  const id = Number(String(bw.getMediaSourceId()).split(':')[1]) || 0;
  if (id) own.set(id, bw);
  return id;
}

function focus(win) {
  const bw = own.get(win);
  if (bw && !bw.isDestroyed()) {
    require('electron').app.focus({ steal: true });
    bw.show();
    bw.focus();
    return true;
  }
  h().send('focus', { win });
  return true;
}

// Like clicking the red button; minimize uses AXMinimized; maximize fills the screen the window is on
// (not the green button, which toggles full screen: Cubby maximizes twice on purpose).
const windowCmd = (cmd) => (win) => { h().send(cmd, { win }); setTimeout(refresh, 300).unref?.(); return true; };

function onShellEvents(bw, handlers = {}) {
  // flash: macOS has no taskbar flash (a bouncing Dock icon isn't observable), so pings come from
  // Dock badges only.
  shellSubs.push(handlers);
  startPolling();
}

// ---- Keys ----------------------------------------------------------------------------
// The tap lives in the helper and must decide at once whether to swallow a key, so it can't ask
// takeSwitch(); its answer is pushed to the helper whenever it changes instead.
let perms = null;
function hookKeys({ switchKey = 'Alt+Tab', takeSwitch = () => true, onSwitch = () => {}, onRelease = () => {}, binds = {} }) {
  if (!perms?.accessibility) perms = oneShot('--permissions') || {};
  if (!perms.accessibility) return null; // the tap can't swallow keys without Accessibility
  const sw = parseAccelerator(switchKey);
  const fns = new Map();
  const list = [];
  for (const [accel, fn] of Object.entries(binds)) {
    const spec = parseAccelerator(accel);
    if (!spec || !fn) continue;
    fns.set(accel, fn);
    list.push({ id: accel, spec: wire(spec) });
  }
  const helper = h();
  let take = !!takeSwitch();
  const send = () => helper.hold('keys', 'hookKeys', { switch: sw && wire(sw), take, binds: list });
  const offs = [
    helper.on('key', (m) => fns.get(m.id)?.()),
    helper.on('switch', (m) => onSwitch(!!m.back)),
    helper.on('release', () => onRelease()),
    helper.on('tap', (m) => log('tap', JSON.stringify(m))),
  ];
  send();
  const poll = setInterval(() => {
    const t = !!takeSwitch();
    if (t !== take) { take = t; send(); }
  }, 250);
  poll.unref?.();
  return () => {
    clearInterval(poll);
    offs.forEach((off) => off());
    helper.drop('keys', 'unhookKeys');
  };
}

// ---- Launch / quit --------------------------------------------------------------------
const expand = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

// uri wins (as on Windows); { exe } is a .app path here (an "Other" app's exePath).
function launch(l) {
  const target = l.path || l.exe;
  const args = l.uri ? [l.uri] : l.bundleId ? ['-b', l.bundleId] : target ? [expand(target)] : null;
  if (args) execFile('open', args, (err) => err && log('open', args.join(' '), err.message));
}

// Quitting these would take the desktop / Dock / menu bar with them: close their windows only.
const PROTECTED_IDS = new Set(['com.apple.finder', 'com.apple.dock', 'com.apple.systemuiserver', 'com.apple.loginwindow', 'com.apple.controlcenter']);
const PROTECTED_EXES = new Set(['finder.app', 'dock.app', 'systemuiserver.app', 'loginwindow.app', 'controlcenter.app']);
const isProtected = (t) => t.pid === process.pid || PROTECTED_IDS.has(t.bundleId) || PROTECTED_EXES.has(t.exe);

function quitApp(target, { force = true } = {}) {
  if (isProtected(target)) return false;
  h().request('quit', { pid: target.pid, force }).catch(() => {
    try { process.kill(target.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {}
  });
  return true;
}

// ---- Icons / installed apps ------------------------------------------------------------------
const iconTarget = (a) => {
  const l = a.launch || {};
  const id = l.bundleId || a.match?.bundleId;
  if (id) return `bundle:${id}`;
  const p = l.path || l.exe;
  return p ? expand(p) : null;
};

const renderIcons = (targets) => h().request('icons', { targets, size: 64 }, 30000).catch(() => ({}));

const listInstalledApps = () => h().request('apps', {}, 30000)
  .then((apps) => apps.map((a) => ({ name: a.name, launch: a.bundleId ? { bundleId: a.bundleId } : { path: a.path } })))
  .catch(() => []);

// ---- Long-running watchers ------------------------------------------------------------------
// Dock badges, keyed by bundle id (Windows keys them by AppID).
function startBadgeWatcher(onBadges) {
  const off = h().on('badges', (m) => onBadges(m.badges || {}));
  h().hold('badges', 'badges', { on: true });
  return () => { off(); h().drop('badges', 'badges', { on: false }); };
}

// On-device SFSpeech in the helper. A recognizer that stops (error, end of WAV) is started again
// after 10s, like a crashed voice.ps1 on Windows.
function startVoice({ phrases, wav }, onLine) {
  const helper = h();
  const msg = { on: true, phrases, wav, locale: 'en-US' };
  let timer;
  const offs = [
    helper.on('voice', (m) => m.line && onLine(m.line)),
    helper.on('voice-ended', (m) => {
      log('voice ended:', m.error);
      clearTimeout(timer);
      timer = setTimeout(() => helper.hold('voice', 'voice', msg), 10000);
    }),
  ];
  helper.hold('voice', 'voice', msg);
  return () => {
    clearTimeout(timer);
    offs.forEach((off) => off());
    helper.drop('voice', 'voice', { on: false });
  };
}

// Cubby has never shipped another app id on macOS, so there's nothing stale to remove.
function removeStaleLoginItems() {}

// ---- mac extras (setup's permissions step) -------------------------------------------------------
// permissions() -> { accessibility, screenRecording, inputMonitoring: bool, microphone, speech: 'granted'|'denied'|'undetermined' }
const PERMISSION_PANES = {
  accessibility: 'Privacy_Accessibility',
  screenRecording: 'Privacy_ScreenCapture',
  inputMonitoring: 'Privacy_ListenEvent',
  microphone: 'Privacy_Microphone',
  speech: 'Privacy_SpeechRecognition',
};
const permissions = () => h().request('permissions').then((p) => (perms = p), () => oneShot('--permissions') || {});
const requestPermission = (kind) => h().request('requestPermission', { kind }).catch(() => false);
function openPermissionSettings(kind) {
  if (PERMISSION_PANES[kind]) execFile('open', [`x-apple.systempreferences:com.apple.preference.security?${PERMISSION_PANES[kind]}`], () => {});
}

// Our own window to the front: an LSUIElement app has to activate itself first (untested on a Mac).
function forceForeground() {
  require('electron').app.focus({ steal: true });
  return true;
}

module.exports = {
  forceForeground,
  listWindows,
  focus,
  minimize: windowCmd('minimize'),
  maximize: windowCmd('maximize'),
  close: windowCmd('close'),
  isWindow: (win) => own.has(win) || wins.some((w) => w.hwnd === win),
  foreground: () => { startPolling(); return fg; },
  // Frames are already global points (Electron's screen space). Minimized / hidden: nowhere.
  windowRect: (win, { excludePid } = {}) => {
    const w = wins.find((x) => x.hwnd === win);
    return w && w.frame && !w.minimized && w.pid !== excludePid ? { ...w.frame } : null;
  },
  handleOf,
  mediaKey: (cmd) => h().send('media', { key: cmd }),
  parseAccelerator,
  hookKeys,
  onShellEvents,
  launch,
  quitApp,
  isProtected,
  iconTarget,
  renderIcons,
  startBadgeWatcher,
  startVoice,
  listInstalledApps,
  removeStaleLoginItems,
  // mac only
  musicProviders: require('./music'),
  permissions,
  requestPermission,
  openPermissionSettings,
  PERMISSION_PANES,
};
