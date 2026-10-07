const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../src/config/edits');
const schema = require('../src/config/schema');
const catalog = require('../src/config/catalog');
const { buildModel } = require('../src/model');

const base = schema.load(fs.readFileSync(path.join(__dirname, 'fixtures/config.json'), 'utf8'), 'windows').config;
const WIN = catalog.load('windows');
const ids = (config, gid) => config.groups.find((g) => g.id === gid).apps.map(catalog.entryId);
const empty = () => E.createGroup(base, 'Work'); // a group with no apps

const idea = { id: 'other:idea64.exe', name: 'Idea64', exePath: 'C:\\Program Files\\JetBrains\\IDEA\\bin\\idea64.exe', title: 'shop - IntelliJ IDEA', running: true };

test('moveApp: into an empty group, to an index, before an app, out to Other', () => {
  const c = empty();
  const into = E.moveApp(c, 'webby', 'work');
  assert.deepStrictEqual(ids(into, 'work'), ['webby']);
  assert.deepStrictEqual(ids(into, 'browsers'), ['surfer'], 'an app lives in exactly one group');

  const at0 = E.moveApp(base, 'surfer', 'chat', { index: 0 });
  assert.deepStrictEqual(ids(at0, 'chat'), ['surfer', 'chatter', 'pinger', 'meetly']);
  const at2 = E.moveApp(base, 'surfer', 'chat', { index: 2 });
  assert.deepStrictEqual(ids(at2, 'chat'), ['chatter', 'pinger', 'surfer', 'meetly']);
  const huge = E.moveApp(base, 'surfer', 'chat', { index: 99 });
  assert.deepStrictEqual(ids(huge, 'chat'), ['chatter', 'pinger', 'meetly', 'surfer'], 'index is clamped');
  const before = E.moveApp(base, 'surfer', 'chat', { before: 'pinger' });
  assert.deepStrictEqual(ids(before, 'chat'), ['chatter', 'surfer', 'pinger', 'meetly']);
  const end = E.moveApp(base, 'chatter', 'browsers', { before: null });
  assert.deepStrictEqual(ids(end, 'browsers'), ['webby', 'surfer', 'chatter']);

  const out = E.moveApp(base, 'pinger', null);
  assert.deepStrictEqual(ids(out, 'chat'), ['chatter', 'meetly']);
  assert.ok(!out.groups.some((g) => ids(out, g.id).includes('pinger')), 'not in any group = it shows up in Other');
});

test('moveApp: the same group reorders, and dropping where it already is does nothing', () => {
  assert.deepStrictEqual(ids(E.moveApp(base, 'chatter', 'chat', { before: null }), 'chat'), ['pinger', 'meetly', 'chatter']);
  assert.deepStrictEqual(ids(E.moveApp(base, 'meetly', 'chat', { index: 0 }), 'chat'), ['meetly', 'chatter', 'pinger']);
  assert.deepStrictEqual(ids(E.moveApp(base, 'chatter', 'chat', { index: 2 }), 'chat'), ['pinger', 'chatter', 'meetly'], 'index is from before the move');
  for (const opts of [{ index: 1 }, { index: 2 }, { before: 'pinger' }, { before: 'meetly' }]) {
    assert.strictEqual(E.moveApp(base, 'pinger', 'chat', opts), base, `no-op ${JSON.stringify(opts)}`);
  }
  assert.deepStrictEqual(ids(E.moveApp(base, 'pinger', 'chat', { before: 'chatter' }), 'chat'), ['pinger', 'chatter', 'meetly']);
});

