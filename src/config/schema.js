// config.json v2: defaults, validation and the v1 -> v2 migration (plan §5). Pure, no electron.
const catalog = require('./catalog');
const music = require('../music/index'); // not '../music': that's the renderer's music.js

const VERSION = 2;
const KEY_NAMES = ['switch', 'search', 'musicPrev', 'musicPlay', 'musicNext'];
const DEFAULTS = {
  version: VERSION,
  setupComplete: false,
  keys: { switch: 'Alt+Tab', search: 'Alt+`', musicPrev: 'Alt+[', musicPlay: 'Alt+\\', musicNext: 'Alt+]', takeOverSystemSwitcher: true },
  startAtLogin: true,
  socialMode: 'ping', // 'ping' | 'dnd'
  // display: 'focus' (the focused window's display) | 'primary' | 'mouse' | display id / label.
  // displayChosen: true once the user picked it in Settings (see upgradeDisplay).
  panels: { socials: false, music: false, display: 'focus' },
  groups: [],
  music: { provider: 'spotify' },
  voice: {
    enabled: false, engine: 'builtin', wakeWord: 'cubby',
    commands: { openAll: ['start'], closeAll: ['close everything'] },
    thresholds: { wake: 0.6, openAll: 0.75, closeAll: 0.8 },
  },
  labels: { closeAll: 'Close all' }, // wording of the Close All button / menu item / confirm
  deleteKey: { confirm: true, macQuit: true }, // Delete closes the hovered app: ask first; on mac quit the app (not just the window)
  apps: {}, // per-app overrides by id: name, tint, badgeOffset, launch fields
};
// Group ids the tray uses for its own columns: Other, the music strip and the "+ New group" drop zone.
const RESERVED_GROUP_IDS = ['other', 'music', 'new'];
const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const regexError = (s) => { try { new RegExp(s, 'i'); return null; } catch (e) { return e.message; } };

// v1 (hand-written, no "version"): replaceAltTab, startWithWindows, socialGroup, panels.spotify,
// voice: bool, socialMode 'visible', hard-coded keys. Unknown fields are carried over.
function migrateV1(v1) {
  const { replaceAltTab, hotkey, startWithWindows, socialGroup, socialMode, panels, voice, music: m, groups = [], ...rest } = v1;
  const p = panels || { socials: socialMode === 'visible' };
  return {
    version: VERSION,
    setupComplete: true,
    keys: { ...DEFAULTS.keys, search: hotkey || DEFAULTS.keys.search, takeOverSystemSwitcher: replaceAltTab !== false },
    startAtLogin: startWithWindows !== false,
    socialMode: socialMode === 'dnd' ? 'dnd' : 'ping',
    panels: { socials: !!p.socials, music: !!(p.music ?? p.spotify), display: DEFAULTS.panels.display },
    groups: groups.map((g) => (socialGroup && g.id === socialGroup ? { ...g, pingGroup: true } : g)),
    music: m ? { provider: 'spotify', ...m } : { provider: 'none' },
    // v1 treated a missing "voice" as on, and its Close All phrase was "kill force" (so keep that wording).
    voice: { ...clone(DEFAULTS.voice), enabled: voice !== false, commands: { ...DEFAULTS.voice.commands, closeAll: ['kill force'] } },
    labels: { closeAll: 'Kill all' },
    ...rest,
  };
}

// Fill missing fields (one level into keys / panels / music / voice) without touching what's there.
function withDefaults(c) {
  const d = clone(DEFAULTS);
  const v = c.voice || {};
  return {
    ...d, ...c,
    keys: { ...d.keys, ...c.keys },
    panels: { ...d.panels, ...c.panels },
    music: { ...d.music, ...c.music },
    voice: { ...d.voice, ...v, commands: { ...d.voice.commands, ...v.commands }, thresholds: { ...d.voice.thresholds, ...v.thresholds } },
    labels: { ...d.labels, ...c.labels },
    deleteKey: c.deleteKey != null && !isObj(c.deleteKey) ? c.deleteKey : { ...d.deleteKey, ...c.deleteKey }, // a non-object is left for validate
    apps: { ...c.apps },
  };
}

// One-time step for v2 files: 'primary' used to be the default, so a 'primary' nobody picked becomes
// 'focus' (panels follow the focused window). displayChosen: false marks it done, so a 'primary'
// typed in by hand later is left alone; Settings saves displayChosen: true. -> whether it changed c.
function upgradeDisplay(raw, c) {
  if (!isObj(raw.panels) || raw.panels.display !== 'primary' || 'displayChosen' in raw.panels) return false;
  c.panels.display = 'focus';
  c.panels.displayChosen = false;
  return true;
}

