// macOS adapter tests that run on any OS (no Mac, no compiled helper): key parsing, the helper
// client protocol against a fake helper, the music providers' fallbacks, and interface parity.
// Run: node --test native/mac-helper/test/
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseAccelerator, wire } = require('../../../src/platform/mac/keys');
const { createHelper } = require('../../../src/platform/mac/helper');

const FAKE = path.join(__dirname, 'fake-helper.js');
const fake = (opts = {}) => createHelper(process.execPath, { args: [FAKE], minDelay: 50, ...opts });

test('mac adapter exports every name the Windows adapter does', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../src/platform/windows/index.js'), 'utf8');
  const block = /module\.exports = \{([\s\S]*?)\};/.exec(src)[1];
  const names = [...block.matchAll(/^\s*(\w+)\s*[,:]/gm)].map((m) => m[1]);
  assert.ok(names.length >= 20, `found ${names.length} names`);
  const mac = require('../../../src/platform/mac'); // must load without a Mac or a helper binary
  for (const n of names) assert.strictEqual(typeof mac[n], 'function', n);
});

test('parseAccelerator maps to macOS virtual keycodes', () => {
  assert.deepStrictEqual(parseAccelerator('Alt+Tab'), { alt: true, ctrl: false, shift: false, win: false, vk: 48 });
  assert.deepStrictEqual(parseAccelerator('Option+Tab'), parseAccelerator('Alt+Tab'));
  assert.strictEqual(parseAccelerator('Alt+`').vk, 50);
  assert.strictEqual(parseAccelerator('Alt+\\').vk, 42);
  assert.strictEqual(parseAccelerator('Alt+[').vk, 33);
  assert.strictEqual(parseAccelerator('Alt+]').vk, 30);
  assert.strictEqual(parseAccelerator('Alt+A').vk, 0, 'A is keycode 0 and still valid');
  assert.strictEqual(parseAccelerator('F1').vk, 122);
  assert.strictEqual(parseAccelerator('Ctrl+Shift+F12').vk, 111);
  assert.ok(parseAccelerator('Cmd+Tab').win);
  assert.ok(parseAccelerator('CmdOrCtrl+K').win, 'CmdOrCtrl is Cmd on a Mac');
  assert.deepStrictEqual(wire(parseAccelerator('Cmd+Shift+Tab')), { alt: false, ctrl: false, shift: true, cmd: true, key: 48 });
  for (const bad of ['', null, 'Hyper+X', 'Alt+F25', 'Alt+NoSuchKey']) assert.strictEqual(parseAccelerator(bad), null, String(bad));
});

test('helper client: replies, errors, timeouts', async () => {
  const h = fake();
  try {
    assert.strictEqual(await h.request('ping'), 'pong');
    const r = await h.request('list');
    assert.strictEqual(r.windows[0].frame.x, -2560, 'negative coordinates survive the round trip');
    await assert.rejects(h.request('fail'), /nope/);
    await assert.rejects(h.request('slow', {}, 100), /timed out/);
    assert.strictEqual(await h.request('ping'), 'pong', 'still usable after a timeout');
  } finally { h.stop(); }
});

test('helper client: restarts after a crash and replays standing state', async () => {
  const h = fake();
  const seen = [];
  h.on('switch', (m) => seen.push(m.back));
  try {
    // Waits for a ping to get through instead of sleeping: a slow CI runner can take longer than any
    // fixed delay to respawn the process. The replay is written before the ping, so its event lands first.
    const up = async () => {
      for (const end = Date.now() + 5000; ; await new Promise((r) => setTimeout(r, 20))) {
        try { return await h.request('ping'); } catch (e) { if (Date.now() > end) throw e; }
      }
    };
    h.hold('keys', 'hookKeys', { take: true });
    assert.strictEqual(await up(), 'pong');
    assert.deepStrictEqual(seen, [true], 'standing message sent once on start');
    await assert.rejects(h.request('crash'), /exited/);
    assert.strictEqual(await up(), 'pong');
    assert.deepStrictEqual(seen, [true, true], 'replayed after restart');
    h.drop('keys');
    await assert.rejects(h.request('crash'), /exited/);
    assert.strictEqual(await up(), 'pong');
    assert.deepStrictEqual(seen, [true, true], 'dropped state is not replayed');
  } finally { h.stop(); }
});

test('helper client: a missing binary rejects instead of throwing', async () => {
  const h = createHelper(path.join(__dirname, 'no-such-helper'), { minDelay: 50 });
  try {
    await assert.rejects(h.request('ping', {}, 1000));
  } finally { h.stop(); }
});

test('music providers fall back to media keys when the player has no window', () => {
  const providers = require('../../../src/platform/mac/music');
  for (const name of ['spotify', 'apple-music']) {
    const keys = [];
    const p = providers[name]({ mediaKey: (k) => keys.push(k) });
    assert.ok(p.name && p.appRef && /^#[0-9A-F]{6}$/i.test(p.tint), name);
    assert.strictEqual(p.nowPlaying({ running: false, windows: [] }), null);
    p.control('next');
    p.control('bogus');
    assert.deepStrictEqual(keys, ['next'], name);
  }
});

test('icon targets and protected apps', () => {
  const mac = require('../../../src/platform/mac');
  assert.strictEqual(mac.iconTarget({ launch: { bundleId: 'com.hnc.Discord' } }), 'bundle:com.hnc.Discord');
  assert.strictEqual(mac.iconTarget({ match: { bundleId: 'com.x' }, launch: { uri: 'x://' } }), 'bundle:com.x');
  assert.strictEqual(mac.iconTarget({ launch: { exe: '/Applications/Foo.app' } }), '/Applications/Foo.app');
  assert.strictEqual(mac.iconTarget({ launch: { uri: 'x://' } }), null);
  assert.ok(mac.isProtected({ pid: 1, bundleId: 'com.apple.finder' }));
  assert.ok(mac.isProtected({ pid: 1, exe: 'dock.app' }));
  assert.ok(!mac.isProtected({ pid: 1, exe: 'slack.app', bundleId: 'com.tinyspeck.slackmacgap' }));
  assert.strictEqual(mac.quitApp({ pid: 1, bundleId: 'com.apple.finder' }), false);
});
