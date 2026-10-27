const assert = require('assert');
const { visibleLayout, remember, prune, describe } = require('../src/snap');

// The live setup from docs/alt-tab-research/00-live-observation.md: one 3840x2400 display.
const D = [{ id: 1, bounds: { x: 0, y: 0, width: 3840, height: 2400 }, workArea: { x: 0, y: 0, width: 3840, height: 2400 } }];
const R = (x, y, width, height) => ({ x, y, width, height });
const win = (hwnd, rect, more = {}) => ({ hwnd, rect, arranged: true, minimized: false, ...more });
const left = win(1, R(0, 0, 1920, 2400)), right = win(2, R(1920, 0, 1920, 2400));
const max = win(9, R(0, 0, 3840, 2400), { arranged: false });
// Uneven quad: the user dragged the divider to x=1733, y=881.
const tL = win(11, R(0, 0, 1733, 881)), tR = win(12, R(1733, 0, 2107, 881)), bL = win(13, R(0, 881, 1733, 1519)), bR = win(14, R(1733, 881, 2107, 1519));
// Half + two quarters.
const A = win(21, R(0, 0, 1920, 2400)), B = win(22, R(1920, 0, 1920, 1200)), C = win(23, R(1920, 1200, 1920, 1200));
const hwnds = (l) => l && l.map((m) => m.hwnd).sort((a, b) => a - b);

assert.deepStrictEqual(hwnds(visibleLayout([left, right, max], D, 1)), [1, 2], 'a visible pair');
assert.deepStrictEqual(hwnds(visibleLayout([tR, bL, tL, bR, max], D, 13)), [11, 12, 13, 14], 'uneven quad');
assert.deepStrictEqual(hwnds(visibleLayout([B, A, C], D, 21)), [21, 22, 23], 'half + two quarters');
assert.equal(visibleLayout([left, max, right], D, 1), null, 'partner buried under a maximized window: not a layout (picked alone)');
assert.equal(visibleLayout([max, left, right], D, 1), null, 'nothing visible');
assert.equal(visibleLayout([left, max], D, 1), null, 'alone');
assert.equal(visibleLayout([{ ...left, arranged: false }, { ...right, arranged: false }], D, 1), null, 'side by side by hand is not a snap layout');
assert.equal(visibleLayout([left, win(3, R(1920, 0, 1920, 1200))], D, 1), null, 'only 3/4 of the screen covered');
// 00's ambiguous case: snap3 A in front of the old *test left. A's layout is A, B, C; test left is hidden.
assert.deepStrictEqual(hwnds(visibleLayout([A, B, C, left, right], D, 21)), [21, 22, 23]);
assert.equal(visibleLayout([A, B, C, left, right], D, 1), null, 'test left is covered by A: it is not part of what you see');
// Another display: its windows don't count.
const D2 = [...D, { id: 2, bounds: { x: 3840, y: 0, width: 1920, height: 1080 }, workArea: { x: 3840, y: 0, width: 1920, height: 1040 } }];
assert.deepStrictEqual(hwnds(visibleLayout([left, win(5, R(3840, 0, 1920, 1040)), right], D2, 1)), [1, 2]);
const l2 = win(6, R(3840, 0, 960, 1040)), r2 = win(7, R(4800, 0, 960, 1040));
assert.deepStrictEqual(hwnds(visibleLayout([left, l2, right, r2], D2, 7)), [6, 7], 'second monitor has its own pair');

// remember: same layout twice keeps its id and color; snapping into a slot ends the old layout.
let ls = remember([], visibleLayout([left, right], D, 1), 1);
assert.deepStrictEqual(ls.map((l) => [l.id, l.color]), [[1, 0]]);
assert.strictEqual(remember(ls, visibleLayout([right, left], D, 2), 2), ls, 'seen again: unchanged');
ls = remember(ls, visibleLayout([tL, tR, bL, bR], D, 11), 2);
assert.deepStrictEqual(ls.map((l) => [l.id, l.color]), [[1, 0], [2, 1]], 'two layouts on one display, one behind the other (Windows keeps both)');
assert.deepStrictEqual(remember(ls, visibleLayout([left, win(3, R(1920, 0, 1920, 2400))], D, 1), 3).map((l) => l.id), [2, 3], 'a window is in one layout: the pair it left is gone');
// Several layouts share one screen: snapping C|D over A|B keeps A|B (the user's case, 10-27).
ls = remember([], visibleLayout([left, right], D, 1), 1);
assert.equal(prune(ls, [A, B, C, left, right]).length, 1, 'other windows snapped over its slots: the pair stays');

// Two pairs on two monitors live side by side, with different colors.
ls = remember(remember([], visibleLayout([left, right], D2, 1), 1), visibleLayout([l2, r2], D2, 6), 2);
assert.deepStrictEqual(ls.map((l) => [l.id, l.color]), [[1, 0], [2, 1]]);
assert.equal(remember(ls, null, 3), ls);

