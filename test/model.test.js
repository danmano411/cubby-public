const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildModel, titleCount, parseBadge, pingApps, appForWindow, badgeGrew, pingText } = require('../src/model');
const schema = require('../src/config/schema');
const catalog = require('../src/config/catalog');
const music = require('../src/music/index');

const fake = { mediaKey: () => {} };
const spotify = music.get('spotify', fake);
const { config: raw, errors } = schema.load(fs.readFileSync(path.join(__dirname, 'fixtures/config.json'), 'utf8'), 'windows');
assert.deepStrictEqual(errors, [], 'fixture is a valid v2 config');
const config = catalog.resolveConfig(raw, spotify, 'windows');

const w = (hwnd, exe, title) => ({ hwnd, exe, title, exePath: `C:\\x\\${exe}`, minimized: false });
const m = buildModel([
  w(30, 'webby.exe', 'YouTube - Webby'),
  w(10, 'webby.exe', 'Mail - Webby'),
  w(5, 'pythonw.exe', 'notes'),
  w(6, 'pythonw.exe', 'some other tool'),
  w(7, 'chatter.exe', '(3) general - Chatter'),
  w(8, 'spotify.exe', 'Some Artist - Some Song'),
  w(9, 'vaulty.exe', 'Vault - Vaulty'),
], config, { pinger: true });

const app = (id) => m.groups.flatMap((g) => g.apps).find((a) => a.id === id);
assert.deepStrictEqual(app('webby').windows.map((x) => x.hwnd), [10, 30], 'multi-window, stable hwnd order');
assert.equal(app('notes').windows.length, 1, 'matched by exe + title');
assert.equal(app('chatter').unread, 3, 'unread parsed from title');
assert.equal(app('pinger').pinged, true, 'ping flag carried through');
assert.equal(app('pinger').running, false);
assert.equal(app('surfer').running, false, 'closed apps still listed');
const other = m.groups.find((g) => g.id === 'other').apps.map((a) => a.name).sort();
assert.deepStrictEqual(other, ['Pythonw', 'Vaulty'], 'unconfigured windows land in Other');
assert.equal(m.groups.find((g) => g.id === 'chat').ping, true, 'pingGroup flag reaches the model');
assert.deepStrictEqual(pingApps(config).map((a) => a.id), ['chatter', 'pinger', 'meetly']);
assert.equal(spotify.nowPlaying(m.music), 'Some Artist - Some Song', 'spotify provider reads the title');
assert.equal(spotify.nowPlaying({ windows: [{ title: 'Spotify Premium' }] }), null, 'paused');
assert.equal(config.music.tint, '#1DB954');

// Provider 'none': no music app at all.
assert.equal(buildModel([], catalog.resolveConfig(raw, music.get('none', fake), 'windows')).music, null);

// Catalog ids and per-app overrides resolve like inline entries.
const mixed = catalog.resolveConfig({ ...raw, groups: [{ id: 'g', name: 'G', apps: ['discord', 'chrome'] }], apps: { chrome: { name: 'Work Chrome', launch: { uri: 'https://example.com' } } } }, spotify, 'windows');
assert.equal(appForWindow(mixed, w(1, 'discord.exe', 'x')).id, 'discord');
assert.equal(mixed.groups[0].apps[0].badgeOffset, 1, 'catalog quirk applied');
assert.deepStrictEqual(mixed.groups[0].apps[1].launch, { appId: 'Chrome', uri: 'https://example.com' });
assert.equal(mixed.groups[0].apps[1].name, 'Work Chrome');
assert.equal(mixed.music.id, 'tunes', 'inline music entry wins over the provider app');
const fromCatalog = catalog.resolveConfig({ ...raw, music: { provider: 'spotify' } }, spotify, 'windows');
assert.equal(fromCatalog.music.id, 'spotify', 'provider appRef resolves through the catalog');

// mac catalog entries match on bundleId.
const mac = catalog.resolveConfig({ ...raw, groups: [{ id: 'g', name: 'G', apps: ['slack'] }], music: { provider: 'spotify' } }, spotify, 'mac');
assert.equal(appForWindow(mac, { exe: '', bundleId: 'com.tinyspeck.slackmacgap', title: 'x' }).id, 'slack');

