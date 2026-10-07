// Multi-monitor behavior found while live-testing on a laptop (2.5x) + an external (1.5x) placed
// left of and above it. Pure: layout.js, features/setup.js and session.js with a fake adapter.
const assert = require('assert');
const { test, mock } = require('node:test');
const layout = require('../src/layout');
const { setupBounds, displayOptions } = require('../src/features/setup');

const disp = (id, label, x, y, width, height, scaleFactor = 1, workArea) => ({ id, label, bounds: { x, y, width, height }, workArea: workArea || { x, y, width, height }, scaleFactor });
const laptop = disp(2315038148, '', 0, 0, 1536, 960, 2.5);
const external = disp(4160558590, 'PHL27E1N5900R', -2560, -680, 2560, 1440, 1.5);
const rig = [laptop, external];
const PANELS = [{ key: 'socials', width: 64, height: 4 * 52 + 26 }, { key: 'music', width: 280, height: 176 }];

const inside = (r, b) => r.x >= b.x && r.y >= b.y && r.x + r.width <= b.x + b.width && r.y + r.height <= b.y + b.height;
const overlaps = (r, b) => r.x < b.x + b.width && b.x < r.x + r.width && r.y < b.y + b.height && b.y < r.y + r.height;
const every = (d) => [layout.overlayBounds(d), layout.toastBounds(d), layout.cueBounds(d), setupBounds(d), ...layout.panelStack(d, PANELS)];

test('every window computed for one display stays on it and never spills onto the other', () => {
  for (const d of rig) {
    const other = rig.find((x) => x !== d);
    for (const r of every(d)) {
      assert.ok(inside(r, d.workArea), `${JSON.stringify(r)} inside ${d.id}`);
      assert.ok(!overlaps(r, other.bounds), `${JSON.stringify(r)} not on ${other.id}`);
    }
  }
});

test('the same window has the same DIP size on both displays (physical size follows each scale)', () => {
  // Measured live: tray 1860x1556 px on the external (1.5x), 3100x1728 px on the laptop (2.5x);
  // panels 96x351 / 160x585 px; toast 540x138 / 900x230 px; cue 390 / 650 px.
  const px = (r, d) => [Math.round(r.width * d.scaleFactor), Math.round(r.height * d.scaleFactor)];
  assert.deepStrictEqual(px(layout.overlayBounds(external), external), [1860, 1556]);
  assert.deepStrictEqual(px(layout.overlayBounds(laptop), laptop), [3100, 1728]);
  for (const d of rig) {
    const [socials, music] = layout.panelStack(d, PANELS);
    assert.deepStrictEqual([socials.width, socials.height, music.width, music.height], [64, 234, 280, 176], `panels on ${d.id}`);
    assert.deepStrictEqual([layout.toastBounds(d).width, layout.toastBounds(d).height], [360, 92]);
    assert.equal(layout.cueBounds(d).width, 260);
  }
  assert.deepStrictEqual(px(layout.panelStack(external, PANELS)[0], external), [96, 351]);
  assert.deepStrictEqual(px(layout.panelStack(laptop, PANELS)[0], laptop), [160, 585]);
});

test('toast clears an auto-hidden taskbar, which pops up exactly when an app flashes', () => {
  // workArea == bounds: taskbar auto-hidden (both displays here). Seen live: the toast sat under it.
  for (const d of rig) {
    const t = layout.toastBounds(d);
    const gap = d.bounds.y + d.bounds.height - (t.y + t.height);
    assert.ok(gap >= 48 + 16, `toast bottom is ${gap} DIP above the edge of ${d.id}`);
  }
  // A visible taskbar is already outside the work area: the usual 16 DIP margin.
  const visible = disp(1, 'A', 0, 0, 1920, 1080, 1, { x: 0, y: 0, width: 1920, height: 1032 });
  assert.equal(layout.toastBounds(visible).y + 92 + 16, 1032);
  // A taskbar on the left with nothing at the bottom still gets the extra room (harmless).
  const left = disp(2, 'B', 0, 0, 1920, 1080, 1, { x: 48, y: 0, width: 1872, height: 1080 });
  assert.ok(inside(layout.toastBounds(left), left.workArea));
  // Too short for the extra room: stays inside the work area.
  const short = disp(3, 'C', 0, 0, 400, 120);
  assert.ok(inside(layout.toastBounds(short), short.workArea));
});

test("toasts land on the panels' display in every panel setting", () => {
  const cursors = [{ x: -1280, y: 40 }, { x: 768, y: 480 }, { x: 100, y: -600 }];
  for (const setting of ['primary', 'mouse', 'PHL27E1N5900R', String(laptop.id), external.id]) {
    for (const c of cursors) {
      const d = layout.pickPanelDisplay(rig, setting, c, laptop.id);
      const t = layout.toastBounds(d);
      const stack = layout.panelStack(d, PANELS);
      assert.ok(stack.every((r) => inside(r, d.workArea)) && inside(t, d.workArea), `${setting} @ ${JSON.stringify(c)}`);
    }
  }
});

