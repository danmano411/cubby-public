// Windows adapter: thin Win32 bindings via koffi plus the PowerShell helpers next to this file.
// Handles are passed around as plain numbers. Interface: see ../index.js.
const koffi = require('koffi');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { iconTarget, expandEnv: expand } = require('./icon-target');
const { createIconQueue } = require('./icon-queue');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');

const EnumProc = koffi.proto('bool __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, void *buf, int max)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t hwnd, void *buf, int max)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)');
const GetWindow = user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t cmd)');
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, void *pid)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, void *rect)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr_t hwnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)');
const PostMessageW = user32.func('bool __stdcall PostMessageW(intptr_t hwnd, uint32_t msg, uintptr_t w, intptr_t l)');
const keybd_event = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)');
const GetAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int vk)');
const RegisterShellHookWindow = user32.func('bool __stdcall RegisterShellHookWindow(intptr_t hwnd)');
const RegisterWindowMessageW = user32.func('uint32_t __stdcall RegisterWindowMessageW(str16 name)');
const OpenProcess = kernel32.func('intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t h)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, void *buf, void *size)');
const DwmGetWindowAttribute = dwmapi.func('int __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, void *buf, uint32_t size)');

const KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', { vkCode: 'uint32_t', scanCode: 'uint32_t', flags: 'uint32_t', time: 'uint32_t', extra: 'uintptr_t' });
const LowLevelKeyboardProc = koffi.proto('intptr_t __stdcall LowLevelKeyboardProc(int code, uintptr_t wParam, void *lParam)');
const SetWindowsHookExW = user32.func('intptr_t __stdcall SetWindowsHookExW(int id, LowLevelKeyboardProc *proc, intptr_t hmod, uint32_t thread)');
const UnhookWindowsHookEx = user32.func('bool __stdcall UnhookWindowsHookEx(intptr_t hhk)');
const CallNextHookEx = user32.func('intptr_t __stdcall CallNextHookEx(intptr_t hhk, int code, uintptr_t wParam, void *lParam)');
const GetModuleHandleW = kernel32.func('intptr_t __stdcall GetModuleHandleW(str16 name)');

const GW_OWNER = 4;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_NOACTIVATE = 0x08000000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SW_RESTORE = 9, SW_MINIMIZE = 6;
const WM_CLOSE = 0x10;
const VK_MENU = 0x12, KEYEVENTF_KEYUP = 2;
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

function readStr(fn, hwnd) {
  const buf = Buffer.alloc(1024);
  const n = fn(hwnd, buf, 512);
  return buf.toString('utf16le', 0, n * 2);
}

const exeCache = new Map(); // pid -> exe path
function exeForPid(pid) {
  if (exeCache.has(pid)) return exeCache.get(pid);
  let exe = '';
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (h) {
    const buf = Buffer.alloc(2048);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(1024);
    if (QueryFullProcessImageNameW(h, 0, buf, size)) exe = buf.toString('utf16le', 0, size.readUInt32LE() * 2);
    CloseHandle(h);
  }
  exeCache.set(pid, exe);
  return exe;
}

function pidOf(hwnd) {
  const buf = Buffer.alloc(4);
  GetWindowThreadProcessId(hwnd, buf);
  return buf.readUInt32LE();
}

function isCloaked(hwnd) {
  const buf = Buffer.alloc(4);
  return DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, buf, 4) === 0 && buf.readUInt32LE() !== 0;
}

// Alt-Tab-style filter: visible, uncloaked, unowned, titled, not a tool window.
function listWindows({ excludePid } = {}) {
  const out = [];
  EnumWindows((hwnd) => {
    if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER)) return true;
    const ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    if (ex & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) return true;
    if (isCloaked(hwnd)) return true;
    const title = readStr(GetWindowTextW, hwnd);
    if (!title) return true;
    if (SHELL_CLASSES.has(readStr(GetClassNameW, hwnd))) return true;
    const pid = pidOf(hwnd);
    if (pid === excludePid) return true;
    const exePath = exeForPid(pid);
    out.push({ hwnd: Number(hwnd), title, pid, exePath, exe: path.basename(exePath).toLowerCase(), minimized: IsIconic(hwnd) });
    return true;
  }, 0);
  return out;
}