assert.equal(titleCount('Inbox (12) - Pinger'), 12);
assert.equal(titleCount('Chat | Personal | Meetly'), 0);
assert.deepStrictEqual(parseBadge('9+ items, status Unknown'), { count: '9+' });
assert.deepStrictEqual(parseBadge('Unread messages'), { dot: true });
assert.equal(parseBadge('No items, status Available'), null);
assert.equal(parseBadge('No Notifications'), null);
assert.deepStrictEqual(parseBadge('2 notifications'), { count: '2' });
const chatterAt = (text) => buildModel([], config, {}, { 'Example.Chatter': text }).groups[0].apps.find((a) => a.id === 'chatter');
assert.equal(chatterAt('3 notifications').unread, '4', 'badgeOffset: text is one behind its icon');
assert.equal(chatterAt('0 notifications').unread, '1', 'first unread');
assert.equal(chatterAt('Unread messages').pinged, true);
assert.equal(chatterAt('No Notifications').pinged, false);
const b = buildModel([w(7, 'chatter.exe', 'general - Chatter')], config, {}, {
  'Example.Chatter': 'Unread messages',
  'Example.Meetly_abc!Meetly': '3 items, status Away',
  'Example.Meetly_abc!Meetly.Work': '9+ items, status Available',
});
const bapp = (id) => b.groups.flatMap((g) => g.apps).find((a) => a.id === id);
assert.equal(bapp('chatter').pinged, true, 'badge without number -> dot');
assert.equal(bapp('meetly').unread, '9+', 'accounts merged, highest count wins');
assert.equal(bapp('pinger').pinged, false);

// Regression: a v1 config (no "version", inline apps, socialGroup, inline music) gives the same
// tray after migration as v1 did. Expected values are what the v1 model produced for these windows.
const v1 = {
  hotkey: 'Alt+`', socialGroup: 'social', voice: true,
  groups: [
    { id: 'social', name: 'Social', apps: [{ id: 'chatter', name: 'Chatter', match: { exe: 'chatter.exe' }, launch: { appId: 'Example.Chatter' }, badgeOffset: 1 }] },
    { id: 'tools', name: 'Tools', apps: [{ id: 'notes', name: 'notes', match: { exe: 'pythonw.exe', title: '^notes$' }, launch: { exe: 'C:/tools/notes.exe' } }] },
  ],
  music: { id: 'tunes', name: 'Tunes', match: { exe: 'tunes.exe' }, launch: { appId: 'Example.Tunes!App' } },
};
const mig = catalog.resolveConfig(schema.load(JSON.stringify(v1), 'windows').config, spotify, 'windows');
const vm = buildModel([w(4, 'tunes.exe', 'A - B'), w(1, 'chatter.exe', 'x - Chatter'), w(2, 'pythonw.exe', 'notes'), w(3, 'pythonw.exe', 'other')], mig, {}, { 'Example.Chatter': '3 notifications' });
const win = (hwnd, title) => ({ hwnd, title, minimized: false });
const row = (id, name, exe, wins, extra = {}) => ({ id, name, other: false, running: wins.length > 0, exePath: `C:\\x\\${exe}`, unread: 0, pinged: false, windows: wins, ...extra });
assert.deepStrictEqual(vm, {
  groups: [
    { id: 'social', name: 'Social', ping: true, apps: [row('chatter', 'Chatter', 'chatter.exe', [win(1, 'x - Chatter')], { unread: '4' })] },
    { id: 'tools', name: 'Tools', ping: false, apps: [row('notes', 'notes', 'pythonw.exe', [win(2, 'notes')])] },
    { id: 'other', name: 'Other', ping: false, apps: [row('other:pythonw.exe', 'Pythonw', 'pythonw.exe', [win(3, 'other')], { other: true })] },
  ],
  music: row('tunes', 'Tunes', 'tunes.exe', [win(4, 'A - B')]),
});
assert.deepStrictEqual(pingApps(mig).map((a) => a.id), ['chatter'], 'socialGroup apps still ping');
assert.equal(spotify.nowPlaying(vm.music), 'A - B');
console.log('model ok');

// badgeGrew: only a badge that appears or grows is a ping.
{
  const c = (n) => ({ count: n });
  const dot = { dot: true };
  assert.equal(badgeGrew(null, c('1')), true);   // appears
  assert.equal(badgeGrew(null, dot), true);
  assert.equal(badgeGrew(c('2'), c('3')), true); // grows
  assert.equal(badgeGrew(c('9'), c('9+')), true);
  assert.equal(badgeGrew(dot, c('1')), true);    // a dot turns into a number
  assert.equal(badgeGrew(c('3'), c('2')), false); // read elsewhere: no ping
  assert.equal(badgeGrew(c('2'), c('2')), false);
  assert.equal(badgeGrew(c('9+'), c('9+')), false);
  assert.equal(badgeGrew(c('2'), dot), false);
  assert.equal(badgeGrew(dot, dot), false);
  assert.equal(badgeGrew(c('2'), null), false);   // cleared
}

// pingText: the ping card says what we know (the count), never the focused window's title.
assert.equal(pingText({ count: '3' }), '3 unread');
assert.equal(pingText({ count: '9+' }), '9+ unread');
assert.equal(pingText({ dot: true }), 'Unread messages');
assert.equal(pingText(null), 'New message');
