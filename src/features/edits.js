// Group editing: drag-to-group, keyboard moves, group management and undo/redo
// (docs/05-drag-to-group.md). The pure edits live in ../config/edits.js; this is the glue:
// IPC from the tray (overlay.js), one editConfig path with history, saving, and reverting on failure.
// ctx: see register() in main.js.
const E = require('../config/edits');

const UNDO_TOAST_MS = 5000;
let ctx = null;
const history = new E.History(50);
let queue = Promise.resolve(); // edits run one at a time (building an entry can wait on the Start-menu list)
let dragging = false;
let dragTimer;
let installed = null; // { at, p }: Start-menu apps, fetched when a drag starts so the drop doesn't wait

const toOverlay = (channel, payload) => ctx.overlay.webContents.send(channel, payload);
const run = (fn) => (queue = queue.then(fn).catch((e) => ctx.log('edits:', e.stack || e)));
const state = () => ({ canUndo: history.canUndo, canRedo: history.canRedo });
const say = (kind, text, extra) => toOverlay('edits:done', { kind, text, ...extra, ...state() });

function installedApps() {
  if (!installed || Date.now() - installed.at > 60000) {
    const slow = new Promise((r) => setTimeout(r, 4000, []));
    const list = Promise.resolve().then(() => ctx.adapter.listInstalledApps()).catch(() => []);
    installed = { at: Date.now(), p: Promise.race([list, slow]) };
  }
  return installed.p;
}

// ---- The one edit path: snapshot, change, validate, save; on any failure put everything back ----

const refresh = () => { ctx.relayout(); ctx.push(); };

// The config object the history was made against. Anything else replacing ctx.config (Settings,
// Reload config) makes the history stale: undo must not bring back what was there before.
let historyOf = null;
function checkHistory() {
  if (ctx.config !== historyOf) history.clear();
  historyOf = ctx.config;
}

function applyConfig(next) {
  const before = ctx.config;
  try {
    const errors = ctx.schema.validate(next, ctx.catalog.platform);
    if (errors.length) throw new Error(errors[0]);
    ctx.config = next;
    if (ctx.saveConfig() === false) throw new Error("config.json can't be saved right now");
    historyOf = next;
    return true;
  } catch (e) {
    ctx.config = before;
    say('error', `Couldn't save that change: ${e.message}`);
    return false;
  }
}

// fn(config) -> next config (same object = nothing to do). label: text, or a function that gives it
// once fn has run. Returns true when something changed.
function editConfig(label, fn, extra) {
  checkHistory();
  const before = ctx.config;
  let next;
  try { next = fn(before); } catch (e) { say('error', e.message); return false; }
  if (next === before || !applyConfig(next)) return false;
  const text = typeof label === 'function' ? label(next) : label;
  history.record(text, before);
  refresh();
  say('edit', text, extra);
  return true;
}

