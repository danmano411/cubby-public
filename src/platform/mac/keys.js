// Electron-style accelerators ("Alt+Tab", "Option+`", "Cmd+Shift+F1") -> macOS key specs.
// key is a virtual keycode (kVK_* from HIToolbox Events.h), i.e. a *physical* key position on an
// ANSI keyboard: on ISO / non-US layouts "`" and a few punctuation keys sit elsewhere.
const LETTERS = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, 9: 25, 7: 26, 8: 28, 0: 29 };
const PUNCT = { '`': 50, '~': 50, '[': 33, ']': 30, '\\': 42, '-': 27, '=': 24, ';': 41, "'": 39, ',': 43, '.': 47, '/': 44 };
const NAMED = { tab: 48, space: 49, enter: 36, return: 36, escape: 53, esc: 53, backspace: 51, delete: 117, insert: 114,
  home: 115, end: 119, pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126 };
const FKEYS = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]; // F1..F20
// win = Cmd here, so the spec has the same fields as on Windows. CmdOrCtrl is Cmd on a Mac.
const MODS = { alt: 'alt', option: 'alt', ctrl: 'ctrl', control: 'ctrl', shift: 'shift',
  cmd: 'win', command: 'win', cmdorctrl: 'win', commandorcontrol: 'win', meta: 'win', super: 'win', win: 'win' };

// -> { alt, ctrl, shift, win, vk } or null when the string isn't a key we can hook.
function parseAccelerator(accel) {
  if (!accel || typeof accel !== 'string') return null;
  const parts = accel.split('+');
  const key = parts.pop();
  const spec = { alt: false, ctrl: false, shift: false, win: false, vk: null };
  for (const p of parts) {
    const m = MODS[p.trim().toLowerCase()];
    if (!m) return null;
    spec[m] = true;
  }
  const f = /^f(\d{1,2})$/i.exec(key);
  if (key in PUNCT) spec.vk = PUNCT[key];
  else if (/^[a-z0-9]$/i.test(key)) spec.vk = LETTERS[key.toLowerCase()];
  else if (f && f[1] >= 1 && f[1] <= FKEYS.length) spec.vk = FKEYS[f[1] - 1];
  else spec.vk = NAMED[key.toLowerCase()] ?? null;
  return spec.vk === null ? null : spec; // vk 0 is the A key
}

// What the helper's hookKeys expects.
const wire = (s) => ({ alt: s.alt, ctrl: s.ctrl, shift: s.shift, cmd: s.win, key: s.vk });

module.exports = { parseAccelerator, wire };
