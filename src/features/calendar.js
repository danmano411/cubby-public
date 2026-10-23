// Next calendar event in the tray, and an optional toast before each event (calendar.notify, off by
// default). Two sources, merged: Notion Calendar's own copy on this computer (calendar.notion, read
// again whenever it changes) and private iCal links (calendar.urls, every 10 minutes). Both are read
// again at once when Settings is saved. ctx: see register() in main.js.
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const cal = require('../calendar');
const nc = require('../notion-calendar');

const REFRESH_MS = 10 * 60000;
const RETRY_MS = 60000; // offline, a timeout: soon
const BLOCKED_MS = 15 * 60000; // HTTP 429: the server is throttling; asking every minute keeps it that way
const NOTION_MS = 30 * 60000; // re-expand repeating events now and then even with no change on disk
let ctx = null;
const src = {
  links: { events: [], status: { state: 'none' }, key: null, nextAt: 0, loading: false, again: false },
  notion: { events: [], status: { state: 'none' }, stamp: null, loading: false, again: false },
};
const told = new Set(); // events already toasted: `${start}|${title}`

// Both sources, one copy of each event (the same meeting can come from a link and from Notion Calendar).
function events() {
  const seen = new Set();
  return [...src.notion.events, ...src.links.events].filter((e) => {
    const k = `${e.start}|${e.title}`;
    return !seen.has(k) && seen.add(k);
  }).sort((a, b) => a.start - b.start);
}
const upcoming = (list) => list.filter((e) => !e.allDay && e.end > Date.now()).length;

function explain(e) {
  if (e.status === 429) return `${e.host} is refusing requests from this network for now (it thinks they're automated). Cubby tries again every 15 minutes; it usually clears on its own, and another network (like a phone hotspot) works right away.`;
  if ([401, 403, 404].includes(e.status)) return `${e.host} turned the link down (${e.message}). Copy it again: resetting the secret address changes it.`;
  return `Couldn't reach ${e.host}: ${e.message}. Cubby tries again in a minute.`;
}

// What Settings shows: { links, notion }, each { state: none | off | missing | loading | ok | error, ... }.
const status = () => ({ links: src.links.status, notion: src.notion.status });
function setStatus(which, st) {
  src[which].status = { ...st, at: Date.now() };
  for (const w of ctx.BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('calendar:status', status());
}

// One load at a time per source; a forced one asked for meanwhile runs right after.
async function once(which, force, fn) {
  const s = src[which];
  if (s.loading) { s.again ||= force; return; }
  s.loading = true;
  try { await fn(s); } finally {
    s.loading = false;
    if (s.again) { s.again = false; once(which, true, fn); }
  }
}

// force: right away, even if the links didn't change (Save changes on the Calendar page).
const refreshLinks = (force = false) => once('links', force, async (s) => {
  const urls = ctx.config.calendar?.urls || [];
  const key = JSON.stringify(urls);
  if (!force && key === s.key && Date.now() < s.nextAt) return;
  s.key = key;
  if (!urls.length) { s.events = []; setStatus('links', { state: 'none' }); ctx.push(); return; }
  setStatus('links', { state: 'loading' });
  const r = await cal.load(urls);
  if (!r.errors.length || r.events.length) s.events = r.events; // offline or throttled: keep what we had
  s.nextAt = Date.now() + (!r.errors.length ? REFRESH_MS : r.errors.some((e) => e.status === 429) ? BLOCKED_MS : RETRY_MS);
  for (const e of r.errors) ctx.log('calendar:', e.host, e.message);
  setStatus('links', r.errors.length ? { state: 'error', message: explain(r.errors[0]), upcoming: upcoming(s.events) } : { state: 'ok', upcoming: upcoming(s.events) });
  ctx.push();
});

// Newest file time in Notion Calendar's database folder (changes whenever it syncs), or null.
function notionStamp() {
  try {
    const dir = nc.dbDir();
    return Math.max(...fs.readdirSync(dir).map((f) => fs.statSync(path.join(dir, f)).mtimeMs));
  } catch { return null; }
}

// Reading takes ~150ms, so it runs on a worker thread: the switcher's keys never wait on it.
function loadNotion() {
  return new Promise((resolve, reject) => {
    const w = new Worker(`const { parentPort, workerData } = require('worker_threads');
      parentPort.postMessage(require(workerData).load());`, { eval: true, workerData: require.resolve('../notion-calendar') });
    w.once('message', resolve);
    w.once('error', reject);
    w.once('exit', (code) => code && reject(new Error(`reader exited with ${code}`)));
  });
}

const refreshNotion = (force = false) => once('notion', force, async (s) => {
  if (ctx.config.calendar?.notion === false) {
    if (s.status.state !== 'off') { s.events = []; s.stamp = null; setStatus('notion', { state: 'off' }); ctx.push(); }
    return;
  }
  const stamp = notionStamp();
  if (stamp == null) {
    if (s.status.state !== 'missing') { s.events = []; setStatus('notion', { state: 'missing' }); ctx.push(); }
    return;
  }
  if (!force && stamp === s.stamp && Date.now() - (s.status.at || 0) < NOTION_MS) return;
  s.stamp = stamp;
  try {
    const r = await loadNotion();
    s.events = r ? r.events : [];
    setStatus('notion', { state: 'ok', upcoming: upcoming(s.events), updatedAt: r?.updatedAt });
  } catch (e) {
    ctx.log('calendar: Notion Calendar', e.message);
    setStatus('notion', { state: 'error', message: `Couldn't read Notion Calendar's data: ${e.message}` });
  }
  ctx.push();
});

const refresh = (force = false) => { refreshNotion(force); refreshLinks(force); };

const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: ctx.hour12() });

function remind(now = Date.now()) {
  const c = ctx.config.calendar;
  if (!c?.notify) return;
  const soon = now + c.notifyMinutes * 60000;
  for (const e of events()) {
    const id = `${e.start}|${e.title}`;
    if (e.allDay || e.start > soon || e.start < now - 60000 || told.has(id)) continue;
    told.add(id);
    const mins = Math.round((e.start - now) / 60000);
    ctx.notify({ id: 'calendar', name: 'Calendar', icon: c.app ? ctx.iconOf(c.app) : undefined, headline: mins > 0 ? `${e.title} in ${mins} min` : `${e.title} now`, title: [`${clock(e.start)} – ${clock(e.end)}`, e.location].filter(Boolean).join(' · '), hwnd: 0 });
  }
}

// What the tray shows: { title, start, end, location, app } or null.
function next() {
  if (!ctx) return null; // asked before register()
  const e = cal.next(events(), Date.now());
  return e && { ...e, app: ctx.config.calendar?.app || null };
}

function register(c) {
  ctx = c;
  if (ctx.smoke) return;
  ctx.ipcMain.on('calendar:refresh', () => refresh(true));
  ctx.ipcMain.on('calendar:status?', (e) => e.sender.send('calendar:status', status()));
  refresh();
  setInterval(() => { refresh(); remind(); }, 15000);
}

module.exports = { register, next };
