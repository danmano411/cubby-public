// Setup wizard + Settings page (renderer). It edits a draft copy of config.json in S.draft; the main
// process (features/setup.js) validates and writes it on Save. 'wizard' walks the steps in order,
// 'settings' shows the same sections from a sidebar.
'use strict';

const STEPS = [
  { id: 'welcome', title: 'Welcome', mac: 'Permissions' },
  { id: 'keys', title: 'Keys' },
  { id: 'groups', title: 'Groups' },
  { id: 'apps', title: 'Apps' },
  { id: 'music', title: 'Music player' },
  { id: 'panels', title: 'Side panels' },
  { id: 'startup', title: 'Startup & voice' },
  { id: 'done', title: 'All set' },
];
// Group templates: which catalog categories each one collects (for "Add detected apps").
const TEMPLATES = [
  { id: 'social', name: 'Social', ping: true, cats: ['Social'] },
  { id: 'work', name: 'Work', cats: ['IDE', 'Notes'] },
  { id: 'browsers', name: 'Browsers', cats: ['Browsers'] },
  { id: 'utilities', name: 'Utilities', cats: ['Utilities'] },
];
const KEYS = {
  switch: { label: 'Switch apps', sub: 'Hold the modifier and tap the key to cycle; let go to switch. A quick tap goes to the previous app.' },
  search: { label: 'Search and open the tray', sub: 'Opens the tray and keeps it open for typing.' },
  musicPrev: { label: 'Music: previous track', music: true },
  musicPlay: { label: 'Music: play / pause', music: true },
  musicNext: { label: 'Music: next track', music: true },
};
const PERMISSIONS = [
  { id: 'accessibility', name: 'Accessibility', why: 'Focus, move and close windows.' },
  { id: 'screen', name: 'Screen Recording', why: 'Read window titles. Without it Cubby shows app names only.' },
  { id: 'input', name: 'Input Monitoring', why: 'Listen for your global keys.' },
  { id: 'microphone', name: 'Microphone and Speech Recognition', why: 'Only if you turn voice on.', pane: 'microphone' },
];

const $ = (s) => document.querySelector(s);
const clone = (o) => JSON.parse(JSON.stringify(o));
const page = $('#page');
const nav = $('#nav');
const foot = $('#foot');

const S = {
  ready: false, mode: 'wizard', platform: 'win32', step: 0, seen: 0,
  draft: null, base: '', firstRun: false, autofill: false,
  displays: [], providers: [], catalog: [], defaults: null,
  cands: null, icons: {}, query: '', target: null, drag: null, redrawLater: false,
  rec: null, recNote: '', errors: [], saving: false, savedAt: 0, perms: {}, vt: { wake: '', open: '', close: '' },
};

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled') e[k] = v;
    else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const steps = () => (S.mode === 'wizard' ? STEPS : STEPS.filter((s) => (s.id === 'welcome' ? S.platform === 'darwin' : s.id !== 'done')));
const stepId = () => steps()[S.step]?.id;
const isMac = () => S.platform === 'darwin';
const dirty = () => !!S.draft && JSON.stringify(S.draft) !== S.base;

// ---- Keys -----------------------------------------------------------------------

const MOD_ALIAS = { option: 'alt', control: 'ctrl', cmdorctrl: 'ctrl', commandorcontrol: 'ctrl', command: 'win', cmd: 'win', super: 'win', meta: 'win' };
function parseAccel(a) {
  if (!a) return null;
  const parts = a.split('+');
  let key = parts.pop().toLowerCase();
  if (key === '~') key = '`';
  const mods = new Set(parts.map((p) => MOD_ALIAS[p.toLowerCase()] || p.toLowerCase()));
  return { mods, key };
}
const normAccel = (a) => { const p = parseAccel(a); return p ? [...p.mods].sort().concat(p.key).join('+') : ''; };

// "Alt+`" -> ["Alt", "~"]; on macOS Alt reads Option and Win reads Cmd.
function keyParts(a) {
  if (!a) return [];
  return a.split('+').map((raw) => {
    const p = raw.toLowerCase();
    if (p === 'alt' || p === 'option') return isMac() ? 'Option' : 'Alt';
    if (p === 'win' || p === 'cmd' || p === 'command' || p === 'super' || p === 'meta') return isMac() ? 'Cmd' : 'Win';
    if (p === 'ctrl' || p === 'control') return 'Ctrl';
    if (raw === '`') return '~';
    return raw.length === 1 ? raw.toUpperCase() : raw;
  });
}
const chips = (a) => {
  const parts = keyParts(a);
  return el('span', { class: 'chips' }, parts.flatMap((p, i) => [i ? el('span', { class: 'plus' }, '+') : null, el('kbd', null, p)]));
};
const keyText = (a) => keyParts(a).join('+');

const NAMED = { Tab: 'Tab', Space: 'Space', Enter: 'Enter', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
const PUNCT = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };
function keyFromCode(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^F(\d{1,2})$/.exec(code)) && m[1] >= 1 && m[1] <= 24) return `F${m[1]}`;
  return NAMED[code] || PUNCT[code] || null;
}