// Where a window is on screen, in DIP (Electron's screen space), for following the focused window
// across displays. null when it doesn't count as being anywhere: minimized, hidden, cloaked (on
// another virtual desktop), the desktop or the taskbar, or excludePid's. The DWM frame excludes the
// invisible resize borders that GetWindowRect includes; both are physical pixels (Electron is
// per-monitor DPI aware).
function windowRect(hwnd, { excludePid } = {}) {
  if (!hwnd || !IsWindow(hwnd) || !IsWindowVisible(hwnd) || IsIconic(hwnd) || isCloaked(hwnd)) return null;
  if (SHELL_CLASSES.has(readStr(GetClassNameW, hwnd)) || pidOf(hwnd) === excludePid) return null;
  const buf = Buffer.alloc(16); // RECT { left, top, right, bottom }
  if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16) !== 0 && !GetWindowRect(hwnd, buf)) return null;
  const [left, top, right, bottom] = [0, 4, 8, 12].map((o) => buf.readInt32LE(o));
  if (right <= left || bottom <= top) return null;
  return require('electron').screen.screenToDipRect(null, { x: left, y: top, width: right - left, height: bottom - top });
}

// SetForegroundWindow is refused unless we "own" input; a synthetic Alt tap satisfies that.
function focus(hwnd) {
  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
  keybd_event(VK_MENU, 0, 0, 0);
  keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
  BringWindowToTop(hwnd);
  return SetForegroundWindow(hwnd);
}

// Bring one of OUR windows to the front. The hook swallows the hotkey, so Windows may not count
// Cubby as the source of the last input and refuse SetForegroundWindow. Sending one tagged,
// unassigned key first makes us that source. Not an Alt tap like focus() uses: that would end an
// Alt+Tab session early. (AttachThreadInput also works but makes the window flap focus/blur on
// detach, leaving Electron thinking it is unfocused.) Returns whether the window ended up in front.
function forceForeground(hwnd) {
  if (Number(GetForegroundWindow()) === hwnd) return true;
  maskModifierRelease();
  BringWindowToTop(hwnd);
  SetForegroundWindow(hwnd);
  return Number(GetForegroundWindow()) === hwnd;
}

const MEDIA = { prev: 0xB1, next: 0xB0, play: 0xB3 };
function mediaKey(k) {
  keybd_event(MEDIA[k], 0, 0, 0);
  keybd_event(MEDIA[k], 0, KEYEVENTF_KEYUP, 0);
}

// ---- Keys --------------------------------------------------------------------
// Accelerators are Electron-style strings ("Alt+Tab", "Alt+`", "Ctrl+Shift+F1").
const NAMED = { tab: 0x09, space: 0x20, enter: 0x0D, return: 0x0D, escape: 0x1B, esc: 0x1B, backspace: 0x08, delete: 0x2E, insert: 0x2D,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27 };
const PUNCT = { '`': 0xC0, '~': 0xC0, '[': 0xDB, '\\': 0xDC, ']': 0xDD, '-': 0xBD, '=': 0xBB, ';': 0xBA, "'": 0xDE, ',': 0xBC, '.': 0xBE, '/': 0xBF };
const MODS = { alt: 'alt', option: 'alt', ctrl: 'ctrl', control: 'ctrl', cmdorctrl: 'ctrl', commandorcontrol: 'ctrl', shift: 'shift', win: 'win', super: 'win', meta: 'win', cmd: 'win', command: 'win' };

// -> { alt, ctrl, shift, win, vk } or null when the string isn't a key we can hook.
function parseAccelerator(accel) {
  if (!accel || typeof accel !== 'string') return null;
  const parts = accel.split('+');
  const key = parts.pop();
  const spec = { alt: false, ctrl: false, shift: false, win: false, vk: 0 };
  for (const p of parts) {
    const m = MODS[p.trim().toLowerCase()];
    if (!m) return null;
    spec[m] = true;
  }
  const f = /^f(\d{1,2})$/i.exec(key);
  if (PUNCT[key]) spec.vk = PUNCT[key];
  else if (/^[a-z0-9]$/i.test(key)) spec.vk = key.toUpperCase().charCodeAt(0);
  else if (f && f[1] >= 1 && f[1] <= 24) spec.vk = 0x6F + Number(f[1]);
  else spec.vk = NAMED[key.toLowerCase()] || 0;
  return spec.vk ? spec : null;
}

