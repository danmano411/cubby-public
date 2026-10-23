// Events from Notion Calendar's own copy on this computer, so the tray can show the next one without
// asking Google (whose iCal links can get blocked, HTTP 429). Notion Calendar keeps Google Calendar
// API event objects in its IndexedDB; leveldb.js reads that from disk, v8 decodes the values.
// It's as fresh as Notion Calendar's last sync: it needn't be open, but it only syncs while it runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const v8 = require('v8');
const ICAL = require('ical.js');
const leveldb = require('./leveldb');

const DAY = 86400000;

function dbDir(platform = process.platform) {
  const base = platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.APPDATA || '';
  return path.join(base, 'Notion Calendar', 'IndexedDB', 'https_calendar.notion.so_0.indexeddb.leveldb');
}

// An IndexedDB value: IDB's version varint and Blink's header, then V8's own (0xFF <version>).
function decode(buf) {
  for (let i = 0; i < Math.min(buf.length - 2, 40); i++) {
    if (buf[i] !== 0xff) continue;
    try { return v8.deserialize(buf.subarray(i)); } catch {}
  }
  return null;
}

// Every stored event object (Google's shape: { id, summary, start, end, recurrence, ... }).
function readRaw(dir = dbDir()) {
  const out = [];
  for (const value of leveldb.read(dir).values()) {
    const v = decode(value);
    if (v && v.kind === 'calendar#event' && v.start) out.push(v);
  }
  return out;
}

// Wall-clock time in a time zone -> ms. Two passes settle the offset across a DST change.
function zoned(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess;
  for (let n = 0; n < 2; n++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(t).map((x) => [x.type, Number(x.value)]));
    t += guess - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return t;
}
// ms -> wall-clock parts in a time zone.
function wall(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(ms).map((x) => [x.type, Number(x.value)]));
  return [p.year, p.month, p.day, p.hour, p.minute, p.second];
}

const localDay = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const startMs = (t) => (t.dateTime ? Date.parse(t.dateTime) : localDay(t.date));
const endMs = (t) => (t.dateTime ? Date.parse(t.dateTime) : localDay(t.date));
const toEvent = (e, start, end) => ({ title: e.summary || '(No title)', start, end, allDay: !e.start.dateTime, location: e.location || '' });

// "EXDATE;TZID=America/New_York:20261019T093000,20261026T093000" -> [ms], in the series' zone.
function exdates(lines, tz, allDay) {
  const out = [];
  for (const line of lines.filter((l) => /^EXDATE/i.test(l))) {
    const zone = line.match(/TZID=([^;:]+)/i)?.[1] || tz;
    for (const v of line.slice(line.lastIndexOf(':') + 1).split(',')) {
      const m = v.match(/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)(Z)?)?/);
      if (!m) continue;
      const [, y, mo, d, h = 0, mi = 0, s = 0, z] = m;
      out.push(allDay || !m[4] ? new Date(+y, mo - 1, +d).getTime() : z ? Date.UTC(y, mo - 1, d, h, mi, s) : zoned(+y, +mo, +d, +h, +mi, +s, zone));
    }
  }
  return out;
}

// Raw events -> Cubby events overlapping [from, to): repeating series expanded in their own time zone,
// skipped (EXDATE / cancelled) and moved occurrences applied.
function toEvents(raw, from, to) {
  const out = [];
  const overrides = new Map(); // series id -> Map(original start ms -> event)
  for (const e of raw) {
    if (!e.recurringEventId || !e.originalStartTime) continue;
    if (!overrides.has(e.recurringEventId)) overrides.set(e.recurringEventId, new Map());
    overrides.get(e.recurringEventId).set(startMs(e.originalStartTime), e);
  }
  const add = (e, start, end) => { if (e.status !== 'cancelled' && end > from && start < to) out.push(toEvent(e, start, end)); };
  for (const e of raw) {
    if (e.recurringEventId && e.originalStartTime) { // a changed occurrence: its own times, unless it's cancelled
      add(e, startMs(e.start), endMs(e.end || e.start));
      continue;
    }
    const start = startMs(e.start);
    const end = endMs(e.end || e.start);
    const rule = (e.recurrence || []).find((l) => /^RRULE:/i.test(l));
    if (!rule) { add(e, start, end); continue; }
    if (e.status === 'cancelled') continue;
    const allDay = !e.start.dateTime;
    const tz = e.start.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const [y, mo, d, h, mi, s] = allDay ? e.start.date.split('-').map(Number).concat(0, 0, 0) : wall(start, tz);
    const dtstart = new ICAL.Time({ year: y, month: mo, day: d, hour: h, minute: mi, second: s, isDate: allDay });
    const skip = new Set(exdates(e.recurrence, tz, allDay));
    const moved = overrides.get(e.id) || new Map();
    const it = ICAL.Recur.fromString(rule.slice(6)).iterator(dtstart);
    // ponytail: walks the series from its first date; capped, plenty for years of a daily meeting.
    for (let t = it.next(), n = 0; t && n < 5000; t = it.next(), n++) {
      const at = allDay ? new Date(t.year, t.month - 1, t.day).getTime() : zoned(t.year, t.month, t.day, t.hour, t.minute, t.second, tz);
      if (at >= to) break;
      if (skip.has(at) || moved.has(at)) continue; // a moved occurrence was added on its own above
      add(e, at, at + (end - start));
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// { events, updatedAt } for [now - 1 day, now + 8 days], or null when Notion Calendar isn't installed.
function load(now = Date.now(), dir = dbDir()) {
  if (!fs.existsSync(dir)) return null;
  const updatedAt = Math.max(...fs.readdirSync(dir).map((f) => fs.statSync(path.join(dir, f)).mtimeMs));
  return { events: toEvents(readRaw(dir), now - DAY, now + 8 * DAY), updatedAt };
}

module.exports = { dbDir, readRaw, toEvents, load, zoned };
