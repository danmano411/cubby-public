const $groups = document.getElementById('groups');
const $filter = document.getElementById('filter');
const $music = document.getElementById('music');

let model = null;
let cols = [];        // [[row]] per visible group, in fixed layout order
let sel = null;       // key of the highlighted row
let foreground = 0;   // hwnd that was active when the tray opened ("you are here")
// Hover only takes the highlight after a real mouse move, not when the tray pops up under a still cursor.
let mouseMoved = false;
let lastXY = null;
document.addEventListener('mousemove', (e) => {
  const xy = `${e.screenX},${e.screenY}`;
  if (lastXY && xy !== lastXY) mouseMoved = true;
  lastXY = xy;
});

// Rows are the navigable stops. Multi-window apps get a header row plus one row per window.
// The music app isn't a group, but it's the last column for Tab / arrows / search (drawn as the
// music strip). No music provider: no strip, no column.
function buildCols() {
  // col.group: the group a column belongs to, kept on the array so empty groups still render (drop targets).
  cols = model.groups
    .filter((g) => g.id !== 'other' || g.apps.length)
    .map((g) => Object.assign(g.apps.flatMap((app) => {
      if (!app.running) return [{ key: `app:${app.id}`, app, group: g, kind: 'closed' }];
      if (app.windows.length === 1) return [{ key: `w:${app.windows[0].hwnd}`, app, group: g, kind: 'single', win: app.windows[0] }];
      return [
        { key: `app:${app.id}`, app, group: g, kind: 'multi', win: app.windows[0] },
        ...app.windows.map((win) => ({ key: `w:${win.hwnd}`, app, group: g, kind: 'sub', win })),
      ];
    }), { group: g }));
  const m = model.music;
  if (!m) return;
  const strip = { id: 'music', name: m.name };
  cols.push(Object.assign([m.running
    ? { key: `w:${m.windows[0].hwnd}`, app: m, group: strip, kind: 'single', win: m.windows[0] }
    : { key: `app:${m.id}`, app: m, group: strip, kind: 'closed' }], { group: strip }));
}

const q = () => $filter.value.trim().toLowerCase();
const isMatch = (r) => !q() || `${r.app.name} ${r.win?.title || ''}`.toLowerCase().includes(q());
const allRows = () => cols.flat();
const pos = () => {
  for (let c = 0; c < cols.length; c++) {
    const r = cols[c].findIndex((x) => x.key === sel);
    if (r >= 0) return [c, r];
  }
  return [0, -1];
};

function render() {
  buildCols();
  if (!allRows().some((r) => r.key === sel)) sel = allRows()[0]?.key ?? null;
  $groups.replaceChildren();
  const dnd = model.socialMode === 'dnd';
  for (const col of cols) {
    const g = col.group;
    if (!g || g.id === 'music') continue;
    const box = h('div', 'group');
    box.dataset.group = g.id;
    if (dnd && g.ping) box.classList.add('social-dnd');
    const head = h('h2', null, g.name);
    const open = g.apps.filter((a) => a.running).length;
    const small = h('small', null, `${open}/${g.apps.length}`);
    if (g.ping) {
      const tag = h('span', 'mode-tag', { dnd: 'DND', ping: 'Ping' }[model.socialMode]);
      small.prepend(tag, ' · ');
    }
    head.append(small);
    box.append(head);
    for (const r of col) box.append(rowEl(r));
    if (!col.length) box.append(h('div', 'empty', 'Drop apps here'));
    decorateGroup(head, g);
    $groups.append(box);
  }
  // The drop zones for a dragged app float over the groups (shown only during a drag): no column
  // of their own, so starting a drag never squeezes the others out from under the cursor.
  document.querySelector('.zones')?.remove();
  document.getElementById('panel').append(zonesEl(!$groups.querySelector('[data-group="other"]')));
  renderMusic();
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === model.socialMode);
  for (const b of document.querySelectorAll('#panels button')) {
    b.classList.toggle('on', !!model.panels[b.dataset.panel]);
    b.hidden = b.dataset.panel === 'music' && !model.music;
  }
  document.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
}

