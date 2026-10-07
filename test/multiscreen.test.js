const assert = require('assert');
const { overlayBounds, panelStack, toastBounds, cueBounds, pickPanelDisplay, displayAt, contains } = require('../src/layout');

// Create a display object matching Electron's screen.Display format
const disp = (id, x, y, width, height, scaleFactor = 1, workArea, label) => ({
  id, bounds: { x, y, width, height }, workArea: workArea || { x, y, width, height }, scaleFactor, label: label || `D${id}`
});

const inside = (r, wa) => r.x >= wa.x && r.y >= wa.y && r.x + r.width <= wa.x + wa.width && r.y + r.height <= wa.y + wa.height;

// Standard test display: 5 pixels, centered, inside workArea.
function checkBounds(name, d, items = []) {
  const rects = { overlay: overlayBounds(d), toast: toastBounds(d), cue: cueBounds(d) };
  for (const r of panelStack(d, items)) rects[r.key] = r;
  for (const [k, r] of Object.entries(rects)) {
    for (const k2 of ['x', 'y', 'width', 'height']) {
      assert.ok(Number.isInteger(r[k2]), `${name}: ${k}.${k2} is integer`);
    }
    assert.ok(r.width > 0 && r.height > 0, `${name}: ${k} is non-empty`);
    assert.ok(inside(r, d.workArea), `${name}: ${k} inside workArea`);
  }
  return rects;
}

