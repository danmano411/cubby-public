const assert = require('assert');
const catalog = require('../src/config/catalog');
const music = require('../src/music/index');
const system = require('../src/music/system-windows');

const CATEGORIES = new Set(['Social', 'Browsers', 'IDE', 'Notes', 'Music', 'Utilities']);
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

for (const platform of ['windows', 'mac']) {
  const entries = catalog.load(platform);
  const key = platform === 'mac' ? 'bundleId' : 'exe';
  const ids = entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `${platform}: catalog ids are unique`);
  assert.ok(entries.length >= 20, `${platform}: a useful catalog (${entries.length} apps)`);

  for (const e of entries) {
    const who = `${platform}/${e.id}`;
    assert.match(e.id, ID, `${who}: id is lowercase words`);
    assert.ok(e.name, `${who}: has a name`);
    assert.ok(CATEGORIES.has(e.category), `${who}: category "${e.category}" is one of ${[...CATEGORIES]}`);
    assert.ok(e.match?.[key], `${who}: match.${key}`);
    if (e.launch) assert.ok(Object.values(e.launch).every((v) => typeof v === 'string' && v), `${who}: launch values are non-empty strings`);
    else assert.ok(e.note, `${who}: an app without a launch explains why in "note"`);
    if (e.tint) assert.match(e.tint, /^#[0-9a-f]{6}$/i, `${who}: tint is a hex colour`);
  }

  const matchKeys = entries.map((e) => `${key}:${e.match[key].toLowerCase()}`);
  assert.equal(new Set(matchKeys).size, matchKeys.length, `${platform}: no two apps match the same ${key}`);

  // Every category is used, so new-group name suggestions can draw on each.
  for (const c of CATEGORIES) assert.ok(entries.some((e) => e.category === c), `${platform}: category ${c} has apps`);
}

// The apps the plan names are all there, on the platforms that have them.
const win = Object.fromEntries(catalog.load('windows').map((e) => [e.id, e]));
const mac = Object.fromEntries(catalog.load('mac').map((e) => [e.id, e]));
for (const id of ['discord', 'slack', 'teams', 'zoom', 'chrome', 'edge', 'firefox', 'arc', 'brave', 'vscode', 'cursor', 'intellij', 'pycharm',
  'notion', 'notion-calendar', 'obsidian', 'spotify', 'files', 'notepad', 'terminal', 'whatsapp', 'telegram']) {
  assert.ok(win[id], `windows catalog has ${id}`);
  assert.ok(mac[id], `mac catalog has ${id}`);
}
assert.ok(mac.safari && mac['apple-music'] && !win.safari && !win['apple-music'], 'Safari and Apple Music are mac-only');

// Quirks the app depends on.
assert.equal(win.discord.badgeOffset, 1, 'Windows Discord badge text runs one behind its icon');
assert.equal(win.discord.category, 'Social');
assert.equal(win.teams.match.exe, 'ms-teams.exe');
assert.equal(win.intellij.match.exe, 'idea64.exe');
assert.equal(win.spotify.tint, '#1DB954');
assert.equal(win.files.name, 'File Explorer');
assert.equal(mac.files.name, 'Finder');
// Generic shapes only; the real denylist runs in scripts/privacy-check.mjs.
const text = JSON.stringify([win, mac]);
assert.ok(!/tenant|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(text), 'no tenant or account GUIDs in the catalog');
assert.ok(!/users[\\/]+[^%\\/]+[\\/]/i.test(text), 'no user-specific paths in the catalog (use %LOCALAPPDATA% and friends)');

// Entries resolve like any config entry, and overrides still apply (e.g. an IntelliJ with no launch of its own).
const idea = catalog.resolve('intellij', { intellij: { launch: { exe: 'C:/idea64.exe' } } }, 'windows');
assert.deepStrictEqual(idea.launch, { exe: 'C:/idea64.exe' });
assert.equal(catalog.resolve('discord', {}, 'windows').badgeOffset, 1);

// ---- 'system' music provider --------------------------------------------------
assert.ok(music.names('win32').includes('system'), "'system' is a registered provider on Windows");
assert.ok(catalog.get(system({ mediaKey() {} }).appRef, 'windows'), 'its appRef is in the Windows catalog');

assert.equal(system.format({ playing: true, app: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', title: 'Song', artist: 'Artist' }), 'Artist - Song');
assert.equal(system.format({ playing: true, app: 'chrome.exe', title: 'Some video', artist: '' }), 'chrome - Some video', 'no artist: the app stands in');
assert.equal(system.format({ playing: true, app: 'Microsoft.ZuneMusic_8wekyb3d8bbwe!App', title: 'Track', artist: '' }), 'ZuneMusic - Track');
assert.equal(system.format({ playing: false, app: 'chrome.exe', title: 'Paused thing', artist: 'A' }), null, 'paused reads as nothing playing');
assert.equal(system.format({ playing: true, title: '' }), null);
assert.equal(system.format(null), null);

console.log('catalog.test ok');
