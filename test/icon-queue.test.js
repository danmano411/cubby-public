const test = require('node:test');
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const { createIconQueue } = require('../src/platform/windows/icon-queue');

// A fake icons.ps1: behave(s)(items, child) scripts what each helper says (default: normal()).
// Counts live helpers. unkillable: taskkill doesn't take.
function fakeHelpers({ behave = normal, unkillable = false } = {}) {
  const s = { live: 0, maxLive: 0, spawned: [], killed: [], rendered: [], itemMs: [] };
  const act = behave(s);
  s.spawnHelper = ({ itemMs } = {}) => {
    s.itemMs.push(itemMs);
    const child = Object.assign(new EventEmitter(), { pid: 1000 + s.spawned.length, stdout: new EventEmitter(), alive: true });
    s.live++;
    s.maxLive = Math.max(s.maxLive, s.live);
    child.say = (line) => child.alive && child.stdout.emit('data', `${line}\r\n`);
    child.exit = () => {
      if (!child.alive) return;
      child.alive = false;
      s.live--;
      child.emit('exit', 0);
      child.emit('close', 0);
    };
    child.stdin = { end: (text) => setImmediate(() => act(JSON.parse(text), child)) };
    s.spawned.push(child);
    return child;
  };
  s.killTree = (child) => { s.killed.push(child.pid); if (!unkillable) setImmediate(child.exit); };
  return s;
}

// Renders every item, a little later each, then exits; items whose target starts with "hang" never answer.
const normal = (s) => (items, child) => {
  let i = 0;
  const next = () => {
    if (i === items.length) { child.say('done'); return child.exit(); }
    const { id, target } = items[i++];
    child.say(`start ${id}`);
    if (target.startsWith('hang')) return; // the shell never answers
    s.rendered.push(target);
    if (target.startsWith('none')) child.say(`fail ${id}`);
    else if (target.startsWith('slow')) child.say(`timeout ${id}`); // icons.ps1's own per-item limit
    else child.say(`ok ${id} data:${target}`);
    setTimeout(next, 1);
  };
  next();
};

// Results arrive line by line, before the helper exits: wait for the queue to wind down.
const idle = async (q) => { while (q.busy) await new Promise((r) => setTimeout(r, 2)); };
const make = (s, opts = {}) => createIconQueue({ spawnHelper: s.spawnHelper, killTree: s.killTree, batchSize: 3, itemMs: 5, coldItemMs: 5, silenceMs: 40, startMs: 60, killWaitMs: 20, ...opts });

test('icon queue: never more than one helper, batches run one after another, shared targets render once', async () => {
  const s = fakeHelpers();
  const q = make(s);
  const tray = q.render(['a', 'b', 'c', 'd']);
  const setup = q.render(['c', 'd', 'e', 'f', 'g', 'none-1']); // overlaps the tray's request
  const again = q.render(['a', 'g']);
  const [r1, r2, r3] = await Promise.all([tray, setup, again]);
  assert.deepStrictEqual(r1, { a: 'data:a', b: 'data:b', c: 'data:c', d: 'data:d' });
  assert.deepStrictEqual(r2, { c: 'data:c', d: 'data:d', e: 'data:e', f: 'data:f', g: 'data:g' }, 'no icon: just left out');
  assert.deepStrictEqual(r3, { a: 'data:a', g: 'data:g' });
  assert.strictEqual(s.maxLive, 1, 'one helper at a time');
  assert.strictEqual(s.spawned.length, 3, '8 distinct targets in batches of 3');
  assert.deepStrictEqual([...s.rendered].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'none-1'], 'each target rendered once');
  await idle(q);
  assert.strictEqual(s.live, 0);

  await q.render(['none-1']);
  assert.strictEqual(s.spawned.length, 3, 'a target with no icon is not tried again');
});