// Things worth knowing before binding a combo. `bad` blocks Next; the rest are advice.
function keyIssues(name, accel) {
  const p = parseAccel(accel);
  if (!p) return [];
  const out = [];
  const warn = (text) => out.push({ text });
  const m = p.mods;
  const only = (...x) => m.size === x.length && x.every((k) => m.has(k));
  const pretty = keyText(accel);
  if (!isMac()) {
    if (m.has('alt') && p.key === 'f4') warn(`${pretty} closes the active window in Windows.`);
    if ((m.has('alt') || m.has('ctrl')) && (p.key === 'escape' || (only('alt') && p.key === 'space'))) warn(`${pretty} is a Windows system shortcut.`);
    if (only('ctrl', 'shift') && p.key === 'escape') warn('Ctrl+Shift+Esc opens Task Manager.');
    if (m.has('win')) warn('Windows keeps most Win+ shortcuts for itself, so this one may not reach Cubby.');
    if (only('alt') && p.key === 'tab' && name !== 'switch') warn("Alt+Tab is Windows' own switcher. Use it for the switch key.");
    if (only('alt', 'shift') || only('ctrl', 'shift')) warn(`${pretty} also switches your keyboard layout when you have more than one installed. Cubby will take it before Windows does.`);
    if (m.has('ctrl') && m.has('alt') && !m.has('win') && /^[a-z0-9]$/.test(p.key)) warn('Ctrl+Alt is AltGr on many keyboard layouts, so this can stop you typing some characters.');
    if (only('alt') && /^[a-z0-9]$/.test(p.key)) warn(`${pretty} opens a menu in many apps. Cubby will take it everywhere.`);
  } else {
    if (only('win') && p.key === 'tab') {
      if (name === 'switch') warn('Experimental: macOS owns Cmd+Tab. Cubby asks the system to hand it over, and that may not always work. Option+Tab is the safe choice.');
      else warn("Cmd+Tab is macOS's own switcher.");
    }
    if (only('win') && ['space', 'q', 'w', 'h', 'm', 'c', 'v', 'x', 'z', 'a', 's', 'n', 't'].includes(p.key)) warn(`${pretty} is used by macOS or by most apps.`);
    if (only('ctrl') && p.key === 'space') warn('Ctrl+Space switches the input source on macOS.');
    if (only('alt') && /^[a-z0-9]$/.test(p.key)) warn(`${pretty} types a special character on macOS. Cubby will take it everywhere.`);
  }
  return out;
}

// -> { [key name]: [issue] } including duplicates between the five keys.
function allKeyIssues() {
  const k = S.draft.keys;
  const res = {};
  const byNorm = {};
  for (const n of Object.keys(KEYS)) {
    res[n] = keyIssues(n, k[n]);
    const norm = normAccel(k[n]);
    if (norm) (byNorm[norm] = byNorm[norm] || []).push(n);
  }
  for (const names of Object.values(byNorm)) {
    if (names.length < 2) continue;
    for (const n of names) res[n].unshift({ bad: true, text: `Same combo as "${names.filter((x) => x !== n).map((x) => KEYS[x].label).join('", "')}". Each key needs its own.` });
  }
  return res;
}

function setKey(name, value) {
  S.draft.keys[name] = value;
  syncTakeOver();
  render();
}
// The switch key only works while takeOverSystemSwitcher is on, so anything but Windows' own Alt+Tab
// keeps it on. Alt+Tab on Windows is the one place the user can turn it off.
function syncTakeOver() {
  const k = S.draft.keys;
  const isAltTab = normAccel(k.switch) === 'alt+tab';
  if (isMac() || !isAltTab) k.takeOverSystemSwitcher = true;
}

// While recording, main lifts its global key hook so the combo reaches this page.
function startRecording(name) {
  S.rec = { name, mods: [] };
  S.recNote = '';
  cubby.send('setup:recording', true);
  render();
}
function stopRecording() { S.rec = null; S.recNote = ''; cubby.send('setup:recording', false); render(); }

window.addEventListener('keydown', (e) => {
  if (!S.rec) return;
  e.preventDefault();
  e.stopPropagation();
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && (isMac() ? 'Cmd' : 'Win')].filter(Boolean);
  if (/^(Control|Alt|Shift|Meta|AltGraph|OS)/.test(e.key) || /^(Control|Alt|Shift|Meta|OS)/.test(e.code)) { // still holding modifiers: preview
    S.rec.mods = mods;
    const live = $('#rec-live');
    if (live) live.textContent = mods.length ? `${mods.map((m) => keyText(m)).join('+')}+…` : 'Press the new combo…';
    return;
  }
  if (e.code === 'Escape' && !mods.length) return stopRecording();
  const key = keyFromCode(e.code);
  if (!key) { S.recNote = "That key can't be used. Try a letter, number, F-key or punctuation key."; return render(); }
  if (!mods.filter((m) => m !== 'Shift').length) { S.recNote = `Hold ${isMac() ? 'Option, Ctrl or Cmd' : 'Alt, Ctrl or Win'} while you press the key, so normal typing still works.`; return render(); }
  const name = S.rec.name;
  S.rec = null;
  S.recNote = '';
  cubby.send('setup:recording', false);
  setKey(name, [...mods, key].join('+'));
}, true);
window.addEventListener('blur', () => { if (S.rec) { S.rec.mods = []; const live = $('#rec-live'); if (live) live.textContent = 'Press the new combo…'; } });

// ---- Draft edits ----------------------------------------------------------------------

