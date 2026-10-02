'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instructors (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  late_after_min INTEGER NOT NULL DEFAULT 15,
  roster_only INTEGER NOT NULL DEFAULT 0,
  enroll_open INTEGER NOT NULL DEFAULT 1,
  geo_enabled INTEGER NOT NULL DEFAULT 0,
  geo_lat REAL,
  geo_lng REAL,
  geo_radius_m INTEGER NOT NULL DEFAULT 150,
  created_at INTEGER NOT NULL
);

-- One row per scheduled meeting of a class ("session").
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date TEXT NOT NULL,          -- YYYY-MM-DD (server local time)
  start_time TEXT NOT NULL,    -- HH:MM
  end_time TEXT NOT NULL,      -- HH:MM
  secret TEXT NOT NULL,        -- per-session key used to sign rotating QR tokens
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | open | closed
  opened_at INTEGER,
  closed_at INTEGER,
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
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,     -- hash of the httpOnly cookie
  local_id TEXT,                       -- id kept in the phone's localStorage
  student_number TEXT NOT NULL UNIQUE REFERENCES students(student_number) ON DELETE CASCADE,
  fingerprint TEXT,
  user_agent TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_local_id ON devices(local_id);

CREATE TABLE IF NOT EXISTS attendance (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_number TEXT NOT NULL,
  status TEXT NOT NULL,                -- present | late | excused
  method TEXT NOT NULL,                -- qr | manual
  device_id INTEGER,
  fingerprint TEXT,
  ip TEXT,
  lat REAL,
  lng REAL,
  distance_m REAL,
  checked_in_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, student_number)
);

-- Rejected / suspicious attempts, shown to the instructor.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  student_number TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  ip TEXT,
  created_at INTEGER NOT NULL
);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  db.tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  // Server-wide signing key, generated once and persisted unless provided.
  let secret = process.env.SERVER_SECRET;
  if (!secret) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'server_secret'").get();
    if (row) secret = row.value;
    else {
      secret = crypto.randomBytes(32).toString('hex');
      db.prepare("INSERT INTO settings (key, value) VALUES ('server_secret', ?)").run(secret);
    }
  }
  db.serverSecret = secret;
  return db;
}

module.exports = { open };