test('icon queue: a hung helper is killed, only the hung target is given up on, the rest are rendered', async () => {
  const s = fakeHelpers();
  const logs = [];
  const q = make(s, { log: (...a) => logs.push(a.join(' ')) });
  const r = await q.render(['a', 'hang-1', 'b', 'c', 'slow-1']);
  assert.deepStrictEqual(r, { a: 'data:a', b: 'data:b', c: 'data:c' });
  assert.deepStrictEqual(s.killed, [1000], 'the helper that went quiet was killed (tree kill)');
  assert.ok(!s.spawned[0].alive);
  assert.strictEqual(s.maxLive, 1, 'the replacement only started once the hung one was gone');
  assert.ok(q.gaveUp('hang-1') && q.gaveUp('slow-1'), 'timed out in the helper or in the queue: both given up on');
  assert.ok(!q.gaveUp('b'), 'b was waiting behind the hang, not guilty');
  assert.ok(logs.some((l) => /went quiet on hang-1/.test(l)));

  const n = s.spawned.length;
  assert.deepStrictEqual(await q.render(['hang-1', 'slow-1']), {});
  assert.strictEqual(s.spawned.length, n, 'timed-out targets are never retried: no helper started for them');
  assert.strictEqual(s.rendered.filter((t) => t === 'b').length, 1);
  await idle(q);
  assert.strictEqual(s.live, 0);
});

test('icon queue: a helper that cannot be killed is never replaced', async () => {
  const s = fakeHelpers({ unkillable: true });
  const q = make(s);
  const r = await q.render(['a', 'hang-1', 'b', 'c', 'd', 'e']);
  assert.deepStrictEqual(r, { a: 'data:a' });
  assert.deepStrictEqual(s.killed, [1000], 'it was asked to die');
  assert.ok(q.wedged);
  assert.strictEqual(s.spawned.length, 1, 'no replacement for that batch, nor for the batch queued behind it');
  assert.deepStrictEqual(await q.render(['x', 'y']), {}, 'later requests get letter tiles at once');
  assert.strictEqual(s.spawned.length, 1);
  assert.strictEqual(q.stats.unkillable, 1);
});

test('icon queue: a helper silent from the start gives up on its batch, output split across chunks still parses', async () => {
  let first = true;
  const s = fakeHelpers({ behave: () => (items, c) => {
    if (first) { first = false; return; } // e.g. stuck before its first item
    for (const { id, target } of items) {
      const line = `start ${id}\nok ${id} data:${target}\n`;
      c.stdout.emit('data', line.slice(0, 9));
      c.stdout.emit('data', line.slice(9));
    }
    c.exit();
  } });
  const q = make(s);
  assert.deepStrictEqual(await q.render(['a', 'b', 'c', 'd']), { d: 'data:d' });
  assert.ok(q.gaveUp('a') && q.gaveUp('b') && q.gaveUp('c'), 'nothing started: any of them could be the hang');
  assert.strictEqual(s.maxLive, 1);
});

// Like normal(), but a target starting with "crash" makes the helper exit mid-item without a word.
const crashing = (s) => (items, child) => {
  let i = 0;
  const next = () => {
    if (i === items.length) return child.exit();
    const { id, target } = items[i++];
    child.say(`start ${id}`);
    if (target.startsWith('crash')) return child.exit();
    s.rendered.push(target);
    child.say(`ok ${id} data:${target}`);
    setTimeout(next, 1);
  };
  next();
};

test('icon queue: a helper that dies mid-item: a strike for that item, the rest go again; a second death gives up on it', async () => {
  const s = fakeHelpers({ behave: crashing });
  const logs = [];
  const q = make(s, { log: (...a) => logs.push(a.join(' ')) });
  const r = await q.render(['a', 'crash-1', 'b', 'c']);
  assert.deepStrictEqual(r, { a: 'data:a', b: 'data:b', c: 'data:c' }, 'the targets behind the crash still render');
  assert.strictEqual(s.spawned.length, 3, '[a crash-1 b] dies, [crash-1 b c] dies, [b c]');
  assert.ok(q.gaveUp('crash-1'), 'second strike');
  assert.ok(!q.gaveUp('b') && !q.gaveUp('c'), 'innocent bystanders are not struck');
  assert.strictEqual(q.stats.died, 2);
  assert.strictEqual(s.maxLive, 1);
  assert.deepStrictEqual(s.killed, [], 'nothing had to be killed');
  assert.ok(logs.some((l) => /giving up on crash-1 after 2/.test(l)));
  assert.deepStrictEqual(await q.render(['crash-1']), {});
  assert.strictEqual(s.spawned.length, 3, 'given up: no helper for it again');
});