function step(kind) {
  checkHistory();
  const entry = kind === 'undo' ? history.peekUndo() : history.peekRedo();
  if (!entry) return say('info', kind === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
  const before = ctx.config;
  if (!applyConfig(E.restore(before, entry.snap))) return;
  history[kind](before);
  refresh();
  say(kind, `${kind === 'undo' ? 'Undid' : 'Redid'}: ${entry.label}`);
}

// ---- Moving apps (drag, keyboard and context menu all end up here) ---------------------------

// req: { app: { id, name, exePath, title, running, bundleId? }, to: group id | null | 'other',
//        before?: app id | null, index?, newGroup?: name }
async function moveRequest({ app: info, to, before, index, newGroup }) {
  const config = ctx.config;
  const music = ctx.runtime().music;
  if (!info || !info.id) return;
  if (music && music.id === info.id) return say('error', `${music.name} lives in the music strip, not in a group`);
  const from = E.locate(config, info.id);
  if (!E.canDrag({ running: info.running, inGroup: !!from })) return;

  let built = null;
  if (!from && (to != null && to !== 'other' || newGroup != null)) {
    const taken = new Set([...config.groups.flatMap((g) => g.apps.map((a) => (typeof a === 'string' ? a : a.id))), ...Object.keys(config.apps)]);
    built = E.entryFromWindow(info, { catalog: ctx.catalog.load(), platform: ctx.catalog.platform, installed: await installedApps(), taken });
  }
  const id = built ? built.id : info.id;
  let toId = to === 'other' ? null : to;
  let created = false;
  editConfig((next) => {
    const target = next.groups.find((g) => g.id === toId);
    return toId == null ? `${info.name} → Other`
      : from && from.group.id === toId ? `${info.name} reordered in ${target.name}`
      : `${info.name} → ${target.name}${created ? ' (new group)' : ''}`;
  }, (cfg) => {
    let c = cfg;
    if (newGroup != null) {
      const existing = E.findGroupByName(c, newGroup);
      if (existing) toId = existing.id;
      else {
        c = E.createGroup(c, newGroup);
        toId = c.groups.at(-1).id;
        created = true;
      }
    }
    return E.moveApp(c, id, toId, { before, index, entry: built?.entry, override: built?.override });
  }, { note: built?.note });
}

// ---- Group management -----------------------------------------------------------------------

function groupMenu(id) {
  const { Menu, dialog } = require('electron');
  const g = ctx.config.groups.find((x) => x.id === id);
  if (!g) return;
  const i = ctx.config.groups.indexOf(g);
  const done = () => { ctx.setHoldOpen(false); ctx.overlay.focus(); };
  const items = [
    { label: 'Rename', click: () => toOverlay('edits:rename', { id }) },
    { label: 'Move left', enabled: i > 0, click: () => run(() => editConfig(`Moved group ${g.name}`, (c) => E.reorderGroup(c, id, { delta: -1 }))) },
    { label: 'Move right', enabled: i < ctx.config.groups.length - 1, click: () => run(() => editConfig(`Moved group ${g.name}`, (c) => E.reorderGroup(c, id, { delta: 1 }))) },
    { type: 'separator' },
    {
      label: 'Delete group',
      click: async () => {
        const n = g.apps.length;
        if (n) {
          ctx.setHoldOpen(true);
          const r = await dialog.showMessageBox(ctx.overlay, {
            type: 'question', buttons: ['Delete group', 'Cancel'], defaultId: 1, cancelId: 1,
            message: `Delete "${g.name}"?`, detail: `Its ${n} app${n === 1 ? '' : 's'} will go to Other (open ones stay visible there). You can undo this.`,
          });
          done();
          if (r.response !== 0) return;
        }
        run(() => editConfig(`Deleted group ${g.name}`, (c) => E.deleteGroup(c, id)));
      },
    },
  ];
  ctx.setHoldOpen(true);
  Menu.buildFromTemplate(items).popup({ window: ctx.overlay, callback: done });
}

// ---- Dragging: keep the tray open and the rows still ------------------------------------------

function endDrag() {
  if (!dragging) return;
  dragging = false;
  clearTimeout(dragTimer);
  ctx.setHoldOpen(false);
  ctx.pausePush(false); // flushes the model that was held back
  // The tray was held open through the drag (and the name field). If focus went to another window
  // meanwhile, its blur was ignored: hide now, or the tray sits there unfocused.
  const o = ctx.overlay;
  if (o.isVisible?.() && !o.isFocused?.()) ctx.hideOverlay();
}

function startDrag(info) {
  if (!info) return;
  dragging = true;
  ctx.setHoldOpen(true);
  ctx.pausePush(true);
  clearTimeout(dragTimer);
  dragTimer = setTimeout(endDrag, 5 * 60 * 1000); // a renderer that died mid-drag must not freeze the tray
  if (!info.exePath) return; // a group header, nothing to look up
  if (!E.locate(ctx.config, info.id)) installedApps();
  toOverlay('edits:info', { id: info.id, category: E.categoryFor(info, ctx.catalog.load()) });
}

function register(c) {
  ctx = c;
  const { ipcMain, overlay } = ctx;
  ipcMain.on('drag-start', (_, info) => startDrag(info));
  ipcMain.on('drag-end', () => run(endDrag));
  ipcMain.on('move-app', (_, req) => run(() => moveRequest(req || {})));
  ipcMain.on('undo', () => run(() => step('undo')));
  ipcMain.on('redo', () => run(() => step('redo')));
  ipcMain.on('rename-group', (_, { id, name }) => run(() => {
    const old = ctx.config.groups.find((g) => g.id === id);
    if (old) editConfig(`Renamed ${old.name} → ${String(name).trim()}`, (cfg) => E.renameGroup(cfg, id, name));
  }));
  ipcMain.on('reorder-group', (_, { id, before }) => run(() => {
    const g = ctx.config.groups.find((x) => x.id === id);
    if (g) editConfig(`Moved group ${g.name}`, (cfg) => E.reorderGroup(cfg, id, { before }));
  }));
  ipcMain.on('group-context', (_, id) => groupMenu(id));
  overlay.on('hide', () => run(endDrag));
}

// For main.js's context menu: the same path as a drag. to: group id, or null for "Remove from Cubby".
const moveApp = (info, to, opts = {}) => run(() => moveRequest({ app: info, to: to == null ? 'other' : to, ...opts }));
// Whenever the config is replaced (Reload config, Settings saved): undo would otherwise restore
// groups from before it. main.js applyConfig() calls this; checkHistory() also catches it on its own.
const clearHistory = () => { history.clear(); historyOf = ctx?.config ?? null; };

module.exports = { register, moveApp, clearHistory };
