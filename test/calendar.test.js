const test = require('node:test');
const assert = require('assert');
const cal = require('../src/calendar');

// The shape Google Calendar's secret iCal link returns: a VTIMEZONE, TZID times, a weekly series with
// a skipped week (EXDATE) and a moved week (RECURRENCE-ID), an all-day event, a cancelled event.
const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:standup@x
DTSTART;TZID=America/New_York:20261005T093000
DTEND;TZID=America/New_York:20261005T094500
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=America/New_York:20261019T093000
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:standup@x
RECURRENCE-ID;TZID=America/New_York:20261026T093000
DTSTART;TZID=America/New_York:20261026T110000
DTEND;TZID=America/New_York:20261026T111500
SUMMARY:Standup (moved)
END:VEVENT
BEGIN:VEVENT
UID:holiday@x
DTSTART;VALUE=DATE:20261023
DTEND;VALUE=DATE:20261024
SUMMARY:Day off
END:VEVENT
BEGIN:VEVENT
UID:gone@x
DTSTART:20261022T190000Z
DTEND:20261022T200000Z
STATUS:CANCELLED
SUMMARY:Cancelled thing
END:VEVENT
BEGIN:VEVENT
UID:review@x
DTSTART:20261022T180000Z
DTEND:20261022T190000Z
SUMMARY:Design review
LOCATION:Room 4
END:VEVENT
END:VCALENDAR`;

const at = (iso) => new Date(iso).getTime();

test('parse: time zones, repeats, skipped and moved weeks, cancelled', () => {
  const ev = cal.parse(ICS, at('2026-10-18T00:00Z'), at('2026-11-03T00:00Z'));
  const timed = ev.filter((e) => !e.allDay).map((e) => [e.title, new Date(e.start).toISOString()]);
  assert.deepStrictEqual(timed, [
    ['Design review', '2026-10-22T18:00:00.000Z'],
    ['Standup (moved)', '2026-10-26T15:00:00.000Z'], // 11:00 EDT
    ['Standup', '2026-11-02T14:30:00.000Z'], // 9:30 EST: the clocks changed on Nov 1
  ], 'Oct 19 is skipped, Oct 26 moved, the cancelled event is gone');
  assert.deepStrictEqual(ev.filter((e) => e.allDay).map((e) => e.title), ['Day off']);
  assert.strictEqual(ev[0].location, 'Room 4');
});

test('next: the one happening now, else the next to start; never an all-day event', () => {
  const ev = cal.parse(ICS, at('2026-10-18T00:00Z'), at('2026-11-03T00:00Z'));
  assert.strictEqual(cal.next(ev, at('2026-10-22T17:00Z')).title, 'Design review');
  assert.strictEqual(cal.next(ev, at('2026-10-22T18:30Z')).title, 'Design review', 'still on: shown until it ends');
  assert.strictEqual(cal.next(ev, at('2026-10-22T19:00Z')).title, 'Standup (moved)', 'the day off is skipped');
  assert.strictEqual(cal.next(ev, at('2026-11-05T00:00Z')), null);
});

test('httpUrl: webcal links are fetched over https', () => {
  assert.strictEqual(cal.httpUrl(' webcal://p01-caldav.icloud.com/x.ics '), 'https://p01-caldav.icloud.com/x.ics');
  assert.strictEqual(cal.httpUrl('https://calendar.google.com/x/basic.ics'), 'https://calendar.google.com/x/basic.ics');
});