test('icon queue: a helper that dies before a word strikes the whole batch; two such deaths give up, a transient one recovers', async () => {
  const deadOnArrival = () => (items, child) => child.exit();
  const s = fakeHelpers({ behave: deadOnArrival });
  const q = make(s);
  assert.deepStrictEqual(await q.render(['a', 'b']), {});
  assert.strictEqual(s.spawned.length, 2, 'one retry, not an endless respawn loop');
  assert.ok(q.gaveUp('a') && q.gaveUp('b'));
  assert.deepStrictEqual(await q.render(['a', 'b']), {});
  assert.strictEqual(s.spawned.length, 2);

  let deaths = 1;
  const flaky = fakeHelpers({ behave: (st) => (items, child) => (deaths-- > 0 ? child.exit() : normal(st)(items, child)) });
  const q2 = make(flaky);
  assert.deepStrictEqual(await q2.render(['a', 'b']), { a: 'data:a', b: 'data:b' }, 'one strike, then rendered by the next helper');
  assert.strictEqual(flaky.spawned.length, 2);
});

test("icon queue: PowerShell that can't start (no pid, or spawn throws): no more helpers this session", async () => {
  let tries = 0;
  const noPid = () => {
    tries++;
    const c = Object.assign(new EventEmitter(), { pid: undefined, stdout: new EventEmitter(), stdin: { end() {} } });
    process.nextTick(() => { c.emit('error', new Error('spawn powershell ENOENT')); c.emit('close', -4058); });
    return c;
  };
  const q = createIconQueue({ spawnHelper: noPid, killTree: () => {}, batchSize: 2, silenceMs: 40, startMs: 60 });
  assert.deepStrictEqual(await q.render(['a', 'b', 'c', 'd']), {});
  assert.strictEqual(tries, 1, 'the batch queued behind it never tries');
  assert.ok(q.wedged);
  assert.strictEqual(q.stats.failedStart, 1);
  assert.deepStrictEqual(await q.render(['e']), {}, 'later requests get letter tiles at once');
  assert.strictEqual(tries, 1);

  let thrown = 0;
  const q2 = createIconQueue({ spawnHelper: () => { thrown++; throw new Error('EMFILE'); }, killTree: () => {}, batchSize: 2 });
  assert.deepStrictEqual(await q2.render(['a', 'b', 'c']), {});
  assert.deepStrictEqual(await q2.render(['x']), {});
  assert.strictEqual(thrown, 1);
  assert.ok(q2.wedged);
});

test('icon queue: quiet between items: the not-yet-started items go again in a new helper, not dropped', async () => {
  // Answers for its first item, then goes silent without starting the next (stuck between items).
  let stalls = 1;
  const stallOnce = (s) => (items, child) => {
    if (stalls-- <= 0) return normal(s)(items, child);
    child.say(`start ${items[0].id}`);
    child.say(`ok ${items[0].id} data:${items[0].target}`);
  };
  const s = fakeHelpers({ behave: stallOnce });
  const logs = [];
  const q = make(s, { log: (...a) => logs.push(a.join(' ')) });
  assert.deepStrictEqual(await q.render(['a', 'b', 'c']), { a: 'data:a', b: 'data:b', c: 'data:c' });
  assert.deepStrictEqual(s.killed, [1000], 'the stalled helper was killed');
  assert.ok(!q.gaveUp('b') && !q.gaveUp('c'), 'b and c were never started: not given up on');
  assert.ok(logs.some((l) => /went quiet between items/.test(l)));
  assert.strictEqual(s.maxLive, 1);

  // A helper that always stalls after one item still ends: a second strike gives up.
  const always = (st) => (items, child) => { child.say(`start ${items[0].id}`); child.say(`ok ${items[0].id} data:${items[0].target}`); };
  const s2 = fakeHelpers({ behave: always });
  const q2 = make(s2);
  assert.deepStrictEqual(await q2.render(['a', 'b', 'c']), { a: 'data:a', b: 'data:b' });
  assert.ok(q2.gaveUp('c'), 'stalled behind twice');
  assert.strictEqual(s2.spawned.length, 2);
});

