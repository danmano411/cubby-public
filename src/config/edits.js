// Group edits as pure functions over a config (docs/05-drag-to-group.md): move / reorder apps,
// create / rename / delete / reorder groups, plus the undo history. No electron, no disk.
// Every edit returns a NEW config, or the very same object when nothing would change, so callers
// can tell a no-op with `next === config`. Errors (unknown group, empty name) throw.
const catalog = require('./catalog');
const { RESERVED_GROUP_IDS } = require('./schema');

const RESERVED = ['other', 'music']; // names the tray draws itself (ids: RESERVED_GROUP_IDS, which adds 'new')
const GENERIC_HOSTS = ['pythonw', 'python', 'python3', 'java', 'javaw', 'electron', 'node'];
const clone = (o) => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const entryId = catalog.entryId;

function locate(config, id) {
  for (const group of config.groups) {
    const index = group.apps.findIndex((a) => entryId(a) === id);
    if (index >= 0) return { group, index };
  }
  return null;
}

// ---- Apps -----------------------------------------------------------------------

// Where an app can be dragged from: open apps always, closed apps only once they're in a group
// (closed apps never show in Other), and never the music app (it lives in the music strip).
const canDrag = ({ running, inGroup, isMusic = false }) => !isMusic && (!!running || !!inGroup);

// Move an app into a group (toGroupId) or out to Other (null). One path for drag, keyboard and the
// context menu. Position: opts.before (id of the app to land in front of, null = end) or opts.index
// (position in the list as it was before the move). An app that isn't in any group yet needs
// opts.entry (catalog id or inline object, see entryFromWindow); opts.override merges into config.apps.
function moveApp(config, id, toGroupId, opts = {}) {
  const next = clone(config);
  const from = locate(next, id);
  const entry = from ? from.group.apps[from.index] : opts.entry;
  if (!entry) {
    if (toGroupId == null) return config; // already in Other
    throw new Error(`Cubby doesn't know "${id}" yet`);
  }
  if (!from && entryId(entry) !== id) throw new Error(`entry "${entryId(entry)}" isn't "${id}"`);
  const to = toGroupId == null ? null : next.groups.find((g) => g.id === toGroupId);
  if (toGroupId != null && !to) throw new Error(`No group "${toGroupId}"`);

  if (from) from.group.apps.splice(from.index, 1);
  if (to) {
    let at = to.apps.length;
    if (opts.before === id && from) at = from.group === to ? from.index : at;
    else if (opts.before != null) {
      const i = to.apps.findIndex((a) => entryId(a) === opts.before);
      if (i >= 0) at = i;
    } else if (opts.before === undefined && Number.isInteger(opts.index)) {
      at = opts.index - (from && from.group === to && from.index < opts.index ? 1 : 0);
    }
    to.apps.splice(Math.max(0, Math.min(at, to.apps.length)), 0, entry);
  }
  if (!from && opts.override) {
    const o = next.apps[id] || {};
    next.apps[id] = { ...o, ...opts.override, launch: { ...o.launch, ...opts.override.launch } };
  }
  return same(next, config) ? config : next;
}

// Shift an app up (-1) or down (+1) inside its group.
function reorderApp(config, id, delta) {
  const at = locate(config, id);
  if (!at) return config;
  const to = at.index + delta;
  if (to < 0 || to >= at.group.apps.length) return config;
  const next = clone(config);
  const apps = locate(next, id).group.apps;
  [apps[at.index], apps[to]] = [apps[to], apps[at.index]];
  return next;
}

// ---- Groups ---------------------------------------------------------------------

const cleanName = (name) => {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('A group needs a name');
  if (RESERVED.includes(n.toLowerCase())) throw new Error(`"${n}" is reserved`);
  return n;
};

function groupId(config, name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
  const taken = new Set([...RESERVED_GROUP_IDS, ...config.groups.map((g) => g.id)]);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

const findGroupByName = (config, name) => config.groups.find((g) => g.name.toLowerCase() === String(name).trim().toLowerCase()) || null;

// Append a group (or insert at opts.index). Its id is groupId(config, name).
function createGroup(config, name, opts = {}) {
  const n = cleanName(name);
  const next = clone(config);
  const g = { id: groupId(config, n), name: n, apps: [] };
  const at = Number.isInteger(opts.index) ? Math.max(0, Math.min(opts.index, next.groups.length)) : next.groups.length;
  next.groups.splice(at, 0, g);
  return next;
}

function renameGroup(config, id, name) {
  const n = cleanName(name);
  const g = config.groups.find((x) => x.id === id);
  if (!g) throw new Error(`No group "${id}"`);
  if (g.name === n) return config;
  const next = clone(config);
  next.groups.find((x) => x.id === id).name = n;
  return next;
}

// Apps in a deleted group simply stop being grouped: open ones show up in Other.
function deleteGroup(config, id) {
  if (!config.groups.some((g) => g.id === id)) throw new Error(`No group "${id}"`);
  const next = clone(config);
  next.groups = next.groups.filter((g) => g.id !== id);
  return next;
}

// Move a group in front of opts.before (a group id, null = end) or by opts.delta (-1 / +1).
function reorderGroup(config, id, opts = {}) {
  const from = config.groups.findIndex((g) => g.id === id);
  if (from < 0) throw new Error(`No group "${id}"`);
  const next = clone(config);
  const [g] = next.groups.splice(from, 1);
  let at = next.groups.length;
  if (opts.delta) at = from + opts.delta;
  else if (opts.before != null) {
    const i = next.groups.findIndex((x) => x.id === opts.before);
    at = i >= 0 ? i : at;
  }
  next.groups.splice(Math.max(0, Math.min(at, next.groups.length)), 0, g);
  return same(next, config) ? config : next;
}

// ---- Building a config entry for an app that isn't in a group yet -------------------

const baseName = (p) => String(p || '').split(/[\\/]/).pop().toLowerCase();
const stripExe = (s) => s.replace(/\.exe$/, '');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isGenericHost = (exe) => GENERIC_HOSTS.includes(stripExe(baseName(exe)));

// The catalog entry for a running app, matched like the model does (exe on Windows, bundleId on mac).
function catalogEntryFor(info, list) {
  const exe = baseName(info.exePath || info.exe);
  return list.find((c) => {
    const { title, ...fields } = c.match;
    const keys = Object.keys(fields);
    return keys.length && keys.every((k) => String(k === 'exe' ? exe : info[k] || '').toLowerCase() === String(fields[k]).toLowerCase());
  }) || null;
}

// "IntelliJ" -> "IDE": the catalog's category, used to pre-fill a new group's name.
const categoryFor = (info, list) => catalogEntryFor(info, list)?.category || '';

// Start-menu app (Get-StartApps: [{ name, launch: { appId } }]) for an exe, or null when it isn't
// clearly one app. Exact name first, then names that start with / contain it; ambiguity gives up
// (the caller falls back to the exe path).
function pickAppId(installed, names) {
  const keys = [...new Set(names.map(norm).filter((k) => k.length >= 3))];
  if (!keys.length) return null;
  const apps = installed.map((a) => ({ n: norm(a.name), launch: a.launch })).filter((a) => a.n && a.launch?.appId);
  const exact = apps.filter((a) => keys.includes(a.n));
  const loose = apps.filter((a) => keys.some((k) => a.n.startsWith(k) || (k.length >= 4 && a.n.includes(k))));
  for (const hits of [exact, loose]) {
    const ids = [...new Set(hits.map((a) => a.launch.appId))];
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) return null;
  }
  return null;
}

