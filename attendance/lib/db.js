'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

// Postgres everywhere: a real server (e.g. Neon via Vercel) when DATABASE_URL
// is set, otherwise PGlite – an embedded Postgres stored in a local folder –
// so the app runs with zero setup on a laptop.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instructors (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS instructors_username ON instructors (lower(username));

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id SERIAL PRIMARY KEY,
  instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  late_after_min INTEGER NOT NULL DEFAULT 15,
  roster_only BOOLEAN NOT NULL DEFAULT FALSE,
  enroll_open BOOLEAN NOT NULL DEFAULT TRUE,
  geo_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  geo_lat DOUBLE PRECISION,
  geo_lng DOUBLE PRECISION,
  geo_radius_m INTEGER NOT NULL DEFAULT 150,
  created_at BIGINT NOT NULL
);

-- One row per scheduled meeting of a class ("session").
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date TEXT NOT NULL,          -- YYYY-MM-DD in the class's time zone
  start_time TEXT NOT NULL,    -- HH:MM
  end_time TEXT NOT NULL,      -- HH:MM
  secret TEXT NOT NULL,        -- per-session key used to sign rotating QR tokens
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | open | closed
  opened_at BIGINT,
  closed_at BIGINT,
  UNIQUE (class_id, date, start_time)
);

CREATE TABLE IF NOT EXISTS roster (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_number TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (class_id, student_number)
);

-- A student identity. Exactly one phone (device) can be bound to it at a time.
CREATE TABLE IF NOT EXISTS students (
  student_number TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,     -- hash of the httpOnly cookie
  local_id TEXT,                       -- id kept in the phone's localStorage
  student_number TEXT NOT NULL UNIQUE REFERENCES students(student_number) ON DELETE CASCADE,
  fingerprint TEXT,
  user_agent TEXT,
  ip TEXT,
  created_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_local_id ON devices (local_id);

CREATE TABLE IF NOT EXISTS attendance (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_number TEXT NOT NULL,
  status TEXT NOT NULL,                -- present | late | excused
  method TEXT NOT NULL,                -- qr | manual
  device_id INTEGER,
  fingerprint TEXT,
  ip TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  distance_m DOUBLE PRECISION,
  checked_in_at BIGINT NOT NULL,
  PRIMARY KEY (session_id, student_number)
);

-- Rejected / suspicious attempts, shown to the instructor.
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  student_number TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  ip TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_class ON events (class_id, created_at);
`;

const INT8 = 20;

function pgDriver(url) {
  const pg = require('pg');
  pg.types.setTypeParser(INT8, Number);
  const local = /localhost|127\.0\.0\.1/.test(url);
  const noSsl = local || /sslmode=disable/.test(url);
  // Hosted Postgres URLs (Neon, Supabase) carry sslmode=require, which pg now
  // treats as full certificate verification and which would override the ssl
  // option below; drop it so the explicit setting applies.
  const connectionString = url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const pool = new pg.Pool({
    connectionString,
    ssl: noSsl ? false : { rejectUnauthorized: false },
    max: Number(process.env.DB_POOL_MAX || 3),
  });
  return {
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    exec: (sql) => pool.query(sql),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(async (sql, params) => (await client.query(sql, params)).rows);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function pgliteDriver(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dir !== 'memory://') fs.mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir, { parsers: { [INT8]: Number } });
  await db.waitReady;
  return {
    query: async (sql, params) => (await db.query(sql, params)).rows,
    exec: (sql) => db.exec(sql),
    tx: (fn) => db.transaction((t) => fn(async (sql, params) => (await t.query(sql, params)).rows)),
    close: () => db.close(),
  };
}

async function open({ databaseUrl, dataDir }) {
  const d = databaseUrl ? pgDriver(databaseUrl) : await pgliteDriver(dataDir);
  await d.exec(SCHEMA);

  const db = {
    ...d,
    one: async (sql, params) => (await d.query(sql, params))[0] || null,
  };

  // Server-wide signing key, generated once and persisted unless provided.
  db.serverSecret = process.env.SERVER_SECRET;
  if (!db.serverSecret) {
    await d.query("INSERT INTO settings (key, value) VALUES ('server_secret', $1) ON CONFLICT (key) DO NOTHING",
      [crypto.randomBytes(32).toString('hex')]);
    db.serverSecret = (await db.one("SELECT value FROM settings WHERE key = 'server_secret'")).value;
  }
  return db;
}

module.exports = { open };
