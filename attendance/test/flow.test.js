'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const sec = require('../lib/security');

let server, base, app;

before(async () => {
  app = createApp({ databaseUrl: '', dataDir: 'memory://', publicUrl: '', rotateMs: 10000, graceWindows: 2 });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Minimal cookie-jar client: one per simulated browser/phone.
function client() {
  const jar = {};
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { call, jar };
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

test('full attendance flow with anti-cheating rules', async () => {
  const prof = client();
  assert.equal((await prof.call('POST', '/api/auth/signup', { username: 'prof', password: 'password123' })).status, 200);
  // Second sign-up is blocked by default.
  assert.equal((await client().call('POST', '/api/auth/signup', { username: 'other', password: 'password123' })).status, 403);

  const { data: { id: classId } } = await prof.call('POST', '/api/classes', { name: 'Biology 101', code: 'BIO101', timezone: TZ });

  // Mon/Wed/Fri for ~3 months.
  const start = new Date();
  const end = new Date(); end.setMonth(end.getMonth() + 3);
  const sched = await prof.call('POST', `/api/classes/${classId}/schedule`, {
    weekdays: [1, 3, 5], startDate: ymd(start), endDate: ymd(end), startTime: '09:00', endTime: '10:00',
  });
  assert.ok(sched.data.created >= 36 && sched.data.created <= 42, `created ${sched.data.created}`);
  // Re-running does not duplicate.
  assert.equal((await prof.call('POST', `/api/classes/${classId}/schedule`, {
    weekdays: [1, 3, 5], startDate: ymd(start), endDate: ymd(end), startTime: '09:00', endTime: '10:00',
  })).data.created, 0);

  // A session today, starting a few minutes ago so check-ins count as present.
  const t = new Date(Date.now() - 2 * 60000);
  const { data: { id: sessionId } } = await prof.call('POST', `/api/classes/${classId}/sessions`, {
    date: ymd(t), startTime: `${pad(t.getHours())}:${pad(t.getMinutes())}`, endTime: '23:59',
  });

  // QR is not available until the session is opened; students can't check in.
  assert.equal((await prof.call('GET', `/api/sessions/${sessionId}/qr`)).status, 409);
  await prof.call('POST', `/api/sessions/${sessionId}/open`);
  const qr = await prof.call('GET', `/api/sessions/${sessionId}/qr`);
  assert.equal(qr.status, 200);
  assert.match(qr.data.svg, /<svg/);
  const token = qr.data.url.split('/c/')[1];

  // Student A registers once and is checked in.
  const alice = client();
  let r = await alice.call('POST', '/api/checkin/scan', { token });
  assert.equal(r.status, 200);
  assert.equal(r.data.me, null);
  const aliceClaim = r.data.claim;
  r = await alice.call('POST', '/api/checkin/register', { claim: aliceClaim, studentNumber: 'S1', name: 'Alice', localId: 'phoneA' });
  assert.equal(r.status, 200);
  r = await alice.call('POST', '/api/checkin/confirm', { claim: aliceClaim, localId: 'phoneA' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'present');

  // Next scan on the same phone: recognised automatically, no typing.
  r = await alice.call('POST', '/api/checkin/scan', { token });
  assert.deepEqual(r.data.me, { studentNumber: 'S1', name: 'Alice' });
  assert.ok(r.data.alreadyCheckedIn);

  // Alice's phone cannot register a second student.
  r = await alice.call('POST', '/api/checkin/register', { claim: aliceClaim, studentNumber: 'S2', name: 'Bob' });
  assert.equal(r.status, 409);

  // A private tab on Alice's phone (new cookie) but same localStorage id is blocked.
  const aliceIncognito = client();
  const c2 = (await aliceIncognito.call('POST', '/api/checkin/scan', { token })).data.claim;
  r = await aliceIncognito.call('POST', '/api/checkin/register', { claim: c2, studentNumber: 'S2', name: 'Bob', localId: 'phoneA' });
  assert.equal(r.status, 409);

  // Someone else can't claim Alice's ID on another phone.
  const mallory = client();
  const c3 = (await mallory.call('POST', '/api/checkin/scan', { token })).data.claim;
  r = await mallory.call('POST', '/api/checkin/register', { claim: c3, studentNumber: 'S1', name: 'Alice' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /another phone/);

  // A claim can't be reused from a different phone (bound to the device cookie).
  r = await mallory.call('POST', '/api/checkin/confirm', { claim: aliceClaim });
  assert.equal(r.status, 410);

  // An old code (e.g. a forwarded screenshot) is rejected.
  const s = await (await app.locals.dbReady).one('SELECT secret FROM sessions WHERE id = $1', [sessionId]);
  const stale = sec.qrToken(sessionId, s.secret, 10000, Date.now() - 60000).token;
  r = await client().call('POST', '/api/checkin/scan', { token: stale });
  assert.equal(r.status, 410);
  // A request without a body is a clean 400, not a crash.
  r = await fetch(base + '/api/checkin/scan', { method: 'POST' });
  assert.equal(r.status, 400);
  // Tampered code rejected.
  r = await client().call('POST', '/api/checkin/scan', { token: token.slice(0, -2) + 'xx' });
  assert.equal(r.status, 400);

  // Geofence: enable 100 m around a point; a far-away phone is rejected, a near one accepted.
  await prof.call('PATCH', `/api/classes/${classId}`, { geo_enabled: true, geo_lat: 33.8938, geo_lng: 35.5018, geo_radius_m: 100 });
  const bob = client();
  const cb = (await bob.call('POST', '/api/checkin/scan', { token })).data.claim;
  await bob.call('POST', '/api/checkin/register', { claim: cb, studentNumber: 'S2', name: 'Bob', localId: 'phoneB' });
  r = await bob.call('POST', '/api/checkin/confirm', { claim: cb });
  assert.equal(r.status, 400); // location required
  r = await bob.call('POST', '/api/checkin/confirm', { claim: cb, lat: 33.95, lng: 35.6, accuracy: 20 });
  assert.equal(r.status, 403);
  // Too vague a reading is rejected, even if it happens to point at the room.
  r = await bob.call('POST', '/api/checkin/confirm', { claim: cb, lat: 33.8939, lng: 35.5019, accuracy: 200 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /imprecise/);
  // ~160 m away with ±60 m: the old lenient rule allowed this, now only 30 m of slack applies.
  r = await bob.call('POST', '/api/checkin/confirm', { claim: cb, lat: 33.8938 + 0.00144, lng: 35.5018, accuracy: 60 });
  assert.equal(r.status, 403);
  // ~120 m away with ±25 m: within 100 m radius + 25 m slack.
  r = await bob.call('POST', '/api/checkin/confirm', { claim: cb, lat: 33.8938 + 0.00108, lng: 35.5018, accuracy: 25 });
  assert.equal(r.status, 200);
  r = await bob.call('POST', '/api/checkin/confirm', { claim: cb, lat: 33.8939, lng: 35.5019, accuracy: 15 });
  assert.equal(r.status, 200);

  // Closing registration blocks new phones.
  await prof.call('PATCH', `/api/classes/${classId}`, { enroll_open: false, geo_enabled: false });
  const carol = client();
  const cc = (await carol.call('POST', '/api/checkin/scan', { token })).data.claim;
  r = await carol.call('POST', '/api/checkin/register', { claim: cc, studentNumber: 'S3', name: 'Carol' });
  assert.equal(r.status, 403);

  // Instructor can reset a phone; the student can then register a new one.
  await prof.call('POST', `/api/classes/${classId}/students/S1/reset-device`);
  await prof.call('PATCH', `/api/classes/${classId}`, { enroll_open: true });
  const aliceNewPhone = client();
  const cn = (await aliceNewPhone.call('POST', '/api/checkin/scan', { token })).data.claim;
  r = await aliceNewPhone.call('POST', '/api/checkin/register', { claim: cn, studentNumber: 'S1', name: 'Alice', localId: 'phoneA2' });
  assert.equal(r.status, 200);

  // Manual mark + report.
  await prof.call('PUT', `/api/sessions/${sessionId}/attendance/S9`, { status: 'excused' });
  const detail = await prof.call('GET', `/api/sessions/${sessionId}`);
  assert.equal(detail.data.attendance.length, 3);
  assert.ok(detail.data.events.some((e) => e.kind === 'expired_code'));
  assert.ok(detail.data.events.some((e) => e.kind === 'too_far'));
  assert.ok(detail.data.events.some((e) => e.kind === 'imprecise_location'));
  assert.ok(detail.data.events.some((e) => e.kind === 'id_on_other_phone'));

  const csv = await prof.call('GET', `/api/classes/${classId}/report.csv`);
  assert.match(csv.data, /Student ID,Name/);
  assert.match(csv.data, /S1,Alice/);

  // Closing the session stops check-ins.
  await prof.call('POST', `/api/sessions/${sessionId}/close`);
  r = await alice.call('POST', '/api/checkin/scan', { token });
  assert.ok(r.status === 409 || r.status === 410);

  // Another instructor cannot see this class.
  assert.equal((await client().call('GET', `/api/classes/${classId}`)).status, 401);
});

test('roster-only classes reject unknown IDs', async () => {
  const prof = client();
  await prof.call('POST', '/api/auth/login', { username: 'prof', password: 'password123' });
  const { data: { id } } = await prof.call('POST', '/api/classes', { name: 'Chem', roster_only: true, timezone: TZ });
  await prof.call('PUT', `/api/classes/${id}/roster`, { text: 'student id, name\nR100, Rana Haddad\nR101; Omar' });
  const room = await prof.call('GET', `/api/classes/${id}`);
  assert.equal(room.data.roster.length, 2);
  const d = new Date();
  const { data: { id: sid } } = await prof.call('POST', `/api/classes/${id}/sessions`, { date: ymd(d), startTime: '00:00', endTime: '23:59' });
  await prof.call('POST', `/api/sessions/${sid}/open`);
  const token = (await prof.call('GET', `/api/sessions/${sid}/qr`)).data.url.split('/c/')[1];

  const x = client();
  const claim = (await x.call('POST', '/api/checkin/scan', { token })).data.claim;
  assert.equal((await x.call('POST', '/api/checkin/register', { claim, studentNumber: 'NOPE', name: 'X' })).status, 403);
  // Name comes from the roster; ID matching is case-insensitive.
  const r = await x.call('POST', '/api/checkin/register', { claim, studentNumber: 'r100', name: '' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.me, { studentNumber: 'R100', name: 'Rana Haddad' });
  const c = await x.call('POST', '/api/checkin/confirm', { claim });
  assert.equal(c.data.status, 'late'); // started at 00:00
});
