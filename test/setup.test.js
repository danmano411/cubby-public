const assert = require('assert');
const { test } = require('node:test');
const { setupBounds, displayOptions, buildCandidates, finishEntries, mergeDraft, exeFromAppId } = require('../src/features/setup');
const { iconTarget } = require('../src/platform/windows/icon-target');
const schema = require('../src/config/schema');
const layout = require('../src/layout');

const disp = (id, label, x, y, width, height, scaleFactor = 1) => ({ id, label, bounds: { x, y, width, height }, workArea: { x, y, width, height }, scaleFactor });
const laptop = disp(2315038148, '', 0, 0, 1536, 960, 2.5);
const external = disp(4160558590, 'PHL27E1N5900R', -2560, -680, 2560, 1440, 1.5);

test('setup window is centered in the work area of either display, integers, inside', () => {
  for (const d of [laptop, external, disp(1, 'tiny', 100, 50, 800, 500)]) {
    const r = setupBounds(d);
    for (const k of ['x', 'y', 'width', 'height']) assert.ok(Number.isInteger(r[k]), `${k} on ${d.id}`);
    assert.ok(r.x >= d.workArea.x && r.y >= d.workArea.y && r.x + r.width <= d.workArea.x + d.workArea.width && r.y + r.height <= d.workArea.y + d.workArea.height, `inside ${d.id}`);
  }
  assert.deepStrictEqual(setupBounds(external), { x: -2560 + 790, y: -680 + 380, width: 980, height: 680 });
  assert.deepStrictEqual(setupBounds(laptop), { x: 278, y: 140, width: 980, height: 680 });
});

test('displayOptions: label when unique, id otherwise, physical pixels, round-trips through pickPanelDisplay', () => {
  const opts = displayOptions([laptop, external], laptop.id);
  assert.deepStrictEqual(opts.map((o) => o.setting), ['2315038148', 'PHL27E1N5900R']); // laptop has no label
  assert.deepStrictEqual(opts.map((o) => [o.width, o.height, o.primary]), [[3840, 2400, true], [3840, 2160, false]]);
  assert.equal(opts[0].label, 'Display 1');
  for (const [i, d] of [laptop, external].entries()) assert.equal(layout.pickPanelDisplay([laptop, external], opts[i].setting, null, laptop.id), d);
  const twins = displayOptions([disp(1, 'Dell', 0, 0, 100, 100), disp(2, 'Dell', 100, 0, 100, 100)], 1);
  assert.deepStrictEqual(twins.map((o) => o.setting), ['1', '2']);
});

test('exeFromAppId reads classic exe paths only', () => {
  assert.equal(exeFromAppId('{6D809377-6AF0-444B-8957-A3773F02200E}\\Avogadro2\\bin\\Avogadro2.exe'), 'avogadro2.exe');
  assert.equal(exeFromAppId('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'), null);
  assert.equal(exeFromAppId('Chrome'), null);
  assert.equal(exeFromAppId('https://example.com/setup.exe'), null);
});

