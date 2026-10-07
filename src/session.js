// Open All / Close All for the configured apps (groups + music). "Other" windows are never touched.
// config here is the resolved runtime config (catalog.resolveConfig).
const adapter = require('./platform');
const { appForWindow, allApps } = require('./model');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) Ask every window to close (same as clicking X). 2) After a grace period, force-quit the
// processes whose windows are gone but which are still alive in the tray (Discord, Slack, ...).
// A process that still has a window up (e.g. a "Save changes?" prompt) is left alone, so
// nothing unsaved is lost. Returns { closed, waiting } app names.
async function closeAll(config, { except = [], graceMs = 3000 } = {}) {
  const targets = adapter.listWindows({ excludePid: process.pid })
    .map((w) => ({ w, app: appForWindow(config, w) }))
    .filter((t) => t.app && !except.includes(t.app.id));
  for (const { w } of targets) adapter.close(w.hwnd);
  await sleep(graceMs);

  const stillShowing = new Set(adapter.listWindows().map((w) => w.pid));
  const waiting = new Set();
  const killed = new Set();
  for (const { w, app } of targets) {
    if (stillShowing.has(w.pid)) { if (!adapter.isProtected(w)) waiting.add(app.name); continue; }
    if (killed.has(w.pid)) continue;
    killed.add(w.pid);
    adapter.quitApp(w, { force: true });
  }
  const names = [...new Set(targets.map((t) => t.app.name))];
  return { closed: names.filter((n) => !waiting.has(n)), waiting: [...waiting] };
}

// Launch every configured app that has no window open right now, then maximize them.
function openAll(config, launch) {
  const open = new Set(adapter.listWindows().map((w) => appForWindow(config, w)?.id));
  const toOpen = allApps(config).filter((a) => !open.has(a.id) && a.launch);
  for (const a of toOpen) launch(a.launch);
  maximizeAsTheyAppear(config, new Set(toOpen.map((a) => a.id)));
  return toOpen.map((a) => a.name);
}

// Apps restore their own saved size right after showing, so each new window is maximized when
// first seen and again 1.5s later. Watches for 30s (slow starters like Teams).
function maximizeAsTheyAppear(config, ids, watchMs = 30000) {
  if (!ids.size) return;
  const seen = new Set();
  const until = Date.now() + watchMs;
  const timer = setInterval(() => {
    for (const w of adapter.listWindows()) {
      if (seen.has(w.hwnd) || !ids.has(appForWindow(config, w)?.id)) continue;
      seen.add(w.hwnd);
      adapter.maximize(w.hwnd);
      setTimeout(() => { if (adapter.isWindow(w.hwnd)) adapter.maximize(w.hwnd); }, 1500);
    }
    if (Date.now() > until) clearInterval(timer);
  }, 500);
}

module.exports = { closeAll, openAll };