// Low-level keyboard hook. The system switcher (Alt+Tab) can't be claimed with RegisterHotKey, so
// it's taken here (only while takeSwitch() is true), and the switch modifier's release is reported
// for switch-on-release. binds: { accelerator: fn } for other shortcuts (search, media), handled
// here rather than RegisterHotKey so they also work mid-switch and never leak into the focused app.
// Shift is free on binds that don't name it (Shift+switch = back). Callbacks run on the next tick;
// the hook itself returns at once (Windows drops slow hooks).
// Returns an unhook function, or null. The hook dies with the process, so a crash gives Alt+Tab back.
const VK_TAB = 0x09, VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_LWIN = 0x5B, VK_RWIN = 0x5C;
const WM_KEYDOWN = 0x100, WM_SYSKEYDOWN = 0x104, LLKHF_ALTDOWN = 0x20;
const RELEASE = { alt: [VK_MENU, 0xA4, 0xA5], ctrl: [VK_CONTROL, 0xA2, 0xA3], win: [VK_LWIN, VK_RWIN] };
const held = (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0;
// Swallowing the key of an Alt/Win shortcut leaves the focused app seeing a LONE Alt (or Win) tap:
// Alt activates its menu bar and grabs focus back from the tray (any app with a classic menu
// bar), Win opens Start. Tapping an unassigned key while the modifier is held "masks" the
// release, the same trick AutoHotkey uses (MenuMaskKey).
const VK_MASK = 0xE8, MASK_TAG = 0xC0BB7; // unassigned VK; dwExtraInfo tag so the hook ignores it
function maskModifierRelease() {
  keybd_event(VK_MASK, 0, 0, MASK_TAG);
  keybd_event(VK_MASK, 0, KEYEVENTF_KEYUP, MASK_TAG);
}
const fits = (spec, mods) => spec.alt === mods.alt && spec.ctrl === mods.ctrl && spec.win === mods.win && (!spec.shift || mods.shift);

function hookKeys({ switchKey = 'Alt+Tab', takeSwitch = () => true, onSwitch = () => {}, onRelease = () => {}, binds = {} }) {
  const sw = parseAccelerator(switchKey);
  const table = new Map(); // vk -> [{ spec, fn }]
  for (const [accel, fn] of Object.entries(binds)) {
    const spec = parseAccelerator(accel);
    if (!spec || !fn) continue;
    if (!table.has(spec.vk)) table.set(spec.vk, []);
    table.get(spec.vk).push({ spec, fn });
  }
  // Letting go of the switch's modifier (Alt for Alt+Tab) ends the switch session.
  const release = new Set(RELEASE[sw && !sw.alt ? (sw.ctrl ? 'ctrl' : sw.win ? 'win' : 'alt') : 'alt']);
  let hhk = 0;
  const proc = koffi.register((code, wParam, lParam) => {
    if (code === 0) {
      const k = koffi.decode(lParam, KBDLLHOOKSTRUCT);
      if (Number(k.extra) === MASK_TAG) return CallNextHookEx(hhk, code, wParam, lParam);
      const down = wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN;
      if (release.has(k.vkCode) && !down) setImmediate(onRelease);
      const binds = table.get(k.vkCode);
      const isSwitch = sw && k.vkCode === sw.vk;
      if (binds || isSwitch) {
        const mods = { alt: !!(k.flags & LLKHF_ALTDOWN), ctrl: held(VK_CONTROL), shift: held(VK_SHIFT), win: held(VK_LWIN) || held(VK_RWIN) };
        const masked = down && (mods.alt || mods.win);
        for (const b of binds || []) {
          if (!fits(b.spec, mods)) continue;
          if (down) setImmediate(() => { if (masked) maskModifierRelease(); b.fn(); });
          return 1;
        }
        if (isSwitch && fits(sw, mods) && takeSwitch()) {
          if (down) { const back = mods.shift && !sw.shift; setImmediate(() => { if (masked) maskModifierRelease(); onSwitch(back); }); }
          return 1; // swallow both down and up so Windows' switcher never sees it
        }
      }
    }
    return CallNextHookEx(hhk, code, wParam, lParam);
  }, koffi.pointer(LowLevelKeyboardProc));
  hhk = SetWindowsHookExW(13 /* WH_KEYBOARD_LL */, proc, GetModuleHandleW(null), 0);
  if (!hhk) { koffi.unregister(proc); return null; }
  return () => { UnhookWindowsHookEx(hhk); koffi.unregister(proc); };
}

// ---- Shell events (taskbar flash, activation, window create/destroy) ------------
const SHELL = { CREATED: 1, DESTROYED: 2, ACTIVATED: 4, RUDE_ACTIVATED: 0x8004, FLASH: 0x8006 };
const handleOf = (bw) => Number(bw.getNativeWindowHandle().readBigUInt64LE());

function onShellEvents(bw, { flash, activate, create, destroy } = {}) {
  RegisterShellHookWindow(handleOf(bw));
  bw.hookWindowMessage(RegisterWindowMessageW('SHELLHOOK'), (wParam, lParam) => {
    const code = Number(wParam.readBigUInt64LE());
    const hwnd = Number(lParam.readBigInt64LE());
    if (code === SHELL.FLASH) flash?.(hwnd);
    else if (code === SHELL.ACTIVATED || code === SHELL.RUDE_ACTIVATED) activate?.(hwnd);
    else if (code === SHELL.CREATED) create?.(hwnd);
    else if (code === SHELL.DESTROYED) destroy?.(hwnd);
  });
}

// ---- Launch / quit ---------------------------------------------------------------
// uri wins over appId (appId is still used for the icon), e.g. Teams opened on a specific org.
function launch(l) {
  const { shell } = require('electron');
  if (l.uri) shell.openExternal(l.uri);
  else if (l.appId) spawn('explorer.exe', [`shell:AppsFolder\\${l.appId}`], { detached: true, stdio: 'ignore' }).unref();
  else if (l.exe) shell.openPath(expand(l.exe));
}

// explorer.exe also runs the taskbar/desktop: close its windows, never kill the process.
const isProtected = (t) => t.exe === 'explorer.exe';

// Force-quit one app process (and its children), e.g. a tray app whose windows are gone.
// target: { pid, exe } as from listWindows. Returns false for protected processes.
function quitApp(target, { force = true } = {}) {
  if (isProtected(target)) return false;
  execFile('taskkill', ['/PID', String(target.pid), '/T', ...(force ? ['/F'] : [])], () => {});
  return true;
}

// ---- PowerShell helpers --------------------------------------------------------
// stdio is spelled out so a helper never holds on to Cubby's own stdout/stderr (e.g. a log file),
// and stderr is dropped: nobody reads it, and a full pipe would block the helper.
const ps = (file, args = [], opts = {}) =>
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, file), ...args],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], ...opts });