function rowEl(r) {
  const el = h('div', `row ${r.kind === 'closed' ? 'closed' : ''} ${r.kind === 'sub' ? 'win' : ''}`);
  if (r.win?.minimized && r.kind === 'sub') el.classList.add('min');
  if (r.key === sel) el.classList.add('sel');
  if (!isMatch(r)) el.classList.add('dim');
  const text = h('div', 'text');
  if (r.kind === 'sub') {
    text.append(h('div', 'name', cleanTitle(r.win.title, r.app.name)));
  } else {
    el.append(iconEl(r.app.id, r.app.name, model.icons, model.tints));
    if (r.kind !== 'closed') el.append(h('span', 'live'));
    text.append(h('div', 'name', r.app.name));
    const sub = r.kind === 'closed' ? 'Not open · Enter to launch'
      : r.kind === 'multi' ? `${r.app.windows.length} windows`
      : cleanTitle(r.win.title, r.app.name);
    if (sub && sub !== r.app.name) text.append(h('div', 'sub', sub));
  }
  el.append(text);
  if (r.win && r.win.hwnd === foreground && r.kind !== 'multi') el.append(h('span', 'here', 'here'));
  if (r.kind !== 'sub') {
    if (r.app.unread) el.append(h('span', 'badge', r.app.unread));
    else if (r.app.pinged) el.append(h('span', 'dot'));
  }
  el.onclick = () => { sel = r.key; go(r); };
  el.onmousemove = () => { if (mouseMoved && sel !== r.key) { sel = r.key; markSel(); } };
  el.oncontextmenu = (e) => {
    e.preventDefault();
    cubby.send('context', { ...appInfo(r), hwnd: r.win && r.kind !== 'multi' ? r.win.hwnd : 0 });
  };
  el.dataset.key = r.key;
  el.dataset.app = r.app.id;
  el.onpointerdown = (e) => pressApp(e, r);
  return el;
}

function markSel() {
  for (const el of document.querySelectorAll('[data-key]')) el.classList.toggle('sel', el.dataset.key === sel);
  document.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
}

function renderMusic() {
  const m = model.music;
  $music.replaceChildren();
  $music.style.visibility = m ? '' : 'hidden'; // keeps its footer space, so the hints stay right-aligned
  if (!m) return;
  const r = cols.at(-1)[0];
  $music.className = m.running ? '' : 'off';
  $music.dataset.key = r.key;
  $music.onpointerdown = (e) => pressApp(e, r); // can be picked up, but not dropped anywhere
  $music.classList.toggle('sel', r.key === sel);
  $music.classList.toggle('dim', !isMatch(r));
  $music.onmousemove = () => { if (mouseMoved && sel !== r.key) { sel = r.key; markSel(); } };
  $music.append(iconEl(m.id, m.name, model.icons, model.tints));
  const now = h('div', 'now');
  const [artist, ...song] = (m.nowPlaying || '').split(' - ');
  now.append(h('div', 'name', m.nowPlaying ? song.join(' - ') || artist : `${m.name} · ${m.running ? 'paused' : 'not open'}`));
  now.append(h('div', 'sub', m.nowPlaying ? artist : m.running ? 'Nothing playing' : 'Click to open'));
  now.onclick = () => (m.running ? cubby.send('activate', m.windows[0].hwnd) : cubby.send('launch', m.id));
  $music.append(now);
  if (m.running) {
    const ctl = h('div', 'ctl');
    const keys = model.keys;
    for (const [k, label, key] of [['prev', '⏮', keys.musicPrev], ['play', '⏯', keys.musicPlay], ['next', '⏭', keys.musicNext]]) {
      const b = h('button', null, label);
      b.title = `${{ prev: 'Previous', play: 'Play / pause', next: 'Next' }[k]}${key ? ` (${key}, works anywhere)` : ''}`;
      b.onclick = () => { cubby.send('media', k); setTimeout(() => $filter.focus(), 0); };
      ctl.append(b);
    }
    $music.append(ctl);
  }
}

function go(r) {
  if (r.kind === 'closed') cubby.send('launch', r.app.id, r.app.launch);
  else cubby.send('activate', r.win.hwnd);
}

// Tab / hotkey: next OPEN window in fixed layout order (closed apps and multi headers skipped).
function cycle(dir) {
  const stops = allRows().filter((r) => (r.kind === 'single' || r.kind === 'sub') && isMatch(r));
  if (!stops.length) return;
  const i = stops.findIndex((r) => r.key === sel);
  sel = stops[(i + dir + stops.length) % stops.length].key;
  markSel();
}

