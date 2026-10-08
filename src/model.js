// Pure logic: turn a raw window list + resolved config (catalog.resolveConfig) into the grouped tray model.
const path = require('path');

// Every match field except title must equal the window's (exe on Windows, bundleId on mac);
// title is an optional regex on top.
function matches(app, w) {
  const { title, ...fields } = app.match;
  const keys = Object.keys(fields);
  if (!keys.length || keys.some((k) => String(w[k] || '').toLowerCase() !== String(fields[k]).toLowerCase())) return false;
  if (!title) return true;
  try { return new RegExp(title, 'i').test(w.title); } catch { return false; } // schema.validate reports bad patterns
}

function titleCount(title) {
  const m = /^\((\d+)\)/.exec(title) || /\((\d+)\)\s*[-|·]/.exec(title);
  return m ? Number(m[1]) : 0;
}

// Taskbar badge text (see badges.ps1) -> { count } | { dot } | null.
// "9+ items, status Unknown" -> { count: '9+' }; "Unread messages" -> { dot }; "No items, ..." -> null.
function parseBadge(text) {
  if (!text || /^no\b/i.test(text)) return null;
  const m = /(\d+\+?)/.exec(text);
  return m ? { count: m[1] } : { dot: true };
}

// Per-app correction: Discord's badge text runs one behind its icon ("0 notifications" for the
// first unread, "3" while the icon shows 4), so its catalog entry sets badgeOffset: 1. A count that
// is still 0 means "unread, no number" -> dot.
function adjust(badge, offset = 0) {
  if (!badge?.count || badge.count.endsWith('+')) return badge;
  const n = parseInt(badge.count, 10) + offset;
  return n > 0 ? { count: String(n) } : { dot: true };
}

// An app's badges, matched by its launch AppID (Windows) or bundle id (mac); prefix match covers
// Teams' "...!MSTeams.Work".
// Is `after` news compared to `before`? A badge that appears or grows is; one that shrinks or stays
// isn't (reading messages elsewhere lowers it, and that must not ping). "9+" counts as more than 9.
function badgeGrew(before, after) {
  if (!after) return false;
  if (!before) return true;
  if (!after.count) return false;
  if (!before.count) return true;
  const n = (b) => parseInt(b.count, 10) + (b.count.endsWith('+') ? 0.5 : 0);
  return n(after) > n(before);
}

// The ping card's second line. Never the app's window title: for a chat app that is the conversation
// you have OPEN (Discord: "#general | Server"), not the one that pinged, and Windows doesn't say which
// one did. The unread count is the only true thing we know.
function pingText(badge) {
  if (badge?.count) return `${badge.count} unread`;
  return badge?.dot ? 'Unread messages' : 'New message';
}

function badgeFor(app, badges) {
  const id = app.launch?.appId || app.launch?.bundleId;
  if (!id) return null;
  const found = Object.entries(badges)
    .filter(([k]) => k === id || k.startsWith(`${id}.`))
    .map(([, v]) => adjust(parseBadge(v), app.badgeOffset))
    .filter(Boolean);
  if (!found.length) return null;
  const counts = found.filter((b) => b.count).sort((a, b) => parseInt(b.count, 10) - parseInt(a.count, 10));
  return counts[0] || { dot: true };
}

// "chrome.exe" -> "Chrome", "google chrome.app" -> "Google chrome"
function prettyExe(exe) {
  const base = path.basename(exe).replace(/\.(exe|app)$/i, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const allApps = (config) => [...config.groups.flatMap((g) => g.apps), config.music].filter(Boolean);
// Title-constrained apps first, so a host-plus-title app (pythonw + title) wins over a plain pythonw match.
const byPriority = (config) => allApps(config).sort((a, b) => !!b.match.title - !!a.match.title);

// music is null when the music provider is 'none'.
function buildModel(windows, config, pings = {}, badges = {}) {
  const ordered = byPriority(config);
  const hits = new Map(allApps(config).map((a) => [a.id, []]));
  const other = new Map();

  for (const w of [...windows].sort((a, b) => a.hwnd - b.hwnd)) {
    const app = ordered.find((a) => matches(a, w));
    if (app) hits.get(app.id).push(w);
    else {
      if (!other.has(w.exe)) other.set(w.exe, { id: `other:${w.exe}`, name: prettyExe(w.exe), exePath: w.exePath, launch: { exe: w.exePath }, other: true, wins: [] });
      other.get(w.exe).wins.push(w);
    }
  }

  const toApp = (app, wins, badge = badgeFor(app, badges)) => ({
    id: app.id,
    name: app.name,
    other: !!app.other,
    running: wins.length > 0,
    exePath: wins[0]?.exePath || app.exePath || null,
    ...(wins[0]?.bundleId && { bundleId: wins[0].bundleId }), // mac: lets drag-to-group add it by bundle id
    unread: Math.max(0, ...wins.map((w) => titleCount(w.title))) || badge?.count || 0,
    pinged: !!pings[app.id] || !!badge?.dot,
    windows: wins.map(({ hwnd, title, minimized }) => ({ hwnd, title, minimized })),
  });

  const groups = config.groups.map((g) => ({ id: g.id, name: g.name, ping: !!g.pingGroup, apps: g.apps.map((a) => toApp(a, hits.get(a.id))) }));
  groups.push({ id: 'other', name: 'Other', ping: false, apps: [...other.values()].map((a) => toApp(a, a.wins)) });
  const music = config.music ? toApp(config.music, hits.get(config.music.id)) : null;
  return { groups, music };
}

const findApp = (config, id) => allApps(config).find((a) => a.id === id);
const appForWindow = (config, w) => byPriority(config).find((a) => matches(a, w)) || null;
// Apps in every ping group (pingGroup: true), in group order.
const pingApps = (config) => config.groups.filter((g) => g.pingGroup).flatMap((g) => g.apps);

module.exports = { badgeGrew, pingText, buildModel, findApp, appForWindow, pingApps, allApps, matches, titleCount, parseBadge, badgeFor };