function launchFor(info, installed, catalogName, platform) {
  if (platform === 'mac') return info.bundleId ? { bundleId: info.bundleId } : info.exePath ? { exe: info.exePath } : null;
  const appId = pickAppId(installed, [stripExe(baseName(info.exePath || info.exe)), info.name, catalogName]);
  if (appId) return { appId };
  return info.exePath ? { exe: info.exePath } : null;
}

// info: { id, name, exePath, title?, bundleId? } of a running app (a model app) ->
//   { id, entry, override?, note?, category }
// Catalog apps become the catalog id (override fills in a launch the catalog can't know, e.g. IntelliJ's
// versioned path). Others get an inline entry. Generic hosts (pythonw, java, ...) match by window title too.
// ctx: { catalog: [...], installed: [...], taken: Set of used ids, platform }
function entryFromWindow(info, ctx = {}) {
  const platform = ctx.platform || catalog.platform;
  const list = ctx.catalog || catalog.load(platform);
  const installed = ctx.installed || [];
  const hit = catalogEntryFor(info, list);
  if (hit) {
    const launch = hit.launch ? null : launchFor(info, installed, hit.name, platform);
    return { id: hit.id, entry: hit.id, override: launch ? { launch } : undefined, category: hit.category || '' };
  }

  const exe = baseName(info.exePath || info.exe);
  const match = platform === 'mac' && info.bundleId ? { bundleId: info.bundleId } : { exe };
  const generic = isGenericHost(exe) && !(platform === 'mac' && info.bundleId);
  let name = info.name;
  let note;
  if (generic && info.title) {
    match.title = `^${escapeRegex(info.title)}$`; // this exact window, not every title containing it
    name = info.title.length > 40 ? `${info.title.slice(0, 39)}…` : info.title;
    note = 'matching by window title';
  }
  const taken = new Set([...(ctx.taken || []), ...list.map((c) => c.id)]);
  const base = (generic && info.title ? `${stripExe(exe)}-${info.title}` : stripExe(exe) || info.id || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  // A bare host exe can't be launched usefully (it would start an empty python / node), so those get no launch.
  const launch = generic ? null : launchFor(info, installed, null, platform);
  const entry = { id, name, match, ...(launch ? { launch } : {}) };
  return { id, entry, note, category: '' };
}

// ---- Undo / redo ------------------------------------------------------------------

// What an edit can change: the groups and the per-app overrides. Anything else in the config
// (panels, keys, voice) is left alone by undo.
const snapshotOf = (config) => clone({ groups: config.groups, apps: config.apps });
const restore = (config, snap) => ({ ...config, ...clone(snap) });

class History {
  constructor(limit = 50) {
    this.limit = limit;
    this.undos = [];
    this.redos = [];
  }
  get canUndo() { return this.undos.length > 0; }
  get canRedo() { return this.redos.length > 0; }
  peekUndo() { return this.undos.at(-1) || null; }
  peekRedo() { return this.redos.at(-1) || null; }
  // A new edit: remember the config from before it; the redo stack is gone.
  record(label, before) {
    this.undos.push({ label, snap: snapshotOf(before) });
    if (this.undos.length > this.limit) this.undos.shift();
    this.redos = [];
  }
  // Both return the entry to apply ({ label, snap }) and file the current state on the other stack.
  undo(current) {
    const e = this.undos.pop();
    if (e) this.redos.push({ label: e.label, snap: snapshotOf(current) });
    return e || null;
  }
  redo(current) {
    const e = this.redos.pop();
    if (e) this.undos.push({ label: e.label, snap: snapshotOf(current) });
    return e || null;
  }
  clear() { this.undos = []; this.redos = []; }
}

module.exports = {
  GENERIC_HOSTS, canDrag, moveApp, reorderApp, createGroup, renameGroup, deleteGroup, reorderGroup,
  groupId, findGroupByName, locate, isGenericHost, categoryFor, catalogEntryFor, pickAppId, entryFromWindow,
  snapshotOf, restore, History,
};