function move(dc, dr) {
  let [c, r] = pos();
  if (dr) {
    const col = cols[c];
    for (let i = r + dr; i >= 0 && i < col.length; i += dr) if (isMatch(col[i])) { sel = col[i].key; break; }
  } else {
    for (let n = c + dc; n >= 0 && n < cols.length; n += dc) {
      const options = cols[n].map((x, i) => [x, i]).filter(([x]) => isMatch(x));
      if (!options.length) continue;
      // Land on the row closest to the current height.
      sel = options.reduce((a, b) => (Math.abs(b[1] - r) < Math.abs(a[1] - r) ? b : a))[0].key;
      break;
    }
  }
  markSel();
}

document.addEventListener('keydown', (e) => {
  const k = e.key;
  if (k === 'Escape') { if (q()) { $filter.value = ''; render(); } else cubby.send('hide'); }
  else if (k === 'Tab') cycle(e.shiftKey ? -1 : 1);
  else if (k === 'ArrowRight') move(1, 0);
  else if (k === 'ArrowLeft') move(-1, 0);
  else if (k === 'ArrowDown') move(0, 1);
  else if (k === 'ArrowUp') move(0, -1);
  else if (k === 'Enter') goSelected();
  else return;
  e.preventDefault();
});

function goSelected() {
  const r = allRows().find((x) => x.key === sel);
  if (r) go(r);
}

$filter.addEventListener('input', () => {
  // App name beats window title (a chat app showing "#announcements" must not win "nt" over an app named nt),
  // then open windows beat closed apps, then layout order (sort is stable).
  const name = (r) => { const n = r.app.name.toLowerCase(); return n.startsWith(q()) ? 0 : n.includes(q()) ? 1 : 2; };
  const shut = (r) => (r.kind === 'closed' || r.kind === 'multi' ? 1 : 0);
  const best = allRows().filter(isMatch).sort((a, b) => name(a) - name(b) || shut(a) - shut(b))[0];
  if (best) sel = best.key;
  render();
});

document.getElementById('backdrop').onclick = () => cubby.send('hide');

document.getElementById('open-all').onclick = () => cubby.send('open-all');
// Close All needs a second click within 3s.
const $close = document.getElementById('close-all');
let closeTimer;
const closeLabel = () => model?.labels?.closeAll || 'Close all';
$close.onclick = () => {
  if ($close.classList.contains('armed')) { disarm(); cubby.send('close-all'); return; }
  const n = model.groups.filter((g) => g.id !== 'other').flatMap((g) => g.apps).concat(model.music || []).filter((a) => a.running).length;
  $close.querySelector('.label').textContent = `${model?.labels?.closeVerb || 'Close'} ${n} apps?`;
  $close.classList.add('armed');
  closeTimer = setTimeout(disarm, 3000);
};
function disarm() { clearTimeout(closeTimer); $close.classList.remove('armed'); $close.querySelector('.label').textContent = closeLabel(); }
for (const b of document.querySelectorAll('#modes button')) {
  b.onclick = () => { cubby.send('social-mode', b.dataset.mode); setTimeout(() => $filter.focus(), 0); };
}
// Side panels toggle independently: none / socials / music / both.
for (const b of document.querySelectorAll('#panels button')) {
  b.onclick = () => { cubby.send('panel', b.dataset.panel, !model.panels[b.dataset.panel]); setTimeout(() => $filter.focus(), 0); };
}

cubby.on('open', (m) => {
  disarm();
  editsReset();
  model = m;
  foreground = m.foreground;
  $filter.value = '';
  mouseMoved = false;
  lastXY = null;
  sel = `w:${foreground}`; // start on "you are here"
  setHints(m.altSession);
  document.getElementById('panel').style.animation = 'none';
  void document.getElementById('panel').offsetWidth;
  document.getElementById('panel').style.animation = '';
  render();
  // Opened with Alt held: pre-select the previous app so a quick Alt+Tab tap goes back, like Windows.
  // More Tabs continue in group order from there. No known previous app -> next open app.
  if (m.altSession) {
    if (allRows().some((r) => r.key === `w:${m.previous}`)) { sel = `w:${m.previous}`; markSel(); }
    else cycle(1);
  }
  $filter.focus();
});
// Alt released during an Alt+Tab session: switch to the highlighted app.
cubby.on('alt-up', goSelected);
// Alt+~ (also mid-Alt+Tab): stay open for typing.
cubby.on('search', () => { setHints(false); $filter.focus(); });

