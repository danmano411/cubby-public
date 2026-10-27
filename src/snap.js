// Split-screen layouts (Windows Snap groups). Windows keeps track of them but has no API for it
// (docs/alt-tab-research), so Cubby keeps its own record: a layout is the set of snapped windows you
// can see tiling a display. It lives until its windows close, move or un-snap; several can share the
// same slots (A|B and C|D both on one screen), and raising one window alone doesn't end it.
// What you see only counts as a new layout when it can't be a mix of layouts (worth()).
// Pure: windows are { hwnd, rect, arranged, minimized } in z-order (front first), rects in DIP;
// displays as from Electron's screen.
const { displayOfRect } = require('./layout');

const area = (r) => r.width * r.height;
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const near = (a, b) => ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 2); // DIP rounding at odd scales
const COVER = 0.95; // the layout fills the work area (snap tiles it exactly; a little slack for rounding)
const HIDDEN = 0.02; // more than 2% of a window under something in front: you can't see it as part of a layout

// The layout `hwnd` is part of as seen on screen right now, or null: the snapped windows on its
// display that nothing covers, if there are 2+ of them and they fill the work area.
function visibleLayout(wins, displays, hwnd) {
  const me = wins.find((w) => w.hwnd === hwnd);
  if (!me?.arranged || me.minimized || !me.rect) return null;
  const d = displayOfRect(displays, me.rect);
  if (!d) return null;
  const covered = [];
  const members = [];
  for (const w of wins) {
    if (w.minimized || !w.rect || displayOfRect(displays, w.rect) !== d) continue;
    const seen = !covered.some((c) => overlap(c, w.rect) > HIDDEN * area(w.rect));
    if (seen && w.arranged) members.push(w);
    covered.push(w.rect); // anything in front hides what's behind it
  }
  if (members.length < 2 || !members.includes(me)) return null;
  const wa = d.workArea;
  const filled = members.reduce((s, w) => s + overlap(w.rect, wa), 0);
  return filled >= COVER * area(wa) ? members.map(({ hwnd: h, rect }) => ({ hwnd: h, rect })) : null;
}

// Layouts are [{ id, color, at, members: [{ hwnd, rect }] }] (at: when it was recorded). Several can share a display (one behind the
// other, as in Windows). Adds `seen` (from visibleLayout), dropping a layout it shares a window with: a
// window is in one layout. Same windows in the same places: no change, so a layout keeps its color
// while you look at it. Colors: the lowest one not in use.
function remember(layouts, seen, nextId, now = 0) {
  if (!seen) return layouts;
  const same = layouts.find((l) => l.members.length === seen.length && seen.every((s) => l.members.some((m) => m.hwnd === s.hwnd && near(m.rect, s.rect))));
  if (same) return layouts;
  const kept = layouts.filter((l) => !l.members.some((m) => seen.some((s) => s.hwnd === m.hwnd)));
  const used = new Set(kept.map((l) => l.color));
  let color = 0;
  while (used.has(color)) color++;
  return [...kept, { id: nextId, color, at: now, members: seen }];
}

// The layouts that still hold: members that are gone, no longer snapped or moved drop out (a
// minimized member stays: it comes back to its slot), and a layout needs 2+ members left.
// (Windows itself ends a group when another window is snapped into one of its slots; the user wants
// A|B kept after snapping C|D over it, so Cubby doesn't.)
function prune(layouts, wins) {
  const byHwnd = new Map(wins.map((w) => [w.hwnd, w]));
  const ok = (m) => { const w = byHwnd.get(m.hwnd); return w && (w.minimized || (w.arranged && w.rect && near(w.rect, m.rect))); };
  return layouts.map((l) => ({ ...l, members: l.members.filter(ok) })).filter((l) => l.members.length >= 2);
}

// Just snapped: on screen and not snapped there a moment ago (prev). Coming back from minimized isn't a snap.
function justSnapped(prev, wins) {
  const was = new Map(prev.map((w) => [w.hwnd, w]));
  return wins.filter((w) => { const p = was.get(w.hwnd); return w.arranged && w.rect && p && !p.minimized && !(p.arranged && near(p.rect, w.rect)); });
}

// Another snapped window sits in one of seen's slots (behind it): what's on screen may be a mix.
function contested(wins, seen) {
  return wins.some((w) => w.arranged && w.rect && !w.minimized && !seen.some((s) => s.hwnd === w.hwnd) && seen.some((s) => overlap(s.rect, w.rect) > HIDDEN * area(s.rect)));
}

// Is what's on screen (seen) a layout to remember? Bring one window of layout X up over layout Y and
// the two can tile the screen together, a mix nobody snapped. So:
//  - a window that's already in another layout only joins a new one if it was snapped again after
//    that layout was recorded, so snapping C|D over A|B keeps A|B (B on screen next to C is a mix);
//  - otherwise it counts if nothing else is snapped behind its slots, or if one of it was just snapped.
// snappedAt: hwnd -> when it was last snapped into place.
// ponytail: snapping just E next to an A that's in A|B isn't remembered (it looks like a mix);
// snapping A again (or E and A both) does it.
const RECENT = 15000;
function worth(layouts, wins, seen, snappedAt, now) {
  if (!seen) return false;
  const holder = (s) => layouts.find((l) => l.members.some((m) => m.hwnd === s.hwnd) && !seen.every((x) => l.members.some((m) => m.hwnd === x.hwnd)));
  if (seen.some((s) => { const l = holder(s); return l && !((snappedAt.get(s.hwnd) || 0) > (l.at || 0)); })) return false;
  return !contested(wins, seen) || seen.some((s) => now - (snappedAt.get(s.hwnd) || -Infinity) < RECENT);
}

// For the tray: members in reading order (top to bottom, then left to right), each with its slot
// as fractions of the layout's bounds, so the overlay can draw a small map of the layout.
function describe(layout) {
  const ms = [...layout.members].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const x0 = Math.min(...ms.map((m) => m.rect.x)), y0 = Math.min(...ms.map((m) => m.rect.y));
  const w = Math.max(...ms.map((m) => m.rect.x + m.rect.width)) - x0, h = Math.max(...ms.map((m) => m.rect.y + m.rect.height)) - y0;
  const f = (v) => Math.round(v * 1000) / 1000;
  return { id: layout.id, color: layout.color, slots: ms.map((m) => ({ hwnd: m.hwnd, x: f((m.rect.x - x0) / w), y: f((m.rect.y - y0) / h), w: f(m.rect.width / w), h: f(m.rect.height / h) })) };
}

module.exports = { visibleLayout, remember, prune, justSnapped, contested, worth, describe };
