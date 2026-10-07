const assert = require('assert');
const { overlayBounds, panelStack, toastBounds, cueBounds, pickPanelDisplay } = require('../src/layout');

const disp = (id, x, y, width, height, scaleFactor = 1, workArea) => ({ id, label: `D${id}`, bounds: { x, y, width, height }, workArea: workArea || { x, y, width, height }, scaleFactor });
const inside = (r, wa) => r.x >= wa.x && r.y >= wa.y && r.x + r.width <= wa.x + wa.width && r.y + r.height <= wa.y + wa.height;
const PANELS = [{ key: 'socials', width: 64, height: 4 * 52 + 26 }, { key: 'music', width: 280, height: 176 }];

// Every rect for a display: integers, non-empty, inside its work area.
function checkAll(d, items = PANELS) {
  const rects = { overlay: overlayBounds(d), toast: toastBounds(d), cue: cueBounds(d) };
  for (const r of panelStack(d, items)) rects[r.key] = r;
  for (const [name, r] of Object.entries(rects)) {
    for (const k of ['x', 'y', 'width', 'height']) assert.ok(Number.isInteger(r[k]), `${name}.${k} on ${d.id} is an integer`);
    assert.ok(r.width > 0 && r.height > 0, `${name} on ${d.id} isn't empty`);
    assert.ok(inside(r, d.workArea), `${name} ${JSON.stringify(r)} inside ${JSON.stringify(d.workArea)}`);
  }
  return rects;
}

// The real setup this was built on: laptop primary at 2.5x, a 1440p external at 1.5x placed LEFT
// of and ABOVE it (negative origin), taskbar auto-hidden (workArea == bounds).
const laptop = disp(2315038148, 0, 0, 1536, 960, 2.5);
const external = disp(4160558590, -2560, -680, 2560, 1440, 1.5);
const two = [laptop, external];

const onExt = checkAll(external);
assert.deepStrictEqual(onExt.overlay, { x: -2560 + 660, y: -680 + 202, width: 1240, height: 1037 });
assert.equal(onExt.music.x + onExt.music.width, -4, 'panels hug the external right edge (just left of the laptop)');
assert.equal(onExt.socials.x, -4 - 64);
assert.equal(onExt.music.y, onExt.socials.y + onExt.socials.height + 10, 'stacked with a 10px gap');
const stackTop = onExt.socials.y - -680;
const stackBottom = 1440 - (onExt.music.y + onExt.music.height - -680);
assert.ok(Math.abs(stackTop - stackBottom) <= 1, 'stack centered vertically');
assert.deepStrictEqual(onExt.toast, { x: -16 - 360, y: -680 + 1440 - 16 - 48 - 92, width: 360, height: 92 }, 'clears the auto-hidden taskbar');
assert.deepStrictEqual(onExt.cue, { x: -2560 + 1150, y: -680 + 590, width: 260, height: 260 });

const onLaptop = checkAll(laptop);
assert.deepStrictEqual(onLaptop.overlay, { x: 148, y: 134, width: 1240, height: 691 });
assert.equal(onLaptop.socials.x + onLaptop.socials.width, 1536 - 4);

// Picking the panel display.
const P = laptop.id;
assert.equal(pickPanelDisplay(two, 'primary', { x: -100, y: 0 }, P), laptop);
assert.equal(pickPanelDisplay(two, undefined, null, P), laptop, 'default is primary');
assert.equal(pickPanelDisplay(two, external.id, null, P), external, 'by id');
assert.equal(pickPanelDisplay(two, String(external.id), null, P), external, 'by id as a string');
assert.equal(pickPanelDisplay(two, 'D4160558590', null, P), external, 'by label');
// Display removed (external unplugged): its id falls back to primary.
assert.equal(pickPanelDisplay([laptop], external.id, null, P), laptop);
assert.equal(pickPanelDisplay([laptop], 'mouse', { x: -1000, y: -300 }, P), laptop, 'cursor on a vanished display -> nearest');

// 'mouse' mode follows the cursor across displays, including negative coordinates and edges.
assert.equal(pickPanelDisplay(two, 'mouse', { x: -1, y: 0 }, P), external);
assert.equal(pickPanelDisplay(two, 'mouse', { x: 0, y: 0 }, P), laptop);
assert.equal(pickPanelDisplay(two, 'mouse', { x: -2560, y: -680 }, P), external, 'top-left pixel');
assert.equal(pickPanelDisplay(two, 'mouse', { x: 1535, y: 959 }, P), laptop, 'bottom-right pixel');
assert.equal(pickPanelDisplay(two, 'mouse', { x: 100, y: -600 }, P), external, 'dead zone above the laptop, near the external -> external');
assert.equal(pickPanelDisplay(two, 'mouse', { x: 500, y: -100 }, P), laptop, 'dead zone just above the laptop -> laptop');
assert.equal(pickPanelDisplay(two, 'mouse', { x: 500, y: 2000 }, P), laptop, 'below everything -> nearest');
assert.equal(pickPanelDisplay(two, 'mouse', null, P), laptop, 'no cursor -> primary');
// Simulated 1s poll: re-layout only when the picked display changes.
let current = null;
let relayouts = 0;
for (const p of [{ x: 10, y: 10 }, { x: 20, y: 30 }, { x: -50, y: 10 }, { x: -900, y: -500 }, { x: 5, y: 5 }]) {
  const d = pickPanelDisplay(two, 'mouse', p, P);
  if (d.id !== current) { current = d.id; relayouts++; }
}
assert.equal(relayouts, 3, 'laptop -> external -> laptop');