// Key labels come from config (model.keys, e.g. switch "Alt+Tab", search "Alt+~").
const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const kbd = (s) => `<kbd>${esc(s)}</kbd>`;
const splitKey = (label) => { const p = (label || '').split('+'); const key = p.pop(); return { mods: p.join('+'), key }; };
function setHints(alt) {
  const sw = splitKey(model.keys.switch);
  const search = splitKey(model.keys.search);
  const mod = sw.mods || 'Alt';
  document.getElementById('hints').innerHTML = alt
    ? `${kbd(sw.key || 'Tab')} next ${kbd('Shift')}${kbd(sw.key || 'Tab')} back · let go of ${kbd(mod)} to switch${search.key && search.mods === mod ? ` · ${kbd(search.key)} to search instead` : ''}`
    : `type to search ${kbd('←')}${kbd('→')} groups ${kbd('↑')}${kbd('↓')} apps ${kbd('Enter')} go ${kbd('Esc')} close`;
  $filter.placeholder = alt ? `Let go of ${mod} to switch` : 'Type to jump…';
  const v = model.voice;
  document.getElementById('open-all').title = `Launch every app in your groups that isn't open${v ? ` (voice: "${v.openAll}")` : ''}`;
  document.getElementById('close-all').title = `Close every app in your groups, click twice${v ? ` (voice: "${v.closeAll}")` : ''}`;
  if (!$close.classList.contains('armed')) $close.querySelector('.label').textContent = closeLabel();
}
cubby.on('model', (m) => { model = { ...m, foreground }; if (rendersHeld()) pendingRender = true; else render(); });
cubby.on('cycle', (d) => cycle(d));

// =====================================================================================
// Editing groups (docs/05-drag-to-group.md): drag apps between groups, keyboard moves, inline
// group naming / renaming, undo + redo. Pointer events, and only clientX/clientY: the tray can sit
// on a monitor with a negative origin and another scale, so screen coordinates mean nothing here.
// Edits are requests to main (move-app, undo, ...). The rows only change when the new model
// comes back, so what you see is always what was saved.
// =====================================================================================

const DRAG_PX = 6;
let drag = null;          // { kind: 'app'|'group', ..., active }
let dragInfo = null;      // from main: { id, category } for the app being dragged
let naming = null;        // { info, zone, input }: the new-group name field
let renaming = null;      // { id, input }
let pendingRender = false;
let suppressClick = false;

const rendersHeld = () => !!(drag?.active || naming || renaming);
function releaseRender() {
  if (rendersHeld() || !pendingRender) return;
  pendingRender = false;
  render();
}
function editsReset() {
  endPointer();
  naming = renaming = null; // the render that follows 'open' rebuilds the zones card
  pendingRender = false;
  clearTimeout(editToastTimer);
  $editToast.hidden = true;
}

// ---- Drag: apps and group headers ----------------------------------------------------

const appInfo = (r) => ({ id: r.app.id, name: r.app.name, exePath: r.app.exePath, bundleId: r.app.bundleId, title: (r.win || r.app.windows[0])?.title || '', running: r.app.running });

function pressApp(e, r) {
  if (e.button !== 0 || drag || e.target.closest('button, input')) return;
  const denied = r.group.id === 'music'; // the music app lives in the strip
  if (r.kind === 'closed' && r.group.id === 'other') return; // closed apps only drag from a group
  drag = { kind: 'app', r, info: appInfo(r), denied, x0: e.clientX, y0: e.clientY, active: false, pointerId: e.pointerId, srcKey: r.key, grab: grabAt(e) };
  armPointer();
}

function pressGroup(e, g) {
  if (e.button !== 0 || drag || e.target.closest('input')) return;
  drag = { kind: 'group', g, x0: e.clientX, y0: e.clientY, active: false, pointerId: e.pointerId, grab: grabAt(e) };
  armPointer();
}

// Where in the pressed element the pointer grabbed it: the ghost keeps that spot under the cursor.
const grabAt = (e) => { const b = e.currentTarget.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };

function armPointer() {
  suppressClick = false; // a new press is a new gesture
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragUp);
  document.addEventListener('pointercancel', cancelDrag);
}

function endPointer() {
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragUp);
  document.removeEventListener('pointercancel', cancelDrag);
  if (drag?.ghost) drag.ghost.remove();
  if (drag?.line) drag.line.remove();
  clearMarks();
  if (!naming) document.querySelector('.zones')?.classList.remove('open');
  document.body.classList.remove('dragging', 'denied');
  for (const el of document.querySelectorAll('.drag-src')) el.classList.remove('drag-src');
  try { if (drag?.active) document.body.releasePointerCapture(drag.pointerId); } catch {}
  drag = null;
  scrollDir = 0;
}

