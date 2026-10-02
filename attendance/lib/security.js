'use strict';
const crypto = require('node:crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- Instructor passwords -------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// ---- Rotating QR tokens ---------------------------------------------------
// The QR shown in class encodes  <sessionId>.<window>.<mac>  where window is
// floor(now / rotateMs). A new code appears every rotateMs; a scanned code is
// accepted only for the current window plus `graceWindows` previous ones, so a
// screenshot sent to a friend outside the room stops working within seconds.

function qrToken(sessionId, sessionSecret, rotateMs, now = Date.now()) {
  const w = Math.floor(now / rotateMs);
  const mac = b64url(hmac(sessionSecret, `${sessionId}.${w}`)).slice(0, 16);
  return { token: `${sessionId}.${w}.${mac}`, expiresAt: (w + 1) * rotateMs };
}

function parseQrToken(token) {
  const m = /^(\d+)\.(\d+)\.([A-Za-z0-9_-]{16})$/.exec(String(token || ''));
  if (!m) return null;
  return { sessionId: Number(m[1]), window: Number(m[2]), mac: m[3] };
}

function verifyQrToken(parsed, sessionSecret, rotateMs, graceWindows, now = Date.now()) {
  const current = Math.floor(now / rotateMs);
  if (parsed.window > current || parsed.window < current - graceWindows) return 'expired';
  const expected = b64url(hmac(sessionSecret, `${parsed.sessionId}.${parsed.window}`)).slice(0, 16);
  return safeEqual(expected, parsed.mac) ? 'ok' : 'invalid';
}

// ---- Check-in claims ------------------------------------------------------
// After a valid scan, the phone gets a short-lived signed claim so that a
// first-time student has a few minutes to type their ID without the rotating
// code expiring underneath them. The claim is bound to the device cookie
// nonce, so it can't be copied to another phone.

function makeClaim(serverSecret, sessionId, deviceNonce, ttlMs, now = Date.now()) {
  const exp = now + ttlMs;
  const body = `${sessionId}.${exp}`;
  const mac = b64url(hmac(serverSecret, `claim.${body}.${deviceNonce}`));
  return `${body}.${mac}`;
}

function verifyClaim(serverSecret, claim, deviceNonce, now = Date.now()) {
  const m = /^(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(String(claim || ''));
  if (!m) return null;
  const [, sid, exp, mac] = m;
  if (Number(exp) < now) return null;
  const expected = b64url(hmac(serverSecret, `claim.${sid}.${exp}.${deviceNonce}`));
  return safeEqual(expected, mac) ? Number(sid) : null;
}

// ---- Geo -----------------------------------------------------------------

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

module.exports = {
  sha256, randomToken, safeEqual,
  hashPassword, verifyPassword,
  qrToken, parseQrToken, verifyQrToken,
  makeClaim, verifyClaim,
  distanceMeters,
};