test('icon queue: cold start: the first batch gets the longer per-item limit, later ones the normal one', async () => {
  // "slow" targets take 120ms in the shell: fine within the cold limit, a hang once warm.
  const slowish = (s) => (items, child) => {
    let i = 0;
    const next = () => {
      if (i === items.length) return child.exit();
      const { id, target } = items[i++];
      child.say(`start ${id}`);
      setTimeout(() => { s.rendered.push(target); child.say(`ok ${id} data:${target}`); next(); }, target.startsWith('slow') ? 120 : 1);
    };
    next();
  };
  const s = fakeHelpers({ behave: slowish });
  const q = make(s, { itemMs: 5, coldItemMs: 200 });
  assert.ok(q.cold);
  assert.deepStrictEqual(await q.render(['slow-1', 'a']), { 'slow-1': 'data:slow-1', a: 'data:a' }, 'cold: 120ms is within the limit');
  assert.ok(!q.cold, 'warm once a helper has answered');
  assert.deepStrictEqual(await q.render(['slow-2', 'b']), { b: 'data:b' }, 'warm: the same 120ms is a hang');
  assert.ok(q.gaveUp('slow-2'));
  assert.deepStrictEqual(s.itemMs, [200, 5, 5], 'icons.ps1 is told the limit: cold, then normal (incl. the replacement helper)');

  // A first helper that dies before answering leaves the next one cold too.
  let deaths = 1;
  const s2 = fakeHelpers({ behave: (st) => (items, child) => (deaths-- > 0 ? child.exit() : normal(st)(items, child)) });
  const q2 = make(s2, { itemMs: 5000, coldItemMs: 12000 });
  await q2.render(['a']);
  await q2.render(['b']);
  assert.deepStrictEqual(s2.itemMs, [12000, 12000, 5000]);
});

// The real icons.ps1, end to end: the line protocol, a missing file, and the process is gone after.
test('icons.ps1: renders through the queue and exits', { skip: process.platform !== 'win32' }, async () => {
  const children = [];
  const q = createIconQueue({
    spawnHelper: () => {
      const c = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(__dirname, '../src/platform/windows/icons.ps1'), '-itemMs', '5000'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      children.push(c);
      return c;
    },
    killTree: (c) => execFile('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true }, () => {}),
    silenceMs: 30000,
  });
  const explorer = path.join(process.env.WINDIR || 'C:\\Windows', 'explorer.exe');
  const missing = path.join(process.env.WINDIR || 'C:\\Windows', 'no-such-cubby-test.exe');
  try {
    const r = await q.render([explorer, missing]);
    assert.match(r[explorer] || '', /^data:image\/png;base64,/);
    assert.ok(!(missing in r));
    assert.ok(q.gaveUp(missing));
    assert.strictEqual(children.length, 1);
    const c = children[0];
    const code = await new Promise((r) => { if (c.exitCode !== null) r(c.exitCode); else { c.once('exit', r); setTimeout(r, 10000, 'still running').unref(); } });
    assert.strictEqual(code, 0, 'the helper exited by itself');
  } finally {
    for (const c of children) if (c.exitCode === null) execFile('taskkill', ['/PID', String(c.pid), '/T', '/F'], () => {});
  }
});
