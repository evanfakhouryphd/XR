'use strict';
const path = require('node:path');
const express = require('express');
const QRCode = require('qrcode');
const sec = require('./lib/security');
const { open } = require('./lib/db');
const { isValidTimeZone, todayIn, wallTimeToEpoch } = require('./lib/time');

const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL || '',
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data', 'pglite'),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  rotateMs: Number(process.env.QR_ROTATE_SECONDS || 10) * 1000,
  graceWindows: Number(process.env.QR_GRACE_WINDOWS || 2),
  claimMs: Number(process.env.CHECKIN_WINDOW_MINUTES || 5) * 60 * 1000,
  allowSignup: process.env.ALLOW_SIGNUP === '1',
  trustProxy: process.env.TRUST_PROXY === '1' || !!process.env.VERCEL,
};

const DEVICE_COOKIE = 'att_dev';
const AUTH_COOKIE = 'att_auth';
const YEAR_MS = 365 * 24 * 3600 * 1000;
const AUTH_TTL_MS = 30 * 24 * 3600 * 1000;

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function createApp(opts = {}) {
  const cfg = { ...config, ...opts };
  // The database is opened lazily so the module loads instantly (serverless
  // cold starts); every request waits for the same connection promise.
  const dbReady = process.env.VERCEL && !cfg.databaseUrl
    ? Promise.reject(new HttpError(500, 'No database configured. In Vercel, open the project → Storage → add a Neon Postgres database, then redeploy.'))
    : open({ databaseUrl: cfg.databaseUrl, dataDir: cfg.dataDir });
  dbReady.catch(() => {}); // surfaced per request instead
  let db;
  const app = express();
  app.use(async (req, res, next) => {
    try { db = await dbReady; next(); } catch (err) { next(err); }
  });
  if (cfg.trustProxy) app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const all = (sql, params) => db.query(sql, params);
  const one = (sql, params) => db.one(sql, params);
  const now = () => Date.now();

  // ---------------------------------------------------------------- helpers
  function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function setCookie(req, res, name, value, maxAgeMs) {
    const secure = req.secure ? '; Secure' : '';
    res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`);
  }

  function baseUrl(req) {
    return cfg.publicUrl || `${req.protocol}://${req.get('host')}`;
  }

  const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const pad = (n) => String(n).padStart(2, '0');
  // Pure calendar arithmetic, done in UTC so it is server-time-zone independent.
  const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

  async function logEvent({ sessionId = null, classId = null, studentNumber = null, kind, detail, ip = null }) {
    await all('INSERT INTO events (session_id, class_id, student_number, kind, detail, ip, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [sessionId, classId, studentNumber, kind, detail, ip, now()]);
  }

  // ------------------------------------------------------- instructor auth
  async function currentInstructor(req) {
    const token = parseCookies(req)[AUTH_COOKIE];
    if (!token) return null;
    return one(`SELECT i.id, i.username FROM auth_sessions a JOIN instructors i ON i.id = a.instructor_id
                WHERE a.token_hash = $1 AND a.expires_at > $2`, [sec.sha256(token), now()]);
  }

  async function requireAuth(req, res, next) {
    try {
      const user = await currentInstructor(req);
      if (!user) return res.status(401).json({ error: 'Please log in.' });
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  }

  async function startAuthSession(req, res, instructorId) {
    const token = sec.randomToken();
    await all('INSERT INTO auth_sessions (token_hash, instructor_id, expires_at) VALUES ($1,$2,$3)',
      [sec.sha256(token), instructorId, now() + AUTH_TTL_MS]);
    setCookie(req, res, AUTH_COOKIE, token, AUTH_TTL_MS);
  }

  const loginAttempts = new Map(); // ip -> { count, resetAt } (per instance)
  function throttleLogin(req) {
    const key = req.ip;
    const entry = loginAttempts.get(key);
    if (entry && entry.resetAt > now() && entry.count >= 10) {
      throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    }
    if (!entry || entry.resetAt <= now()) loginAttempts.set(key, { count: 1, resetAt: now() + 10 * 60 * 1000 });
    else entry.count += 1;
  }

  const instructorCount = async () => (await one('SELECT COUNT(*) AS n FROM instructors')).n;

  app.get('/api/auth/state', async (req, res) => {
    const n = await instructorCount();
    res.json({ user: await currentInstructor(req), setupNeeded: n === 0, signupAllowed: n === 0 || cfg.allowSignup });
  });

  app.post('/api/auth/signup', async (req, res) => {
    if ((await instructorCount()) > 0 && !cfg.allowSignup) throw new HttpError(403, 'Sign-up is disabled.');
    const username = str(req.body.username, 60);
    const password = String(req.body.password || '');
    if (username.length < 3) throw new HttpError(400, 'Username must be at least 3 characters.');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (await one('SELECT 1 FROM instructors WHERE lower(username) = lower($1)', [username])) throw new HttpError(409, 'That username is taken.');
    const row = await one('INSERT INTO instructors (username, pass_hash, created_at) VALUES ($1,$2,$3) RETURNING id',
      [username, sec.hashPassword(password), now()]);
    await startAuthSession(req, res, row.id);
    res.json({ ok: true });
  });

  app.post('/api/auth/login', async (req, res) => {
    throttleLogin(req);
    const row = await one('SELECT id, pass_hash FROM instructors WHERE lower(username) = lower($1)', [str(req.body.username, 60)]);
    if (!row || !sec.verifyPassword(String(req.body.password || ''), row.pass_hash)) {
      throw new HttpError(401, 'Wrong username or password.');
    }
    loginAttempts.delete(req.ip);
    await startAuthSession(req, res, row.id);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = parseCookies(req)[AUTH_COOKIE];
    if (token) await all('DELETE FROM auth_sessions WHERE token_hash = $1', [sec.sha256(token)]);
    setCookie(req, res, AUTH_COOKIE, '', 0);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------- classes
  const idParam = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new HttpError(404, 'Not found.');
    return n;
  };

  async function ownClass(req, id) {
    const cls = await one('SELECT * FROM classes WHERE id = $1 AND instructor_id = $2', [idParam(id), req.user.id]);
    if (!cls) throw new HttpError(404, 'Class not found.');
    return cls;
  }

  async function ownSession(req, id) {
    const s = await one(`SELECT s.*, c.name AS class_name, c.code AS class_code, c.late_after_min, c.geo_enabled, c.timezone
                 FROM sessions s JOIN classes c ON c.id = s.class_id
                 WHERE s.id = $1 AND c.instructor_id = $2`, [idParam(id), req.user.id]);
    if (!s) throw new HttpError(404, 'Session not found.');
    return s;
  }

  // Students who belong to a class: roster entries plus anyone who has ever
  // checked in to one of its sessions.
  function classMembers(classId) {
    return all(`
      SELECT m.student_number,
             COALESCE(NULLIF(r.name, ''), st.name, '') AS name,
             r.student_number IS NOT NULL AS on_roster,
             d.id AS device_id, d.created_at AS device_created_at, d.last_seen AS device_last_seen, d.user_agent
      FROM (
        SELECT student_number FROM roster WHERE class_id = $1
        UNION
        SELECT a.student_number FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.class_id = $1
      ) m
      LEFT JOIN roster r ON r.class_id = $1 AND r.student_number = m.student_number
      LEFT JOIN students st ON st.student_number = m.student_number
      LEFT JOIN devices d ON d.student_number = m.student_number
      ORDER BY lower(COALESCE(NULLIF(r.name, ''), st.name, '')), m.student_number`, [classId]);
  }

  app.get('/api/classes', requireAuth, async (req, res) => {
    const classes = await all('SELECT * FROM classes WHERE instructor_id = $1 ORDER BY created_at DESC', [req.user.id]);
    for (const c of classes) {
      const t = await one(`SELECT COUNT(*) AS session_count, MIN(date) FILTER (WHERE date >= $2) AS next_date
                           FROM sessions WHERE class_id = $1`, [c.id, todayIn(c.timezone)]);
      Object.assign(c, t);
    }
    res.json(classes);
  });

  function applyClassFields(body, cls = {}) {
    const out = { ...cls };
    if ('name' in body) out.name = str(body.name, 120);
    if ('code' in body) out.code = str(body.code, 40);
    if ('timezone' in body) {
      const tz = str(body.timezone, 64);
      if (tz && !isValidTimeZone(tz)) throw new HttpError(400, 'Unknown time zone.');
      if (tz) out.timezone = tz;
    }
    if ('late_after_min' in body) out.late_after_min = Math.max(0, Math.min(600, Number(body.late_after_min) || 0));
    if ('roster_only' in body) out.roster_only = !!body.roster_only;
    if ('enroll_open' in body) out.enroll_open = !!body.enroll_open;
    if ('geo_enabled' in body) out.geo_enabled = !!body.geo_enabled;
    if ('geo_radius_m' in body) out.geo_radius_m = Math.max(20, Math.min(5000, Number(body.geo_radius_m) || 150));
    const coord = (v) => (v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    if ('geo_lat' in body) out.geo_lat = coord(body.geo_lat);
    if ('geo_lng' in body) out.geo_lng = coord(body.geo_lng);
    if (!out.name) throw new HttpError(400, 'Class name is required.');
    if (out.geo_enabled && (out.geo_lat === null || out.geo_lng === null)) {
      throw new HttpError(400, 'Set the classroom location before turning on the location check.');
    }
    return out;
  }

  app.post('/api/classes', requireAuth, async (req, res) => {
    const c = applyClassFields(req.body, { timezone: 'UTC', late_after_min: 15, roster_only: false, enroll_open: true, geo_enabled: false, geo_radius_m: 150, geo_lat: null, geo_lng: null, code: '' });
    const row = await one(`INSERT INTO classes (instructor_id, name, code, timezone, late_after_min, roster_only, enroll_open, geo_enabled, geo_lat, geo_lng, geo_radius_m, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [req.user.id, c.name, c.code, c.timezone, c.late_after_min, c.roster_only, c.enroll_open, c.geo_enabled, c.geo_lat, c.geo_lng, c.geo_radius_m, now()]);
    res.json({ id: row.id });
  });

  app.get('/api/classes/:id', requireAuth, async (req, res) => {
    const cls = await ownClass(req, req.params.id);
    const sessions = await all(`
      SELECT s.id, s.date, s.start_time, s.end_time, s.status,
        (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id AND a.status IN ('present','late')) AS attended
      FROM sessions s WHERE s.class_id = $1 ORDER BY s.date, s.start_time`, [cls.id]);
    const roster = await all('SELECT student_number, name FROM roster WHERE class_id = $1 ORDER BY lower(name), student_number', [cls.id]);
    res.json({ class: cls, today: todayIn(cls.timezone), sessions, roster, members: await classMembers(cls.id) });
  });

  app.patch('/api/classes/:id', requireAuth, async (req, res) => {
    const c = applyClassFields(req.body, await ownClass(req, req.params.id));
    await all(`UPDATE classes SET name=$1, code=$2, timezone=$3, late_after_min=$4, roster_only=$5, enroll_open=$6, geo_enabled=$7, geo_lat=$8, geo_lng=$9, geo_radius_m=$10 WHERE id=$11`,
      [c.name, c.code, c.timezone, c.late_after_min, c.roster_only, c.enroll_open, c.geo_enabled, c.geo_lat, c.geo_lng, c.geo_radius_m, c.id]);
    res.json({ ok: true });
  });

  app.delete('/api/classes/:id', requireAuth, async (req, res) => {
    const cls = await ownClass(req, req.params.id);
    await all('DELETE FROM classes WHERE id = $1', [cls.id]);
    res.json({ ok: true });
  });

  // Generate sessions from a weekly pattern, e.g. Mon/Wed/Fri for 3 months.
  app.post('/api/classes/:id/schedule', requireAuth, async (req, res) => {
    const cls = await ownClass(req, req.params.id);
    const { startDate, endDate, startTime, endTime } = req.body;
    const weekdays = new Set((req.body.weekdays || []).map(Number).filter((d) => d >= 0 && d <= 6));
    if (!isDate(startDate) || !isDate(endDate)) throw new HttpError(400, 'Pick a start and end date.');
    if (!isTime(startTime) || !isTime(endTime) || endTime <= startTime) throw new HttpError(400, 'Pick a valid start and end time.');
    if (!weekdays.size) throw new HttpError(400, 'Pick at least one weekday.');
    const start = new Date(`${startDate}T12:00:00Z`);
    const end = new Date(`${endDate}T12:00:00Z`);
    if (end < start) throw new HttpError(400, 'End date is before start date.');
    if ((end - start) / 86400000 > 400) throw new HttpError(400, 'Schedules are limited to about a year.');

    const rows = [];
    for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      if (weekdays.has(d.getUTCDay())) rows.push(ymd(d));
    }
    if (!rows.length) return res.json({ created: 0 });
    // One multi-row insert: a single round trip even for a year of sessions.
    const params = [cls.id, startTime, endTime];
    const values = rows.map((date) => {
      params.push(date, sec.randomToken());
      return `($1, $${params.length - 1}, $2, $3, $${params.length})`;
    });
    const inserted = await all(`INSERT INTO sessions (class_id, date, start_time, end_time, secret) VALUES ${values.join(',')}
      ON CONFLICT (class_id, date, start_time) DO NOTHING RETURNING id`, params);
    res.json({ created: inserted.length });
  });

  app.post('/api/classes/:id/sessions', requireAuth, async (req, res) => {
    const cls = await ownClass(req, req.params.id);
    const { date, startTime, endTime } = req.body;
    if (!isDate(date) || !isTime(startTime) || !isTime(endTime) || endTime <= startTime) {
      throw new HttpError(400, 'Pick a valid date, start time and end time.');
    }
    const row = await one(`INSERT INTO sessions (class_id, date, start_time, end_time, secret) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (class_id, date, start_time) DO NOTHING RETURNING id`, [cls.id, date, startTime, endTime, sec.randomToken()]);
    if (!row) throw new HttpError(409, 'A session already exists at that date and time.');
    res.json({ id: row.id });
  });

  // Roster: one student per line, "student_id, name" (CSV/TSV/semicolon).
  app.put('/api/classes/:id/roster', requireAuth, async (req, res) => {
    const cls = await ownClass(req, req.params.id);
    const rows = [];
    const seen = new Set();
    for (const line of String(req.body.text || '').split(/\r?\n/)) {
      const parts = line.split(/[,;\t]/).map((p) => p.trim().replace(/^"|"$/g, ''));
      const num = str(parts[0], 40);
      if (!num || seen.has(num.toLowerCase())) continue;
      if (/^(student|id|student.?id|number)$/i.test(num)) continue; // header row
      seen.add(num.toLowerCase());
      rows.push([num, str(parts.slice(1).join(' '), 120)]);
    }
    if (rows.length > 5000) throw new HttpError(400, 'Rosters are limited to 5000 students.');
    await db.tx(async (tq) => {
      await tq('DELETE FROM roster WHERE class_id = $1', [cls.id]);
      if (rows.length) {
        await tq(`INSERT INTO roster (class_id, student_number, name)
                  SELECT $1, * FROM unnest($2::text[], $3::text[])`, [cls.id, rows.map((r) => r[0]), rows.map((r) => r[1])]);
      }
    });
    res.json({ count: rows.length });
  });

  app.post('/api/classes/:id/students/:num/reset-device', requireAuth, async (req, res) => {
    const cls = await ownClass(req, req.params.id);
    const num = str(req.params.num, 40);
    if (!(await classMembers(cls.id)).some((m) => m.student_number === num)) throw new HttpError(404, 'Student not in this class.');
    const removed = await all('DELETE FROM devices WHERE student_number = $1 RETURNING id', [num]);
    await logEvent({ classId: cls.id, studentNumber: num, kind: 'device_reset', detail: 'Instructor reset the registered phone.' });
    res.json({ ok: true, removed: removed.length });
  });

  app.get('/api/classes/:id/events', requireAuth, async (req, res) => {
    const cls = await ownClass(req, req.params.id);
    res.json(await all(`SELECT e.*, s.date AS session_date FROM events e LEFT JOIN sessions s ON s.id = e.session_id
                WHERE e.class_id = $1 ORDER BY e.created_at DESC LIMIT 300`, [cls.id]));
  });

  async function report(cls) {
    const sessions = await all(`SELECT id, date, start_time, status FROM sessions
      WHERE class_id = $1 AND (date <= $2 OR status != 'scheduled') ORDER BY date, start_time`, [cls.id, todayIn(cls.timezone)]);
    const members = await classMembers(cls.id);
    const marks = {};
    for (const a of await all(`SELECT a.session_id, a.student_number, a.status FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.class_id = $1`, [cls.id])) {
      (marks[a.student_number] ||= {})[a.session_id] = a.status;
    }
    const students = members.map((m) => {
      const row = marks[m.student_number] || {};
      const attended = sessions.filter((s) => row[s.id] === 'present' || row[s.id] === 'late').length;
      const excused = sessions.filter((s) => row[s.id] === 'excused').length;
      const counted = sessions.length - excused;
      return { student_number: m.student_number, name: m.name, marks: row, attended, excused, rate: counted ? attended / counted : null };
    });
    return { class: cls, sessions, students };
  }

  app.get('/api/classes/:id/report', requireAuth, async (req, res) => {
    res.json(await report(await ownClass(req, req.params.id)));
  });

  app.get('/api/classes/:id/report.csv', requireAuth, async (req, res) => {
    const r = await report(await ownClass(req, req.params.id));
    // Prefix formula-like cells so spreadsheet apps don't execute them.
    const esc = (v) => {
      let s = String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const code = { present: 'P', late: 'L', excused: 'E' };
    const lines = [['Student ID', 'Name', ...r.sessions.map((s) => `${s.date} ${s.start_time}`), 'Attended', 'Excused', 'Rate'].map(esc).join(',')];
    for (const s of r.students) {
      lines.push([s.student_number, s.name, ...r.sessions.map((x) => code[s.marks[x.id]] || 'A'), s.attended, s.excused,
        s.rate === null ? '' : `${Math.round(s.rate * 100)}%`].map(esc).join(','));
    }
    const filename = `${r.class.name.replace(/[^\w-]+/g, '_')}_attendance.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n') + '\n');
  });

  // ------------------------------------------------------------ sessions
  app.get('/api/sessions/:id', requireAuth, async (req, res) => {
    const s = await ownSession(req, req.params.id);
    const rows = await all(`SELECT a.*, COALESCE(NULLIF(r.name,''), st.name, '') AS name
      FROM attendance a
      LEFT JOIN roster r ON r.class_id = $1 AND r.student_number = a.student_number
      LEFT JOIN students st ON st.student_number = a.student_number
      WHERE a.session_id = $2 ORDER BY a.checked_in_at`, [s.class_id, s.id]);

    // Flag check-ins that came from an indistinguishable browser on the same
    // network within a short time of each other – a hint that one phone may
    // have been used for two people (e.g. via a private/incognito tab).
    for (const a of rows) {
      a.flags = [];
      if (a.method !== 'qr') continue;
      for (const b of rows) {
        if (b === a || b.method !== 'qr' || !a.fingerprint || a.fingerprint !== b.fingerprint || a.ip !== b.ip) continue;
        if (Math.abs(a.checked_in_at - b.checked_in_at) <= 3 * 60 * 1000) {
          a.flags.push(`Same browser signature & network as ${b.name || b.student_number}`);
        }
      }
    }
    for (const a of rows) delete a.fingerprint;
    const members = await classMembers(s.class_id);
    const events = await all('SELECT * FROM events WHERE session_id = $1 ORDER BY created_at DESC LIMIT 100', [s.id]);
    const { secret, ...session } = s;
    res.json({ session, attendance: rows, members, events });
  });

  app.post('/api/sessions/:id/open', requireAuth, async (req, res) => {
    const s = await ownSession(req, req.params.id);
    await all(`UPDATE sessions SET status='open', opened_at=COALESCE(opened_at, $1), closed_at=NULL WHERE id=$2`, [now(), s.id]);
    res.json({ ok: true });
  });

  app.post('/api/sessions/:id/close', requireAuth, async (req, res) => {
    const s = await ownSession(req, req.params.id);
    await all(`UPDATE sessions SET status='closed', closed_at=$1 WHERE id=$2`, [now(), s.id]);
    res.json({ ok: true });
  });

  app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
    const s = await ownSession(req, req.params.id);
    await all('DELETE FROM sessions WHERE id = $1', [s.id]);
    res.json({ ok: true });
  });

  app.get('/api/sessions/:id/qr', requireAuth, async (req, res) => {
    const s = await ownSession(req, req.params.id);
    if (s.status !== 'open') throw new HttpError(409, 'Open the session to show its QR code.');
    const { token, expiresAt } = sec.qrToken(s.id, s.secret, cfg.rotateMs);
    const url = `${baseUrl(req)}/c/${token}`;
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    const { n } = await one(`SELECT COUNT(*) AS n FROM attendance WHERE session_id = $1 AND status IN ('present','late')`, [s.id]);
    res.set('Cache-Control', 'no-store');
    res.json({ url, svg, expiresAt, serverNow: now(), rotateMs: cfg.rotateMs, count: n });
  });

  // Manual override by the instructor.
  app.put('/api/sessions/:id/attendance/:num', requireAuth, async (req, res) => {
    const s = await ownSession(req, req.params.id);
    const num = str(req.params.num, 40);
    const status = String(req.body.status || '');
    if (!num) throw new HttpError(400, 'Missing student ID.');
    if (status === 'absent') {
      await all('DELETE FROM attendance WHERE session_id = $1 AND student_number = $2', [s.id, num]);
    } else if (['present', 'late', 'excused'].includes(status)) {
      await all(`INSERT INTO attendance (session_id, student_number, status, method, checked_in_at) VALUES ($1,$2,$3,'manual',$4)
         ON CONFLICT (session_id, student_number) DO UPDATE SET status = excluded.status`, [s.id, num, status, now()]);
    } else {
      throw new HttpError(400, 'Unknown status.');
    }
    res.json({ ok: true });
  });

  // ------------------------------------------------------- student check-in
  // Every phone that opens a check-in link gets a long-lived random httpOnly
  // cookie. Registering binds that cookie to ONE student ID; a student ID can
  // only be bound to ONE phone. Only the instructor can undo a binding.
  function deviceToken(req, res) {
    let token = parseCookies(req)[DEVICE_COOKIE];
    if (!token || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
      token = sec.randomToken();
      setCookie(req, res, DEVICE_COOKIE, token, 5 * YEAR_MS);
    }
    return token;
  }

  function deviceFor(token) {
    return one(`SELECT d.*, st.name FROM devices d JOIN students st ON st.student_number = d.student_number WHERE d.token_hash = $1`,
      [sec.sha256(token)]);
  }

  async function sessionForCheckin(sessionId) {
    const s = await one(`SELECT s.*, c.name AS class_name, c.code AS class_code, c.timezone, c.late_after_min, c.roster_only, c.enroll_open,
                        c.geo_enabled, c.geo_lat, c.geo_lng, c.geo_radius_m
                 FROM sessions s JOIN classes c ON c.id = s.class_id WHERE s.id = $1`, [sessionId]);
    if (!s) throw new HttpError(404, 'This attendance code is not valid.');
    return s;
  }

  function publicSession(s) {
    return { className: s.class_name, classCode: s.class_code, date: s.date, startTime: s.start_time, endTime: s.end_time, needsLocation: !!s.geo_enabled };
  }

  async function totalsFor(studentNumber, cls) {
    const t = await one(`SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE a.status IN ('present','late')) AS attended
      FROM sessions x LEFT JOIN attendance a ON a.session_id = x.id AND a.student_number = $1
      WHERE x.class_id = $2 AND (x.date <= $3 OR x.status != 'scheduled')`, [studentNumber, cls.class_id, todayIn(cls.timezone)]);
    return { attended: t.attended || 0, total: t.total || 0 };
  }

  app.get('/c/:token', (req, res) => {
    deviceToken(req, res);
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'checkin.html'));
  });

  // Step 1: the phone presents the code it just scanned.
  app.post('/api/checkin/scan', async (req, res) => {
    const token = deviceToken(req, res);
    const parsed = sec.parseQrToken(req.body.token);
    if (!parsed || parsed.sessionId > 2147483647) throw new HttpError(400, 'This attendance code is not valid.');
    const s = await sessionForCheckin(parsed.sessionId);
    const verdict = sec.verifyQrToken(parsed, s.secret, cfg.rotateMs, cfg.graceWindows);
    if (verdict === 'invalid') throw new HttpError(400, 'This attendance code is not valid.');
    const device = await deviceFor(token);
    if (verdict === 'expired') {
      await logEvent({ sessionId: s.id, classId: s.class_id, studentNumber: device?.student_number, kind: 'expired_code', detail: 'Scanned an expired QR code (possibly a forwarded photo/screenshot).', ip: req.ip });
      throw new HttpError(410, 'This QR code has expired. Scan the code currently shown in class.');
    }
    if (s.status !== 'open') throw new HttpError(409, 'Attendance for this session is not open.');

    const claim = sec.makeClaim(db.serverSecret, s.id, sec.sha256(token), cfg.claimMs);
    const existing = device && await one('SELECT status, checked_in_at FROM attendance WHERE session_id = $1 AND student_number = $2', [s.id, device.student_number]);
    res.json({
      claim,
      claimExpiresInMs: cfg.claimMs,
      session: publicSession(s),
      me: device ? { studentNumber: device.student_number, name: device.name } : null,
      alreadyCheckedIn: existing || null,
      totals: device ? await totalsFor(device.student_number, s) : null,
      enrollOpen: !!s.enroll_open,
    });
  });

  async function claimedSession(req, res) {
    const token = deviceToken(req, res);
    const sid = sec.verifyClaim(db.serverSecret, req.body.claim, sec.sha256(token));
    if (!sid) throw new HttpError(410, 'Your check-in window ran out. Please scan the QR code again.');
    const s = await sessionForCheckin(sid);
    if (s.status !== 'open') throw new HttpError(409, 'Attendance for this session is closed.');
    return { token, s };
  }

  // Step 2 (first time only): bind this phone to a student ID.
  app.post('/api/checkin/register', async (req, res) => {
    const { token, s } = await claimedSession(req, res);
    const studentNumber = str(req.body.studentNumber, 40);
    const name = str(req.body.name, 120);
    const localId = str(req.body.localId, 100) || null;
    const ev = (studentNumber, kind, detail) => logEvent({ sessionId: s.id, classId: s.class_id, studentNumber, kind, detail, ip: req.ip });
    if (!studentNumber) throw new HttpError(400, 'Enter your student ID.');
    if (await deviceFor(token)) throw new HttpError(409, 'This phone is already registered.');
    if (!s.enroll_open) {
      await ev(studentNumber, 'register_blocked', 'Tried to register a new phone while registration is closed for this class.');
      throw new HttpError(403, 'New phone registration is closed for this class. Please see your instructor.');
    }
    const onRoster = await one('SELECT student_number, name FROM roster WHERE class_id = $1 AND lower(student_number) = lower($2)', [s.class_id, studentNumber]);
    if (s.roster_only && !onRoster) {
      await ev(studentNumber, 'not_on_roster', 'Tried to register with an ID that is not on the class roster.');
      throw new HttpError(403, 'That student ID is not on the class list. Check it, or see your instructor.');
    }
    const canonicalNumber = onRoster ? onRoster.student_number : studentNumber;
    const displayName = name || onRoster?.name || '';
    if (!displayName) throw new HttpError(400, 'Enter your full name.');

    if (await one('SELECT 1 FROM devices WHERE student_number = $1', [canonicalNumber])) {
      await ev(canonicalNumber, 'id_on_other_phone', 'Someone tried to register this student ID on a second phone.');
      throw new HttpError(409, 'This student ID is already registered on another phone. If you changed phones, ask your instructor to reset it.');
    }
    const prior = localId && await one('SELECT student_number FROM devices WHERE local_id = $1', [localId]);
    if (prior) {
      await ev(canonicalNumber, 'phone_reused', `Phone already registered to ${prior.student_number} tried to register as ${canonicalNumber}.`);
      throw new HttpError(409, 'This phone is already registered to another student.');
    }
    try {
      await db.tx(async (tq) => {
        await tq(`INSERT INTO students (student_number, name, created_at) VALUES ($1,$2,$3)
           ON CONFLICT (student_number) DO UPDATE SET name = excluded.name`, [canonicalNumber, displayName, now()]);
        await tq(`INSERT INTO devices (token_hash, local_id, student_number, fingerprint, user_agent, ip, created_at, last_seen) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
          [sec.sha256(token), localId, canonicalNumber, str(req.body.fingerprint, 100), str(req.get('user-agent'), 300), req.ip, now()]);
      });
    } catch (err) {
      // Lost a race with a simultaneous registration (unique violation).
      if (err.code === '23505') throw new HttpError(409, 'This student ID or phone was just registered. Please scan again.');
      throw err;
    }
    res.json({ me: { studentNumber: canonicalNumber, name: displayName } });
  });

  // Step 3: record attendance for the phone's registered student.
  app.post('/api/checkin/confirm', async (req, res) => {
    const { token, s } = await claimedSession(req, res);
    const device = await deviceFor(token);
    if (!device) throw new HttpError(403, 'This phone is not registered yet.');
    const num = device.student_number;
    const log = (kind, detail) => logEvent({ sessionId: s.id, classId: s.class_id, studentNumber: num, kind, detail, ip: req.ip });

    // Browsers (notably Safari) may wipe localStorage while keeping the
    // cookie, so a changed local id is refreshed rather than rejected.
    const localId = str(req.body.localId, 100) || null;
    if (s.roster_only && !(await one('SELECT 1 FROM roster WHERE class_id = $1 AND student_number = $2', [s.class_id, num]))) {
      await log('not_on_roster', 'Registered student is not on this class roster.');
      throw new HttpError(403, 'You are not on the class list for this class. Please see your instructor.');
    }

    let lat = null, lng = null, distance = null;
    if (s.geo_enabled) {
      lat = Number(req.body.lat);
      lng = Number(req.body.lng);
      const accuracy = Math.min(Math.max(Number(req.body.accuracy) || 0, 0), 1000);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new HttpError(400, 'Location is required for this class. Allow location access and try again.', { needsLocation: true });
      }
      distance = sec.distanceMeters(lat, lng, s.geo_lat, s.geo_lng);
      // Give the benefit of the doubt for GPS accuracy, up to a cap.
      if (distance - Math.min(accuracy, 150) > s.geo_radius_m) {
        await log('too_far', `Checked in ${Math.round(distance)} m from the classroom (allowed ${s.geo_radius_m} m).`);
        throw new HttpError(403, `You appear to be ${Math.round(distance)} m away from the classroom. You need to be in class to check in.`);
      }
    }

    const late = now() > wallTimeToEpoch(s.date, s.start_time, s.timezone) + s.late_after_min * 60000;
    const inserted = await one(`INSERT INTO attendance (session_id, student_number, status, method, device_id, fingerprint, ip, lat, lng, distance_m, checked_in_at)
       VALUES ($1,$2,$3,'qr',$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (session_id, student_number) DO NOTHING RETURNING status`,
    [s.id, num, late ? 'late' : 'present', device.id, str(req.body.fingerprint, 100), req.ip, lat, lng, distance, now()]);
    const status = inserted ? inserted.status
      : (await one('SELECT status FROM attendance WHERE session_id = $1 AND student_number = $2', [s.id, num])).status;
    await all('UPDATE devices SET last_seen = $1, local_id = COALESCE($2, local_id) WHERE id = $3', [now(), localId, device.id]);

    res.json({
      status,
      already: !inserted,
      me: { studentNumber: num, name: device.name },
      session: publicSession(s),
      totals: await totalsFor(num, s),
    });
  });

  // ------------------------------------------------------------- static
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  app.locals.dbReady = dbReady;
  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Attendance app running on http://localhost:${config.port}`);
    if (!config.publicUrl) console.log('Tip: set PUBLIC_URL to the https address students will reach (see README).');
  });
}

module.exports = { createApp };