// prune: closed, moved or un-snapped members drop out; minimized ones stay; under 2 left ends it.
ls = remember([], visibleLayout([tL, tR, bL, bR], D, 11), 1);
assert.equal(prune(ls, [tL, tR, bL, bR]).length, 1);
assert.deepStrictEqual(hwnds(prune(ls, [tL, tR, { ...bL, minimized: true, rect: null }]) [0].members), [11, 12, 13], 'closed one dropped, minimized one kept');
assert.deepStrictEqual(prune(ls, [tL, { ...tR, arranged: false }]), [], 'one left: no layout');
assert.equal(prune(ls, [tL, tR, bL, { ...bR, rect: R(100, 100, 800, 600) }])[0].members.length, 3, 'a member dragged away drops out');
assert.equal(prune(ls, [tL, tR, bL, { ...bR, rect: R(1734, 882, 2106, 1518) }])[0].members.length, 4, '1px rounding is still in place');

// describe: reading order, slots as fractions.
const d = describe(remember([], visibleLayout([C, A, B], D, 21), 4)[0]);
assert.deepStrictEqual(d.slots.map((s) => s.hwnd), [21, 22, 23]);
assert.deepStrictEqual(d.slots[0], { hwnd: 21, x: 0, y: 0, w: 0.5, h: 1 });
assert.deepStrictEqual(d.slots[2], { hwnd: 23, x: 0.5, y: 0.5, w: 0.5, h: 0.5 });

// justSnapped: newly snapped or moved into a slot; not a restore from minimized, not a window seen for the first time.
const { justSnapped, contested, worth } = require('../src/snap');
const floating = { ...A, arranged: false, rect: R(300, 300, 1200, 900) };
assert.deepStrictEqual(justSnapped([floating, left], [A, left]).map((w) => w.hwnd), [21]);
assert.deepStrictEqual(justSnapped([{ ...A, minimized: true, arranged: false, rect: null }], [A]), []);
assert.deepStrictEqual(justSnapped([], [A]), []);
assert.deepStrictEqual(justSnapped([{ ...B, rect: R(1920, 0, 1920, 2400) }], [B]).map((w) => w.hwnd), [22], 'right half -> top-right quarter');

// contested: the live mix. *test left brought up over snap3: left + B + C tile the screen, but A and
// *test right sit in the same slots behind them, so it may be a mix. A clean pair is not contested.
const mix = visibleLayout([left, B, C, A, right], D, 1);
assert.deepStrictEqual(hwnds(mix), [1, 22, 23]);
assert.equal(contested([left, B, C, A, right], mix), true);
assert.equal(contested([left, right, max], visibleLayout([left, right, max], D, 1)), false);
assert.equal(contested([left, right, { ...A, minimized: true, rect: null, arranged: false }], visibleLayout([left, right], D, 1)), false, 'a minimized snapped window competes for nothing');

// worth: the user's two-pair case. A|B = left|right (snapped at t=1..2, recorded at 3), then C|D over them.
const pA = win(31, R(0, 0, 1920, 2400)), pB = win(32, R(1920, 0, 1920, 2400)), pC = win(33, R(0, 0, 1920, 2400)), pD = win(34, R(1920, 0, 1920, 2400));
const at = new Map([[31, 1000], [32, 2000]]);
let two = remember([], visibleLayout([pA, pB], D, 31), 1, 3000);
assert.equal(worth(two, [pA, pB], visibleLayout([pA, pB], D, 31), at, 3000), true, 'the known pair, seen again');
// C snapped on the left 2s later: on screen C + B. B is in A|B and wasn't snapped since: not a layout,
// even though B itself was snapped only seconds ago (the bug the user hit).
at.set(33, 5000);
assert.equal(worth(two, [pC, pB, pA], visibleLayout([pC, pB, pA], D, 33), at, 5000), false);
// D snapped on the right: C|D, both just snapped: a layout, and A|B stays.
at.set(34, 7000);
assert.equal(worth(two, [pD, pC, pB, pA], visibleLayout([pD, pC, pB, pA], D, 34), at, 7000), true);
two = remember(two, visibleLayout([pD, pC, pB, pA], D, 34), 2, 7000);
assert.deepStrictEqual(two.map((l) => hwnds(l.members)), [[31, 32], [33, 34]]);
// Then A, B, C, D, B one at a time: B over C shows B + C. Mixes of known layouts never count.
assert.equal(worth(two, [pB, pC, pD, pA], visibleLayout([pB, pC, pD, pA], D, 32), at, 9000), false);
// B snapped again onto the left, next to D: D still belongs to C|D and wasn't re-snapped, so this
// reads as a mix and isn't remembered (snap.js's ponytail note); re-snapping D too makes it count.
const pB2 = { ...pB, rect: R(0, 0, 1920, 2400) };
at.set(32, 60000);
assert.equal(worth(two, [pB2, pD, pC, pA], visibleLayout([pB2, pD, pC, pA], D, 32), at, 60000), false);
at.set(34, 61000);
assert.equal(worth(two, [pD, pB2, pC, pA], visibleLayout([pD, pB2, pC, pA], D, 34), at, 61000), true);
// Nothing known yet: a clean pair counts, a mix with snapped windows behind doesn't (unless just snapped).
assert.equal(worth([], [left, right, max], visibleLayout([left, right, max], D, 1), new Map(), 1e6), true);
assert.equal(worth([], [left, B, C, A, right], mix, new Map(), 1e6), false);
assert.equal(worth([], [left, B, C, A, right], mix, new Map([[1, 1e6 - 3000]]), 1e6), true, 'just snapped left over A: the user made this');
assert.equal(worth([], [left, B, C, A, right], mix, new Map([[1, 1e6 - 60000]]), 1e6), false, 'a minute ago is not just now');
assert.equal(worth([], [], null, new Map(), 0), false);