function onDragMove(e) {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < DRAG_PX) return;
    startDrag();
  }
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.ghost.style.transform = `translate(${drag.x - drag.grab.x}px, ${drag.y - drag.grab.y}px)`;
  const bar = $groups.getBoundingClientRect();
  scrollDir = overZones(drag.x, drag.y) ? 0 : drag.x < bar.left + 48 ? -1 : drag.x > bar.right - 48 ? 1 : 0;
  updateTarget();
}

function startDrag() {
  drag.active = true;
  clearTimeout(editToastTimer);
  $editToast.hidden = true;
  try { document.body.setPointerCapture(drag.pointerId); } catch {}
  document.body.classList.add('dragging');
  document.body.classList.toggle('denied', !!drag.denied);
  const ghost = h('div', 'ghost');
  if (drag.kind === 'app') {
    const { app } = drag.r;
    ghost.append(iconEl(app.id, app.name, model.icons, model.tints), h('span', null, app.name));
    for (const el of document.querySelectorAll(`[data-app="${CSS.escape(app.id)}"]`)) el.classList.add('drag-src');
    if (drag.r.group.id === 'music') $music.classList.add('drag-src');
    dragInfo = null;
    cubby.send('drag-start', drag.info);
    if (!drag.denied) addZones();
  } else {
    ghost.append(h('span', null, drag.g.name));
    document.querySelector(`.group[data-group="${CSS.escape(drag.g.id)}"]`)?.classList.add('drag-src');
    cubby.send('drag-start', { id: `group:${drag.g.id}` }); // holds the tray open and the model still
  }
  document.body.append(ghost);
  drag.ghost = ghost;
  // The ghost is smaller than a row: keep the grab point inside it so it never drifts off the cursor.
  const b = ghost.getBoundingClientRect();
  drag.grab = { x: Math.min(drag.grab.x, b.width - 12), y: Math.min(drag.grab.y, b.height / 2) };
  scrollTick();
}

// The extra drop targets for an app: a new group, and Other when there's no such column. A card
// docked to the bottom-right corner of the groups area, over the columns, shown only while an app
// is dragged: it takes no space, so the columns never move. Rendered with the groups (render()).
function zonesEl(withOther) {
  const box = h('div', 'zones');
  const zone = (id, label, sub) => {
    const z = h('div', 'group zone');
    z.dataset.group = id;
    z.append(h('div', 'zone-label', label), h('div', 'zone-sub', sub));
    box.append(z);
  };
  if (withOther) zone('other', 'Other', 'Drop to take it out of its group');
  zone('new', '+ New group', 'Drop to name it');
  return box;
}
function addZones() {
  const zones = document.querySelector('.zones');
  if (!zones) return;
  // Measured from #panel (the card's containing block), clear of the groups' scrollbars.
  const p = document.getElementById('panel').getBoundingClientRect();
  const g = $groups.getBoundingClientRect();
  zones.style.right = `${Math.round(p.right - g.right) + 14}px`;
  zones.style.bottom = `${Math.round(p.bottom - g.bottom) + 14}px`;
  zones.classList.add('open');
}
function overZones(x, y) {
  const zones = document.querySelector('.zones.open');
  const b = zones?.getBoundingClientRect();
  return !!b && x >= b.left && x < b.right && y >= b.top && y < b.bottom;
}

// Auto-scroll when the cursor sits near the left/right edge of the groups row.
let scrollDir = 0;
function scrollTick() {
  if (!drag?.active) return;
  if (scrollDir) {
    $groups.scrollLeft += scrollDir * 14;
    updateTarget();
  }
  requestAnimationFrame(scrollTick);
}

function clearMarks() {
  for (const el of document.querySelectorAll('.drop, .drop-before, .drop-end')) el.classList.remove('drop', 'drop-before', 'drop-end');
  if (drag?.line) drag.line.hidden = true;
}