const entryId = (e) => (typeof e === 'string' ? e : e.id);
const musicRef = () => S.providers.find((p) => p.name === S.draft.music.provider)?.appRef || null;
const groupOf = (id) => S.draft.groups.find((g) => g.apps.some((a) => entryId(a) === id));
const appInfo = (e) => {
  if (typeof e !== 'string') return { id: e.id, name: e.name };
  const c = S.catalog.find((x) => x.id === e);
  return { id: e, name: c ? c.name : e };
};
function uniqueGroupId(base) {
  const ids = new Set(S.draft.groups.map((g) => g.id));
  let id = base;
  for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
  return id;
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';

function addGroup(name, { ping = false, id } = {}) {
  const g = { id: uniqueGroupId(id || slug(name)), name, apps: [] };
  if (ping) g.pingGroup = true;
  S.draft.groups.push(g);
  S.target = S.target || g.id;
  return g;
}
function moveGroup(i, d) {
  const gs = S.draft.groups;
  const j = i + d;
  if (j < 0 || j >= gs.length) return;
  [gs[i], gs[j]] = [gs[j], gs[i]];
  render();
}
function deleteGroup(i) {
  const g = S.draft.groups[i];
  if (g.apps.length && !confirm(`Delete "${g.name}"? Its ${g.apps.length} app${g.apps.length > 1 ? 's' : ''} will go back to Other.`)) return;
  S.draft.groups.splice(i, 1);
  if (S.target === g.id) S.target = S.draft.groups[0]?.id || null;
  render();
}
function removeApp(id) {
  for (const g of S.draft.groups) g.apps = g.apps.filter((a) => entryId(a) !== id);
}
// Put an app in a group (at index, else the end). An app lives in exactly one group.
function placeApp(entry, gid, index) {
  const id = entryId(entry);
  const ref = musicRef();
  if (ref && id === ref) return flash(`${appInfo(entry).name} lives in the music strip, not in a group.`);
  const g = S.draft.groups.find((x) => x.id === gid);
  if (!g) return flash('Add a group first.');
  const old = g.apps.findIndex((a) => entryId(a) === id);
  if (old >= 0 && index != null && old < index) index -= 1;
  removeApp(id);
  g.apps.splice(index == null ? g.apps.length : Math.min(index, g.apps.length), 0, clone(entry));
  S.target = gid;
}
function suggestedGroup(c) {
  const t = TEMPLATES.find((x) => x.cats.includes(c.category));
  return t && S.draft.groups.find((g) => g.id === t.id || (t.ping && g.pingGroup && !S.draft.groups.some((x) => x.id === t.id)));
}
// Catalog apps found on this PC go into the group their category belongs to.
function autofill() {
  let n = 0;
  const ref = musicRef();
  for (const c of S.cands || []) {
    if (!c.detected || typeof c.entry !== 'string' || c.id === ref || groupOf(c.id)) continue;
    const g = suggestedGroup(c);
    if (g) { g.apps.push(c.entry); n++; }
  }
  return n;
}

let flashTimer;
function flash(text) {
  document.querySelector('.toast')?.remove();
  document.body.append(el('div', { class: 'toast', role: 'status' }, text));
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => document.querySelector('.toast')?.remove(), 2600);
}

// ---- Small components -----------------------------------------------------------------------

function switchEl(checked, onChange, label, disabled) {
  const input = el('input', { type: 'checkbox', checked, disabled, 'aria-label': label, onchange: (e) => onChange(e.target.checked) });
  return el('span', { class: 'switch' }, input, el('i'));
}
function toggleRow(label, sub, checked, onChange, disabled) {
  return el('div', { class: `row-card${disabled ? ' dim' : ''}` }, el('div', { class: 'grow' }, el('div', { class: 'label' }, label), sub && el('div', { class: 'sub' }, sub)), switchEl(checked, onChange, label, disabled));
}
function options(list, value, onPick) {
  return el('div', { class: 'opts', role: 'radiogroup' }, list.map((o) => el('label', { class: `opt${o.value === value ? ' on' : ''}${o.disabled ? ' disabled' : ''}` },
    el('input', { type: 'radio', name: 'opt', checked: o.value === value, disabled: o.disabled, onchange: () => onPick(o.value) }),
    el('div', { class: 'grow' }, el('div', { class: 'label' }, o.label), o.sub && el('div', { class: 'sub' }, o.sub)),
    o.tag && el('span', { class: `tag ${o.tagClass || ''}` }, o.tag))));
}
const head = (title, lede) => [el('h1', null, title), lede && el('p', { class: 'lede' }, lede)];

// ---- Pages -------------------------------------------------------------------------------------

function permRow(p) {
  const st = S.perms[p.id];
  return el('div', { class: 'perm' },
    el('div', null, el('b', null, p.name), el('span', { class: 'why' }, p.why)),
    st === 'granted' ? el('span', { class: 'tag ok' }, 'Allowed') : null,
    el('button', { class: 'btn small', onclick: () => cubby.send('setup:open-pane', p.pane || p.id) }, 'Open System Settings'));
}

function welcomePage() {
  const intro = S.mode === 'wizard'
    ? [el('div', { class: 'hero' }, el('span', { class: 'logo' }), el('div', null, el('h1', null, 'Welcome to Cubby'), el('p', { class: 'lede', style: 'margin:0' }, 'Your apps, in groups, one key away. Setup takes about a minute and you can change everything later in Settings.'))),
      el('ul', { class: 'points' },
        el('li', null, el('div', null, el('b', null, 'One key to switch'), el('span', null, 'Cycle through your open windows, grouped by app.'))),
        el('li', null, el('div', null, el('b', null, 'One key to search'), el('span', null, 'Type a few letters to jump to, or launch, any app.'))),
        el('li', null, el('div', null, el('b', null, 'Groups, pings and music'), el('span', null, 'Sort apps into groups, get a small toast when chat apps want you, and control music from the side.'))))]
    : head('Permissions', 'Cubby keeps working in a reduced mode when one of these is off.');
  const perms = isMac()
    ? [el('h3', null, 'Permissions'), el('p', { class: 'note', style: 'margin:-2px 0 10px' }, 'macOS asks for these once. Open each pane and switch Cubby on.'), PERMISSIONS.map(permRow)]
    : [];
  return [...intro, ...perms];
}

