// Where every Cubby window goes, in integer DIP rects. Pure (no electron) so multi-monitor setups
// can be tested: a display is { id, bounds, workArea, scaleFactor, label? } as from Electron's screen.
// Origins can be negative (monitors left of / above the primary) and scale factors can differ.
const MARGIN = 4;
const rect = (x, y, width, height) => ({ x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) });

// The tray: centered, 72% of the work area tall, at most 1240 wide.
function overlayBounds(d) {
  const wa = d.workArea;
  const width = Math.min(1240, Math.max(wa.width - 64, Math.min(wa.width, 480)));
  return rect(wa.x + (wa.width - width) / 2, wa.y + wa.height * 0.14, width, wa.height * 0.72);
}

// Side panels on the right edge, stacked top to bottom and centered vertically as one group.
// items: [{ key, width, height }] -> [{ key, x, y, width, height, shrunk }] in the same order.
// Taller than the work area: every panel shrinks proportionally (shrunk: true, content scrolls).
function panelStack(d, items, gap = 10) {
  const wa = d.workArea;
  const gaps = gap * Math.max(0, items.length - 1);
  const total = items.reduce((s, i) => s + i.height, 0);
  const avail = wa.height - 2 * MARGIN - gaps;
  const k = total > avail ? Math.max(0, avail) / total : 1;
  const heights = items.map((i) => Math.max(1, Math.floor(i.height * k)));
  const used = heights.reduce((s, h) => s + h, 0) + gaps;
  let y = wa.y + Math.max(MARGIN, Math.round((wa.height - used) / 2));
  return items.map((it, n) => {
    const width = Math.min(it.width, wa.width - 2 * MARGIN);
    const r = { key: it.key, ...rect(wa.x + wa.width - width - MARGIN, y, width, heights[n]), shrunk: k < 1 };
    y += heights[n] + gap;
    return r;
  });
}

// Ping toast: bottom-right corner. A work area that reaches the bottom of the display means the
// taskbar is auto-hidden, and it pops up over that edge exactly when an app flashes for attention,
// so keep the toast above where it will appear.
const AUTOHIDE_BAR = 48;
function toastBounds(d) {
  const wa = d.workArea;
  const b = d.bounds || wa;
  const width = Math.min(360, wa.width - 16);
  const height = Math.min(92, wa.height - 16);
  const bottom = 16 + (wa.y + wa.height >= b.y + b.height ? AUTOHIDE_BAR : 0);
  return rect(wa.x + wa.width - width - 16, Math.max(wa.y, wa.y + wa.height - height - bottom), width, height);
}

// Voice cue: a square in the middle.
function cueBounds(d) {
  const wa = d.workArea;
  const s = Math.min(260, wa.width, wa.height);
  return rect(wa.x + (wa.width - s) / 2, wa.y + (wa.height - s) / 2, s, s);
}

const contains = (b, p) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
const distance = (b, p) => Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.width - 1)), Math.max(b.y - p.y, 0, p.y - (b.y + b.height - 1)));

// The display under a point, else the nearest one (the cursor can sit in a gap between monitors).
const displayAt = (displays, p) => displays.find((d) => contains(d.bounds, p)) || displays.reduce((a, b) => (distance(b.bounds, p) < distance(a.bounds, p) ? b : a));

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

// The display a window is on: the one holding its center, else the one it overlaps most, else null.
function displayOfRect(displays, r) {
  if (!r || !(r.width > 0 && r.height > 0)) return null;
  const center = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  const hit = displays.find((d) => contains(d.bounds, center));
  if (hit) return hit;
  const best = displays.reduce((a, b) => (overlap(b.bounds, r) > overlap(a.bounds, r) ? b : a));
  return overlap(best.bounds, r) > 0 ? best : null;
}

// config.panels.display: 'focus' (default: the display of the focused window) | 'primary' |
// 'mouse' (display under the cursor) | a display id or label.
// at: { cursor, focusRect, current }. focusRect is the focused window's DIP rect, null when nothing
// counts as focused (minimized, the desktop, Cubby itself): then the panels stay on `current` (the
// display id they're on now). A display that's gone (unplugged) falls back to the primary.
// A bare point for `at` is the cursor.
function pickPanelDisplay(displays, setting, at, primaryId) {
  const { cursor, focusRect, current } = at && 'x' in at ? { cursor: at } : at || {};
  const primary = displays.find((d) => d.id === primaryId) || displays[0];
  if (setting === 'mouse') return cursor ? displayAt(displays, cursor) : primary;
  if (setting == null || setting === '' || setting === 'focus') return displayOfRect(displays, focusRect) || displays.find((d) => d.id === current) || primary;
  if (setting === 'primary') return primary;
  return displays.find((d) => String(d.id) === String(setting) || (d.label && d.label === setting)) || primary;
}

module.exports = { overlayBounds, panelStack, toastBounds, cueBounds, pickPanelDisplay, displayAt, displayOfRect, contains };