test("'focus' panels and toasts go to the focused window's display on the real rig", () => {
  const P = laptop.id;
  const on = (focusRect, current = null) => layout.pickPanelDisplay(rig, 'focus', { focusRect, current, cursor: { x: 500, y: 500 } }, P);
  const browserOnExternal = { x: -2000, y: -500, width: 1400, height: 900 };
  const editorOnLaptop = { x: 0, y: 0, width: 1536, height: 912 };
  for (const [r, d] of [[browserOnExternal, external], [editorOnLaptop, laptop]]) {
    const picked = on(r);
    assert.equal(picked, d, 'the cursor (on the laptop) does not matter');
    const stack = layout.panelStack(picked, PANELS);
    assert.ok(stack.every((x) => inside(x, d.workArea)) && inside(layout.toastBounds(picked), d.workArea));
  }
  // Panels sit at the external's right edge, i.e. just left of the laptop.
  assert.equal(layout.panelStack(on(browserOnExternal), PANELS)[1].x + 280, -4);
  // Clicking the desktop / taskbar or minimizing everything: no rect, the panels stay.
  assert.equal(on(null, external.id), external);
});

test("'mouse' panels follow the cursor across the real rig, including the dead zones", () => {
  const P = laptop.id;
  const at = (x, y) => layout.pickPanelDisplay(rig, 'mouse', { x, y }, P).id;
  assert.equal(at(-1280, 40), external.id, 'middle of the external');
  assert.equal(at(-1, 759), external.id, 'external bottom-right pixel');
  assert.equal(at(0, 0), laptop.id, 'laptop top-left pixel');
  // Below the external's bottom (y >= 760) and left of the laptop: no display, nearest wins.
  assert.equal(at(-5, 900), laptop.id, 'just left of the laptop');
  assert.equal(at(-1500, 800), external.id, 'just below the external');
  // Moving the cursor back and forth re-lays out once per display change, like the 1s poll.
  let last = null;
  let moves = 0;
  for (const [x, y] of [[-1280, 40], [-1270, 50], [500, 500], [510, 500], [-2000, -600], [1535, 959]]) {
    const id = at(x, y);
    if (id !== last) { moves++; last = id; }
  }
  assert.equal(moves, 4);
});

test('panel display setting survives re-plugging, a relabel, and a new primary', () => {
  const opts = displayOptions(rig, laptop.id);
  const ext = opts.find((o) => !o.primary).setting;
  assert.equal(ext, 'PHL27E1N5900R', 'saved by label so a new id after re-plugging still matches');
  const replugged = { ...external, id: 999 };
  assert.equal(layout.pickPanelDisplay([laptop, replugged], ext, null, laptop.id), replugged);
  // Unplugged: falls back to the primary instead of placing panels off-screen.
  assert.equal(layout.pickPanelDisplay([laptop], ext, null, laptop.id), laptop);
  // The laptop has no label, so it's saved by id; that id disappearing also falls back.
  const lap = opts.find((o) => o.primary).setting;
  assert.equal(lap, String(laptop.id));
  assert.equal(layout.pickPanelDisplay([external], lap, null, external.id), external);
  // 'primary' follows whichever display Windows calls primary now.
  assert.equal(layout.pickPanelDisplay(rig, 'primary', null, external.id), external);
  // A primary id that isn't in the list (mid-reconfiguration) doesn't crash or return nothing.
  assert.ok(rig.includes(layout.pickPanelDisplay(rig, 'primary', null, 12345)));
});

test('three displays: right of, above, and portrait; all positions stay on their own display', () => {
  const center = disp(1, 'Main', 0, 0, 1920, 1080, 1.25, { x: 0, y: 0, width: 1920, height: 1032 });
  const right = disp(2, 'Right', 1920, 0, 2560, 1440, 1);
  const portrait = disp(3, 'Portrait', -1080, -400, 1080, 1920, 1);
  const three = [center, right, portrait];
  for (const d of three) {
    for (const r of every(d)) {
      assert.ok(inside(r, d.workArea), `${JSON.stringify(r)} inside ${d.label}`);
      for (const o of three) if (o !== d) assert.ok(!overlaps(r, o.bounds), `${d.label} rect not on ${o.label}`);
    }
  }
  assert.ok(layout.overlayBounds(portrait).width <= 1080 - 64 + 1, 'tray narrows to fit a portrait screen');
  assert.equal(layout.pickPanelDisplay(three, 'mouse', { x: 3000, y: 100 }, 1), right);
  assert.equal(layout.pickPanelDisplay(three, 'mouse', { x: -500, y: 1400 }, 1), portrait);
  assert.equal(layout.pickPanelDisplay(three, 'mouse', { x: 1919, y: 1079 }, 1), center);
  assert.equal(layout.pickPanelDisplay(three, 'Right', null, 1), right);
});