function keysPage() {
  const issues = allKeyIssues();
  const k = S.draft.keys;
  const row = (name) => {
    const info = KEYS[name];
    const rec = S.rec?.name === name;
    const list = issues[name];
    const bad = list.some((i) => i.bad);
    const muted = info.music && S.draft.music.provider === 'none';
    return el('div', { class: `keyrow${rec ? ' rec' : ''}${bad ? ' bad' : ''}${muted ? ' dim' : ''}`, style: muted ? 'opacity:.5' : null },
      el('div', null, el('div', { class: 'label' }, info.label), info.sub && el('div', { class: 'sub' }, info.sub)),
      rec ? el('span', { class: 'listening', id: 'rec-live' }, 'Press the new combo…') : k[name] ? chips(k[name]) : el('span', { class: 'off' }, 'Off'),
      el('div', { class: 'acts' },
        rec ? el('button', { class: 'btn small', onclick: stopRecording }, 'Cancel') : el('button', { class: 'btn small', onclick: () => startRecording(name) }, 'Change'),
        !rec && normAccel(k[name]) !== normAccel(S.defaults.keys[name]) ? el('button', { class: 'btn small quiet', title: `Back to ${keyText(S.defaults.keys[name])}`, onclick: () => setKey(name, S.defaults.keys[name]) }, 'Reset') : null,
        !rec && k[name] ? el('button', { class: 'btn small quiet', title: 'Turn this key off', onclick: () => setKey(name, '') }, 'Turn off') : null),
      (rec && S.recNote) || list.length ? el('div', { class: 'issues' }, rec && S.recNote ? el('div', { class: 'issue bad' }, S.recNote) : null, !rec && list.map((i) => el('div', { class: `issue${i.bad ? ' bad' : ''}` }, i.text))) : null);
  };
  const out = [...head('Keys', 'Two keys do most of the work. Click Change, then press the combo you want.')];
  out.push(row('switch'));
  const altTab = normAccel(k.switch) === 'alt+tab';
  if (!isMac() && altTab) {
    out.push(toggleRow('Replace Alt+Tab', "On: Cubby's switcher opens instead of Windows'. Off: Alt+Tab stays with Windows and only the search key opens Cubby.", !!k.takeOverSystemSwitcher, (on) => { k.takeOverSystemSwitcher = on; render(); }));
  }
  if (isMac()) {
    const cmd = normAccel(k.switch) === 'win+tab';
    out.push(toggleRow('Use Cmd+Tab instead (experimental)', 'Option+Tab is the safe default. Cmd+Tab is macOS\'s own switcher, and Cubby can only take it over with a keyboard tap.', cmd, (on) => setKey('switch', on ? 'Cmd+Tab' : S.defaults.keys.switch)));
  }
  out.push(row('search'));
  out.push(el('h3', null, 'Music keys'));
  if (S.draft.music.provider === 'none') out.push(el('p', { class: 'note', style: 'margin:-4px 0 8px' }, 'These do nothing while the music player is set to None.'));
  for (const n of ['musicPrev', 'musicPlay', 'musicNext']) out.push(row(n));
  if (!k.switch && !k.search) out.push(el('div', { class: 'banner warn' }, 'Both main keys are off. You can still open Cubby from the tray icon.'));
  return out;
}

function groupsPage() {
  const gs = S.draft.groups;
  const out = [...head('Groups', 'Groups are the columns in your tray. Start from a template, then rename, reorder or delete them.')];
  out.push(el('div', { class: 'chiprow' },
    el('span', { class: 'lab' }, 'Add:'),
    TEMPLATES.map((t) => el('button', { class: 'btn small', disabled: gs.some((g) => g.id === t.id), onclick: () => { addGroup(t.name, { ping: !!t.ping, id: t.id }); autofillNew(t); render(); } }, `+ ${t.name}`)),
    el('button', { class: 'btn small', onclick: () => { const g = addGroup('New group'); S.focus = g.id; render(); } }, '+ Blank group'),
    gs.length ? el('button', { class: 'btn small quiet danger', onclick: () => { if (!gs.some((g) => g.apps.length) || confirm('Remove all groups and the apps in them?')) { S.draft.groups = []; S.target = null; render(); } } }, 'Start over') : null));
  if (!gs.length) out.push(el('div', { class: 'banner warn' }, 'No groups yet. Every app will show up under Other.'));
  gs.forEach((g, i) => {
    out.push(el('div', { class: 'grow-row' },
      el('input', { type: 'text', value: g.name, maxlength: 40, 'data-g': g.id, 'aria-label': 'Group name', spellcheck: 'false', oninput: (e) => { g.name = e.target.value; renderFoot(); } }),
      el('label', { class: `ping${g.pingGroup ? ' on' : ''}`, title: 'Ping groups raise a toast and show in the Socials side strip' }, switchEl(!!g.pingGroup, (on) => { if (on) g.pingGroup = true; else delete g.pingGroup; render(); }, `${g.name} is a ping group`), 'Ping group'),
      el('span', { class: 'count' }, `${g.apps.length} app${g.apps.length === 1 ? '' : 's'}`),
      el('span', { class: 'acts', style: 'display:flex;gap:2px' },
        el('button', { class: 'btn icon quiet', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => moveGroup(i, -1) }, '▲'),
        el('button', { class: 'btn icon quiet', title: 'Move down', 'aria-label': 'Move down', disabled: i === gs.length - 1, onclick: () => moveGroup(i, 1) }, '▼'),
        el('button', { class: 'btn icon quiet danger', title: 'Delete group', 'aria-label': 'Delete group', onclick: () => deleteGroup(i) }, '✕'))));
  });
  out.push(el('p', { class: 'note' }, 'Ping groups: apps in them raise a small toast when they want your attention, and appear in the Socials side strip. Mark as many groups as you like.'));
  return out;
}
// A template added after the app list loaded takes its detected apps straight away.
function autofillNew(t) {
  const g = S.draft.groups.find((x) => x.id === t.id);
  if (!g || !S.cands) return;
  for (const c of S.cands) if (c.detected && typeof c.entry === 'string' && t.cats.includes(c.category) && !groupOf(c.id) && c.id !== musicRef()) g.apps.push(c.entry);
}