test('moveApp: never mutates its input, and unknown things are errors or no-ops', () => {
  const frozen = JSON.stringify(base);
  E.moveApp(base, 'webby', 'chat', { index: 1 });
  assert.strictEqual(JSON.stringify(base), frozen);
  assert.throws(() => E.moveApp(base, 'webby', 'nope'), /No group/);
  assert.throws(() => E.moveApp(base, 'ghost', 'chat'), /doesn't know/);
  assert.strictEqual(E.moveApp(base, 'ghost', null), base, 'removing something that was never grouped');
  assert.throws(() => E.moveApp(base, 'ghost', 'chat', { entry: { id: 'other', name: 'x', match: { exe: 'x.exe' } } }), /isn't/);
});

test('moveApp: an app that is not in a group yet comes with its entry; overrides are merged', () => {
  const entry = { id: 'tool', name: 'Tool', match: { exe: 'tool.exe' }, launch: { exe: 'C:\\t\\tool.exe' } };
  const next = E.moveApp(base, 'tool', 'tools', { entry, before: 'notes' });
  assert.deepStrictEqual(ids(next, 'tools'), ['tool', 'notes']);
  const withOverride = E.moveApp(base, 'intellij', 'tools', { entry: 'intellij', override: { launch: { exe: 'C:\\idea64.exe' } } });
  assert.deepStrictEqual(withOverride.apps.intellij, { launch: { exe: 'C:\\idea64.exe' } });
  assert.deepStrictEqual(E.moveApp(withOverride, 'intellij', 'chat').apps.intellij, { launch: { exe: 'C:\\idea64.exe' } }, 'moving it again leaves the override');
});

test('reorderApp: up and down inside a group, stopping at the edges', () => {
  assert.deepStrictEqual(ids(E.reorderApp(base, 'pinger', -1), 'chat'), ['pinger', 'chatter', 'meetly']);
  assert.deepStrictEqual(ids(E.reorderApp(base, 'pinger', 1), 'chat'), ['chatter', 'meetly', 'pinger']);
  assert.strictEqual(E.reorderApp(base, 'chatter', -1), base);
  assert.strictEqual(E.reorderApp(base, 'meetly', 1), base);
  assert.strictEqual(E.reorderApp(base, 'ghost', 1), base);
});

test('groups: create, rename, delete, reorder', () => {
  const made = E.createGroup(base, '  IDE  ');
  assert.deepStrictEqual(made.groups.at(-1), { id: 'ide', name: 'IDE', apps: [] });
  assert.strictEqual(E.groupId(made, 'IDE'), 'ide-2', 'ids stay unique');
  assert.strictEqual(E.createGroup(made, 'IDE').groups.at(-1).id, 'ide-2');
  assert.strictEqual(E.groupId(base, '!!!'), 'group');
  assert.throws(() => E.createGroup(base, '   '), /needs a name/);
  assert.throws(() => E.createGroup(base, 'Other'), /reserved/);
  assert.strictEqual(E.createGroup(base, 'New').groups.at(-1).id, 'new-2', '"new" is the drop zone\'s id, never a group\'s');
  assert.deepStrictEqual(schema.validate(E.createGroup(base, 'New'), 'windows'), []);
  assert.strictEqual(E.findGroupByName(base, 'browsers').id, 'browsers');
  assert.strictEqual(E.findGroupByName(base, 'nope'), null);

  assert.strictEqual(E.renameGroup(base, 'tools', 'Dev').groups[1].name, 'Dev');
  assert.strictEqual(E.renameGroup(base, 'tools', 'Dev').groups[1].id, 'tools', 'the id does not change');
  assert.strictEqual(E.renameGroup(base, 'tools', 'Tools'), base);
  assert.throws(() => E.renameGroup(base, 'tools', ''), /needs a name/);

  const gone = E.deleteGroup(base, 'chat');
  assert.deepStrictEqual(gone.groups.map((g) => g.id), ['tools', 'browsers']);
  assert.throws(() => E.deleteGroup(base, 'nope'), /No group/);

  assert.deepStrictEqual(E.reorderGroup(base, 'browsers', { before: 'chat' }).groups.map((g) => g.id), ['browsers', 'chat', 'tools']);
  assert.deepStrictEqual(E.reorderGroup(base, 'chat', { before: null }).groups.map((g) => g.id), ['tools', 'browsers', 'chat']);
  assert.deepStrictEqual(E.reorderGroup(base, 'tools', { delta: 1 }).groups.map((g) => g.id), ['chat', 'browsers', 'tools']);
  assert.strictEqual(E.reorderGroup(base, 'chat', { delta: -1 }), base);
  assert.strictEqual(E.reorderGroup(base, 'chat', { before: 'tools' }), base);
});

test('canDrag: open apps always, closed apps only inside a group, never the music app', () => {
  assert.ok(E.canDrag({ running: true, inGroup: false }), 'open app in Other');
  assert.ok(E.canDrag({ running: true, inGroup: true }));
  assert.ok(E.canDrag({ running: false, inGroup: true }), 'closed app in a group');
  assert.ok(!E.canDrag({ running: false, inGroup: false }), 'closed and ungrouped');
  assert.ok(!E.canDrag({ running: true, inGroup: false, isMusic: true }));
});

test('entryFromWindow: a catalog app becomes its catalog id, with a launch filled in when the catalog has none', () => {
  const r = E.entryFromWindow(idea, { catalog: WIN, installed: [], platform: 'windows' });
  assert.strictEqual(r.id, 'intellij');
  assert.strictEqual(r.entry, 'intellij');
  assert.strictEqual(r.category, 'IDE');
  assert.deepStrictEqual(r.override, { launch: { exe: idea.exePath } }, 'no Start-menu match: fall back to the exe path');

  const viaMenu = E.entryFromWindow(idea, { catalog: WIN, platform: 'windows', installed: [
    { name: 'IntelliJ IDEA 2024.2', launch: { appId: 'C:\\idea64.exe' } }, { name: 'Notepad', launch: { appId: 'np' } },
  ] });
  assert.deepStrictEqual(viaMenu.override, { launch: { appId: 'C:\\idea64.exe' } });

  const chrome = E.entryFromWindow({ id: 'other:chrome.exe', name: 'Chrome', exePath: 'C:\\c\\chrome.exe', title: 'x' }, { catalog: WIN, platform: 'windows' });
  assert.deepStrictEqual([chrome.entry, chrome.override, chrome.category], ['chrome', undefined, 'Browsers'], 'the catalog already knows how to launch Chrome');
});

test('entryFromWindow: an app the catalog does not know gets an inline entry, launched by AUMID when the Start menu has it', () => {
  const info = { id: 'other:vaulty.exe', name: 'Vaulty', exePath: 'C:\\v\\vaulty.exe', title: 'Vault - Vaulty', running: true };
  const plain = E.entryFromWindow(info, { catalog: WIN, installed: [], platform: 'windows' });
  assert.deepStrictEqual(plain.entry, { id: 'vaulty', name: 'Vaulty', match: { exe: 'vaulty.exe' }, launch: { exe: 'C:\\v\\vaulty.exe' } });
  assert.strictEqual(plain.category, '', 'unknown apps get an empty name field');
  assert.strictEqual(plain.note, undefined);

  const menu = [{ name: 'Vaulty', launch: { appId: 'Vendor.Vaulty!App' } }, { name: 'Other Thing', launch: { appId: 'x' } }];
  assert.deepStrictEqual(E.entryFromWindow(info, { catalog: WIN, installed: menu, platform: 'windows' }).entry.launch, { appId: 'Vendor.Vaulty!App' });

  const twice = [{ name: 'Vaulty Pro', launch: { appId: 'a' } }, { name: 'Vaulty Lite', launch: { appId: 'b' } }];
  assert.deepStrictEqual(E.entryFromWindow(info, { catalog: WIN, installed: twice, platform: 'windows' }).entry.launch, { exe: 'C:\\v\\vaulty.exe' }, 'ambiguous: do not guess');

  const taken = E.entryFromWindow(info, { catalog: WIN, platform: 'windows', taken: new Set(['vaulty', 'vaulty-2']) });
  assert.strictEqual(taken.id, 'vaulty-3');
  assert.strictEqual(taken.entry.id, 'vaulty-3');
});

test('entryFromWindow: generic hosts get a title matcher, so they do not catch every app on that host', () => {
  for (const exe of ['pythonw.exe', 'java.exe', 'javaw.exe', 'electron.exe', 'node.exe']) assert.ok(E.isGenericHost(exe), exe);
  assert.ok(!E.isGenericHost('idea64.exe'));
  const info = { id: 'other:pythonw.exe', name: 'Pythonw', exePath: 'C:\\Python\\pythonw.exe', title: 'my (tool) v1.2', running: true };
  const r = E.entryFromWindow(info, { catalog: WIN, installed: [], platform: 'windows' });
  assert.strictEqual(r.note, 'matching by window title');
  assert.deepStrictEqual(r.entry.match, { exe: 'pythonw.exe', title: '^my \\(tool\\) v1\\.2$' }, 'regex characters are escaped, and the title is anchored');
  assert.strictEqual(r.entry.name, 'my (tool) v1.2');
  assert.strictEqual(r.entry.launch, undefined, 'launching bare pythonw is useless');
  assert.match(r.id, /^pythonw-my-tool-v1-2/);

  // End to end: the model sends only the matching window to the new app.
  const moved = E.moveApp(base, r.id, 'tools', { entry: r.entry });
  assert.deepStrictEqual(schema.validate(moved, 'windows'), []);
  const rc = catalog.resolveConfig(moved, null, 'windows');
  const w = (hwnd, title) => ({ hwnd, exe: 'pythonw.exe', exePath: info.exePath, title, minimized: false });
  const model = buildModel([w(1, 'my (tool) v1.2'), w(2, 'notes'), w(3, 'something else'), w(4, 'old my (tool) v1.2 copy')], rc);
  const app = (id) => model.groups.flatMap((g) => g.apps).find((a) => a.id === id);
  assert.deepStrictEqual(app(r.id).windows.map((x) => x.hwnd), [1], 'only the exact title, not one that contains it');
  assert.deepStrictEqual(app('notes').windows.map((x) => x.hwnd), [2], 'the existing title-matched app is untouched');
  assert.deepStrictEqual(model.groups.find((g) => g.id === 'other').apps.map((a) => a.windows.map((x) => x.hwnd)), [[3, 4]], 'the rest stay in Other');
});

test('entryFromWindow: macOS matches by bundle id', () => {
  const mac = catalog.load('mac');
  const known = E.entryFromWindow({ id: 'other:x', name: 'IntelliJ IDEA', exePath: '/Applications/IntelliJ IDEA.app', bundleId: 'com.jetbrains.intellij', title: 't' }, { catalog: mac, platform: 'mac' });
  assert.deepStrictEqual([known.entry, known.override, known.category], ['intellij', undefined, 'IDE']);
  const unknown = E.entryFromWindow({ id: 'other:y', name: 'Thing', exePath: '/Applications/Thing.app', bundleId: 'com.acme.Thing', title: 't' }, { catalog: mac, platform: 'mac' });
  assert.deepStrictEqual(unknown.entry.match, { bundleId: 'com.acme.Thing' });
  assert.deepStrictEqual(unknown.entry.launch, { bundleId: 'com.acme.Thing' });
});

test('categoryFor pre-fills the new group name from the catalog', () => {
  const cat = (exe) => E.categoryFor({ exePath: `C:\\x\\${exe}` }, WIN);
  assert.strictEqual(cat('idea64.exe'), 'IDE');
  assert.strictEqual(cat('code.exe'), 'IDE');
  assert.strictEqual(cat('cursor.exe'), 'IDE');
  assert.strictEqual(cat('Discord.exe'), 'Social');
  assert.strictEqual(cat('slack.exe'), 'Social');
  assert.strictEqual(cat('chrome.exe'), 'Browsers');
  assert.strictEqual(cat('arc.exe'), 'Browsers');
  assert.strictEqual(cat('unknown.exe'), '');
  for (const c of [...WIN, ...catalog.load('mac')]) assert.ok(c.category, `${c.id} has a category`);
});

test('every edit produces a config the validator accepts', () => {
  const r = E.entryFromWindow(idea, { catalog: WIN, installed: [], platform: 'windows' });
  let c = E.createGroup(base, 'IDE');
  c = E.moveApp(c, r.id, 'ide', { entry: r.entry, override: r.override });
  c = E.moveApp(c, 'webby', 'ide', { index: 0 });
  c = E.reorderApp(c, 'webby', 1);
  c = E.reorderGroup(c, 'ide', { before: 'chat' });
  assert.deepStrictEqual(schema.validate(c, 'windows'), []);
  assert.deepStrictEqual(ids(c, 'ide'), ['intellij', 'webby']);
  const rc = catalog.resolveConfig(c, null, 'windows');
  assert.deepStrictEqual(rc.groups[0].apps[0].launch, { exe: idea.exePath }, 'IntelliJ launches from the override');
});

test('history: undo restores exactly, redo re-applies, a new edit clears redo', () => {
  const h = new E.History();
  assert.ok(!h.canUndo && !h.canRedo);
  assert.strictEqual(h.undo(base), null);
  assert.strictEqual(h.redo(base), null);

  const a = E.moveApp(base, 'webby', 'chat');
  h.record('webby → Chat', base);
  const b = E.createGroup(a, 'Work');
  h.record('new group', a);
  assert.ok(h.canUndo && !h.canRedo);

  const u1 = h.undo(b);
  assert.strictEqual(u1.label, 'new group');
  assert.deepStrictEqual(E.restore(b, u1.snap).groups, a.groups, 'exactly the config from before the edit');
  assert.ok(h.canRedo);
  const u2 = h.undo(a);
  assert.deepStrictEqual(E.restore(a, u2.snap).groups, base.groups);
  assert.ok(!h.canUndo);

  const r1 = h.redo(base);
  assert.strictEqual(r1.label, 'webby → Chat');
  assert.deepStrictEqual(E.restore(base, r1.snap).groups, a.groups, 'redo re-applies the edit');
  const r2 = h.redo(a);
  assert.deepStrictEqual(E.restore(a, r2.snap).groups, b.groups);

  h.undo(b); // back to a, with one redo waiting
  assert.ok(h.canRedo);
  h.record('something else', a);
  assert.ok(!h.canRedo, 'a new edit clears redo');
});

test('history: undo only touches groups and app overrides, and keeps 50 steps', () => {
  const live = { ...base, panels: { socials: true, music: false, display: 'primary' } };
  const h = new E.History();
  h.record('x', base); // snapshot taken while panels.socials was false-ish
  const e = h.undo(live);
  const back = E.restore(live, e.snap);
  assert.strictEqual(back.panels.socials, true, 'settings changed since then are not rolled back');

  const small = new E.History(3);
  for (let i = 0; i < 5; i++) small.record(`edit ${i}`, base);
  assert.strictEqual(small.undos.length, 3);
  assert.strictEqual(small.peekUndo().label, 'edit 4');
  assert.strictEqual(new E.History().limit, 50);
  const big = new E.History();
  for (let i = 0; i < 60; i++) big.record(`edit ${i}`, base);
  assert.strictEqual(big.undos.length, 50);
  assert.strictEqual(big.undos[0].label, 'edit 10', 'the oldest steps fall off');
});

test('history: snapshots are copies, so later changes to the live config cannot corrupt them', () => {
  const live = JSON.parse(JSON.stringify(base));
  const h = new E.History();
  h.record('x', live);
  live.groups[0].apps.length = 0; // something edits the config in place afterwards
  const e = h.undo(live);
  assert.strictEqual(e.snap.groups[0].apps.length, 3);
});

// ---- The feature glue (src/features/edits.js) with a fake ctx ---------------------------------

const { EventEmitter } = require('events');
const music = require('../src/music/index');

function fakeCtx({ save, withMusic } = {}) {
  delete require.cache[require.resolve('../src/features/edits')]; // fresh history per test
  const feature = require('../src/features/edits');
  const log = { sent: [], saved: [], calls: [] };
  const ipcMain = new EventEmitter();
  const win = { visible: true, focused: true };
  const overlay = Object.assign(new EventEmitter(), {
    webContents: { send: (c, p) => log.sent.push([c, p]) },
    isVisible: () => win.visible, isFocused: () => win.focused,
  });
  const provider = withMusic ? music.get('spotify', { mediaKey() {} }) : null;
  const ctx = {
    config: JSON.parse(JSON.stringify(base)), ipcMain, overlay, schema, log: () => {},
    catalog: { platform: 'windows', load: () => WIN },
    adapter: { listInstalledApps: async () => [] },
    saveConfig: () => { if (save) return save(); log.saved.push(JSON.stringify(ctx.config.groups)); return true; },
    push: () => log.calls.push('push'), relayout: () => log.calls.push('relayout'),
    setHoldOpen: (on) => log.calls.push(`hold:${on}`), pausePush: (on) => log.calls.push(`pause:${on}`),
    runtime: () => catalog.resolveConfig(ctx.config, provider, 'windows'),
    hideOverlay: () => { log.calls.push('hide'); if (win.visible) { win.visible = false; overlay.emit('hide'); } },
  };
  feature.register(ctx);
  const settle = () => new Promise((r) => setImmediate(r));
  const send = async (channel, payload) => { ipcMain.emit(channel, {}, payload); await settle(); await settle(); };
  const done = () => log.sent.filter(([c]) => c === 'edits:done').map(([, p]) => p);
  return { ctx, log, send, done, feature, win };
}

test('feature: a drag holds the tray open and pauses the 1s push, then flushes it', async () => {
  const { send, log } = fakeCtx();
  await send('drag-start', idea);
  assert.deepStrictEqual(log.calls, ['hold:true', 'pause:true']);
  assert.deepStrictEqual(log.sent.at(-1), ['edits:info', { id: idea.id, category: 'IDE' }], 'the catalog category pre-fills the name');
  await send('move-app', { app: idea, to: 'tools', before: 'notes' });
  await send('drag-end');
  assert.deepStrictEqual(log.calls.slice(-2), ['hold:false', 'pause:false']);
  assert.ok(log.calls.indexOf('relayout') > 1 && log.calls.indexOf('pause:false') > log.calls.indexOf('relayout'), 'edit applied before the push resumes');
});

test('feature: dropping an open app into a group saves it right away and offers undo', async () => {
  const { ctx, send, log, done } = fakeCtx();
  await send('move-app', { app: idea, to: 'tools', before: 'notes' });
  assert.deepStrictEqual(ctx.config.groups.find((g) => g.id === 'tools').apps.map(catalog.entryId), ['intellij', 'notes']);
  assert.deepStrictEqual(ctx.config.apps.intellij, { launch: { exe: idea.exePath } });
  assert.strictEqual(log.saved.length, 1);
  assert.deepStrictEqual(done().at(-1), { kind: 'edit', text: 'Idea64 → Tools', note: undefined, canUndo: true, canRedo: false });
});

test('feature: new group takes the typed name, reuses a group with that name, and is one undo step', async () => {
  const { ctx, send, done } = fakeCtx();
  await send('move-app', { app: idea, newGroup: 'IDE' });
  assert.deepStrictEqual(ctx.config.groups.at(-1), { id: 'ide', name: 'IDE', apps: ['intellij'] });
  assert.strictEqual(done().at(-1).text, 'Idea64 → IDE (new group)');
  await send('undo');
  assert.ok(!ctx.config.groups.some((g) => g.id === 'ide'), 'the group and the move are undone together');
  assert.ok(!ctx.config.apps.intellij);
  assert.strictEqual(done().at(-1).text, 'Undid: Idea64 → IDE (new group)');
  await send('redo');
  assert.deepStrictEqual(ctx.config.groups.at(-1).apps, ['intellij']);

  await send('move-app', { app: { ...idea, id: 'other:code.exe', exePath: 'C:\\c\\code.exe', name: 'Code' }, newGroup: 'ide' });
  assert.deepStrictEqual(ctx.config.groups.filter((g) => g.name.toLowerCase() === 'ide').length, 1, 'same name = same group');
  assert.deepStrictEqual(ctx.config.groups.at(-1).apps, ['intellij', 'vscode']);
});

test('feature: undo and redo walk the stack, and a new edit clears redo', async () => {
  const { ctx, send, done } = fakeCtx();
  await send('move-app', { app: { id: 'webby', name: 'Webby', running: true, exePath: 'x' }, to: 'chat', before: null });
  await send('move-app', { app: { id: 'surfer', name: 'Surfer', running: false }, to: 'chat', before: null });
  assert.deepStrictEqual(ids(ctx.config, 'chat').slice(-2), ['webby', 'surfer']);
  await send('undo');
  await send('undo');
  assert.deepStrictEqual(ctx.config.groups, base.groups, 'back to the start, exactly');
  assert.strictEqual(done().at(-1).canUndo, false);
  await send('undo');
  assert.strictEqual(done().at(-1).text, 'Nothing to undo');
  await send('redo');
  assert.deepStrictEqual(ids(ctx.config, 'chat').at(-1), 'webby');
  await send('move-app', { app: { id: 'surfer', name: 'Surfer', running: false }, to: 'tools', before: null });
  await send('redo');
  assert.strictEqual(done().at(-1).text, 'Nothing to redo', 'the new edit cleared redo');
});

test('feature: a failed save puts everything back and says so', async () => {
  const { ctx, send, done, log } = fakeCtx({ save: () => { throw new Error('EACCES'); } });
  await send('move-app', { app: { id: 'webby', name: 'Webby', running: true }, to: 'chat', before: null });
  assert.deepStrictEqual(ctx.config.groups, base.groups, 'the UI and the file agree: nothing changed');
  assert.strictEqual(done().at(-1).kind, 'error');
  assert.match(done().at(-1).text, /EACCES/);
  await send('undo');
  assert.strictEqual(done().at(-1).text, 'Nothing to undo', 'a failed edit leaves no history');
  assert.ok(!log.calls.includes('relayout'));

  const refused = fakeCtx({ save: () => false }); // main.js refuses to overwrite a config that failed to load
  await refused.send('move-app', { app: { id: 'webby', name: 'Webby', running: true }, to: 'chat', before: null });
  assert.deepStrictEqual(refused.ctx.config.groups, base.groups);
  assert.strictEqual(refused.done().at(-1).kind, 'error');
});

test('feature: the music app and closed ungrouped apps cannot be dropped into groups', async () => {
  const { ctx, send, done } = fakeCtx({ withMusic: true });
  await send('move-app', { app: { id: 'tunes', name: 'Tunes', running: true, exePath: 'x' }, to: 'chat' });
  assert.deepStrictEqual(ctx.config.groups, base.groups);
  assert.match(done().at(-1).text, /music strip/);
  const before = done().length;
  await send('move-app', { app: { id: 'other:ghost.exe', name: 'Ghost', running: false }, to: 'chat' });
  assert.deepStrictEqual(ctx.config.groups, base.groups);
  assert.strictEqual(done().length, before, 'silently ignored');
});

test('feature: group edits (rename, reorder) share the same history', async () => {
  const { ctx, send, done } = fakeCtx();
  await send('rename-group', { id: 'tools', name: 'Dev' });
  assert.strictEqual(done().at(-1).text, 'Renamed Tools → Dev');
  await send('reorder-group', { id: 'browsers', before: 'chat' });
  assert.deepStrictEqual(ctx.config.groups.map((g) => g.id), ['browsers', 'chat', 'tools']);
  await send('rename-group', { id: 'chat', name: '  ' });
  assert.strictEqual(done().at(-1).kind, 'error');
  await send('undo');
  await send('undo');
  assert.deepStrictEqual(ctx.config.groups, base.groups);
});

test('feature: generic host drop adds a title matcher and says so', async () => {
  const { ctx, send, done } = fakeCtx();
  const py = { id: 'other:pythonw.exe', name: 'Pythonw', exePath: 'C:\\Py\\pythonw.exe', title: 'sorter', running: true };
  await send('move-app', { app: py, to: 'tools' });
  const entry = ctx.config.groups.find((g) => g.id === 'tools').apps.at(-1);
  assert.deepStrictEqual(entry.match, { exe: 'pythonw.exe', title: '^sorter$' });
  assert.strictEqual(done().at(-1).note, 'matching by window title');
});

test('feature: naming a new group after focus went elsewhere hides the tray when the drag ends', async () => {
  const { send, log, win } = fakeCtx();
  await send('drag-start', idea);
  await send('drag-end');
  assert.ok(!log.calls.includes('hide'), 'a normal drop keeps the focused tray open');

  await send('drag-start', idea);
  win.focused = false; // the name field lost focus to another window; the held-open tray ignored the blur
  await send('drag-end');
  assert.deepStrictEqual(log.calls.slice(-3), ['hold:false', 'pause:false', 'hide']);
  assert.strictEqual(win.visible, false);
});

test('feature: replacing the config (Settings saved, Reload config) clears undo and redo', async () => {
  const { ctx, send, done, feature } = fakeCtx();
  await send('move-app', { app: { id: 'webby', name: 'Webby', running: true, exePath: 'x' }, to: 'chat', before: null });
  assert.strictEqual(done().at(-1).canUndo, true);
  ctx.config = JSON.parse(JSON.stringify(base)); // what setup's save / loadConfig do
  await send('undo');
  assert.strictEqual(done().at(-1).text, 'Nothing to undo', 'Ctrl+Z cannot bring back the pre-Settings groups');
  assert.deepStrictEqual(ctx.config.groups, base.groups);

  await send('move-app', { app: { id: 'webby', name: 'Webby', running: true, exePath: 'x' }, to: 'chat', before: null });
  await send('undo');
  assert.strictEqual(done().at(-1).canRedo, true);
  feature.clearHistory(); // main.js applyConfig()
  await send('redo');
  assert.strictEqual(done().at(-1).text, 'Nothing to redo');
});

test('feature: a drag that never ends is released when the tray hides', async () => {
  const { ctx, send, log } = fakeCtx();
  await send('drag-start', idea);
  ctx.overlay.emit('hide');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(log.calls.slice(-2), ['hold:false', 'pause:false']);
});
