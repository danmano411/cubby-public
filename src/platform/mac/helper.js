// Client for native/mac-helper (cubby-helper): one long-lived process, newline-delimited JSON.
//   -> { id, cmd, ...params }         <- { id, ok, result | error }        replies
//                                     <- { event, ... }                    pushed at any time
// If the process exits it's started again (1s, doubling up to 30s) and the standing state (key
// hook, badge watcher, voice) is replayed, so callers see one helper that never dies.
const { spawn } = require('child_process');

function createHelper(command, { args = [], spawnFn = spawn, log = () => {}, timeoutMs = 5000, minDelay = 1000, maxDelay = 30000 } = {}) {
  let proc = null;
  let timer = null;
  let stopped = false;
  let nextId = 1;
  let delay = minDelay;
  let startedAt = 0;
  const pending = new Map(); // id -> { resolve, reject, t }
  const listeners = new Map(); // event -> Set(fn)
  const standing = new Map(); // key -> message replayed on every start

  const write = (msg) => { try { proc.stdin.write(`${JSON.stringify(msg)}\n`); } catch {} };

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return log('helper: bad line', line.slice(0, 200)); }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.t);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'helper error'));
    } else if (msg.event) {
      for (const fn of listeners.get(msg.event) || []) {
        try { fn(msg); } catch (e) { log('helper listener', msg.event, e.stack); }
      }
    }
  }

  function start() {
    timer = null;
    startedAt = Date.now();
    let p;
    try { p = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { log('helper spawn', e.message); return ended(null); }
    proc = p;
    let buf = '';
    let done = false;
    const end = () => { if (!done) { done = true; ended(p); } }; // 'error' and 'exit' can both fire
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) if (i > 0) onLine(buf.slice(0, i));
    });
    p.stderr.on('data', (d) => log('helper:', String(d).trim()));
    p.stdin.on('error', () => {});
    p.on('error', (e) => { log('helper', e.message); end(); });
    p.on('exit', end);
    for (const m of standing.values()) write(m);
  }

  function ended(p) {
    if (p && proc !== p) return;
    proc = null;
    for (const [id, q] of pending) { clearTimeout(q.t); q.reject(new Error('helper exited')); pending.delete(id); }
    if (stopped) return;
    if (Date.now() - startedAt > 30000) delay = minDelay; // it had been running fine: restart quickly
    timer = setTimeout(start, delay);
    timer.unref?.();
    delay = Math.min(delay * 2, maxDelay);
  }

  const ensure = () => { if (!proc && !timer && !stopped) start(); return !!proc; };

  function request(cmd, params = {}, ms = timeoutMs) {
    if (!ensure()) return Promise.reject(new Error('helper not running'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`helper: ${cmd} timed out`)); }, ms);
      t.unref?.();
      pending.set(id, { resolve, reject, t });
      write({ ...params, id, cmd });
    });
  }

  return {
    request,
    send: (cmd, params) => { request(cmd, params).catch((e) => log('helper', cmd, e.message)); },
    // Standing state: sent now and again after every restart, until dropped.
    hold(key, cmd, params = {}) {
      const msg = { ...params, cmd };
      const wasRunning = !!proc;
      standing.set(key, msg);
      if (wasRunning) write(msg);
      else ensure(); // a fresh start replays it
    },
    drop(key, cmd, params = {}) {
      standing.delete(key);
      if (cmd && proc) write({ ...params, cmd });
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    stop() { stopped = true; clearTimeout(timer); proc?.kill(); },
    get running() { return !!proc; },
  };
}

module.exports = { createHelper };