test('Windows iconTarget avoids the ids the shell hangs on', () => {
  const env = (s) => s.replace('%WINDIR%', 'C:\\Windows');
  assert.equal(iconTarget({ launch: { appId: '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\charmap.exe' } }, env), 'C:\\Windows\\System32\\charmap.exe');
  assert.equal(iconTarget({ launch: { appId: '{00000000-0000-0000-0000-000000000000}\\x.exe' } }), null);
  assert.equal(iconTarget({ launch: { appId: 'Microsoft.Office.MSACCESS.EXE.15' } }), null);
  assert.equal(iconTarget({ launch: { appId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' } }), 'shell:::{4234d49b-0245-4df3-b780-3893943456e1}\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App');
  assert.equal(iconTarget({ launch: { exe: 'C:/a.exe' } }), 'C:\\a.exe');
  assert.equal(iconTarget({ launch: {} }), null);
  // Network paths: the shell blocks ~25s on an offline server, so they get letter tiles.
  assert.equal(iconTarget({ launch: { exe: '\\\\server\\share\\app.exe' } }), null);
  assert.equal(iconTarget({ launch: { exe: '//server/share/app.exe' } }), null);
  assert.equal(iconTarget({ launch: { appId: '\\\\server\\share\\app.exe' } }), null);
  assert.equal(iconTarget({ launch: { exe: '\\\\?\\C:\\a.exe' } }), '\\\\?\\C:\\a.exe', 'a long local path is fine');
});

const CATALOG = [
  { id: 'discord', name: 'Discord', category: 'Social', match: { exe: 'discord.exe' }, launch: { appId: 'com.squirrel.Discord.Discord' } },
  { id: 'chrome', name: 'Chrome', category: 'Browsers', match: { exe: 'chrome.exe' }, launch: { appId: 'Chrome' } },
  { id: 'notion', name: 'Notion', category: 'Notes', match: { exe: 'notion.exe' }, launch: { exe: '%LOCALAPPDATA%\\Programs\\Notion\\Notion.exe' } },
  { id: 'slack', name: 'Slack', category: 'Social', match: { exe: 'slack.exe' }, launch: { appId: 'com.tinyspeck.slackdesktop' } },
];
const INSTALLED = [
  { name: 'Chrome', launch: { appId: 'Chrome' } },
  { name: 'Calculator', launch: { appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' } },
  { name: 'Avogadro2', launch: { appId: '{6D809377}\\Avogadro2\\bin\\avogadro2.exe' } },
  { name: 'Slack (classic)', launch: { appId: 'C:\\Users\\x\\AppData\\Local\\slack\\slack.exe' } },
  { name: 'Some Game', launch: { appId: 'steam://rungameid/1' } },
  { name: 'Docs', launch: { appId: 'https://docs.example.com/' } },
  { name: 'Calculator', launch: { appId: 'Other.Calculator!App' } },
];
const win = (exe, hwnd = 1) => ({ hwnd, title: exe, pid: hwnd, exePath: `C:\\x\\${exe}`, exe, minimized: false });

test('buildCandidates: catalog, installed and open apps merge without duplicates', () => {
  const c = buildCandidates({
    catalogEntries: CATALOG, installed: INSTALLED, windows: [win('discord.exe'), win('avogadro2.exe', 2), win('mystery.exe', 3), win('chrome.exe', 4)],
    exists: (p) => p.endsWith('Notion.exe'), expand: (s) => s.replace('%LOCALAPPDATA%', 'C:\\L'),
  });
  const by = Object.fromEntries(c.map((x) => [x.id, x]));
  assert.equal(new Set(c.map((x) => x.id)).size, c.length, 'ids are unique');
  assert.equal(by.discord.open, true);
  assert.equal(by.chrome.installed && by.chrome.open, true, 'Chrome: catalog entry, found installed and open');
  assert.equal(by.notion.installed, true, 'exe-launch catalog app found on disk');
  assert.equal(by.slack.installed, true, 'classic slack.exe install maps onto the catalog entry');
  assert.equal(by.slack.detected, true);
  assert.equal(c.filter((x) => /^chrome/.test(x.id)).length, 1);
  assert.deepStrictEqual(by.avogadro2.entry, { id: 'avogadro2', name: 'Avogadro2', launch: { appId: '{6D809377}\\Avogadro2\\bin\\avogadro2.exe' }, match: { exe: 'avogadro2.exe' } });
  assert.equal(by.avogadro2.open, true);
  assert.deepStrictEqual(by.mystery.entry, { id: 'mystery', name: 'Mystery', match: { exe: 'mystery.exe' }, launch: { exe: 'C:\\x\\mystery.exe' } });
  assert.equal(by.calculator.entry.match, undefined, 'Store app: exe is resolved on save');
  assert.ok(by['calculator-2'], 'same name twice gets a suffix');
  assert.ok(!c.some((x) => /game|docs/.test(x.id)), 'URL launchers are left out');
  assert.equal(typeof by.discord.entry, 'string', 'catalog apps are stored by id');
  assert.deepStrictEqual(c.slice(0, 2).map((x) => x.open), [true, true], 'open apps come first');
});

test('finishEntries fills match.exe: exe path, manifest, then the name', async () => {
  const groups = [{ id: 'g', name: 'G', apps: ['chrome',
    { id: 'a', name: 'A', launch: { appId: 'Fam_1!App' } },
    { id: 'b', name: 'My Tool 2', launch: { appId: 'weird.id' } },
    { id: 'c', name: 'C', launch: { appId: 'D:\\apps\\Cee.exe' } },
    { id: 'd', name: 'D', match: { exe: 'kept.exe' }, launch: { exe: 'x' } }] }];
  await finishEntries(groups, async (id) => (id === 'Fam_1!App' ? 'a-real.exe' : null));
  assert.deepStrictEqual(groups[0].apps.map((a) => a.match?.exe), [undefined, 'a-real.exe', 'mytool2.exe', 'cee.exe', 'kept.exe']);
});

test('mergeDraft takes only what setup owns and the result validates', () => {
  const current = schema.load(JSON.stringify({ ...schema.DEFAULTS, socialMode: 'dnd', apps: { discord: { badgeOffset: 2 } }, voice: { ...schema.DEFAULTS.voice, thresholds: { wake: 0.5, openAll: 0.7, killAll: 0.9 } } })).config;
  const draft = {
    keys: { ...current.keys, switch: 'Ctrl+Alt+Tab', musicPrev: '', takeOverSystemSwitcher: true },
    startAtLogin: false, music: { provider: 'none' },
    groups: [{ id: 'social', name: '  Chat ', pingGroup: true, apps: ['discord'] }, { id: 'x', name: '', pingGroup: false, apps: [{ id: 'tool', name: 'Tool', match: { exe: 'tool.exe' }, launch: { exe: 'C:\\tool.exe' } }] }],
    panels: { socials: true, music: true, display: 'PHL27E1N5900R' },
    voice: { enabled: true, engine: 'vosk', wakeWord: ' Hey  Cubby! ', commands: { openAll: ['Start', 'launch everything'], killAll: [] } },
    socialMode: 'ping', version: 99,
  };
  const next = mergeDraft(current, draft);
  assert.equal(next.setupComplete, true);
  assert.equal(next.socialMode, 'dnd', 'not owned by setup');
  assert.equal(next.version, 2);
  assert.deepStrictEqual(next.apps, current.apps);
  assert.equal(next.keys.switch, 'Ctrl+Alt+Tab');
  assert.equal(next.keys.musicPrev, '');
  assert.equal(next.keys.search, current.keys.search);
  assert.equal(next.startAtLogin, false);
  assert.equal(next.panels.music, false, 'no music panel without a player');
  assert.equal(next.panels.display, 'PHL27E1N5900R');
  assert.equal(next.panels.displayChosen, true, "a choice saved in Settings is the user's: never upgraded to 'focus'");
  assert.equal(schema.load(JSON.stringify({ ...next, panels: { ...next.panels, display: 'primary' } })).config.panels.display, 'primary');
  assert.equal(mergeDraft(current, { panels: { socials: true } }).panels.displayChosen, undefined, 'no display in the draft: not marked');
  assert.deepStrictEqual(next.groups.map((g) => [g.name, !!g.pingGroup]), [['Chat', true], ['Group', false]]);
  assert.equal(next.voice.engine, 'builtin', "vosk isn't downloadable yet");
  assert.equal(next.voice.wakeWord, 'hey cubby');
  assert.deepStrictEqual(next.voice.commands, { openAll: ['start', 'launch everything'], killAll: current.voice.commands.killAll });
  assert.deepStrictEqual(next.voice.thresholds, { wake: 0.5, openAll: 0.7, killAll: 0.9 });
  assert.deepStrictEqual(schema.validate(schema.withDefaults(next)), []);
  assert.equal(current.groups.length, 0, 'the live config is not mutated');
});

test('mergeDraft + validate catch a duplicate key and a repeated app', () => {
  const cur = schema.load(JSON.stringify(schema.DEFAULTS)).config;
  const dup = mergeDraft(cur, { keys: { ...cur.keys, search: 'Alt+Tab' } });
  assert.ok(schema.validate(schema.withDefaults(dup)).some((e) => /both/.test(e)));
  const twice = mergeDraft(cur, { groups: [{ id: 'a', name: 'A', apps: ['discord'] }, { id: 'b', name: 'B', apps: ['discord'] }] });
  assert.ok(schema.validate(schema.withDefaults(twice)).some((e) => /two groups/.test(e)));
});
