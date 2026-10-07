const assert = require('assert');
const fs = require('fs');
const path = require('path');
const schema = require('../src/config/schema');

// A FAKE v1 config with the same shape as a real hand-written one: inline apps, socialGroup,
// panels.spotify, voice: true, replaceAltTab, startWithWindows, legacy hotkey, socialMode.
const v1 = {
  hotkey: 'Alt+`',
  socialMode: 'dnd',
  socialGroup: 'social',
  groups: [
    { id: 'social', name: 'Social', apps: [
      { id: 'chatter', name: 'Chatter', match: { exe: 'chatter.exe' }, launch: { appId: 'Example.Chatter' }, badgeOffset: 1 },
      { id: 'meetly', name: 'Meetly', match: { exe: 'meetly.exe' }, launch: { appId: 'Example.Meetly!App', uri: 'meetly:/home?org=example' } },
    ] },
    { id: 'tools', name: 'Tools', apps: [
      { id: 'notes', name: 'notes', match: { exe: 'pythonw.exe', title: '^notes$' }, launch: { exe: '%USERPROFILE%/tools/notes.exe' } },
    ] },
  ],
  music: { id: 'tunes', name: 'Tunes', match: { exe: 'tunes.exe' }, launch: { appId: 'Example.Tunes!App' }, tint: '#1DB954' },
  replaceAltTab: true,
  startWithWindows: true,
  voice: true,
  panels: { socials: true, spotify: true },
};

const text = JSON.stringify(v1);
const { config: c, migrated, errors } = schema.load(`﻿${text}`, 'windows'); // BOM tolerated
assert.equal(migrated, true);
assert.deepStrictEqual(errors, []);
assert.equal(c.version, 2);
assert.equal(c.setupComplete, true, 'migrated configs skip first-run setup');
assert.deepStrictEqual(c.keys, { switch: 'Alt+Tab', search: 'Alt+`', musicPrev: 'Alt+[', musicPlay: 'Alt+\\', musicNext: 'Alt+]', takeOverSystemSwitcher: true });
assert.equal(c.startAtLogin, true);
assert.equal(c.socialMode, 'dnd');
assert.deepStrictEqual(c.panels, { socials: true, music: true, display: 'focus' }, 'v1 never had a display choice: the default');
assert.equal(c.groups[0].pingGroup, true, 'socialGroup -> pingGroup on that group');
assert.equal(c.groups[1].pingGroup, undefined);
assert.deepStrictEqual(c.groups[0].apps, v1.groups[0].apps, 'inline apps kept as-is');
assert.deepStrictEqual(c.music, { provider: 'spotify', ...v1.music });
assert.deepStrictEqual(c.voice, {
  enabled: true, engine: 'builtin', wakeWord: 'cubby',
  commands: { openAll: ['start'], killAll: ['kill force'] },
  thresholds: { wake: 0.6, openAll: 0.75, killAll: 0.8 },
});
for (const k of ['replaceAltTab', 'startWithWindows', 'socialGroup', 'hotkey']) assert.ok(!(k in c), `${k} removed`);
assert.ok(!('spotify' in c.panels));

// Re-loading the migrated file is a no-op.
const again = schema.load(JSON.stringify(c), 'windows');
assert.equal(again.migrated, false);
assert.equal(again.upgraded, false);
assert.deepStrictEqual(again.config, c);

// v1 variants: off switches, old "visible" social mode, no panels, missing voice = on (as v1 ran it).
const off = schema.load(JSON.stringify({ ...v1, replaceAltTab: false, startWithWindows: false, voice: false, socialMode: 'visible', panels: undefined }), 'windows').config;
assert.equal(off.keys.takeOverSystemSwitcher, false);
assert.equal(off.startAtLogin, false);
assert.equal(off.voice.enabled, false);
assert.equal(off.socialMode, 'ping');
assert.deepStrictEqual(off.panels, { socials: true, music: false, display: 'focus' }, '"visible" meant the socials strip');
const { voice, ...noVoice } = v1;
assert.equal(schema.load(JSON.stringify(noVoice), 'windows').config.voice.enabled, true);

// The starter config is valid on both platforms.
const starterText = fs.readFileSync(path.join(__dirname, '../src/default-config.json'), 'utf8');
for (const p of ['windows', 'mac']) {
  const s = schema.load(starterText, p);
  assert.deepStrictEqual(s.errors, [], `starter valid on ${p}`);
  assert.equal(s.migrated, false);
  assert.equal(s.config.setupComplete, false);
  assert.equal(s.config.voice.enabled, false);
}
assert.equal(schema.load(starterText, 'windows').config.panels.display, 'focus', 'new configs follow the focused window');
assert.equal(schema.DEFAULTS.panels.display, 'focus');
assert.ok(JSON.parse(starterText).groups.every((g) => g.apps.every((a) => typeof a === 'string')), 'starter uses catalog ids only');