// Which app the dragged one lands in front of, from the rows' vertical positions. A multi-window
// app is one block (header + its windows). before null = at the end.
function insertionPoint(col, y) {
  const blocks = new Map();
  for (const row of col.querySelectorAll('.row[data-app]')) {
    const b = row.getBoundingClientRect();
    const cur = blocks.get(row.dataset.app);
    blocks.set(row.dataset.app, { top: cur ? cur.top : b.top, bottom: b.bottom });
  }
  let last = null;
  for (const [id, b] of blocks) {
    if (y < (b.top + b.bottom) / 2) return { before: id, y: b.top - 1 };
    last = b;
  }
  return { before: null, y: last ? last.bottom + 1 : (col.querySelector('h2')?.getBoundingClientRect().bottom ?? col.getBoundingClientRect().top) };
}

function updateTarget() {
  clearMarks();
  drag.target = null;
  if (drag.denied) return;
  const col = document.elementFromPoint(drag.x, drag.y)?.closest('.group');
  if (!col || !col.dataset.group) return;
  const to = col.dataset.group;
  if (drag.kind === 'group') {
    if (to === 'other' || to === 'new') return;
    const cols = [...$groups.querySelectorAll('.group[data-group]')].filter((c) => !['other', 'new'].includes(c.dataset.group));
    const i = cols.indexOf(col);
    const rect = col.getBoundingClientRect();
    const beforeEl = drag.x < rect.left + rect.width / 2 ? col : cols[i + 1];
    if (beforeEl) beforeEl.classList.add('drop-before');
    else col.classList.add('drop-end');
    drag.target = { before: beforeEl ? beforeEl.dataset.group : null };
    return;
  }
  col.classList.add('drop');
  drag.target = { to, before: null };
  if (to === 'new' || to === 'other') return;
  const p = insertionPoint(col, drag.y);
  drag.target.before = p.before;
  drag.line = drag.line || h('div', 'drop-line');
  col.append(drag.line);
  drag.line.hidden = false;
  drag.line.style.top = `${p.y - col.getBoundingClientRect().top}px`;
}

function onDragUp() {
  if (!drag) return;
  if (!drag.active) return endPointer(); // a plain click: the row's own click handler runs
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 60);
  const { kind, g, info, target } = drag;
  endPointer();
  setTimeout(releaseRender, 0); // after any name field has opened
  if (kind === 'group') {
    if (target && target.before !== g.id) cubby.send('reorder-group', { id: g.id, before: target.before });
    return cubby.send('drag-end');
  }
  if (!target) return cubby.send('drag-end');
  if (target.to === 'new') return startNaming(info);
  cubby.send('move-app', { app: info, to: target.to, before: target.before });
  cubby.send('drag-end');
  setTimeout(() => $filter.focus(), 0);
}

function cancelDrag() {
  if (!drag) return;
  const was = drag.active;
  endPointer();
  if (was) cubby.send('drag-end');
  releaseRender();
}

document.addEventListener('click', (e) => {
  if (!suppressClick) return;
  suppressClick = false;
  e.stopPropagation();
  e.preventDefault();
}, true);

cubby.on('edits:info', (i) => {
  if (!drag?.active && !naming) return;
  dragInfo = i;
  if (naming && naming.info.id === i.id && !naming.input.dataset.touched && i.category) {
    naming.input.value = i.category;
    naming.input.select();
  }
});

// ---- New group: ask for a name, right on the dashed card ---------------------------------

function startNaming(info) {
  const zones = document.querySelector('.zones');
  const zone = zones?.querySelector('.zone[data-group="new"]');
  if (!zone) return cubby.send('drag-end');
  addZones();
  zones.classList.add('naming'); // the field takes the zones card; the Other zone steps aside
  zone.classList.add('naming');
  zone.replaceChildren();
  const input = h('input', 'name-field');
  input.placeholder = 'Group name';
  input.maxLength = 24;
  input.spellcheck = false;
  input.value = dragInfo && dragInfo.id === info.id ? dragInfo.category : ''; // the catalog's guess for this app
  zone.append(h('h2', null, 'New group'), input, h('div', 'zone-sub', 'Enter to create · Esc to cancel'));
  naming = { info, zone, input };
  const finish = (name) => {
    if (naming?.input !== input) return;
    naming = null;
    if (name) cubby.send('move-app', { app: info, newGroup: name });
    cubby.send('drag-end');
    $filter.focus();
    pendingRender = true; // puts the zones card back as it was (and picks up what arrived meanwhile)
    releaseRender();
  };
  input.oninput = () => { input.dataset.touched = '1'; };
  input.onkeydown = (e) => {
    e.stopPropagation(); // not the tray's own Enter / arrows
    if (e.key === 'Enter') { if (input.value.trim()) finish(input.value.trim()); e.preventDefault(); }
    else if (e.key === 'Escape') { finish(''); e.preventDefault(); }
  };
  input.onblur = () => setTimeout(() => finish(''), 0);
  input.focus();
  input.select();
}

