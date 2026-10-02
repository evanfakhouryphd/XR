'use strict';
// Session dates/times are wall-clock times in the class's time zone, so the
// app behaves the same whether the server runs in UTC (Vercel) or locally.

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function partsIn(ts, tz) {
  const out = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  for (const p of fmt.formatToParts(new Date(ts))) out[p.type] = p.value;
  return out;
}

// Today's date (YYYY-MM-DD) in the given time zone.
function todayIn(tz, now = Date.now()) {
  const p = partsIn(now, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

function offsetMs(ts, tz) {
  const p = partsIn(ts, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}

// Epoch ms for a wall-clock date + HH:MM in the given time zone.
function wallTimeToEpoch(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz); // second pass handles DST boundaries
}

module.exports = { isValidTimeZone, todayIn, wallTimeToEpoch };