function candSub(c) {
  const where = c.open ? [el('span', { class: 'live' }), 'Open now'] : c.installed ? ['Installed'] : c.detected ? ['Found'] : ['Not detected'];
  return [c.category ? `${c.category} · ` : '', ...where, c.launchOnly ? ' · launch only' : ''];
}
function dragProps(entry, from) {
  return {
    draggable: 'true',
    ondragstart: (e) => { S.drag = { entry, from }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', entryId(entry)); e.currentTarget.classList.add('dragging'); },
    ondragend: () => { S.drag = null; document.querySelectorAll('.dragging,.over,.ins').forEach((n) => n.classList.remove('dragging', 'over', 'ins')); if (S.redrawLater) { S.redrawLater = false; render(); } },
  };
}
function drawCands() {
  const list = $('#cand-list');
  if (!list) return;
  const q = S.query.trim().toLowerCase();
  const ref = musicRef();
  const placed = {};
  for (const g of S.draft.groups) for (const a of g.apps) placed[entryId(a)] = g.name;
  if (!S.cands) return list.replaceChildren(el('div', { class: 'empty' }, 'Looking for apps…'));
  const shown = S.cands.filter((c) => c.id !== ref && (q ? `${c.name} ${c.category}`.toLowerCase().includes(q) : c.detected));
  if (!shown.length) return list.replaceChildren(el('div', { class: 'empty' }, q ? 'No app matches. Open the app and press Rescan.' : 'No apps found yet. Search the catalog, or open an app and press Rescan.'));
  list.replaceChildren(...shown.slice(0, 300).map((c) => el('div', { class: `app${placed[c.id] ? ' placed' : ''}`, title: placed[c.id] ? `In ${placed[c.id]}. Click to move it to the selected group.` : 'Click to add to the selected group, or drag it onto a group', ...dragProps(c.entry, 'cand'), onclick: () => { placeApp(c.entry, S.target || S.draft.groups[0]?.id); render(); } },
    iconEl(c.id, c.name, S.icons, null),
    el('div', { class: 'text' }, el('div', { class: 'name' }, c.name), el('div', { class: 'sub' }, placed[c.id] ? `In ${placed[c.id]}` : candSub(c))),
    placed[c.id] ? null : el('span', { class: 'add' }, '+'))));
}
function appsPage() {
  const gs = S.draft.groups;
  if (!S.target || !gs.some((g) => g.id === S.target)) S.target = gs[0]?.id || null;
  const out = [...head('Apps', 'Put your apps into groups. Click an app to add it to the highlighted group, or drag it onto any group.')];
  const detected = (S.cands || []).filter((c) => c.detected && typeof c.entry === 'string' && c.id !== musicRef() && !groupOf(c.id) && suggestedGroup(c)).length;
  const search = el('input', { class: 'search', type: 'search', placeholder: 'Search installed and open apps…', value: S.query, spellcheck: 'false', 'aria-label': 'Search apps', oninput: (e) => { S.query = e.target.value; drawCands(); } });
  const list = el('div', { id: 'cand-list',
    ondragover: (e) => { if (S.drag?.from === 'group') { e.preventDefault(); e.currentTarget.classList.add('over'); } },
    ondragleave: (e) => e.currentTarget.classList.remove('over'),
    ondrop: (e) => { if (S.drag?.from === 'group') { e.preventDefault(); removeApp(entryId(S.drag.entry)); render(); } } });
  const left = el('div', { class: 'cands' }, search, list,
    el('div', { class: 'chiprow', style: 'margin:10px 0 0' },
      el('button', { class: 'btn small', onclick: () => { S.cands = null; cubby.send('setup:apps'); drawCands(); } }, 'Rescan'),
      detected ? el('button', { class: 'btn small', onclick: () => { const n = autofill(); flash(n ? `Added ${n} app${n > 1 ? 's' : ''} to their groups.` : 'Nothing to add.'); render(); } }, `Add ${detected} detected app${detected > 1 ? 's' : ''} to matching groups`) : null),
    el('p', { class: 'note faint' }, 'Drag an app from a group back here to take it out. Apps that are open but not in a group stay under Other in the tray.'));
  out.push(el('div', { class: 'apps' }, left, el('div', { class: 'cards' }, cardsEl())));
  return out;
}
function cardsEl() {
  const gs = S.draft.groups;
  return gs.length ? gs.map((g) => el('div', { class: `card${g.id === S.target ? ' target' : ''}`, 'data-g': g.id,
    ondragover: (e) => { if (S.drag) { e.preventDefault(); e.currentTarget.classList.add('over'); } },
    ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('over'); },
    ondrop: (e) => { if (!S.drag) return; e.preventDefault(); const d = S.drag; S.drag = null; placeApp(d.entry, g.id); render(); } },
    el('h4', { onclick: () => { S.target = g.id; render(); } }, g.name || 'Group', g.pingGroup ? el('span', { class: 'pingtag' }, '· pings') : null, g.id === S.target ? el('span', { class: 'pingtag', style: 'margin-left:auto' }, 'adding here') : null),
    g.apps.length ? g.apps.map((a, i) => {
      const info = appInfo(a);
      return el('div', { class: 'app', ...dragProps(a, 'group'),
        ondragover: (e) => { if (S.drag) { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add('ins'); } },
        ondragleave: (e) => e.currentTarget.classList.remove('ins'),
        ondrop: (e) => { if (!S.drag) return; e.preventDefault(); e.stopPropagation(); const d = S.drag; S.drag = null; placeApp(d.entry, g.id, i); render(); } },
      iconEl(info.id, info.name, S.icons, null), el('div', { class: 'text' }, el('div', { class: 'name' }, info.name)),
      el('button', { class: 'x', title: 'Remove from group', 'aria-label': `Remove ${info.name}`, onclick: (e) => { e.stopPropagation(); removeApp(info.id); render(); } }, '✕'));
    }) : el('div', { class: 'drop-hint' }, 'Drop apps here')))
    : [el('div', { class: 'banner warn' }, 'Add a group on the Groups step first.')];
}