// Long-running line-per-event helper, restarted 10s after it exits until stop() is called.
function watchLines(file, args, onLine) {
  let proc = null;
  let stopped = false;
  let timer;
  const start = () => {
    const p = (proc = ps(file, args));
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) onLine(buf.slice(0, i).trim());
    });
    p.on('error', () => {});
    p.on('exit', () => { if (proc === p && !stopped) timer = setTimeout(start, 10000); });
  };
  start();
  return () => { stopped = true; clearTimeout(timer); proc?.kill(); };
}

// Icons are rendered by the shell (same as the Start menu), keyed by launch target (icon-target.js),
// through one queue for the whole app: one icons.ps1 at a time, hung targets never retried, a quiet
// helper killed with its tree (icon-queue.js). Targets that don't render get letter tiles.
const killTree = (child) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
const iconQueue = createIconQueue({
  spawnHelper: ({ itemMs }) => ps('icons.ps1', ['-itemMs', String(itemMs)]), // 5s per item; 12s while PowerShell is cold
  killTree,
  log: (...a) => process.env.CUBBY_DEBUG && console.log(...a),
});
const renderIcons = (targets) => iconQueue.render(targets);

// Taskbar badges by AppID (badges.ps1); onBadges gets the full map whenever it changes.
const startBadgeWatcher = (onBadges) => watchLines('badges.ps1', [], (line) => {
  try { onBadges(JSON.parse(line)); } catch {}
});

// Offline recognizer (voice.ps1). onLine gets "<grammar>|<text>|<confidence>".
// wav: read from an audio file instead of the mic (testing).
const startVoice = ({ phrases, wav }, onLine) =>
  watchLines('voice.ps1', ['-phrases', phrases.join('|'), ...(wav ? ['-wav', wav] : [])], (line) => line && onLine(line));

// Start-menu apps (AppsFolder), e.g. for setup's "add apps" list.
function listInstalledApps() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', 'Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress'],
      { windowsHide: true, maxBuffer: 16 << 20, timeout: 60000 }, (err, out) => {
        try {
          const list = [].concat(JSON.parse(out || '[]'));
          resolve(list.filter((a) => a && a.Name && a.AppID).map((a) => ({ name: a.Name, launch: { appId: a.AppID } })));
        } catch { resolve([]); }
      });
  });
}

// Older builds registered the login item (HKCU Run) under another app id. Remove Run values that
// launch this same command (all of `commandParts`) under any other name, so Cubby starts once.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
function removeStaleLoginItems(keepName, commandParts) {
  execFile('reg', ['query', RUN_KEY], { windowsHide: true }, (err, out) => {
    if (err) return;
    const parts = commandParts.map((p) => p.toLowerCase());
    for (const line of out.split(/\r?\n/)) {
      const m = /^ {4}(.+?) {4}REG_(?:EXPAND_)?SZ {4}(.*)$/.exec(line);
      if (!m || m[1] === keepName || !parts.every((p) => m[2].toLowerCase().includes(p))) continue;
      execFile('reg', ['delete', RUN_KEY, '/v', m[1], '/f'], { windowsHide: true }, () => {});
    }
  });
}

module.exports = {
  listWindows,
  focus,
  forceForeground,
  minimize: (hwnd) => ShowWindow(hwnd, SW_MINIMIZE),
  maximize: (hwnd) => ShowWindow(hwnd, 3 /* SW_MAXIMIZE */),
  close: (hwnd) => PostMessageW(hwnd, WM_CLOSE, 0, 0),
  isWindow: (hwnd) => IsWindow(hwnd),
  foreground: () => Number(GetForegroundWindow()),
  windowRect,
  handleOf,
  mediaKey,
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
};