// Validation: clear messages, never silently "fixed".
const bad = (patch) => schema.load(JSON.stringify({ ...JSON.parse(starterText), ...patch }), 'windows').errors;
assert.match(bad({ keys: { search: 'Alt+[' } }).join(), /keys\.search and keys\.musicPrev are both/);
assert.match(bad({ keys: { search: 'Alt+~', switch: 'Alt+`' } }).join(), /keys\.switch and keys\.search/, '~ and ` are the same key');
assert.match(bad({ keys: { search: 'Q' } }).join(), /keys\.search: "Q" isn't a key combo/);
assert.deepStrictEqual(bad({ keys: { musicPrev: '', musicPlay: null } }), [], 'empty = off');
assert.match(bad({ groups: [{ id: 'g', name: 'G', apps: ['no-such-app'] }] }).join(), /unknown app "no-such-app"/);
assert.match(bad({ groups: [{ id: 'g', name: 'G', apps: [{ id: 'x', name: 'X' }] }] }).join(), /needs "id", "name" and "match"/);
assert.match(bad({ groups: [{ id: 'a', name: 'A', apps: ['discord'] }, { id: 'b', name: 'B', apps: ['discord'] }] }).join(), /in two groups/);
assert.match(bad({ music: { provider: 'winamp' } }).join(), /music\.provider/);
assert.match(bad({ voice: { thresholds: { wake: 2 } } }).join(), /voice\.thresholds\.wake/);
assert.match(bad({ socialMode: 'loud' }).join(), /socialMode/);
assert.match(schema.load('{"version": 3}').errors.join(), /newer Cubby/);
// Reserved group ids: the tray's own Other / music / "+ New group" columns.
for (const id of ['other', 'music', 'new', 'New']) assert.match(bad({ groups: [{ id, name: 'X', apps: [] }] }).join(), /is reserved/, id);
// Voice commands need at least one phrase.
assert.match(bad({ voice: { commands: { openAll: [] } } }).join(), /voice\.commands\.openAll must be a list of at least one phrase/);
assert.match(bad({ voice: { commands: { killAll: ['  '] } } }).join(), /voice\.commands\.killAll/);
// A title pattern that doesn't compile is a clear error, not a crash later in the model.
const badTitle = bad({ groups: [{ id: 'g', name: 'G', apps: [{ id: 'x', name: 'X', match: { exe: 'x.exe', title: 'a(b' } }] }] });
assert.match(badTitle.join(), /app "x": match\.title "a\(b" isn't a valid pattern/);
assert.match(bad({ apps: { x: { match: { exe: 'x.exe', title: '[' } } } }).join(), /apps\.x: match\.title/);
assert.deepStrictEqual(bad({ groups: [{ id: 'g', name: 'G', apps: [{ id: 'x', name: 'X', match: { exe: 'x.exe', title: '^a \\(b\\)$' } }] }] }), []);
// No "version" but v2-only fields ("keys", pingGroup): a hand-written v2 file, not a v1 to migrate.
const handV2 = { keys: { search: 'Alt+Q' }, startAtLogin: false, groups: [{ id: 'chat', name: 'Chat', pingGroup: true, apps: ['discord'] }] };
for (const raw of [handV2, { groups: handV2.groups }, { keys: handV2.keys }]) {
  const r = schema.load(JSON.stringify(raw), 'windows');
  assert.equal(r.migrated, false, JSON.stringify(raw));
  assert.deepStrictEqual(r.errors, []);
  assert.equal(r.config.version, 2);
}
const v2 = schema.load(JSON.stringify(handV2), 'windows').config;
assert.equal(v2.keys.search, 'Alt+Q', 'keys kept, not replaced by v1 defaults');
assert.equal(v2.startAtLogin, false);
assert.equal(v2.groups[0].pingGroup, true);
assert.equal(v2.setupComplete, false);
assert.equal(schema.load(JSON.stringify({ groups: [] }), 'windows').migrated, true, 'still v1 without v2 fields');
assert.throws(() => schema.load('{ "groups": [ }'), SyntaxError);

// One-time: a v2 file with display 'primary' that nobody chose (it was the old default) -> 'focus'.
const oldDefault = { ...JSON.parse(starterText), setupComplete: true, panels: { socials: true, music: true, display: 'primary' } };
const up = schema.load(JSON.stringify(oldDefault), 'windows');
assert.equal(up.upgraded, true);
assert.equal(up.migrated, false, 'not a v1 migration: no v1 backup');
assert.deepStrictEqual(up.errors, []);
assert.deepStrictEqual(up.config.panels, { socials: true, music: true, display: 'focus', displayChosen: false });
// Saved and loaded again: done, nothing changes.
const up2 = schema.load(JSON.stringify(up.config), 'windows');
assert.equal(up2.upgraded, false);
assert.deepStrictEqual(up2.config, up.config);
// The user later picks 'primary' (Settings saves displayChosen: true), or types it in by hand after
// the step ran (displayChosen: false): kept either way.
for (const displayChosen of [true, false]) {
  const kept = schema.load(JSON.stringify({ ...oldDefault, panels: { ...oldDefault.panels, displayChosen } }), 'windows');
  assert.equal(kept.upgraded, false);
  assert.equal(kept.config.panels.display, 'primary', `displayChosen: ${displayChosen}`);
}
// Other choices are never touched; a file with no display at all just gets the default.
for (const display of ['mouse', 'PHL27E1N5900R', '4160558590', 'focus']) {
  const r = schema.load(JSON.stringify({ ...oldDefault, panels: { display } }), 'windows');
  assert.equal(r.upgraded, false, display);
  assert.equal(r.config.panels.display, display);
}
assert.equal(schema.load(JSON.stringify({ ...oldDefault, panels: { socials: true } }), 'windows').config.panels.display, 'focus');

assert.equal(schema.keyLabel('Alt+`', 'win32'), 'Alt+~');
assert.equal(schema.keyLabel('Alt+\\', 'win32'), 'Alt+\\');
assert.equal(schema.keyLabel('Alt+`', 'darwin'), 'Option+~');
assert.equal(schema.keyLabel('Cmd+Tab', 'darwin'), 'Cmd+Tab');
assert.equal(schema.keyLabel('Win+\\', 'darwin'), 'Cmd+\\');
console.log('schema ok');