// 'focus' mode: the display holding the center of the focused window (DIP rect), on the real rig.
const F = (focusRect, current = null, displays = two) => pickPanelDisplay(displays, 'focus', { focusRect, current }, P);
assert.equal(F({ x: -2000, y: -500, width: 1200, height: 800 }), external, 'window on the external -> external');
assert.equal(F({ x: 100, y: 100, width: 900, height: 600 }), laptop, 'window on the laptop -> laptop');
assert.equal(F({ x: -2568, y: -688, width: 2576, height: 1456 }), external, 'maximized on the external (frame spills a few px) -> external');
assert.equal(F({ x: 0, y: 0, width: 1536, height: 912 }), laptop, 'maximized on the laptop');
// Straddling both: the center decides.
assert.equal(F({ x: -700, y: 100, width: 1000, height: 400 }), external, 'center at x=-200 -> external');
assert.equal(F({ x: -300, y: 100, width: 1000, height: 400 }), laptop, 'center at x=200 -> laptop');
assert.equal(F({ x: -1, y: 100, width: 2, height: 400 }), laptop, 'center exactly on the seam (x=0) -> laptop');
// Center in a dead zone (below the external, left of the laptop): the display it overlaps most.
assert.equal(F({ x: -900, y: 700, width: 800, height: 200 }), external, 'center (-500, 800) is on no display; overlaps the external only');
assert.equal(F({ x: -200, y: 740, width: 600, height: 200 }), laptop, 'center (100, 840) is on the laptop');
assert.equal(F({ x: -3000, y: 2000, width: 100, height: 100 }, external.id), external, 'off every display: keep current');
// Nothing focused that counts (minimized, the desktop, Cubby itself): keep the current display.
assert.equal(F(null, external.id), external, 'none -> keep the external');
assert.equal(F(null, laptop.id), laptop, 'none -> keep the laptop');
assert.equal(F({ x: -2000, y: -500, width: 0, height: 0 }, laptop.id), laptop, 'empty rect -> keep current');
assert.equal(F(null, null), laptop, 'nothing yet -> primary');
// Unplugged: the external is gone, so its id as `current` falls back to the primary.
assert.equal(F(null, external.id, [laptop]), laptop, 'current display unplugged -> primary');
assert.equal(F({ x: -2000, y: -500, width: 1200, height: 800 }, external.id, [laptop]), laptop, 'window left on a vanished display -> primary');
// Negative coordinates all the way: the external's top-left corner region.
assert.equal(F({ x: -2560, y: -680, width: 10, height: 10 }), external, 'top-left corner window');
assert.equal(F({ x: -10, y: -10, width: 8, height: 8 }, laptop.id), external, 'just above-left of the laptop origin, still on the external');
assert.equal(pickPanelDisplay(two, undefined, { focusRect: { x: -2000, y: -500, width: 100, height: 100 } }, P), external, 'unset setting = focus');
// Focus jumping between windows re-lays out only when the display changes (the 1s poll + activate).
current = laptop.id;
relayouts = 0;
for (const r of [{ x: 10, y: 10, width: 500, height: 400 }, null, { x: 600, y: 10, width: 500, height: 400 }, { x: -2000, y: -500, width: 800, height: 600 },
  null, { x: -1000, y: -400, width: 800, height: 600 }, { x: 200, y: 200, width: 300, height: 300 }]) {
  const d = F(r, current);
  if (d.id !== current) { current = d.id; relayouts++; }
}
assert.equal(relayouts, 2, 'laptop -> external -> laptop, nothing in between');

// Single display with a visible taskbar (workArea smaller than bounds).
const single = disp(1, 0, 0, 1920, 1080, 1, { x: 0, y: 0, width: 1920, height: 1032 });
const s = checkAll(single);
assert.ok(s.toast.y + s.toast.height <= 1032, 'toast clears the taskbar');

// Displays stacked vertically (external above, same width), and one with the taskbar on the left.
checkAll(disp(10, 0, -1080, 1920, 1080));
checkAll(disp(11, 0, 0, 1920, 1080, 1.25, { x: 48, y: 0, width: 1872, height: 1080 }));
assert.equal(pickPanelDisplay([disp(10, 0, -1080, 1920, 1080), disp(11, 0, 0, 1920, 1080)], 'mouse', { x: 100, y: -1 }, 11).id, 10);

// Tiny work area: nothing off-screen, panels shrink and say so.
const tiny = disp(20, 100, 100, 300, 200, 1);
const t = checkAll(tiny);
assert.ok(t.overlay.width <= 300);
const shrunk = panelStack(tiny, PANELS);
assert.ok(shrunk.every((r) => r.shrunk), 'flagged so the content can scroll');
assert.ok(shrunk.every((r) => r.width <= 300 - 8));
// A tall socials strip (many ping apps) on a short screen also shrinks instead of running off.
const many = [{ key: 'socials', width: 64, height: 30 * 52 + 26 }];
checkAll(laptop, many);
assert.ok(panelStack(laptop, many)[0].height >= 960 - 10, 'uses the full height');
assert.deepStrictEqual(panelStack(laptop, []), [], 'no panels');
assert.equal(panelStack(laptop, PANELS)[0].shrunk, false);

console.log('layout ok');