// Test 1: Exact user setup (from the task description and layout.test.js)
// PRIMARY: laptop internal 1536x960 DIP (3840x2400 physical) at 2.5x scale
// SECONDARY: external "PHL27E1N5900R" -2560,-680 | 2560x1440 DIP (3840x2160 physical) at 1.5x scale
// LEFT of and ABOVE the primary (negative coords), taskbar auto-hide (workArea == bounds)
{
  const PRIMARY_ID = 2315038148;
  const SECONDARY_ID = 4160558590;
  const laptop = disp(PRIMARY_ID, 0, 0, 1536, 960, 2.5);
  const external = disp(SECONDARY_ID, -2560, -680, 2560, 1440, 1.5, null, 'PHL27E1N5900R');
  const displays = [laptop, external];

  // Panels config: standard 64px socials + 280px music
  const PANELS = [
    { key: 'socials', width: 64, height: 4 * 52 + 26 }, // 4 ping apps
    { key: 'music', width: 280, height: 176 }
  ];

  // Test: overlay on external display
  {
    const r = overlayBounds(external);
    assert.ok(inside(r, external.workArea), 'overlay on external stays inside');
    assert.ok(r.x < 0, 'overlay x is negative (left of primary)');
    assert.ok(r.y < 0, 'overlay y is negative (above primary)');
    assert.ok(r.width > 400, 'overlay is wide enough to be useful');
    assert.ok(r.height > 400, 'overlay is tall enough to be useful');
  }

  // Test: panels on external stay on right edge (just left of laptop)
  {
    const panels = panelStack(external, PANELS);
    assert.equal(panels.length, 2, 'both panels rendered');
    for (const p of panels) {
      assert.ok(inside(p, external.workArea), `${p.key} inside external workArea`);
      // Panels are right-aligned to the work area, so their right edge should be near the right boundary
      assert.ok(p.x + p.width <= external.workArea.x + external.workArea.width, `${p.key} right-aligned`);
      assert.ok(p.x >= external.workArea.x - 400, `${p.key} on right side`);
    }
    // Stacked vertically with gap
    const socials = panels.find((p) => p.key === 'socials');
    const music = panels.find((p) => p.key === 'music');
    assert.ok(music.y > socials.y, 'music below socials');
    assert.ok(music.y - (socials.y + socials.height) >= 5, 'gap between panels');
    // Centered vertically as a group
    const stackTop = socials.y - external.bounds.y;
    const stackBottom = external.bounds.height - (music.y + music.height - external.bounds.y);
    assert.ok(Math.abs(stackTop - stackBottom) <= 2, 'panel stack centered vertically');
  }

  // Test: toast in bottom-right corner of external
  {
    const t = toastBounds(external);
    assert.ok(inside(t, external.workArea), 'toast inside external');
    assert.ok(t.y + t.height >= external.workArea.y + external.workArea.height - 20 - 48, 'toast near bottom (above an auto-hidden taskbar)');
    assert.ok(t.x + t.width >= external.workArea.x + external.workArea.width - 20, 'toast near right edge');
  }

  // Test: cue in center of external
  {
    const c = cueBounds(external);
    assert.ok(inside(c, external.workArea), 'cue inside external');
    const centerX = external.workArea.x + external.workArea.width / 2;
    const centerY = external.workArea.y + external.workArea.height / 2;
    const dist = Math.hypot(c.x + c.width / 2 - centerX, c.y + c.height / 2 - centerY);
    assert.ok(dist < 50, `cue roughly centered (distance: ${dist})`);
  }

  // Test: overlay on laptop
  {
    const r = overlayBounds(laptop);
    assert.ok(inside(r, laptop.workArea), 'overlay on laptop stays inside');
    assert.ok(r.x >= 0, 'overlay x is non-negative (on laptop)');
    assert.ok(r.y >= 0, 'overlay y is non-negative (on laptop)');
  }

  // Test: panels on laptop stay on right edge
  {
    const panels = panelStack(laptop, PANELS);
    for (const p of panels) {
      assert.ok(inside(p, laptop.workArea), `${p.key} inside laptop workArea`);
      assert.ok(p.x >= laptop.workArea.x + laptop.workArea.width - 350, `${p.key} on right side`);
    }
  }

  // Test: pickPanelDisplay with cursor tracking
  {
    const P = laptop.id;
    // Default (primary)
    assert.equal(pickPanelDisplay(displays, 'primary', null, P), laptop);
    assert.equal(pickPanelDisplay(displays, undefined, null, P), laptop);

    // By id
    assert.equal(pickPanelDisplay(displays, external.id, null, P), external);
    assert.equal(pickPanelDisplay(displays, String(external.id), null, P), external);

    // By label
    assert.equal(pickPanelDisplay(displays, 'PHL27E1N5900R', null, P), external);

    // Mouse mode: cursor follows
    assert.equal(pickPanelDisplay(displays, 'mouse', { x: -1000, y: -680 }, P), external, 'cursor far left on external');
    assert.equal(pickPanelDisplay(displays, 'mouse', { x: 100, y: 500 }, P), laptop, 'cursor on laptop');
    assert.equal(pickPanelDisplay(displays, 'mouse', { x: -2560, y: -680 }, P), external, 'cursor at external top-left');
    assert.equal(pickPanelDisplay(displays, 'mouse', { x: 1535, y: 959 }, P), laptop, 'cursor at laptop bottom-right');

    // Dead zone (between monitors) goes to nearest
    assert.equal(pickPanelDisplay(displays, 'mouse', { x: 100, y: -600 }, P), external, 'dead zone above laptop -> external');
    assert.equal(pickPanelDisplay(displays, 'mouse', { x: 500, y: -100 }, P), laptop, 'dead zone just above laptop -> laptop');
  }

  // Test: displayAt with multiple displays
  {
    assert.equal(displayAt(displays, { x: -1000, y: -680 }), external, 'point on external');
    assert.equal(displayAt(displays, { x: 500, y: 500 }), laptop, 'point on laptop');
    assert.equal(displayAt(displays, { x: 100, y: -600 }), external, 'dead zone -> nearest (external)');
  }

  // Test: contains for boundary checking
  {
    assert.ok(contains(external.bounds, { x: -2560, y: -680 }), 'top-left of external');
    assert.ok(contains(external.bounds, { x: -1, y: -680 }), 'right edge of external');
    assert.ok(!contains(external.bounds, { x: 0, y: -680 }), 'just past right edge of external');
    assert.ok(contains(laptop.bounds, { x: 0, y: 0 }), 'top-left of laptop');
    assert.ok(contains(laptop.bounds, { x: 1535, y: 959 }), 'bottom-right of laptop');
    assert.ok(!contains(laptop.bounds, { x: 1536, y: 0 }), 'just past right edge of laptop');
  }

  console.log('✓ User setup (laptop 2.5x + external 1.5x, negative coords)');
}

