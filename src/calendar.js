// Calendar: the next event, from the user's private calendar links (iCal / .ics: Google Calendar's
// "Secret address in iCal format", Outlook, iCloud...). Notion Calendar shows those same calendars;
// it has no API of its own. ical.js expands repeating events and converts time zones.
const ICAL = require('ical.js');

const DAY = 86400000;

// .ics text -> [{ title, start, end, allDay, location }] (ms), every occurrence overlapping [from, to).
// Cancelled events are left out; a moved or renamed occurrence (RECURRENCE-ID) replaces its original.
function parse(text, from, to) {
  const cal = new ICAL.Component(ICAL.parse(text));
  for (const tz of cal.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz);
  const events = cal.getAllSubcomponents('vevent').map((c) => new ICAL.Event(c));
  const masters = new Map();
  for (const e of events) if (!e.isRecurrenceException()) masters.set(e.uid, e);
  for (const e of events) if (e.isRecurrenceException() && masters.has(e.uid)) masters.get(e.uid).relateException(e);

  const out = [];
  const add = (item, s, e) => {
    if (String(item.component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') return;
    const start = s.toJSDate().getTime();
    const end = e ? e.toJSDate().getTime() : start + (s.isDate ? DAY : 0);
    if (end > from && start < to) out.push({ title: item.summary || '(No title)', start, end, allDay: s.isDate, location: item.location || '' });
  };
  for (const e of events) {
    if (e.isRecurrenceException() && masters.has(e.uid)) continue; // reached through its master
    if (!e.isRecurring()) { add(e, e.startDate, e.endDate); continue; }
    const it = e.iterator();
    // ponytail: walks every occurrence since the series began; capped, fine for years of a daily meeting.
    for (let t = it.next(), n = 0; t && n < 5000; t = it.next(), n++) {
      if (t.toJSDate().getTime() >= to) break;
      const d = e.getOccurrenceDetails(t);
      add(d.item, d.startDate, d.endDate);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// The event to show: one happening now (the latest to start), else the next to start. Timed events
// only: an all-day event would sit there all day.
function next(events, now) {
  const timed = events.filter((e) => !e.allDay && e.end > now);
  const current = timed.filter((e) => e.start <= now).at(-1);
  return current || timed.find((e) => e.start > now) || null;
}

// webcal:// is how calendar apps hand these links around; it's plain https underneath.
const httpUrl = (u) => String(u).trim().replace(/^webcal:\/\//i, 'https://');

// Every link's events for [now - 1 day, now + 8 days]. A link that fails is reported
// ({ host, status, message }), the rest still count.
async function load(urls, now = Date.now()) {
  const errors = [];
  const lists = await Promise.all(urls.map(async (u) => {
    try {
      const r = await fetch(httpUrl(u), { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return parse(await r.text(), now - DAY, now + 8 * DAY);
    } catch (e) {
      // host only: the rest of the link is the secret
      errors.push({ host: httpUrl(u).replace(/^\w+:\/\/([^/]+).*/, '$1'), status: Number(e.message.match(/^HTTP (\d+)/)?.[1]) || 0, message: e.message });
      return [];
    }
  }));
  return { events: lists.flat().sort((a, b) => a.start - b.start), errors };
}

module.exports = { parse, next, load, httpUrl };