// ---- Group headers: double-click to rename, right-click for the menu ---------------------

function decorateGroup(head, g) {
  if (g.id === 'other') return;
  head.title = 'Drag to reorder · double-click to rename · right-click for more';
  head.onpointerdown = (e) => pressGroup(e, g);
  head.ondblclick = () => startRename(g.id);
  head.oncontextmenu = (e) => { e.preventDefault(); cubby.send('group-context', g.id); };
}

function startRename(id) {
  const head = document.querySelector(`.group[data-group="${CSS.escape(id)}"] h2`);
  const g = model.groups.find((x) => x.id === id);
  if (!head || !g || renaming) return;
  const input = h('input', 'name-field inline');
  input.value = g.name;
  input.maxLength = 24;
  input.spellcheck = false;
  head.firstChild.replaceWith(input);
  renaming = { id, input };
  const finish = (save) => {
    if (renaming?.input !== input) return;
    renaming = null;
    const name = input.value.trim();
    if (save && name && name !== g.name) cubby.send('rename-group', { id, name });
    pendingRender = true;
    releaseRender(); // puts the header text back (and picks up whatever arrived meanwhile)
    $filter.focus();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  input.focus();
  input.select();
}

cubby.on('edits:rename', ({ id }) => startRename(id));

// ---- Keyboard: Ctrl+Z / Ctrl+Y undo and redo, Ctrl+arrows move the selected app -------------
// Capture phase, so it wins over the tray's own arrow-key navigation. Cmd works the same as Ctrl.

function keyMove(key) {
  const r = allRows().find((x) => x.key === sel);
  if (!r || r.group.id === 'music' || !model) return;
  const groups = model.groups.filter((g) => g.id !== 'other');
  const here = groups.findIndex((g) => g.id === r.group.id); // -1: in Other
  const apps = r.group.apps;
  const i = apps.findIndex((a) => a.id === r.app.id);
  let to = r.group.id;
  let before;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const target = key === 'ArrowLeft' ? (here < 0 ? groups.at(-1) : groups[here - 1]) : groups[here + 1];
    if (!target || here < 0 && key === 'ArrowRight') return;
    to = target.id;
    before = target.apps[Math.min(i, target.apps.length)]?.id ?? null; // same height in the next group
  } else {
    if (here < 0) return; // Other isn't ordered
    if (key === 'ArrowUp' && i > 0) before = apps[i - 1].id;
    else if (key === 'ArrowDown' && i < apps.length - 1) before = apps[i + 2]?.id ?? null;
    else return;
  }
  cubby.send('move-app', { app: appInfo(r), to, before });
}

document.addEventListener('keydown', (e) => {
  if (e.target.classList?.contains('name-field')) return; // the field handles its own keys
  if (drag?.active) {
    if (e.key === 'Escape') cancelDrag();
    e.preventDefault();
    return e.stopImmediatePropagation();
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'z' || k === 'y') {
    const a = document.activeElement;
    if (a && a.tagName === 'INPUT' && a.value) return; // undoing typing, not groups
    cubby.send(k === 'y' || e.shiftKey ? 'redo' : 'undo');
  } else if (e.key.startsWith('Arrow') && !e.shiftKey) keyMove(e.key);
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

// ---- Toast: what just changed, with Undo for a few seconds -------------------------------

const $editToast = h('div', 'edit-toast');
$editToast.hidden = true;
document.getElementById('panel').append($editToast);
let editToastTimer;

cubby.on('edits:done', ({ kind, text, note, canUndo }) => {
  $editToast.replaceChildren(h('span', 'msg', note ? `${text} · ${note}` : text));
  $editToast.className = `edit-toast ${kind}`;
  if (kind === 'edit' && canUndo) {
    const b = h('button', null, 'Undo');
    b.onclick = () => { cubby.send('undo'); $filter.focus(); };
    $editToast.append(b);
  }
  $editToast.hidden = false;
  clearTimeout(editToastTimer);
  editToastTimer = setTimeout(() => { $editToast.hidden = true; }, kind === 'edit' ? 5000 : kind === 'error' ? 6000 : 2500);
});