// One-time step: voice.commands/thresholds killAll -> closeAll (values untouched). A config whose old phrase
// was "kill force" also gets labels.closeAll = "Kill all", so existing users keep the wording they had.
// -> whether it changed c.
function renameKillAll(c) {
  const v = c.voice;
  if (!isObj(v)) return false;
  let changed = false;
  for (const k of ['commands', 'thresholds']) {
    if (!isObj(v[k]) || !('killAll' in v[k])) continue;
    const old = v[k].killAll;
    delete v[k].killAll;
    if (!(('closeAll') in v[k])) v[k].closeAll = old;
    changed = true;
  }
  const phrases = isObj(v.commands) ? v.commands.closeAll : null;
  if (changed && Array.isArray(phrases) && phrases.includes('kill force') && !c.labels?.closeAll) c.labels = { ...c.labels, closeAll: 'Kill all' };
  return changed;
}

// Modifier(s) + one key. A bare key would eat normal typing, so at least one modifier is required.
const ACCEL = /^(?:(?:alt|option|ctrl|control|cmdorctrl|commandorcontrol|shift|cmd|command|super|win|meta)\+)+(?:[a-z0-9`~[\]\\\-=;',./]|f(?:[1-9]|1\d|2[0-4])|tab|space|enter|return|escape|esc|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right)$/i;
const MOD_ALIAS = { option: 'alt', control: 'ctrl', cmdorctrl: 'ctrl', commandorcontrol: 'ctrl', command: 'cmd', super: 'win', meta: 'win' };
function normalizeAccel(a) {
  const parts = a.toLowerCase().split('+');
  const key = parts.pop().replace('~', '`');
  return [...new Set(parts.map((m) => MOD_ALIAS[m] || m))].sort().concat(key).join('+');
}
// Display label: "Alt+`" -> "Alt+~" (the key is labeled ~ on most keyboards); on macOS "Option+~".
const MAC_MODS = { alt: 'Option', option: 'Option', win: 'Cmd', cmd: 'Cmd', command: 'Cmd', super: 'Cmd', meta: 'Cmd' };
function keyLabel(a, platform = process.platform) {
  if (!a) return '';
  const parts = a.replace(/`$/, '~').split('+');
  const key = parts.pop();
  return (platform === 'darwin' ? parts.map((m) => MAC_MODS[m.toLowerCase()] || m) : parts).concat(key).join('+');
}

// The label's first word is the verb: "Kill all" -> "Kill" ("Kill 11 apps?", "Killing all apps").
const closeVerb = (label) => String(label || '').trim().split(/\s+/)[0] || 'Close';
const verbIng = (verb) => verb.replace(/e$/i, '') + 'ing';

function validate(c, platform) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (c.version !== VERSION) err(`"version" must be ${VERSION}`);
  const seen = {};
  for (const k of KEY_NAMES) {
    const a = c.keys[k];
    if (a == null || a === '') continue; // off
    if (typeof a !== 'string' || !ACCEL.test(a)) { err(`keys.${k}: "${a}" isn't a key combo like "Alt+\`"`); continue; }
    const n = normalizeAccel(a);
    if (seen[n]) err(`keys.${seen[n]} and keys.${k} are both "${a}"`);
    else seen[n] = k;
  }
  if (!['ping', 'dnd'].includes(c.socialMode)) err(`socialMode must be "ping" or "dnd", not "${c.socialMode}"`);
  if (!music.names().includes(c.music.provider)) err(`music.provider must be one of ${music.names().join(', ')}`);
  if (!Array.isArray(c.groups)) err('"groups" must be a list');
  const groupIds = new Set();
  const appIds = {};
  // match.title is a regex: one that doesn't compile is reported here, not thrown by every refresh.
  const checkTitle = (where, m) => {
    if (!isObj(m) || m.title == null) return;
    const e = typeof m.title === 'string' ? regexError(m.title) : 'not a string';
    if (e) err(`${where}: match.title "${m.title}" isn't a valid pattern (${e})`);
  };
  for (const [i, g] of (Array.isArray(c.groups) ? c.groups : []).entries()) {
    const where = `groups[${i}]${g?.name ? ` ("${g.name}")` : ''}`;
    if (!isObj(g) || typeof g.id !== 'string' || typeof g.name !== 'string') { err(`${where} needs an "id" and a "name"`); continue; }
    if (RESERVED_GROUP_IDS.includes(g.id.toLowerCase())) err(`${where}: group id "${g.id}" is reserved (${RESERVED_GROUP_IDS.join(', ')})`);
    if (groupIds.has(g.id)) err(`${where}: group id "${g.id}" is used twice`);
    groupIds.add(g.id);
    if (!Array.isArray(g.apps)) { err(`${where}: "apps" must be a list`); continue; }
    for (const a of g.apps) {
      if (typeof a === 'string') {
        if (!catalog.get(a, platform)) err(`${where}: unknown app "${a}" (not in the ${platform || catalog.platform} catalog)`);
      } else if (!isObj(a) || typeof a.id !== 'string' || typeof a.name !== 'string' || !isObj(a.match) || !Object.keys(a.match).some((k) => k !== 'title')) {
        err(`${where}: each app needs "id", "name" and "match" (e.g. { "exe": "app.exe" }), or a catalog id string`);
        continue;
      }
      if (typeof a !== 'string') checkTitle(`${where}, app "${a.id}"`, a.match);
      const id = catalog.entryId(a);
      if (appIds[id]) err(`app "${id}" is in two groups ("${appIds[id]}" and "${g.name}")`);
      appIds[id] = g.name;
    }
  }
  if (isObj(c.apps)) for (const [id, o] of Object.entries(c.apps)) checkTitle(`apps.${id}`, o?.match);
  checkTitle('music', c.music?.match);
  checkTitle('music.app', c.music?.app?.match);
  if (c.labels != null && (!isObj(c.labels) || (c.labels.closeAll != null && (typeof c.labels.closeAll !== 'string' || !c.labels.closeAll.trim())))) err('labels.closeAll must be a non-empty string');
  if (c.deleteKey != null) {
    if (!isObj(c.deleteKey)) err('deleteKey must be an object');
    else for (const k of ['confirm', 'macQuit']) if (c.deleteKey[k] != null && typeof c.deleteKey[k] !== 'boolean') err(`deleteKey.${k} must be true or false`);
  }
  const v = c.voice;
  if (typeof v.enabled !== 'boolean') err('voice.enabled must be true or false');
  if (typeof v.wakeWord !== 'string' || !v.wakeWord.trim()) err('voice.wakeWord must be a word');
  for (const k of ['openAll', 'closeAll']) {
    const list = v.commands[k];
    if (!Array.isArray(list) || !list.length || !list.every((p) => typeof p === 'string' && p.trim())) err(`voice.commands.${k} must be a list of at least one phrase`);
  }
  for (const [k, t] of Object.entries(v.thresholds)) if (typeof t !== 'number' || t < 0 || t > 1) err(`voice.thresholds.${k} must be between 0 and 1`);
  return errors;
}

// config.json text -> { config, migrated, upgraded, errors }. Throws on invalid JSON (caller shows it).
// migrated: was v1 (keep a backup, save). upgraded: a v2 file that a one-time step changed (save).
function load(text, platform) {
  const raw = JSON.parse(text.replace(/^﻿/, '')); // Notepad/PowerShell may add a BOM
  if (!isObj(raw)) return { config: null, migrated: false, upgraded: false, errors: ['config.json must be a JSON object { ... }'] };
  if (raw.version > VERSION) return { config: null, migrated: false, upgraded: false, errors: [`config.json is version ${raw.version}, made by a newer Cubby`] };
  // v1 never had "keys" or pingGroup: a file with those but no "version" is a hand-written v2.
  const v2Shape = isObj(raw.keys) || (Array.isArray(raw.groups) && raw.groups.some((g) => isObj(g) && 'pingGroup' in g));
  const migrated = raw.version ? raw.version < VERSION : !v2Shape;
  const src = migrated ? migrateV1(raw) : clone({ ...raw, version: VERSION });
  const renamed = !migrated && renameKillAll(src);
  const config = withDefaults(src);
  const upgraded = (!migrated && upgradeDisplay(raw, config)) || renamed;
  return { config, migrated, upgraded, errors: validate(config, platform) };
}

module.exports = { VERSION, DEFAULTS, KEY_NAMES, RESERVED_GROUP_IDS, migrateV1, withDefaults, validate, load, keyLabel, normalizeAccel, closeVerb, verbIng };
