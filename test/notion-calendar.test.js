const test = require('node:test');
const assert = require('assert');
const nc = require('../src/notion-calendar');
const leveldb = require('../src/leveldb');

// Google Calendar API event objects, the shape Notion Calendar stores.
const NY = 'America/New_York';
const RAW = [
  { kind: 'calendar#event', id: 'standup', summary: 'Standup', status: 'confirmed',
    start: { dateTime: '2026-10-05T09:30:00-04:00', timeZone: NY }, end: { dateTime: '2026-10-05T09:45:00-04:00', timeZone: NY },
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=America/New_York:20261019T093000'] },
  { kind: 'calendar#event', id: 'standup_20261026', recurringEventId: 'standup', summary: 'Standup (moved)', status: 'confirmed',
    originalStartTime: { dateTime: '2026-10-26T09:30:00-04:00', timeZone: NY },
    start: { dateTime: '2026-10-26T11:00:00-04:00', timeZone: NY }, end: { dateTime: '2026-10-26T11:15:00-04:00', timeZone: NY } },
  { kind: 'calendar#event', id: 'standup_20261109', recurringEventId: 'standup', status: 'cancelled',
    originalStartTime: { dateTime: '2026-11-09T09:30:00-05:00', timeZone: NY }, start: { dateTime: '2026-11-09T09:30:00-05:00' } },
  { kind: 'calendar#event', id: 'review', summary: 'Design review', location: 'Room 4', status: 'confirmed',
    start: { dateTime: '2026-10-22T14:00:00-04:00', timeZone: NY }, end: { dateTime: '2026-10-22T15:00:00-04:00', timeZone: NY } },
  { kind: 'calendar#event', id: 'gone', summary: 'Called off', status: 'cancelled',
    start: { dateTime: '2026-10-22T15:00:00-04:00', timeZone: NY }, end: { dateTime: '2026-10-22T16:00:00-04:00', timeZone: NY } },
  { kind: 'calendar#event', id: 'off', summary: 'Day off', start: { date: '2026-10-23' }, end: { date: '2026-10-24' } },
];
const at = (iso) => new Date(iso).getTime();

test('toEvents: repeats in their zone, skipped / moved / cancelled occurrences, all-day', () => {
  const ev = nc.toEvents(RAW, at('2026-10-18T00:00Z'), at('2026-11-17T00:00Z'));
  assert.deepStrictEqual(ev.filter((e) => !e.allDay).map((e) => [e.title, new Date(e.start).toISOString()]), [
    ['Design review', '2026-10-22T18:00:00.000Z'],
    ['Standup (moved)', '2026-10-26T15:00:00.000Z'],
    ['Standup', '2026-11-02T14:30:00.000Z'], // 9:30 EST after the Nov 1 change
    ['Standup', '2026-11-16T14:30:00.000Z'], // Oct 19 skipped (EXDATE), Nov 9 cancelled
  ]);
  assert.deepStrictEqual(ev.filter((e) => e.allDay).map((e) => e.title), ['Day off']);
  assert.strictEqual(ev[0].location, 'Room 4');
  assert.strictEqual(ev.find((e) => e.title === 'Standup').end - ev.find((e) => e.title === 'Standup').start, 15 * 60000);
});

test('zoned: wall time in a zone -> instant, across DST', () => {
  assert.strictEqual(new Date(nc.zoned(2026, 7, 1, 9, 0, 0, NY)).toISOString(), '2026-07-01T13:00:00.000Z');
  assert.strictEqual(new Date(nc.zoned(2026, 12, 1, 9, 0, 0, NY)).toISOString(), '2026-12-01T14:00:00.000Z');
});

test('leveldb: snappy blocks and varints', () => {
  // "abcabcabc": literal "abc" then a copy of 6 bytes from 3 back.
  assert.strictEqual(leveldb.unsnappy(Buffer.from([9, 0x08, 0x61, 0x62, 0x63, 0x09, 0x03])).toString(), 'abcabcabc');
  assert.deepStrictEqual(leveldb.varint(Buffer.from([0xac, 0x02]), 0), [300, 2]);
});