function musicPage() {
  const cur = S.draft.music.provider;
  return [...head('Music player', 'Cubby shows what is playing in the tray and in a side panel, and the music keys control it.'),
    options(S.providers.map((p) => ({ value: p.name, label: p.label, sub: p.note, disabled: !p.available, tag: p.available ? null : 'Coming soon', tagClass: 'soon' })), cur, (v) => { S.draft.music.provider = v; if (v === 'none') S.draft.panels.music = false; render(); })];
}

function panelsPage() {
  const p = S.draft.panels;
  const noMusic = S.draft.music.provider === 'none';
  const out = [...head('Side panels', 'Slim panels on the edge of your screen that stay out of the way until you need them.')];
  out.push(toggleRow('Socials', 'A strip of your ping-group apps with unread badges.', !!p.socials, (on) => { p.socials = on; render(); }));
  out.push(toggleRow('Music', noMusic ? 'Pick a music player first.' : 'A now-playing card with controls.', !!p.music && !noMusic, (on) => { p.music = on; render(); }, noMusic));
  if (p.socials && !S.draft.groups.some((g) => g.pingGroup)) out.push(el('div', { class: 'banner warn' }, 'The Socials strip is empty until a group is marked as a ping group (Groups step).'));
  out.push(el('h3', null, 'Show side panels on'));
  if (S.displays.length < 2) out.push(el('p', { class: 'note', style: 'margin:0' }, 'Only one display is connected. Connect another and you can choose which one the panels use.'));
  else {
    const list = [{ value: 'focus', label: 'Follow the focused window', sub: 'Panels move to the display of the window you are working in.' },
      { value: 'primary', label: 'Main display', sub: `The display marked as main in system settings (${S.displays.find((d) => d.primary)?.label || 'main'}).` },
      { value: 'mouse', label: 'Display with the mouse', sub: 'Panels move to whichever display the pointer is on.' },
      ...S.displays.map((d) => ({ value: d.setting, label: d.label, sub: `${d.width}×${d.height}${d.primary ? ' · main display' : ''}` }))];
    const cur = p.display || 'focus';
    if (!list.some((o) => o.value === cur)) list.push({ value: cur, label: cur, sub: 'Not connected right now. Panels use the main display until it is back.' });
    out.push(options(list, cur, (v) => { p.display = v; render(); }));
  }
  return out;
}

