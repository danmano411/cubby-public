const test = require('node:test');
const assert = require('node:assert');
const { hour12From } = require('../src/model');

test('clock follows the Windows time format: h / tt = 12-hour, H = 24-hour', () => {
  assert.strictEqual(hour12From('h:mm:ss tt'), true); // en-US default
  assert.strictEqual(hour12From('hh:mm:ss tt'), true);
  assert.strictEqual(hour12From('tt h:mm:ss'), true); // AM/PM first (ko-KR, zh-CN style)
  assert.strictEqual(hour12From('H:mm:ss'), false);
  assert.strictEqual(hour12From('HH:mm:ss'), false); // en-GB, de-DE
  assert.strictEqual(hour12From("HH 'h' mm"), false); // quoted literal h isn't the hour
});

test('no Windows format (mac, or the read failed): leave it to the OS locale', () => {
  assert.strictEqual(hour12From(null), undefined);
  assert.strictEqual(hour12From(''), undefined);
});
