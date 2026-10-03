'use strict';
(() => {
  const app = document.getElementById('app');
  const token = decodeURIComponent(location.pathname.split('/').pop() || '');
  let claim = null;
  let session = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function localId() {
    try {
      let id = localStorage.getItem('att_local_id');
      if (!id) {
        id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('att_local_id', id);
      }
      return id;
    } catch { return null; }
  }

  // Coarse browser signature. Not unique (two identical phones match) – it is
  // only used to flag suspicious pairs of check-ins for the instructor.
  function fingerprint() {
    const parts = [
      navigator.userAgent, navigator.language, (navigator.languages || []).join(','),
      screen.width + 'x' + screen.height + 'x' + screen.colorDepth, window.devicePixelRatio,
      Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.hardwareConcurrency, navigator.maxTouchPoints,
    ].join('|');
    let h = 2166136261;
    for (let i = 0; i < parts.length; i++) { h ^= parts.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Please try again.');
      Object.assign(err, data, { status: res.status });
      throw err;
    }
    return data;
  }

  function header() {
    if (!session) return '';
    return `<p class="center muted" style="margin-bottom:0">${esc(session.classCode ? session.classCode + ' · ' : '')}${esc(new Date(session.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))} · ${esc(session.startTime)}–${esc(session.endTime)}</p>
            <h1 class="center">${esc(session.className)}</h1>`;
  }

  function showError(message, { retryScan = false, retry = null } = {}) {
    app.innerHTML = `${header()}
      <div class="big-icon bad">!</div>
      <h2 class="center">Couldn't check you in</h2>
      <p class="center">${esc(message)}</p>
      ${retry ? '<button class="primary full" id="retry">Try again</button>' : ''}
      ${retryScan ? '<p class="center muted">Scan the QR code on the screen again with your camera.</p>' : ''}`;
    if (retry) document.getElementById('retry').onclick = retry;
  }

  function showSuccess(r) {
    const late = r.status === 'late';
    const pct = r.totals.total ? Math.round((r.totals.attended / r.totals.total) * 100) : null;
    app.innerHTML = `${header()}
      <div class="big-icon ${late ? 'warn' : 'ok'}">✓</div>
      <h2 class="center">${r.already ? "You're already checked in" : late ? 'Checked in (late)' : "You're checked in"}</h2>
      <p class="center"><strong>${esc(r.me.name)}</strong><br><span class="muted">${esc(r.me.studentNumber)}</span></p>
      <div class="card center">
        <div class="muted">Your attendance in this class</div>
        <div style="font-size:1.6rem;font-weight:700">${r.totals.attended} / ${r.totals.total}${pct !== null ? ` <span class="muted" style="font-size:1rem">(${pct}%)</span>` : ''}</div>
      </div>
      <p class="center muted"><small>Checked in at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. You can close this page.</small></p>`;
  }

  // Watch the position for a few seconds and keep the most precise reading:
  // the first fix indoors is often coarse (Wi-Fi/cell) and improves quickly.
  function getLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Your browser does not support location.'));
      let best = null;
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        navigator.geolocation.clearWatch(watch);
        clearTimeout(timer);
        if (best) resolve(best);
        else reject(err || new Error('Could not get your location. Make sure location services are on, then try again.'));
      };
      const watch = navigator.geolocation.watchPosition(
        (p) => {
          const r = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
          if (!best || r.accuracy < best.accuracy) best = r;
          const hint = document.getElementById('loc-hint');
          if (hint) hint.textContent = `Location accuracy: ±${Math.round(best.accuracy)} m`;
          if (best.accuracy <= 30) finish();
        },
        (e) => {
          if (e.code === 1) {
            finish(new Error('Location access was blocked. This class requires your location to confirm you are in the classroom. Enable location for this site in your browser settings, then try again.'));
          }
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
      );
      const timer = setTimeout(() => finish(), 12000);
    });
  }

  async function confirm() {
    app.innerHTML = `${header()}<div class="spinner"></div><p class="center muted">${session.needsLocation ? 'Checking your location…' : 'Checking you in…'}</p>${session.needsLocation ? '<p class="center muted" id="loc-hint"></p>' : ''}`;
    try {
      const body = { claim, localId: localId(), fingerprint: fingerprint() };
      if (session.needsLocation) Object.assign(body, await getLocation());
      showSuccess(await api('/api/checkin/confirm', body));
    } catch (err) {
      showError(err.message, { retry: err.status === 410 ? null : confirm, retryScan: err.status === 410 });
    }
  }

  function showRegister(enrollOpen, prefillError, prev = {}) {
    if (!enrollOpen) {
      showError('This phone is not registered for attendance, and new registrations are closed for this class. Please see your instructor.');
      return;
    }
    app.innerHTML = `${header()}
      <div class="card">
        <h2>One-time setup</h2>
        <p class="muted">Link this phone to your student ID. From then on, scanning the code checks you in automatically – no typing.</p>
        <div class="notice warn" style="font-size:.9rem">Each phone can be linked to <strong>one</strong> student, and each student to <strong>one</strong> phone. Only your instructor can change it.</div>
        ${prefillError ? `<div class="notice bad">${esc(prefillError)}</div>` : ''}
        <form id="reg">
          <div class="field">
            <label for="sid">Student ID</label>
            <input id="sid" type="text" value="${esc(prev.sid)}" inputmode="text" autocomplete="off" autocapitalize="characters" required maxlength="40">
          </div>
          <div class="field">
            <label for="sname">Full name</label>
            <input id="sname" type="text" value="${esc(prev.name)}" autocomplete="name" required maxlength="120">
          </div>
          <label class="check"><input type="checkbox" id="mine" required> This is my own phone and my own student ID.</label>
          <button class="primary full" style="margin-top:1rem" type="submit">Register &amp; check in</button>
        </form>
      </div>`;
    document.getElementById('reg').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        await api('/api/checkin/register', {
          claim,
          studentNumber: document.getElementById('sid').value,
          name: document.getElementById('sname').value,
          localId: localId(),
          fingerprint: fingerprint(),
        });
        await confirm();
      } catch (err) {
        if (err.status === 410) showError(err.message, { retryScan: true });
        else showRegister(true, err.message, { sid: document.getElementById('sid').value, name: document.getElementById('sname').value });
      }
    };
  }

  async function start() {
    try {
      const r = await api('/api/checkin/scan', { token });
      claim = r.claim;
      session = r.session;
      // Drop the code from the address bar so the page can't be re-shared.
      history.replaceState(null, '', '/c/done');
      if (r.alreadyCheckedIn && r.me) {
        return showSuccess({ ...r, status: r.alreadyCheckedIn.status, already: true });
      }
      if (r.me) return confirm();
      showRegister(r.enrollOpen);
    } catch (err) {
      showError(err.message, { retryScan: true });
    }
  }

  start();
})();
