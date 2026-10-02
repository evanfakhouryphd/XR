'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { todayIn, wallTimeToEpoch } = require('../lib/time');

test('wall-clock times convert correctly across time zones and DST', () => {
  assert.equal(wallTimeToEpoch('2026-10-02', '09:00', 'UTC'), Date.UTC(2026, 9, 2, 9, 0));
  assert.equal(wallTimeToEpoch('2026-10-02', '09:00', 'Asia/Beirut'), Date.UTC(2026, 9, 2, 6, 0)); // UTC+3 summer
  assert.equal(wallTimeToEpoch('2026-12-02', '09:00', 'Asia/Beirut'), Date.UTC(2026, 11, 2, 7, 0)); // UTC+2 winter
  assert.equal(wallTimeToEpoch('2026-07-01', '09:00', 'America/New_York'), Date.UTC(2026, 6, 1, 13, 0));
  assert.equal(todayIn('Asia/Tokyo', Date.UTC(2026, 9, 2, 20, 0)), '2026-10-03');
  assert.equal(todayIn('America/Los_Angeles', Date.UTC(2026, 9, 2, 3, 0)), '2026-10-01');
});