// Test 2: Vertical stacking (displays above/below each other)
{
  const top = disp(1, 0, -1080, 1920, 1080, 1);
  const bottom = disp(2, 0, 0, 1920, 1080, 1);
  const displays = [bottom, top]; // primary first

  checkBounds('vertical top', top);
  checkBounds('vertical bottom', bottom);

  // Panels placed on primary (bottom), not top
  assert.equal(pickPanelDisplay(displays, 'primary', null, bottom.id), bottom);

  // Mouse on top should detect it
  assert.equal(pickPanelDisplay(displays, 'mouse', { x: 960, y: -540 }, bottom.id), top);
  assert.equal(pickPanelDisplay(displays, 'mouse', { x: 960, y: 540 }, bottom.id), bottom);

  console.log('✓ Vertical stacking (displays above/below)');
}

// Test 3: Side-by-side displays at same height
{
  const left = disp(1, 0, 0, 1920, 1080, 1);
  const right = disp(2, 1920, 0, 2560, 1080, 1);
  const displays = [left, right];

  checkBounds('side-by-side left', left);
  checkBounds('side-by-side right', right);

  // Panels follow cursor
  assert.equal(pickPanelDisplay(displays, 'mouse', { x: 100, y: 500 }, left.id), left);
  assert.equal(pickPanelDisplay(displays, 'mouse', { x: 2000, y: 500 }, left.id), right);

  console.log('✓ Side-by-side (displays at same height)');
}

// Test 4: Display removed (unplugged)
{
  const PRIMARY_ID = 1;
  const SECONDARY_ID = 99; // This one will "unplug"
  const primary = disp(PRIMARY_ID, 0, 0, 1920, 1080, 1);
  const secondary = disp(SECONDARY_ID, 1920, 0, 1920, 1080, 1);

  // Config was on secondary, but it's now gone
  assert.equal(pickPanelDisplay([primary], secondary.id, null, PRIMARY_ID), primary, 'missing display falls back to primary');

  // Even if cursor was on the secondary
  assert.equal(pickPanelDisplay([primary], secondary.id, { x: 1950, y: 500 }, PRIMARY_ID), primary, 'cursor near lost display, no alternate -> primary');

  console.log('✓ Display removal (unplugged monitor)');
}

// Test 5: Very different DPI scaling
{
  const low = disp(1, 0, 0, 1920, 1080, 1);      // 96 DPI
  const high = disp(2, 1920, 0, 1280, 720, 2);   // 192 DPI (physical same size as low)
  const displays = [low, high];

  checkBounds('low dpi', low);
  checkBounds('high dpi', high);

  // Windows placed correctly despite different scales
  const lowOverlay = overlayBounds(low);
  const highOverlay = overlayBounds(high);
  assert.ok(lowOverlay.width <= 1920, 'low dpi overlay fits');
  assert.ok(highOverlay.width <= 1280, 'high dpi overlay fits in DIP coords');

  console.log('✓ Very different DPI (1x and 2x scaling)');
}