test('a window left on an unplugged display is re-placed on the nearest remaining one', () => {
  // relayoutAll(): the overlay / cue are re-placed on the display matching their old rect; once
  // the external is gone, the nearest display must take them, at that display's size.
  const old = layout.overlayBounds(external);
  const center = { x: old.x + old.width / 2, y: old.y + old.height / 2 };
  const d = layout.displayAt([laptop], center);
  assert.equal(d, laptop);
  const r = layout.overlayBounds(d);
  assert.ok(inside(r, laptop.workArea));
  assert.deepStrictEqual([r.width, r.height], [1240, 691]);
});

// ---- Open All on two monitors: maximize logic with a fake adapter ------------------------------

function loadSession(fake) {
  const platformPath = require.resolve('../src/platform');
  const sessionPath = require.resolve('../src/session');
  const saved = require.cache[platformPath];
  require.cache[platformPath] = { id: platformPath, filename: platformPath, loaded: true, exports: fake };
  delete require.cache[sessionPath];
  try { return require(sessionPath); } finally {
    delete require.cache[sessionPath];
    if (saved) require.cache[platformPath] = saved; else delete require.cache[platformPath];
  }
}

test('Open All launches only closed apps and maximizes each new window on whatever monitor it opens', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    const app = (id, exe) => ({ id, name: id, match: { exe }, launch: { appId: id } });
    const config = { groups: [{ id: 'g', name: 'G', apps: [app('chrome', 'chrome.exe'), app('slack', 'slack.exe'), app('notes', 'notes.exe')] }], music: null };
    // Chrome is already open (on the external); Slack opens on the external, Notes on the laptop.
    let windows = [{ hwnd: 1, exe: 'chrome.exe', title: 'Chrome', pid: 1 }];
    const launched = [];
    const maximized = [];
    const session = loadSession({
      listWindows: () => windows.slice(),
      maximize: (h) => maximized.push(h),
      isWindow: (h) => windows.some((w) => w.hwnd === h),
    });
    const names = session.openAll(config, (l) => launched.push(l.appId));
    assert.deepStrictEqual(names, ['slack', 'notes']);
    assert.deepStrictEqual(launched, ['slack', 'notes']);

    mock.timers.tick(500);
    assert.deepStrictEqual(maximized, [], 'nothing new yet; the open Chrome window is left alone');
    windows = [...windows, { hwnd: 20, exe: 'slack.exe', title: 'Slack', pid: 2, monitor: 'external' }];
    mock.timers.tick(500);
    assert.deepStrictEqual(maximized, [20]);
    windows = [...windows, { hwnd: 30, exe: 'notes.exe', title: 'Notes', pid: 3, monitor: 'laptop' }];
    mock.timers.tick(500);
    assert.deepStrictEqual(maximized, [20, 30]);
    mock.timers.tick(1500); // the second pass, after the apps restore their own saved size
    assert.deepStrictEqual(maximized.slice().sort(), [20, 20, 30, 30]);
    // A window that closed before its second pass isn't touched.
    windows = [...windows, { hwnd: 31, exe: 'notes.exe', title: 'Notes 2', pid: 3 }];
    mock.timers.tick(500);
    windows = windows.filter((w) => w.hwnd !== 31);
    mock.timers.tick(1500);
    assert.equal(maximized.filter((h) => h === 31).length, 1);
    // After the 30s watch, later windows of those apps are left as they are.
    mock.timers.tick(30000);
    const before = maximized.length;
    windows = [...windows, { hwnd: 40, exe: 'slack.exe', title: 'Slack 2', pid: 2 }];
    mock.timers.tick(2000);
    assert.equal(maximized.length, before);
  } finally {
    mock.timers.reset();
  }
});

test('Open All with every app already open is a no-op (nothing launched, nothing maximized)', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    const config = { groups: [{ id: 'g', name: 'G', apps: [{ id: 'a', name: 'A', match: { exe: 'a.exe' }, launch: { appId: 'a' } }] }], music: null };
    const maximized = [];
    const session = loadSession({ listWindows: () => [{ hwnd: 5, exe: 'a.exe', title: 'A' }], maximize: (h) => maximized.push(h), isWindow: () => true });
    const launched = [];
    assert.deepStrictEqual(session.openAll(config, (l) => launched.push(l)), []);
    mock.timers.tick(5000);
    assert.deepStrictEqual([launched, maximized], [[], []]);
  } finally {
    mock.timers.reset();
  }
});
