// The one way icons get rendered on Windows: every caller (the tray, setup) goes through this queue.
//   - at most ONE icons.ps1 helper runs at a time; requests wait their turn and are merged into batches
//   - a target is rendered once per session at most: in-flight targets are shared, and targets the shell
//     had no icon for, or never answered for, are not tried again
//   - a helper that goes quiet is killed with its whole process tree; if even that fails, no helper is
//     started again this session (the shell is wedged, and each new one would hang the same way)
//   - a helper that dies, or stalls between items, leaves its unanswered targets with a strike: they go
//     back in line for a new helper, and a target's second strike gives up on it
//   - if the helper can't be started at all (no PowerShell), none is tried again this session
//   - the first batch after app start gets a longer per-item limit: a cold shell is slow, not hung
// The helper reports per item (see icons.ps1), so a hang is pinned on the one item that was in progress.
// Pure apart from the injected spawnHelper / killTree, so test/icon-queue.test.js drives it with fakes.
const LINE = /^(start|ok|fail|timeout) (\d+)(?: (\S+))?$/;

// spawnHelper({ itemMs }) -> ChildProcess-like { pid, stdin.end(text), stdout 'data', 'exit', 'error' };
// pid undefined = it didn't start. itemMs: icons.ps1's per-item limit (coldItemMs until a helper has
// answered for an item once). killTree(child) kills it and its children (taskkill /T /F); its 'exit'
// event says whether that worked.
// silenceMs: longest gap between two lines before the helper counts as hung (icons.ps1 gives up on an
// item after itemMs by itself, so this only trips when the helper itself is stuck; a cold batch gets
// its extra item time on top); startMs: before the first line.
const STRIKES = 2;
function createIconQueue({ spawnHelper, killTree, batchSize = 16, itemMs = 5000, coldItemMs = 12000, silenceMs = 15000, startMs = 60000, killWaitMs = 5000, log = () => {} }) {
  const waiting = []; // targets not handed to a helper yet, oldest first
  const pending = new Map(); // target -> [callback(url | null)]
  const gaveUp = new Set(); // no icon, or the shell never answered: not tried again this session
  const strikes = new Map(); // target -> helpers that died or stalled with it unanswered
  let running = false;
  let wedged = false; // a helper survived being killed, or none could be started: no more helpers this session
  let cold = true; // no helper has answered for an item yet (first batch after app start)
  const stats = { spawned: 0, killed: 0, unkillable: 0, died: 0, failedStart: 0 };

  const settle = (t, url) => {
    const fns = pending.get(t) || [];
    pending.delete(t);
    for (const fn of fns) fn(url);
  };
  const drop = (t) => { gaveUp.add(t); settle(t, null); };
  // Unanswered through no fault of their own (strike = false) or maybe their fault (strike = true):
  // back to the front of the line for the next helper, unless that was a target's last strike.
  const retry = (targets, strike) => {
    const again = [];
    for (const t of targets) {
      const n = (strikes.get(t) || 0) + (strike ? 1 : 0);
      strikes.set(t, n);
      if (n >= STRIKES) { log('icons: giving up on', t, 'after', n, 'failed helpers'); drop(t); } else again.push(t);
    }
    waiting.unshift(...again);
  };

  // targets -> Promise<{ [target]: dataUrl }>, with only the ones that rendered.
  function render(targets) {
    const list = [...new Set(targets || [])].filter((t) => typeof t === 'string' && t);
    const jobs = list.map((t) => {
      if (wedged || gaveUp.has(t)) return null;
      return new Promise((resolve) => {
        if (!pending.has(t)) { pending.set(t, []); waiting.push(t); }
        pending.get(t).push((url) => resolve(url ? [t, url] : null));
      });
    });
    pump();
    return Promise.all(jobs).then((pairs) => Object.fromEntries(pairs.filter(Boolean)));
  }

  function pump() {
    if (running || !waiting.length) return;
    if (wedged) { for (const t of waiting.splice(0)) drop(t); return; }
    running = true;
    runBatch(waiting.splice(0, batchSize)).then(() => { running = false; pump(); });
  }

  function runBatch(batch) {
    return new Promise((finish) => {
      const left = new Set(batch); // not reported on yet
      let current = null; // the item the helper said it started
      let buf = '';
      let timer = null;
      let listening = true; // false once the helper is done with, or given up on
      let exited = false;
      let heard = false;
      let child;
      const ms = cold ? coldItemMs : itemMs;
      const finishBatch = () => {
        for (const t of left) settle(t, null); // ended without a word on these: no icon this time
        finish();
      };
      const onLine = (line) => {
        const m = LINE.exec(line.trim());
        const t = m && batch[Number(m[2])];
        if (!t || !left.has(t)) return;
        if (m[1] === 'start') { current = t; return; }
        left.delete(t);
        current = null;
        cold = false;
        if (m[1] === 'ok' && m[3]) return settle(t, m[3]);
        if (m[1] === 'timeout') log('icons: no answer for', t);
        drop(t);
      };
      // Exited (or errored) by itself. Anything still unanswered means it died: a strike for the item it
      // was on (the rest go again), or for every one left when it hadn't started one.
      const ended = () => {
        if (!listening) return;
        listening = false;
        clearTimeout(timer);
        onLine(buf);
        if (left.size) {
          stats.died++;
          log('icons: helper', child.pid, 'ended without answering for', [...left].join(', '));
          if (current) { left.delete(current); retry([current], true); retry(left, false); } else retry(left, true);
          left.clear();
        }
        finishBatch();
      };
      // PowerShell itself can't be started: every helper would fail the same way.
      const cantStart = (e) => {
        stats.failedStart++;
        if (!wedged) log('icons: the helper could not be started:', e && e.message, '- no icon helpers this session');
        wedged = true;
        listening = false;
        clearTimeout(timer);
        for (const t of left) drop(t);
        left.clear();
        finishBatch();
      };
      const hung = () => {
        if (!listening) return;
        listening = false;
        // The item in progress is the one that hangs; before any item started, it could be any of them.
        // Quiet between two items (after answering for some): no item to blame, so the ones it hadn't
        // started each get a strike and go again.
        const between = !current && heard;
        const guilty = current ? [current] : between ? [] : [...left];
        log('icons: helper', child.pid, 'went quiet', between ? 'between items' : `on ${guilty.join(', ')}`);
        for (const t of guilty) { left.delete(t); drop(t); }
        try { killTree(child); } catch (e) { log('icons: kill failed', e.message); }
        setTimeout(() => {
          if (exited) {
            stats.killed++;
            retry(left, between); // back to the front of the line, in a new helper
          } else {
            stats.unkillable++;
            wedged = true;
            log('icons: helper', child.pid, "couldn't be killed; no more icon helpers this session");
            for (const t of left) drop(t);
          }
          left.clear();
          finishBatch();
        }, killWaitMs);
      };
      // Before its first word the helper gets longer: a cold PowerShell compiling icons.ps1's C# right
      // after login can take a while, and that isn't any target's fault.
      const quiet = () => { clearTimeout(timer); timer = setTimeout(hung, heard ? silenceMs + ms - itemMs : startMs); };

      try {
        child = spawnHelper({ itemMs: ms });
      } catch (e) {
        return cantStart(e);
      }
      // 'close' (stdout drained) ends a normal run; 'exit' is what tells a kill worked. A spawn that
      // failed has no pid, and its 'error' comes on the next tick.
      child.on('exit', () => { exited = true; });
      child.on('close', ended);
      child.on('error', (e) => (child.pid === undefined ? cantStart(e) : ended()));
      if (child.pid === undefined) return;
      stats.spawned++;
      child.stdout.on('data', (d) => {
        if (!listening) return;
        heard = true;
        quiet();
        buf += d;
        for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) onLine(buf.slice(0, i));
      });
      quiet();
      child.stdin.on?.('error', () => {}); // EPIPE when the helper is already gone: 'close' handles it
      try { child.stdin.end(JSON.stringify(batch.map((target, i) => ({ id: String(i), target })))); } catch {}
    });
  }

  return {
    render,
    get busy() { return running; },
    get wedged() { return wedged; },
    get cold() { return cold; },
    gaveUp: (t) => gaveUp.has(t),
    stats,
  };
}

module.exports = { createIconQueue };