// Test 6: Tiny work area (e.g., all taskbars visible)
{
  const tiny = disp(1, 0, 0, 800, 600, 1, { x: 40, y: 40, width: 720, height: 520 });
  const r = checkBounds('tiny', tiny);

  // Everything shrinks to fit, nothing goes off-screen
  assert.ok(r.overlay.width <= 720, 'overlay fits in tiny workArea');
  assert.ok(r.overlay.height <= 520, 'overlay height fits in tiny workArea');

  // Panels shrink if needed
  const PANELS = [
    { key: 'panel1', width: 64, height: 500 },  // Taller than work area
    { key: 'panel2', width: 280, height: 500 }
  ];
  const panels = panelStack(tiny, PANELS);
  assert.ok(panels[0].shrunk, 'panel1 flagged as shrunk');
  assert.ok(panels[1].shrunk, 'panel2 flagged as shrunk');
  for (const p of panels) {
    assert.ok(inside(p, tiny.workArea), `${p.key} still fits (shrunk)`);
  }

  console.log('✓ Tiny work area (heavy taskbars)');
}

// Test 7: Taskbar on the left (unusual but valid)
{
  const main = disp(1, 0, 0, 1920, 1080, 1, { x: 48, y: 0, width: 1872, height: 1080 });
  const r = checkBounds('taskbar left', main);

  // Overlay should not overlap the taskbar on the left
  assert.ok(r.overlay.x >= main.workArea.x, 'overlay respects left taskbar');

  // Panels should stay in the safe workArea
  const PANELS = [{ key: 'panel', width: 64, height: 400 }];
  const panels = panelStack(main, PANELS);
  for (const p of panels) {
    assert.ok(inside(p, main.workArea), `${p.key} respects taskbar on left`);
  }

  console.log('✓ Taskbar on the left');
}

// Test 8: No panels (empty list)
{
  const d = disp(1, 0, 0, 1920, 1080, 1);
  const panels = panelStack(d, []);
  assert.deepStrictEqual(panels, [], 'no panels = empty result');

  console.log('✓ No panels (empty list)');
}

// Test 9: Single very tall panel (e.g., 30 ping apps)
{
  const d = disp(1, 0, 0, 1920, 1080, 1);
  const TALL = [{ key: 'socials', width: 64, height: 30 * 52 + 26 }]; // 1586px tall
  const panels = panelStack(d, TALL);

  assert.equal(panels.length, 1, 'one panel');
  assert.ok(inside(panels[0], d.workArea), 'shrunk panel fits');
  assert.ok(panels[0].shrunk, 'flagged as shrunk');
  assert.ok(panels[0].height < TALL[0].height, 'height reduced');

  console.log('✓ Single very tall panel (many ping apps)');
}

// Test 10: Re-layout on display change (simulated)
{
  const PRIMARY_ID = 1;
  const two = [disp(PRIMARY_ID, 0, 0, 1920, 1080, 1), disp(2, 1920, 0, 1920, 1080, 1)];
  const one = [disp(PRIMARY_ID, 0, 0, 1920, 1080, 1)];

  let current = null;
  let changes = 0;

  // Simulate picking panels display on cursor movement, detecting changes
  for (const cursor of [
    { x: 100, y: 500 },    // Left monitor (display 1)
    { x: 2000, y: 500 },   // Right monitor (display 2) - CHANGE
    { x: 3000, y: 500 },   // Still right monitor (display 2) - no change
    { x: -100, y: 500 },   // Left of left monitor -> nearest is 1 - CHANGE
  ]) {
    const d = pickPanelDisplay(two, 'mouse', cursor, PRIMARY_ID);
    if (d.id !== current) { current = d.id; changes++; }
  }
  assert.equal(changes, 3, 'cursor moves -> re-layout 3 times (to right display, then back to left)');

  // Unplug right display: next layout should stay on primary
  const d = pickPanelDisplay(one, two[1].id, { x: 2000, y: 500 }, PRIMARY_ID);
  assert.equal(d.id, PRIMARY_ID, 'display gone -> primary');

  console.log('✓ Display change detection (re-layout trigger)');
}

console.log('\n✅ All multi-screen tests passed');
