'use strict';
const path = require('node:path');
const express = require('express');
const QRCode = require('qrcode');
const sec = require('./lib/security');
const { open } = require('./lib/db');

const config = {
  port: Number(process.env.PORT || 3000),
  dbFile: process.env.DB_FILE || path.join(__dirname, 'data', 'attendance.db'),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  rotateMs: Number(process.env.QR_ROTATE_SECONDS || 10) * 1000,
  graceWindows: Number(process.env.QR_GRACE_WINDOWS || 2),
  claimMs: Number(process.env.CHECKIN_WINDOW_MINUTES || 5) * 60 * 1000,
  allowSignup: process.env.ALLOW_SIGNUP === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
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
  const db = open(cfg.dbFile);
  const app = express();
  if (cfg.trustProxy) app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const q = (sql) => db.prepare(sql);
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

  const wrap = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out && typeof out.then === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
  };

  const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const localTs = (date, time) => new Date(`${date}T${time}:00`).getTime();

  function logEvent({ sessionId = null, classId = null, studentNumber = null, kind, detail, ip = null }) {
    q('INSERT INTO events (session_id, class_id, student_number, kind, detail, ip, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(sessionId, classId, studentNumber, kind, detail, ip, now());
  }

  // ------------------------------------------------------- instructor auth
  function currentInstructor(req) {
    const token = parseCookies(req)[AUTH_COOKIE];
    if (!token) return null;
    const row = q(`SELECT i.id, i.username FROM auth_sessions a JOIN instructors i ON i.id = a.instructor_id
                   WHERE a.token_hash = ? AND a.expires_at > ?`).get(sec.sha256(token), now());
    return row || null;
  }

  function requireAuth(req, res, next) {
    const user = currentInstructor(req);
    if (!user) return res.status(401).json({ error: 'Please log in.' });
    req.user = user;
    next();
  }

  function startAuthSession(req, res, instructorId) {
    const token = sec.randomToken();
    q('INSERT INTO auth_sessions (token_hash, instructor_id, expires_at) VALUES (?,?,?)')
      .run(sec.sha256(token), instructorId, now() + AUTH_TTL_MS);
    setCookie(req, res, AUTH_COOKIE, token, AUTH_TTL_MS);
  }

  const loginAttempts = new Map(); // ip -> { count, resetAt }
  function throttleLogin(req) {
    const key = req.ip;
    const entry = loginAttempts.get(key);
    if (entry && entry.resetAt > now() && entry.count >= 10) {
      throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    }
    if (!entry || entry.resetAt <= now()) loginAttempts.set(key, { count: 1, resetAt: now() + 10 * 60 * 1000 });
    else entry.count += 1;
  }

  const instructorCount = () => q('SELECT COUNT(*) AS n FROM instructors').get().n;

  app.get('/api/auth/state', wrap((req, res) => {
    const n = instructorCount();
    res.json({ user: currentInstructor(req), setupNeeded: n === 0, signupAllowed: n === 0 || cfg.allowSignup });
  }));

  app.post('/api/auth/signup', wrap((req, res) => {
    if (instructorCount() > 0 && !cfg.allowSignup) throw new HttpError(403, 'Sign-up is disabled.');
    const username = str(req.body.username, 60);
    const password = String(req.body.password || '');
    if (username.length < 3) throw new HttpError(400, 'Username must be at least 3 characters.');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (q('SELECT 1 FROM instructors WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken.');
    const { lastInsertRowid } = q('INSERT INTO instructors (username, pass_hash, created_at) VALUES (?,?,?)')
      .run(username, sec.hashPassword(password), now());
    startAuthSession(req, res, Number(lastInsertRowid));
    res.json({ ok: true });
  }));

  app.post('/api/auth/login', wrap((req, res) => {
    throttleLogin(req);
    const row = q('SELECT id, pass_hash FROM instructors WHERE username = ?').get(str(req.body.username, 60));
    if (!row || !sec.verifyPassword(String(req.body.password || ''), row.pass_hash)) {
      throw new HttpError(401, 'Wrong username or password.');
    }
    loginAttempts.delete(req.ip);
    startAuthSession(req, res, row.id);
    res.json({ ok: true });
  }));

  app.post('/api/auth/logout', wrap((req, res) => {
    const token = parseCookies(req)[AUTH_COOKIE];
    if (token) q('DELETE FROM auth_sessions WHERE token_hash = ?').run(sec.sha256(token));
    setCookie(req, res, AUTH_COOKIE, '', 0);
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------- classes
  function ownClass(req, id) {
    const cls = q('SELECT * FROM classes WHERE id = ? AND instructor_id = ?').get(Number(id), req.user.id);
    if (!cls) throw new HttpError(404, 'Class not found.');
    return cls;
  }

  function ownSession(req, id) {
    const s = q(`SELECT s.*, c.name AS class_name, c.code AS class_code, c.late_after_min, c.geo_enabled
                 FROM sessions s JOIN classes c ON c.id = s.class_id
                 WHERE s.id = ? AND c.instructor_id = ?`).get(Number(id), req.user.id);
    if (!s) throw new HttpError(404, 'Session not found.');
    return s;
  }

  // Students who belong to a class: roster entries plus anyone who has ever
  // checked in to one of its sessions.
  function classMembers(classId) {
    return q(`
      SELECT m.student_number,
             COALESCE(NULLIF(r.name, ''), st.name, '') AS name,
             r.student_number IS NOT NULL AS on_roster,
             d.id AS device_id, d.created_at AS device_created_at, d.last_seen AS device_last_seen, d.user_agent
      FROM (
        SELECT student_number FROM roster WHERE class_id = ?1
        UNION
        SELECT a.student_number FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.class_id = ?1
      ) m
      LEFT JOIN roster r ON r.class_id = ?1 AND r.student_number = m.student_number
      LEFT JOIN students st ON st.student_number = m.student_number
      LEFT JOIN devices d ON d.student_number = m.student_number
      ORDER BY name COLLATE NOCASE, m.student_number`).all(classId);
  }

  function classPayload(cls) {
    const { geo_lat, geo_lng, ...rest } = cls;
    return {
      ...rest,
      roster_only: !!cls.roster_only,
      enroll_open: !!cls.enroll_open,
      geo_enabled: !!cls.geo_enabled,
      geo_lat, geo_lng,
    };
  }

  app.get('/api/classes', requireAuth, wrap((req, res) => {
    const rows = q(`
      SELECT c.*,
        (SELECT COUNT(*) FROM sessions s WHERE s.class_id = c.id) AS session_count,
        (SELECT COUNT(*) FROM sessions s WHERE s.class_id = c.id AND s.date < date('now','localtime')) AS past_count,
        (SELECT MIN(date) FROM sessions s WHERE s.class_id = c.id AND s.date >= date('now','localtime')) AS next_date
      FROM classes c WHERE c.instructor_id = ? ORDER BY c.created_at DESC`).all(req.user.id);
    res.json(rows.map(classPayload));
  }));

  function applyClassFields(body, cls = {}) {
    const out = { ...cls };
    if ('name' in body) out.name = str(body.name, 120);
    if ('code' in body) out.code = str(body.code, 40);
    if ('late_after_min' in body) out.late_after_min = Math.max(0, Math.min(600, Number(body.late_after_min) || 0));
    if ('roster_only' in body) out.roster_only = body.roster_only ? 1 : 0;
    if ('enroll_open' in body) out.enroll_open = body.enroll_open ? 1 : 0;
    if ('geo_enabled' in body) out.geo_enabled = body.geo_enabled ? 1 : 0;
    if ('geo_radius_m' in body) out.geo_radius_m = Math.max(20, Math.min(5000, Number(body.geo_radius_m) || 150));
    if ('geo_lat' in body) out.geo_lat = body.geo_lat === null ? null : Number(body.geo_lat);
    if ('geo_lng' in body) out.geo_lng = body.geo_lng === null ? null : Number(body.geo_lng);
    if (!out.name) throw new HttpError(400, 'Class name is required.');
    if (out.geo_enabled && !(Number.isFinite(out.geo_lat) && Number.isFinite(out.geo_lng))) {
      throw new HttpError(400, 'Set the classroom location before turning on the location check.');
    }
    return out;
  }

  app.post('/api/classes', requireAuth, wrap((req, res) => {
    const c = applyClassFields(req.body, { late_after_min: 15, roster_only: 0, enroll_open: 1, geo_enabled: 0, geo_radius_m: 150, geo_lat: null, geo_lng: null, code: '' });
    const { lastInsertRowid } = q(`INSERT INTO classes (instructor_id, name, code, late_after_min, roster_only, enroll_open, geo_enabled, geo_lat, geo_lng, geo_radius_m, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, c.name, c.code, c.late_after_min, c.roster_only, c.enroll_open, c.geo_enabled, c.geo_lat, c.geo_lng, c.geo_radius_m, now());
    res.json({ id: Number(lastInsertRowid) });
  }));

  app.get('/api/classes/:id', requireAuth, wrap((req, res) => {
    const cls = ownClass(req, req.params.id);
    const sessions = q(`
      SELECT s.id, s.date, s.start_time, s.end_time, s.status,
        (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id AND a.status IN ('present','late')) AS attended
      FROM sessions s WHERE s.class_id = ? ORDER BY s.date, s.start_time`).all(cls.id);
    const roster = q('SELECT student_number, name FROM roster WHERE class_id = ? ORDER BY name COLLATE NOCASE').all(cls.id);
    res.json({ class: classPayload(cls), sessions, roster, members: classMembers(cls.id) });
  }));

  app.patch('/api/classes/:id', requireAuth, wrap((req, res) => {
    const c = applyClassFields(req.body, ownClass(req, req.params.id));
    q(`UPDATE classes SET name=?, code=?, late_after_min=?, roster_only=?, enroll_open=?, geo_enabled=?, geo_lat=?, geo_lng=?, geo_radius_m=? WHERE id=?`)
      .run(c.name, c.code, c.late_after_min, c.roster_only, c.enroll_open, c.geo_enabled, c.geo_lat, c.geo_lng, c.geo_radius_m, c.id);
    res.json({ ok: true });
  }));

  app.delete('/api/classes/:id', requireAuth, wrap((req, res) => {
    const cls = ownClass(req, req.params.id);
    q('DELETE FROM classes WHERE id = ?').run(cls.id);
    res.json({ ok: true });
  }));

  // Generate sessions from a weekly pattern, e.g. Mon/Wed/Fri for 3 months.
  app.post('/api/classes/:id/schedule', requireAuth, wrap((req, res) => {
    const cls = ownClass(req, req.params.id);
    const { startDate, endDate, startTime, endTime } = req.body;
    const weekdays = new Set((req.body.weekdays || []).map(Number).filter((d) => d >= 0 && d <= 6));
    if (!isDate(startDate) || !isDate(endDate)) throw new HttpError(400, 'Pick a start and end date.');
    if (!isTime(startTime) || !isTime(endTime) || endTime <= startTime) throw new HttpError(400, 'Pick a valid start and end time.');
    if (!weekdays.size) throw new HttpError(400, 'Pick at least one weekday.');
    const start = new Date(`${startDate}T12:00:00`);
    const end = new Date(`${endDate}T12:00:00`);
    if (end < start) throw new HttpError(400, 'End date is before start date.');
    if ((end - start) / 86400000 > 400) throw new HttpError(400, 'Schedules are limited to about a year.');

    const insert = q(`INSERT OR IGNORE INTO sessions (class_id, date, start_time, end_time, secret) VALUES (?,?,?,?,?)`);
    let created = 0;
    db.tx(() => {
      for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (!weekdays.has(d.getDay())) continue;
        created += Number(insert.run(cls.id, ymd(d), startTime, endTime, sec.randomToken()).changes);
      }
    });
    res.json({ created });
  }));

  app.post('/api/classes/:id/sessions', requireAuth, wrap((req, res) => {
    const cls = ownClass(req, req.params.id);
    const { date, startTime, endTime } = req.body;
    if (!isDate(date) || !isTime(startTime) || !isTime(endTime) || endTime <= startTime) {
      throw new HttpError(400, 'Pick a valid date, start time and end time.');
    }
    const r = q('INSERT OR IGNORE INTO sessions (class_id, date, start_time, end_time, secret) VALUES (?,?,?,?,?)')
      .run(cls.id, date, startTime, endTime, sec.randomToken());
    if (!r.changes) throw new HttpError(409, 'A session already exists at that date and time.');
    res.json({ id: Number(r.lastInsertRowid) });
  }));

  // Roster: one student per line, "student_id, name" (CSV/TSV/semicolon).
  app.put('/api/classes/:id/roster', requireAuth, wrap((req, res) => {
    const cls = ownClass(req, req.params.id);
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
    db.tx(() => {
      q('DELETE FROM roster WHERE class_id = ?').run(cls.id);
      const ins = q('INSERT INTO roster (class_id, student_number, name) VALUES (?,?,?)');
      for (const [num, name] of rows) ins.run(cls.id, num, name);
    });
    res.json({ count: rows.length });
  }));

  app.post('/api/classes/:id/students/:num/reset-device', requireAuth, wrap((req, res) => {
    const cls = ownClass(req, req.params.id);
    const num = str(req.params.num, 40);
    if (!classMembers(cls.id).some((m) => m.student_number === num)) throw new HttpError(404, 'Student not in this class.');
    const r = q('DELETE FROM devices WHERE student_number = ?').run(num);
    logEvent({ classId: cls.id, studentNumber: num, kind: 'device_reset', detail: 'Instructor reset the registered phone.' });
    res.json({ ok: true, removed: Number(r.changes) });
  }));

  app.get('/api/classes/:id/events', requireAuth, wrap((req, res) => {
    const cls = ownClass(req, req.params.id);
    res.json(q(`SELECT e.*, s.date AS session_date FROM events e LEFT JOIN sessions s ON s.id = e.session_id
                WHERE e.class_id = ? ORDER BY e.created_at DESC LIMIT 300`).all(cls.id));
  }));

  function report(cls) {
    const sessions = q(`SELECT id, date, start_time, status FROM sessions WHERE class_id = ? AND (date <= date('now','localtime') OR status != 'scheduled') ORDER BY date, start_time`).all(cls.id);
    const members = classMembers(cls.id);
    const marks = {};
    for (const a of q(`SELECT a.session_id, a.student_number, a.status FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.class_id = ?`).all(cls.id)) {
      (marks[a.student_number] ||= {})[a.session_id] = a.status;
    }
    const students = members.map((m) => {
      const row = marks[m.student_number] || {};
      const attended = sessions.filter((s) => row[s.id] === 'present' || row[s.id] === 'late').length;
      const excused = sessions.filter((s) => row[s.id] === 'excused').length;
      const counted = sessions.length - excused;
      return { student_number: m.student_number, name: m.name, marks: row, attended, excused, rate: counted ? attended / counted : null };
    });
    return { class: classPayload(cls), sessions, students };
  }

  app.get('/api/classes/:id/report', requireAuth, wrap((req, res) => {
    res.json(report(ownClass(req, req.params.id)));
  }));

  app.get('/api/classes/:id/report.csv', requireAuth, wrap((req, res) => {
    const r = report(ownClass(req, req.params.id));
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
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
  }));

  // ------------------------------------------------------------ sessions
  app.get('/api/sessions/:id', requireAuth, wrap((req, res) => {
    const s = ownSession(req, req.params.id);
    const rows = q(`SELECT a.*, COALESCE(NULLIF(r.name,''), st.name, '') AS name
      FROM attendance a
      LEFT JOIN roster r ON r.class_id = ? AND r.student_number = a.student_number
      LEFT JOIN students st ON st.student_number = a.student_number
      WHERE a.session_id = ? ORDER BY a.checked_in_at`).all(s.class_id, s.id);

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
      delete a.fingerprint;
    }
    const members = classMembers(s.class_id);
    const events = q('SELECT * FROM events WHERE session_id = ? ORDER BY created_at DESC LIMIT 100').all(s.id);
    const { secret, ...session } = s;
    res.json({ session, attendance: rows, members, events });
  }));

  app.post('/api/sessions/:id/open', requireAuth, wrap((req, res) => {
    const s = ownSession(req, req.params.id);
    q(`UPDATE sessions SET status='open', opened_at=COALESCE(opened_at, ?), closed_at=NULL WHERE id=?`).run(now(), s.id);
    res.json({ ok: true });
  }));

  app.post('/api/sessions/:id/close', requireAuth, wrap((req, res) => {
    const s = ownSession(req, req.params.id);
    q(`UPDATE sessions SET status='closed', closed_at=? WHERE id=?`).run(now(), s.id);
    res.json({ ok: true });
  }));

  app.delete('/api/sessions/:id', requireAuth, wrap((req, res) => {
    const s = ownSession(req, req.params.id);
    q('DELETE FROM sessions WHERE id = ?').run(s.id);
    res.json({ ok: true });
  }));

  app.get('/api/sessions/:id/qr', requireAuth, wrap(async (req, res) => {
    const s = ownSession(req, req.params.id);
    if (s.status !== 'open') throw new HttpError(409, 'Open the session to show its QR code.');
    const { token, expiresAt } = sec.qrToken(s.id, s.secret, cfg.rotateMs);
    const url = `${baseUrl(req)}/c/${token}`;
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    const count = q(`SELECT COUNT(*) AS n FROM attendance WHERE session_id = ? AND status IN ('present','late')`).get(s.id).n;
    res.set('Cache-Control', 'no-store');
    res.json({ url, svg, expiresAt, serverNow: now(), rotateMs: cfg.rotateMs, count });
  }));

  // Manual override by the instructor.
  app.put('/api/sessions/:id/attendance/:num', requireAuth, wrap((req, res) => {
    const s = ownSession(req, req.params.id);
    const num = str(req.params.num, 40);
    const status = String(req.body.status || '');
    if (!num) throw new HttpError(400, 'Missing student ID.');
    if (status === 'absent') {
      q('DELETE FROM attendance WHERE session_id = ? AND student_number = ?').run(s.id, num);
    } else if (['present', 'late', 'excused'].includes(status)) {
      q(`INSERT INTO attendance (session_id, student_number, status, method, checked_in_at) VALUES (?,?,?, 'manual', ?)
         ON CONFLICT (session_id, student_number) DO UPDATE SET status = excluded.status`).run(s.id, num, status, now());
    } else {
      throw new HttpError(400, 'Unknown status.');
    }
    res.json({ ok: true });
  }));

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
    return q(`SELECT d.*, st.name FROM devices d JOIN students st ON st.student_number = d.student_number WHERE d.token_hash = ?`)
      .get(sec.sha256(token)) || null;
  }

  function sessionForCheckin(sessionId) {
    const s = q(`SELECT s.*, c.name AS class_name, c.code AS class_code, c.late_after_min, c.roster_only, c.enroll_open,
                        c.geo_enabled, c.geo_lat, c.geo_lng, c.geo_radius_m
                 FROM sessions s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).get(sessionId);
    if (!s) throw new HttpError(404, 'This attendance code is not valid.');
    return s;
  }

  function publicSession(s) {
    return { className: s.class_name, classCode: s.class_code, date: s.date, startTime: s.start_time, endTime: s.end_time, needsLocation: !!s.geo_enabled };
  }

  function totalsFor(studentNumber, classId) {
    const t = q(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN a.status IN ('present','late') THEN 1 ELSE 0 END) AS attended
      FROM sessions x LEFT JOIN attendance a ON a.session_id = x.id AND a.student_number = ?
      WHERE x.class_id = ? AND (x.date <= date('now','localtime') OR x.status != 'scheduled')`).get(studentNumber, classId);
    return { attended: t.attended || 0, total: t.total || 0 };
  }

  app.get('/c/:token', (req, res) => {
    deviceToken(req, res);
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'checkin.html'));
  });

  // Step 1: the phone presents the code it just scanned.
  app.post('/api/checkin/scan', wrap((req, res) => {
    const token = deviceToken(req, res);
    const parsed = sec.parseQrToken(req.body.token);
    if (!parsed) throw new HttpError(400, 'This attendance code is not valid.');
    const s = sessionForCheckin(parsed.sessionId);
    const verdict = sec.verifyQrToken(parsed, s.secret, cfg.rotateMs, cfg.graceWindows);
    const device = deviceFor(token);
    if (verdict === 'invalid') throw new HttpError(400, 'This attendance code is not valid.');
    if (verdict === 'expired') {
      logEvent({ sessionId: s.id, classId: s.class_id, studentNumber: device?.student_number, kind: 'expired_code', detail: 'Scanned an expired QR code (possibly a forwarded photo/screenshot).', ip: req.ip });
      throw new HttpError(410, 'This QR code has expired. Scan the code currently shown in class.');
    }
    if (s.status !== 'open') throw new HttpError(409, 'Attendance for this session is not open.');

    const claim = sec.makeClaim(db.serverSecret, s.id, sec.sha256(token), cfg.claimMs);
    const existing = device && q('SELECT status, checked_in_at FROM attendance WHERE session_id = ? AND student_number = ?').get(s.id, device.student_number);
    res.json({
      claim,
      claimExpiresInMs: cfg.claimMs,
      session: publicSession(s),
      me: device ? { studentNumber: device.student_number, name: device.name } : null,
      alreadyCheckedIn: existing || null,
      totals: device ? totalsFor(device.student_number, s.class_id) : null,
      enrollOpen: !!s.enroll_open,
    });
  }));

  function claimedSession(req, res) {
    const token = deviceToken(req, res);
    const sid = sec.verifyClaim(db.serverSecret, req.body.claim, sec.sha256(token));
    if (!sid) throw new HttpError(410, 'Your check-in window ran out. Please scan the QR code again.');
    const s = sessionForCheckin(sid);
    if (s.status !== 'open') throw new HttpError(409, 'Attendance for this session is closed.');
    return { token, s };
  }

  // Step 2 (first time only): bind this phone to a student ID.
  app.post('/api/checkin/register', wrap((req, res) => {
    const { token, s } = claimedSession(req, res);
    const studentNumber = str(req.body.studentNumber, 40);
    const name = str(req.body.name, 120);
    const localId = str(req.body.localId, 100) || null;
    if (!studentNumber) throw new HttpError(400, 'Enter your student ID.');
    if (deviceFor(token)) throw new HttpError(409, 'This phone is already registered.');
    if (!s.enroll_open) {
      logEvent({ sessionId: s.id, classId: s.class_id, studentNumber, kind: 'register_blocked', detail: 'Tried to register a new phone while registration is closed for this class.', ip: req.ip });
      throw new HttpError(403, 'New phone registration is closed for this class. Please see your instructor.');
    }
    const onRoster = q('SELECT name FROM roster WHERE class_id = ? AND student_number = ? COLLATE NOCASE').get(s.class_id, studentNumber);
    if (s.roster_only && !onRoster) {
      logEvent({ sessionId: s.id, classId: s.class_id, studentNumber, kind: 'not_on_roster', detail: 'Tried to register with an ID that is not on the class roster.', ip: req.ip });
      throw new HttpError(403, 'That student ID is not on the class list. Check it, or see your instructor.');
    }
    const canonicalNumber = onRoster ? q('SELECT student_number FROM roster WHERE class_id = ? AND student_number = ? COLLATE NOCASE').get(s.class_id, studentNumber).student_number : studentNumber;
    const displayName = name || onRoster?.name || '';
    if (!displayName) throw new HttpError(400, 'Enter your full name.');

    if (q('SELECT 1 FROM devices WHERE student_number = ?').get(canonicalNumber)) {
      logEvent({ sessionId: s.id, classId: s.class_id, studentNumber: canonicalNumber, kind: 'id_on_other_phone', detail: 'Someone tried to register this student ID on a second phone.', ip: req.ip });
      throw new HttpError(409, 'This student ID is already registered on another phone. If you changed phones, ask your instructor to reset it.');
    }
    const prior = localId && q('SELECT student_number FROM devices WHERE local_id = ?').get(localId);
    if (prior) {
      logEvent({ sessionId: s.id, classId: s.class_id, studentNumber: canonicalNumber, kind: 'phone_reused', detail: `Phone already registered to ${prior.student_number} tried to register as ${canonicalNumber}.`, ip: req.ip });
      throw new HttpError(409, 'This phone is already registered to another student.');
    }
    try {
      db.tx(() => {
        q(`INSERT INTO students (student_number, name, created_at) VALUES (?,?,?)
           ON CONFLICT (student_number) DO UPDATE SET name = excluded.name`).run(canonicalNumber, displayName, now());
        q(`INSERT INTO devices (token_hash, local_id, student_number, fingerprint, user_agent, ip, created_at, last_seen) VALUES (?,?,?,?,?,?,?,?)`)
          .run(sec.sha256(token), localId, canonicalNumber, str(req.body.fingerprint, 100), str(req.get('user-agent'), 300), req.ip, now(), now());
      });
    } catch (err) {
      // Lost a race with a simultaneous registration (UNIQUE constraint).
      if (/UNIQUE/.test(err.message)) throw new HttpError(409, 'This student ID or phone was just registered. Please scan again.');
      throw err;
    }
    res.json({ me: { studentNumber: canonicalNumber, name: displayName } });
  }));

  // Step 3: record attendance for the phone's registered student.
  app.post('/api/checkin/confirm', wrap((req, res) => {
    const { token, s } = claimedSession(req, res);
    const device = deviceFor(token);
    if (!device) throw new HttpError(403, 'This phone is not registered yet.');
    const num = device.student_number;
    const log = (kind, detail) => logEvent({ sessionId: s.id, classId: s.class_id, studentNumber: num, kind, detail, ip: req.ip });

    // Browsers (notably Safari) may wipe localStorage while keeping the
    // cookie, so a changed local id is refreshed rather than rejected.
    const localId = str(req.body.localId, 100) || null;
    if (s.roster_only && !q('SELECT 1 FROM roster WHERE class_id = ? AND student_number = ?').get(s.class_id, num)) {
      log('not_on_roster', 'Registered student is not on this class roster.');
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
        log('too_far', `Checked in ${Math.round(distance)} m from the classroom (allowed ${s.geo_radius_m} m).`);
        throw new HttpError(403, `You appear to be ${Math.round(distance)} m away from the classroom. You need to be in class to check in.`);
      }
    }

    const existing = q('SELECT status, checked_in_at FROM attendance WHERE session_id = ? AND student_number = ?').get(s.id, num);
    let status = existing?.status;
    if (!existing) {
      status = now() > localTs(s.date, s.start_time) + s.late_after_min * 60000 ? 'late' : 'present';
      q(`INSERT INTO attendance (session_id, student_number, status, method, device_id, fingerprint, ip, lat, lng, distance_m, checked_in_at)
         VALUES (?,?,?,'qr',?,?,?,?,?,?,?)`).run(s.id, num, status, device.id, str(req.body.fingerprint, 100), req.ip, lat, lng, distance, now());
    }
    q('UPDATE devices SET last_seen = ?, local_id = COALESCE(?, local_id) WHERE id = ?').run(now(), localId, device.id);

    res.json({
      status,
      already: !!existing,
      me: { studentNumber: num, name: device.name },
      session: publicSession(s),
      totals: totalsFor(num, s.class_id),
    });
  }));

  // ------------------------------------------------------------- static
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  app.locals.db = db;
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