const cleanPhrase = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const splitPhrases = (s) => s.split(',').map(cleanPhrase).filter(Boolean);
function voiceProblems() {
  if (!S.draft.voice.enabled) return {};
  const p = {};
  if (!cleanPhrase(S.vt.wake)) p.wake = 'Pick a wake word.';
  if (!splitPhrases(S.vt.open).length) p.open = 'Add at least one phrase.';
  if (!splitPhrases(S.vt.close).length) p.close = 'Add at least one phrase.';
  return p;
}
function syncVoice() {
  const v = S.draft.voice;
  v.wakeWord = cleanPhrase(S.vt.wake) || v.wakeWord;
  if (splitPhrases(S.vt.open).length) v.commands.openAll = splitPhrases(S.vt.open);
  if (splitPhrases(S.vt.close).length) v.commands.closeAll = splitPhrases(S.vt.close);
}
function startupPage() {
  const v = S.draft.voice;
  const out = [...head('Startup & voice')];
  out.push(toggleRow(isMac() ? 'Open Cubby at login' : 'Start Cubby with Windows', 'Cubby runs quietly in the tray so your keys always work.', !!S.draft.startAtLogin, (on) => { S.draft.startAtLogin = on; renderFoot(); }));
  out.push(toggleRow('Voice commands', 'Say a wake word and a command, like "Cubby start" to open all your apps. Off by default. Runs offline on this PC.', !!v.enabled, (on) => { v.enabled = on; render(); }));
  if (v.enabled) {
    const bad = voiceProblems();
    const field = (key, label, hint) => el('div', { class: `field${bad[key] ? ' bad' : ''}` }, el('label', null, label), el('input', { type: 'text', value: S.vt[key], spellcheck: 'false', autocomplete: 'off', 'aria-label': label,
      oninput: (e) => { S.vt[key] = e.target.value; syncVoice(); const sayEl = $('#say'); if (sayEl) sayEl.replaceChildren(...sayNodes()); renderFoot(); } }), el('div', { class: 'note', style: 'margin-top:3px' }, bad[key] || hint));
    out.push(el('h3', null, 'Speech engine'));
    out.push(options([
      { value: 'builtin', label: 'Built-in', sub: isMac() ? 'On-device speech recognition from macOS. No download.' : 'Windows speech recognition. No download.', tag: 'Default' },
      { value: 'vosk', label: 'Download Vosk (~40 MB, more accurate) - coming soon', sub: 'An optional offline engine you can add later.', disabled: true },
    ], 'builtin', () => {}));
    out.push(el('h3', null, 'Phrases'));
    out.push(el('div', { class: 'fields' },
      field('wake', 'Wake word', 'Say this first. Pick something you do not say in normal conversation.'),
      field('open', 'Open all apps', 'Separate several phrases with commas.'),
      field('close', 'Close all apps', 'This closes every app in your groups, so use a phrase that is hard to say by accident.')));
    out.push(el('div', { class: 'say', id: 'say' }, ...sayNodes()));
    out.push(el('p', { class: 'note faint' }, 'Letters, numbers and spaces only. Cubby needs microphone access while voice is on.'));
  }
  out.push(el('h3', null, 'Close all'));
  out.push(el('div', { class: 'field' }, el('label', null, 'Button label'), el('input', { type: 'text', value: S.draft.labels?.closeAll || '', placeholder: 'Close all', spellcheck: 'false', 'aria-label': 'Button label',
    oninput: (e) => { const t = e.target.value.trim(); S.draft.labels = { ...S.draft.labels, closeAll: t || 'Close all' }; renderFoot(); } }), el('div', { class: 'note', style: 'margin-top:3px' }, 'Optional. The first word is used in the confirm text, like "Close 5 apps?".')));
  return out;
}
function sayNodes() {
  const w = cleanPhrase(S.vt.wake) || '…';
  const o = splitPhrases(S.vt.open)[0] || '…';
  const k = splitPhrases(S.vt.close)[0] || '…';
  return ['Try saying ', el('b', null, `"${w} ${o}"`), ' or ', el('b', null, `"${w} ${k}"`), '.'];
}

function donePage() {
  const k = S.draft.keys;
  const item = (label, sub, a) => el('div', { class: 'item' }, el('div', null, el('div', { class: 'label' }, label), el('div', { class: 'sub' }, sub)), a ? chips(a) : el('span', { class: 'off' }, 'Off'));
  return [...head("You're all set", 'Cubby is running. These are your two keys.'),
    el('div', { class: 'keybig' }, item('Switch apps', 'Hold the modifier, tap to cycle, let go to switch.', k.switch), item('Search and open the tray', 'Type to jump to or launch any app.', k.search)),
    el('p', { class: 'note' }, 'Cubby also lives in the system tray, next to the clock. Right-click it for Settings, or to change any of this later.')];
}

const PAGES = { welcome: welcomePage, keys: keysPage, groups: groupsPage, apps: appsPage, music: musicPage, panels: panelsPage, startup: startupPage, done: donePage };

// ---- Shell: nav, footer, render -------------------------------------------------------------------

function renderNav() {
  nav.replaceChildren(...steps().map((s, i) => {
    const wiz = S.mode === 'wizard';
    const reachable = !wiz || i <= S.seen;
    return el('button', { class: `${i === S.step ? 'on' : ''}${wiz && i < S.step ? ' done' : ''}`, disabled: !reachable || S.saving, onclick: () => go(i) },
      wiz ? el('span', { class: 'num' }, i < S.step ? '✓' : String(i + 1)) : null, (isMac() && s.mac) || s.title);
  }));
}

// Why Next / Save is blocked on the current page ('' = fine).
function blocker(id = stepId()) {
  if (!S.draft) return 'Loading…';
  if (S.rec) return 'Press the new combo, or Cancel.';
  if ((id === 'keys' || S.mode === 'settings') && Object.values(allKeyIssues()).some((l) => l.some((i) => i.bad))) return 'Two keys use the same combo.';
  if ((id === 'startup' || S.mode === 'settings') && Object.keys(voiceProblems()).length) return 'Finish the voice phrases, or turn voice off.';
  return '';
}

function renderFoot() {
  if (!S.ready) return foot.replaceChildren();
  const id = stepId();
  const why = blocker();
  const wiz = S.mode === 'wizard';
  let status = el('div', { class: 'status' });
  if (why) { status = el('div', { class: 'status bad' }, why); }
  else if (!wiz) status = el('div', { class: `status${S.saving ? '' : S.savedAt && !dirty() ? ' ok' : ''}` }, S.saving ? 'Saving…' : dirty() ? 'Unsaved changes' : S.savedAt ? 'Saved' : '');
  const btns = el('div', { class: 'btns' });
  if (wiz) {
    if (id === 'welcome') btns.append(el('button', { class: 'btn quiet', disabled: S.saving, title: 'Keep the starter groups and default keys', onclick: skip }, 'Use defaults'));
    if (S.step > 0 && id !== 'done') btns.append(el('button', { class: 'btn', disabled: S.saving, onclick: () => go(S.step - 1) }, 'Back'));
    if (id === 'done') btns.append(el('button', { class: 'btn primary', onclick: () => cubby.send('setup:finish') }, 'Open Cubby'));
    else btns.append(el('button', { class: 'btn primary', disabled: !!why || S.saving, onclick: next }, id === 'welcome' ? 'Get started' : id === 'startup' ? (S.saving ? 'Saving…' : 'Save and finish') : 'Next'));
  } else {
    btns.append(el('button', { class: 'btn', onclick: close }, 'Close'), el('button', { class: 'btn primary', disabled: !!why || S.saving || !dirty(), onclick: save }, 'Save changes'));
  }
  foot.replaceChildren(status, btns);
}

function render() {
  if (S.drag) { S.redrawLater = true; return; }
  if (!S.ready) { page.replaceChildren(el('div', { id: 'loading' }, 'Loading…')); return; }
  const top = page.scrollTop;
  const listTop = $('#cand-list')?.scrollTop;
  const id = stepId();
  $('#mode-title').textContent = S.mode === 'wizard' ? 'Setup' : 'Settings';
  renderNav();
  page.replaceChildren(...[
    S.errors.length ? el('div', { class: 'banner bad', role: 'alert' }, "Couldn't save:", el('ul', null, S.errors.map((e) => el('li', null, e)))) : null,
    ...PAGES[id]()].filter(Boolean)); // replaceChildren(null) would insert the text "null"
  page.scrollTop = top;
  if (id === 'apps') { drawCands(); if (listTop != null) $('#cand-list').scrollTop = listTop; }
  renderFoot();
  if (S.focus) {
    const input = page.querySelector(`input[data-g="${S.focus}"]`);
    if (input) { input.focus(); input.select(); }
    S.focus = null;
  }
  if (id === 'welcome' && isMac()) cubby.send('setup:permissions');
}

function go(i) {
  if (S.rec) { S.rec = null; S.recNote = ''; cubby.send('setup:recording', false); }
  S.step = Math.max(0, Math.min(steps().length - 1, i));
  S.seen = Math.max(S.seen, S.step);
  S.errors = [];
  render();
  page.scrollTop = 0;
}
function next() {
  if (blocker()) return;
  if (stepId() === 'startup') return save();
  go(S.step + 1);
}
function skip() {
  if (S.cands && S.firstRun) autofill();
  save();
}
function save() {
  if (S.saving || blocker()) return;
  S.saving = true;
  S.errors = [];
  renderFoot();
  renderNav();
  cubby.send('setup:save', S.draft);
}
function close() {
  if (dirty() && !confirm('Close without saving your changes?')) return;
  cubby.send('setup:close');
}

$('#win-close').addEventListener('click', () => {
  if (S.mode === 'wizard' && stepId() !== 'done' && !confirm('Close setup? You can finish it any time from the tray menu. Nothing has been saved yet.')) return;
  if (S.mode === 'settings') return close();
  cubby.send('setup:close');
});
$('#win-min').addEventListener('click', () => cubby.send('setup:minimize'));
window.addEventListener('focus', () => { if (isMac() && stepId() === 'welcome') cubby.send('setup:permissions'); });

// ---- Main-process messages ----------------------------------------------------------------------------

function applyStep(want) {
  if (!want) return;
  const i = steps().findIndex((s) => s.id === want);
  if (i >= 0) { S.seen = Math.max(S.seen, i); S.step = i; }
}

cubby.on('setup:init', (d) => {
  Object.assign(S, { mode: d.mode, platform: d.platform, displays: d.displays, providers: d.providers, catalog: d.catalog, defaults: d.defaults, firstRun: d.firstRun });
  S.draft = clone(d.config);
  if (S.firstRun && S.mode === 'wizard') { // the starter groups come in empty; "detected apps" fill them
    for (const g of S.draft.groups) g.apps = [];
    S.autofill = true;
  }
  if (S.firstRun && isMac()) S.draft.keys.takeOverSystemSwitcher = true;
  syncTakeOver();
  S.base = JSON.stringify(S.draft);
  const v = S.draft.voice;
  S.vt = { wake: v.wakeWord, open: v.commands.openAll.join(', '), close: v.commands.closeAll.join(', ') };
  S.target = S.draft.groups[0]?.id || null;
  S.step = 0;
  S.seen = 0;
  applyStep(d.step);
  if (S.mode === 'settings' && !d.step) S.step = 0;
  S.ready = true;
  render();
  cubby.send('setup:apps');
});
cubby.on('setup:goto', (d) => { if (!S.ready) return; applyStep(d.step); render(); });
cubby.on('setup:apps', ({ candidates }) => {
  S.cands = candidates;
  if (S.autofill) { autofill(); S.autofill = false; S.base = JSON.stringify(S.draft); }
  if (!S.ready || S.drag) return;
  if (stepId() === 'apps') { drawCands(); $('.cards')?.replaceChildren(...cardsEl()); }
  renderFoot();
});
// Icons arrive in small batches; repaint only the app lists (no focus or scroll loss).
let iconTimer;
cubby.on('setup:icons', (map) => {
  Object.assign(S.icons, map);
  clearTimeout(iconTimer);
  iconTimer = setTimeout(() => {
    if (!S.ready || S.drag || stepId() !== 'apps') return;
    const top = $('#cand-list')?.scrollTop;
    drawCands();
    $('.cards')?.replaceChildren(...cardsEl());
    if (top != null) $('#cand-list').scrollTop = top;
  }, 200);
});
cubby.on('setup:permissions', (p) => { S.perms = p; if (S.ready && stepId() === 'welcome') { const top = page.scrollTop; render(); page.scrollTop = top; } });
cubby.on('setup:saved', (r) => {
  S.saving = false;
  if (r.ok) {
    S.base = JSON.stringify(S.draft);
    S.savedAt = Date.now();
    S.errors = [];
    if (S.mode === 'wizard') return go(steps().findIndex((s) => s.id === 'done'));
  } else S.errors = r.errors;
  render();
});

render();
cubby.send('setup:ready');
