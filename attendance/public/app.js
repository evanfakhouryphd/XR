'use strict';
(() => {
  const app = document.getElementById('app');
  const topbar = document.getElementById('topbar');
  let user = null;
  let timers = [];

  // ------------------------------------------------------------- utilities
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = (date) => WEEKDAYS[new Date(`${date}T12:00:00`).getDay()];
  const fmtDate = (date) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDateTime = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function every(ms, fn) { timers.push(setInterval(fn, ms)); }
  function later(ms, fn) { timers.push(setTimeout(fn, ms)); }
  function clearTimers() { timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); timers = []; }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith('/api/auth')) { user = null; route(); throw new Error('Please log in.'); }
    if (res.status === 403 && data.mustChangePassword) { if (user) user.must_change_password = true; location.hash = '#/account'; route(); throw new Error(data.error); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  // Run an async action from a button, showing errors in place.
  function action(fn) {
    return async (e) => {
      if (e && e.preventDefault) e.preventDefault();
      const btn = e && (e.submitter || (e.currentTarget instanceof HTMLButtonElement ? e.currentTarget : null));
      if (btn) btn.disabled = true;
      try { await fn(e); } catch (err) { toast(err.message); } finally { if (btn) btn.disabled = false; }
    };
  }

  const statusPill = (s) => ({
    scheduled: '<span class="pill">Scheduled</span>',
    open: '<span class="pill ok">● Open</span>',
    closed: '<span class="pill info">Closed</span>',
  }[s] || '');

  const markPill = (s) => ({
    present: '<span class="pill ok">Present</span>',
    late: '<span class="pill warn">Late</span>',
    excused: '<span class="pill info">Excused</span>',
  }[s] || '<span class="pill bad">Absent</span>');

  const EVENT_LABELS = {
    expired_code: ['warn', 'Expired code'],
    too_far: ['bad', 'Outside classroom'],
    imprecise_location: ['warn', 'Imprecise location'],
    id_on_other_phone: ['bad', 'ID on 2nd phone'],
    phone_reused: ['bad', 'Phone reused'],
    not_on_roster: ['warn', 'Not on roster'],
    register_blocked: ['warn', 'Registration closed'],
    device_reset: ['info', 'Phone reset'],
  };
  const eventPill = (k) => { const [c, l] = EVENT_LABELS[k] || ['', k]; return `<span class="pill ${c}">${esc(l)}</span>`; };

  // ---------------------------------------------------------------- router
  async function route() {
    clearTimers();
    document.body.style.overflow = '';
    if (!user) {
      const st = await api('GET', '/api/auth/state');
      user = st.user;
      if (!user) return renderAuth(st);
    }
    topbar.hidden = false;
    $('#whoami').textContent = user.display_name || user.username;
    $('#nav-instructors').hidden = !user.isAdmin || user.must_change_password;
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    try {
      if (user.must_change_password || parts[0] === 'account') return renderAccount();
      if (parts[0] === 'instructors' && user.isAdmin) return await renderInstructors();
      if (parts[0] === 'class') return await renderClass(Number(parts[1]), parts[2] || 'sessions');
      if (parts[0] === 'session') return await renderSession(Number(parts[1]));
      if (parts[0] === 'present') return await renderPresent(Number(parts[1]));
      return await renderClasses();
    } catch (err) {
      app.innerHTML = `<div class="wrap"><div class="notice bad">${esc(err.message)}</div><a href="#/">← Back to classes</a></div>`;
    }
  }
  window.addEventListener('hashchange', route);
  $('#logout').onclick = action(async () => {
    await api('POST', '/api/auth/logout');
    user = null;
    location.hash = '#/';
    route();
  });

  // ------------------------------------------------------------------ auth
  function renderAuth(st) {
    topbar.hidden = true;
    let mode = st.setupNeeded ? 'signup' : 'login';
    const draw = () => {
      app.innerHTML = `
        <div class="auth">
          <section class="auth-brand">
            <img src="/brand/lau-logo-white.svg" alt="Lebanese American University">
            <div>
              <h1 class="page-title">Class <b>Attendance</b></h1>
              <p>Rotating QR codes for every class session. Students check in from their own phone, in the room.</p>
            </div>
          </section>
          <section class="auth-form"><div>
          <h2>${mode === 'signup' ? 'Create account' : 'Instructor log in'}</h2>
          <p class="muted">${mode === 'signup' ? (st.setupNeeded ? 'Create the first instructor account to get started.' : 'Create an instructor account.') : 'Sign in to manage your classes.'}</p>
          <form id="auth">
            <div id="err"></div>
            <div class="field"><label for="u">Username</label><input id="u" type="text" autocomplete="username" required></div>
            <div class="field"><label for="p">Password</label><input id="p" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required minlength="${mode === 'signup' ? 8 : 1}"></div>
            <button class="primary full" type="submit">${mode === 'signup' ? 'Create account' : 'Log in'}</button>
          </form>
          ${st.signupAllowed && !st.setupNeeded ? `<p style="margin-top:1rem"><a href="#" id="switch">${mode === 'signup' ? 'I already have an account' : 'Create an account'}</a></p>` : ''}
          </div></section>
        </div>`;
      $('#auth').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('POST', `/api/auth/${mode}`, { username: $('#u').value, password: $('#p').value });
          user = null;
          route();
        } catch (err) {
          $('#err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
        }
      };
      const sw = $('#switch');
      if (sw) sw.onclick = (e) => { e.preventDefault(); mode = mode === 'signup' ? 'login' : 'signup'; draw(); };
    };
    draw();
  }

  // --------------------------------------------------------------- classes
  async function renderClasses() {
    const classes = await api('GET', '/api/classes');
    app.innerHTML = `
      <div class="wrap">
        <div class="row between" style="margin-bottom:1rem">
          <h1 class="page-title">Your <b>classes</b></h1>
        </div>
        ${!user.isAdmin && !classes.length ? '<div class="card empty">No classes are assigned to you yet. The administrator assigns instructors to classes.</div>' : ''}
        ${classes.length ? `<div class="grid" style="margin-bottom:1.5rem">${classes.map((c) => `
          <a class="card class-card" href="#/class/${c.id}">
            <div class="muted"><small>${esc(c.code || ' ')}</small></div>
            <h2>${esc(c.name)}</h2>
            <div class="muted"><small>${c.session_count} session${c.session_count === 1 ? '' : 's'}${c.next_date ? ` · next ${esc(fmtDate(c.next_date))}` : ''}</small></div>
          </a>`).join('')}</div>` : (user.isAdmin ? '<div class="card empty">No classes yet – create your first one below.</div>' : '')}
        ${user.isAdmin ? `<form class="card" id="new-class" style="max-width:560px">
          <h2>New class</h2>
          <div class="inline-fields">
            <div class="field"><label for="cn">Class name</label><input id="cn" type="text" placeholder="Intro to Psychology" required></div>
            <div class="field"><label for="cc">Course code <span class="hint">(optional)</span></label><input id="cc" type="text" placeholder="PSY 101"></div>
          </div>
          <button class="primary" type="submit">Create class</button>
        </form>` : ''}
      </div>`;
    if (user.isAdmin) $('#new-class').onsubmit = action(async () => {
      const { id } = await api('POST', '/api/classes', { name: $('#cn').value, code: $('#cc').value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      location.hash = `#/class/${id}/sessions`;
    });
  }

  // ----------------------------------------------------------------- class
  async function renderClass(id, tab) {
    const data = await api('GET', `/api/classes/${id}`);
    const c = data.class;
    const tabs = [['sessions', 'Schedule'], ['students', 'Students'], ['report', 'Report'], ['activity', 'Alerts']];
    if (data.canManage) tabs.push(['instructors', 'Instructors'], ['settings', 'Settings']);
    if (!data.canManage && (tab === 'settings' || tab === 'instructors')) tab = 'sessions';
    const teachers = data.instructors.map((i) => i.display_name || i.username);
    app.innerHTML = `
      <div class="wrap">
        <a href="#/" class="muted"><small>← All classes</small></a>
        <div class="row between">
          <div>
            <h1 style="margin:.25rem 0 0">${esc(c.name)}</h1>
            <div class="muted">${esc(c.code)}${teachers.length ? `${c.code ? ' · ' : ''}Instructor${teachers.length === 1 ? '' : 's'}: ${esc(teachers.join(', '))}` : ''}</div>
          </div>
          <div class="row">
            ${c.geo_enabled ? '<span class="pill info" title="Students must be near the classroom">📍 Location check</span>' : ''}
            ${c.roster_only ? '<span class="pill info">Roster only</span>' : ''}
            ${c.enroll_open ? '' : '<span class="pill warn">Registration closed</span>'}
          </div>
        </div>
        <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/class/${id}/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</nav>
        <div id="tab"></div>
      </div>`;
    const el = $('#tab');
    if (tab === 'students') return classStudents(el, data);
    if (tab === 'report') return classReport(el, c);
    if (tab === 'activity') return classActivity(el, c);
    if (tab === 'settings') return classSettings(el, c);
    if (tab === 'instructors') return classInstructors(el, data);
    return classSessions(el, data);
  }

  function classSessions(el, { class: c, sessions, members, today: t, canManage }) {
    const d3 = new Date(`${t}T12:00:00`); d3.setMonth(d3.getMonth() + 3); const in3m = ymd(d3);
    const upcoming = sessions.filter((s) => s.date >= t);
    const past = sessions.filter((s) => s.date < t).reverse();
    const row = (s) => `
      <tr class="${s.date === t ? 'today' : ''}">
        <td><strong>${esc(weekday(s.date))}</strong> ${esc(fmtDate(s.date).replace(/^\w+,?\s*/, ''))}${s.date === t ? ' <span class="pill info">Today</span>' : ''}</td>
        <td class="hide-sm">${esc(s.start_time)}–${esc(s.end_time)}</td>
        <td>${statusPill(s.status)}</td>
        <td class="num">${s.status === 'scheduled' && s.date > t ? '' : `${s.attended}${members.length ? ` / ${members.length}` : ''}`}</td>
        <td class="num"><a class="btn small ${s.status === 'open' || s.date === t ? 'primary' : ''}" href="#/session/${s.id}">${s.status === 'open' ? 'Manage' : 'Open'}</a>
            ${canManage ? `<button class="small ghost danger" data-del="${s.id}" title="Delete session">✕</button>` : ''}</td>
      </tr>`;
    const table = (list) => `<div class="table-scroll"><table class="session-list">
        <thead><tr><th>Date</th><th class="hide-sm">Time</th><th>Status</th><th class="num">Attended</th><th></th></tr></thead>
        <tbody>${list.map(row).join('')}</tbody></table></div>`;

    el.innerHTML = `
      ${canManage ? `<div class="card">
        <h2>Create a schedule</h2>
        <p class="muted">Pick the days the class meets and the date range. One session (with its own QR code) is created for each meeting.</p>
        <form id="sched">
          <div class="field">
            <label>Meets on</label>
            <div class="weekday-picker">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label><input type="checkbox" name="wd" value="${d}">${WEEKDAYS[d]}</label>`).join('')}</div>
          </div>
          <div class="inline-fields">
            <div class="field"><label for="sd">First day</label><input id="sd" type="date" value="${t}" required></div>
            <div class="field"><label for="ed">Last day</label><input id="ed" type="date" value="${in3m}" required></div>
            <div class="field"><label for="st">Starts</label><input id="st" type="time" value="09:00" required></div>
            <div class="field"><label for="et">Ends</label><input id="et" type="time" value="10:30" required></div>
          </div>
          <div class="row">
            <button class="primary" type="submit">Generate sessions</button>
            <a href="#" id="toggle-single" class="muted"><small>or add a single session</small></a>
          </div>
        </form>
        <form id="single" hidden style="margin-top:1rem;border-top:1px solid var(--border);padding-top:1rem">
          <div class="inline-fields">
            <div class="field"><label for="od">Date</label><input id="od" type="date" value="${t}" required></div>
            <div class="field"><label for="ost">Starts</label><input id="ost" type="time" value="09:00" required></div>
            <div class="field"><label for="oet">Ends</label><input id="oet" type="time" value="10:30" required></div>
          </div>
          <button type="submit">Add session</button>
        </form>
      </div>` : ''}
      <div class="card">
        <h2>Today &amp; upcoming <span class="muted" style="font-weight:400">(${upcoming.length})</span></h2>
        ${upcoming.length ? table(upcoming) : `<div class="empty">No upcoming sessions.${canManage ? ' Create a schedule above.' : ''}</div>`}
      </div>
      ${past.length ? `<div class="card"><h2>Past <span class="muted" style="font-weight:400">(${past.length})</span></h2>${table(past)}</div>` : ''}`;

    if (canManage) $('#sched').onsubmit = action(async () => {
      const weekdays = $$('input[name=wd]:checked').map((i) => Number(i.value));
      const r = await api('POST', `/api/classes/${c.id}/schedule`, {
        weekdays, startDate: $('#sd').value, endDate: $('#ed').value, startTime: $('#st').value, endTime: $('#et').value,
      });
      toast(r.created ? `Created ${r.created} session${r.created === 1 ? '' : 's'}` : 'No new sessions (they already exist)');
      route();
    });
    if (canManage) $('#toggle-single').onclick = (e) => { e.preventDefault(); $('#single').hidden = !$('#single').hidden; };
    if (canManage) $('#single').onsubmit = action(async () => {
      await api('POST', `/api/classes/${c.id}/sessions`, { date: $('#od').value, startTime: $('#ost').value, endTime: $('#oet').value });
      toast('Session added');
      route();
    });
    $$('[data-del]', el).forEach((b) => {
      b.onclick = action(async () => {
        if (!confirm('Delete this session and its attendance records?')) return;
        await api('DELETE', `/api/sessions/${b.dataset.del}`);
        route();
      });
    });
  }

  function classStudents(el, { class: c, roster, members, canManage }) {
    el.innerHTML = `
      <div class="card">
        <h2>Students <span class="muted" style="font-weight:400">(${members.length})</span></h2>
        <p class="muted">Everyone on your roster plus anyone who has checked in. Each student's ID is locked to one phone; if a student gets a new phone, reset it here and they register again on the next scan.</p>
        ${members.length ? `<div class="table-scroll"><table>
          <thead><tr><th>Name</th><th>Student ID</th><th class="hide-sm">Roster</th><th>Phone</th><th></th></tr></thead>
          <tbody>${members.map((m) => `<tr>
            <td>${esc(m.name || '—')}</td>
            <td><code>${esc(m.student_number)}</code></td>
            <td class="hide-sm">${m.on_roster ? '<span class="pill ok">Yes</span>' : '<span class="pill warn">No</span>'}</td>
            <td>${m.device_id ? `<span class="pill ok" title="${esc(m.user_agent || '')}">Registered</span> <small class="muted hide-sm">${esc(fmtDate(new Date(m.device_created_at).toISOString().slice(0, 10)))}</small>` : '<span class="pill">Not yet</span>'}</td>
            <td class="num">${m.device_id ? `<button class="small" data-reset="${esc(m.student_number)}">Reset phone</button>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>` : `<div class="empty">No students yet.${canManage ? ' Paste a roster below, or students' : ' Students'} will appear as they check in.</div>`}
      </div>
      ${canManage ? `<form class="card" id="roster">
        <h2>Roster</h2>
        <p class="muted">Optional. One student per line: <code>student ID, full name</code>. You can paste straight from a spreadsheet. With a roster, names come from here and you can restrict check-in to listed students (Settings).</p>
        <textarea id="rt" placeholder="20231234, Jane Doe&#10;20231235, John Smith">${esc(roster.map((r) => `${r.student_number}, ${r.name}`).join('\n'))}</textarea>
        <div class="row" style="margin-top:.75rem"><button class="primary" type="submit">Save roster</button><span class="muted"><small>${roster.length} on roster</small></span></div>
      </form>` : ''}`;
    if (canManage) $('#roster').onsubmit = action(async () => {
      const r = await api('PUT', `/api/classes/${c.id}/roster`, { text: $('#rt').value });
      toast(`Roster saved (${r.count} students)`);
      route();
    });
    $$('[data-reset]', el).forEach((b) => {
      b.onclick = action(async () => {
        if (!confirm(`Unlink the phone registered to ${b.dataset.reset}? They will register again next time they scan.`)) return;
        await api('POST', `/api/classes/${c.id}/students/${encodeURIComponent(b.dataset.reset)}/reset-device`);
        toast('Phone reset');
        route();
      });
    });
  }

  async function classReport(el, c) {
    const r = await api('GET', `/api/classes/${c.id}/report`);
    const code = { present: 'P', late: 'L', excused: 'E' };
    const pct = (x) => (x === null ? '—' : `${Math.round(x * 100)}%`);
    el.innerHTML = `
      <div class="card">
        <div class="row between">
          <h2 style="margin:0">Attendance report</h2>
          <a class="btn" href="/api/classes/${c.id}/report.csv">⬇ Download CSV</a>
        </div>
        <p class="muted" style="margin-top:.5rem"><small>Includes sessions up to today. <span class="mark P">P</span> present · <span class="mark L">L</span> late · <span class="mark E">E</span> excused (not counted) · <span class="mark A">A</span> absent. Click a column to open that session.</small></p>
        ${r.students.length && r.sessions.length ? `<div class="table-scroll"><table class="matrix">
          <thead><tr><th>Student</th><th>Rate</th>${r.sessions.map((s) => `<th><a href="#/session/${s.id}" title="${esc(s.date)} ${esc(s.start_time)}">${esc(s.date.slice(5).replace('-', '/'))}</a></th>`).join('')}</tr></thead>
          <tbody>${r.students.map((s) => `<tr>
            <td>${esc(s.name || s.student_number)}<br><small class="muted">${esc(s.student_number)}</small></td>
            <td><strong>${pct(s.rate)}</strong></td>
            ${r.sessions.map((x) => { const m = code[s.marks[x.id]] || 'A'; return `<td><span class="mark ${m}">${m}</span></td>`; }).join('')}
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nothing to report yet.</div>'}
      </div>`;
  }

  async function classActivity(el, c) {
    const events = await api('GET', `/api/classes/${c.id}/events`);
    el.innerHTML = `
      <div class="card">
        <h2>Alerts</h2>
        <p class="muted">Blocked or suspicious check-in attempts: expired codes (often a forwarded screenshot), scans from outside the classroom, attempts to register an ID on a second phone, and so on.</p>
        ${events.length ? `<div class="table-scroll"><table>
          <thead><tr><th>When</th><th>What</th><th>Student</th><th>Details</th></tr></thead>
          <tbody>${events.map((e) => `<tr>
            <td><small>${esc(fmtDateTime(e.created_at))}</small></td>
            <td>${eventPill(e.kind)}</td>
            <td><code>${esc(e.student_number || '?')}</code></td>
            <td><small>${esc(e.detail)}${e.session_id ? ` <a href="#/session/${e.session_id}">session</a>` : ''}</small></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nothing suspicious so far.</div>'}
      </div>`;
  }

  function classSettings(el, c) {
    el.innerHTML = `
      <form class="card" id="settings" style="max-width:680px">
        <h2>Class settings</h2>
        <div class="inline-fields">
          <div class="field"><label for="n">Class name</label><input id="n" type="text" value="${esc(c.name)}" required></div>
          <div class="field"><label for="code">Course code</label><input id="code" type="text" value="${esc(c.code)}"></div>
        </div>
        <div class="inline-fields">
          <div class="field">
            <label for="late">Mark as late after (minutes)</label>
            <input id="late" type="number" min="0" max="600" value="${c.late_after_min}">
          </div>
          <div class="field">
            <label for="tz">Time zone</label>
            <input id="tz" type="text" value="${esc(c.timezone)}" list="tz-list">
            <datalist id="tz-list">${(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []).map((z) => `<option value="${z}">`).join('')}</datalist>
          </div>
        </div>
        <h3 style="margin-top:1.25rem">Anti-cheating</h3>
        <div class="field">
          <label class="check"><input type="checkbox" id="enroll" ${c.enroll_open ? 'checked' : ''}>
            <span>Allow new phones to register<div class="hint">Turn this off after the first week or two. From then on, only phones already linked to a student can check in, so nobody can register a friend's ID on a second browser.</div></span></label>
        </div>
        <div class="field">
          <label class="check"><input type="checkbox" id="ronly" ${c.roster_only ? 'checked' : ''}>
            <span>Only students on the roster can check in<div class="hint">Stops made-up or mistyped student IDs. Requires a roster (Students tab).</div></span></label>
        </div>
        <div class="field">
          <label class="check"><input type="checkbox" id="geo" ${c.geo_enabled ? 'checked' : ''}>
            <span>Require students to be in the classroom (location check)<div class="hint">Students' phones share their GPS location when checking in. Anyone farther than the radius is rejected, and so are vague readings (worse than ±75 m), so students may need Precise Location turned on.</div></span></label>
        </div>
        <div id="geo-fields" class="card" style="background:var(--surface-2);box-shadow:none">
          <div class="inline-fields">
            <div class="field"><label for="lat">Latitude</label><input id="lat" type="number" step="any" value="${c.geo_lat ?? ''}"></div>
            <div class="field"><label for="lng">Longitude</label><input id="lng" type="number" step="any" value="${c.geo_lng ?? ''}"></div>
            <div class="field"><label for="rad">Radius (m)</label><input id="rad" type="number" min="20" max="5000" value="${c.geo_radius_m}"></div>
          </div>
          <div class="row">
            <button type="button" id="here">📍 Use my current location</button>
            <span class="muted" id="geo-status"><small>Do this from the classroom, ideally on your phone (laptop locations can be off by a few hundred metres).</small></span>
          </div>
        </div>
        <button class="primary" type="submit">Save settings</button>
      </form>
      <div class="card" style="max-width:680px">
        <h3>Danger zone</h3>
        <p class="muted">Deleting a class removes all its sessions and attendance records.</p>
        <button class="danger" id="delete">Delete class</button>
      </div>`;
    $('#here').onclick = () => {
      const st = $('#geo-status');
      if (!navigator.geolocation) { st.textContent = 'Location is not available in this browser.'; return; }
      st.textContent = 'Getting location…';
      navigator.geolocation.getCurrentPosition(
        (p) => {
          $('#lat').value = p.coords.latitude.toFixed(6);
          $('#lng').value = p.coords.longitude.toFixed(6);
          st.textContent = `Got it (accuracy ±${Math.round(p.coords.accuracy)} m). Remember to save.`;
        },
        (e) => { st.textContent = e.code === 1 ? 'Location permission denied.' : 'Could not get location (HTTPS is required).'; },
        { enableHighAccuracy: true, timeout: 15000 },
      );
    };
    $('#settings').onsubmit = action(async () => {
      const num = (v) => (v === '' ? null : Number(v));
      await api('PATCH', `/api/classes/${c.id}`, {
        name: $('#n').value, code: $('#code').value, timezone: $('#tz').value, late_after_min: Number($('#late').value),
        enroll_open: $('#enroll').checked, roster_only: $('#ronly').checked,
        geo_enabled: $('#geo').checked, geo_lat: num($('#lat').value), geo_lng: num($('#lng').value), geo_radius_m: Number($('#rad').value),
      });
      toast('Settings saved');
      route();
    });
    $('#delete').onclick = action(async () => {
      if (!confirm(`Delete "${c.name}" and all of its attendance records? This cannot be undone.`)) return;
      await api('DELETE', `/api/classes/${c.id}`);
      location.hash = '#/';
    });
  }

  async function classInstructors(el, { class: c, instructors: assigned }) {
    const all = (await api('GET', '/api/instructors')).filter((i) => i.role !== 'admin');
    const on = new Set(assigned.map((i) => i.id));
    el.innerHTML = `
      <form class="card" id="assign" style="max-width:680px">
        <h2>Instructors for this class</h2>
        <p class="muted">Assigned instructors can open this class, start sessions, show the QR code, take attendance and see the report. Only you can change the schedule, settings and roster.</p>
        ${all.length ? `<div class="stack">${all.map((i) => `
          <label class="check"><input type="checkbox" name="inst" value="${i.id}" ${on.has(i.id) ? 'checked' : ''}>
            <span>${esc(i.display_name || i.username)} <span class="muted">(${esc(i.username)})</span></span></label>`).join('')}</div>
          <div class="row" style="margin-top:1rem"><button class="primary" type="submit">Save</button><a href="#/instructors">Add a new instructor</a></div>`
        : '<div class="empty">No instructor accounts yet. <a href="#/instructors">Create one</a> first.</div>'}
      </form>`;
    const form = $('#assign');
    if (all.length) form.onsubmit = action(async () => {
      await api('PUT', `/api/classes/${c.id}/instructors`, { instructorIds: $$('input[name=inst]:checked').map((i) => Number(i.value)) });
      toast('Instructors saved');
      route();
    });
  }

  // ------------------------------------------------------- instructors (admin)
  function credentialsCard(username, password, fresh) {
    const loginUrl = `${location.origin}/`;
    const message = `Class attendance – LAU\nSign in at: ${loginUrl}\nUsername: ${username}\nTemporary password: ${password}\nYou'll be asked to choose your own password when you first sign in.`;
    return `
      <div class="notice ok" id="creds">
        <strong>${fresh ? 'Account created' : 'Password reset'} for ${esc(username)}.</strong> Send these details to them – the temporary password is shown only once.
        <pre style="white-space:pre-wrap;margin:.6rem 0;font:inherit;color:var(--anthracite);background:var(--surface);padding:.75rem;border:1px solid var(--border)">${esc(message)}</pre>
        <button type="button" class="small" id="copy-creds">Copy message</button>
      </div>`;
  }

  async function renderInstructors(flash) {
    const [people, classes] = await Promise.all([api('GET', '/api/instructors'), api('GET', '/api/classes')]);
    const instructors = people.filter((p) => p.role !== 'admin');
    app.innerHTML = `
      <div class="wrap">
        <a href="#/" class="muted"><small>← All classes</small></a>
        <h1 class="page-title" style="margin:.25rem 0 1.25rem">Instructor <b>accounts</b></h1>
        ${flash || ''}
        <div class="card">
          <h2>Instructors <span class="muted" style="font-weight:400">(${instructors.length})</span></h2>
          ${instructors.length ? `<div class="table-scroll"><table>
            <thead><tr><th>Name</th><th>Username</th><th>Classes</th><th class="hide-sm">Status</th><th></th></tr></thead>
            <tbody>${instructors.map((i) => `<tr>
              <td>${esc(i.display_name || '—')}</td>
              <td><code>${esc(i.username)}</code></td>
              <td>${i.classes.length ? i.classes.map((c) => `<a class="pill info" href="#/class/${c.id}/instructors">${esc(c.code || c.name)}</a>`).join(' ') : '<span class="muted">None</span>'}</td>
              <td class="hide-sm">${i.must_change_password ? '<span class="pill warn">Hasn’t signed in yet</span>' : '<span class="pill ok">Active</span>'}</td>
              <td class="num" style="white-space:nowrap">
                <button class="small" data-reset-pw="${i.id}">Reset password</button>
                <button class="small ghost danger" data-remove="${i.id}" data-name="${esc(i.display_name || i.username)}">Remove</button>
              </td></tr>`).join('')}</tbody></table></div>`
          : '<div class="empty">No instructors yet. Add the first one below.</div>'}
        </div>
        <form class="card" id="new-inst" style="max-width:680px">
          <h2>Add an instructor</h2>
          <p class="muted">They get a temporary password to change at first sign-in. They can run sessions for the classes you pick; you keep control of schedules, settings and rosters.</p>
          <div class="inline-fields">
            <div class="field"><label for="in-name">Full name</label><input id="in-name" type="text" placeholder="Dr. Rana Haddad" required></div>
            <div class="field"><label for="in-user">Username</label><input id="in-user" type="text" placeholder="rhaddad" autocomplete="off" autocapitalize="none" required pattern="[A-Za-z0-9._@\\-]{3,60}"><div class="hint">E.g. their LAU email or email name.</div></div>
          </div>
          ${classes.length ? `<div class="field"><label>Classes</label><div class="stack">${classes.map((c) => `
            <label class="check"><input type="checkbox" name="in-class" value="${c.id}"><span>${esc(c.name)}${c.code ? ` <span class="muted">(${esc(c.code)})</span>` : ''}</span></label>`).join('')}</div></div>` : ''}
          <button class="primary" type="submit">Create account</button>
        </form>
      </div>`;

    const bindCopy = () => {
      const btn = $('#copy-creds');
      if (btn) btn.onclick = async () => {
        try { await navigator.clipboard.writeText($('#creds pre').textContent); toast('Copied'); } catch { toast('Select the text and copy it'); }
      };
    };
    bindCopy();
    $('#new-inst').onsubmit = action(async () => {
      const r = await api('POST', '/api/instructors', {
        displayName: $('#in-name').value, username: $('#in-user').value.trim(),
        classIds: $$('input[name=in-class]:checked').map((i) => Number(i.value)),
      });
      await renderInstructors(credentialsCard(r.username, r.tempPassword, true));
    });
    $$('[data-reset-pw]').forEach((b) => {
      b.onclick = action(async () => {
        if (!confirm('Give this instructor a new temporary password? They will be signed out everywhere.')) return;
        const r = await api('POST', `/api/instructors/${b.dataset.resetPw}/reset-password`);
        await renderInstructors(credentialsCard(r.username, r.tempPassword, false));
      });
    });
    $$('[data-remove]').forEach((b) => {
      b.onclick = action(async () => {
        if (!confirm(`Remove ${b.dataset.name}? They will no longer be able to sign in. Their classes and attendance records stay.`)) return;
        await api('DELETE', `/api/instructors/${b.dataset.remove}`);
        toast('Instructor removed');
        await renderInstructors();
      });
    });
  }

  // ----------------------------------------------------------------- account
  function renderAccount() {
    const forced = !!user.must_change_password;
    app.innerHTML = `
      <div class="narrow">
        <h1 class="page-title" style="margin-bottom:1rem">Your <b>account</b></h1>
        ${forced ? '<div class="notice warn">Welcome! You signed in with a temporary password. Choose your own password to continue.</div>' : ''}
        <form class="card" id="pw">
          <h2>Change password</h2>
          <p class="muted">Signed in as <strong>${esc(user.display_name || user.username)}</strong> (${esc(user.username)})${user.isAdmin ? ' · administrator' : ''}.</p>
          <div class="field"><label for="pw-cur">${forced ? 'Temporary password' : 'Current password'}</label><input id="pw-cur" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="pw-new">New password</label><input id="pw-new" type="password" autocomplete="new-password" minlength="8" required><div class="hint">At least 8 characters.</div></div>
          <div class="field"><label for="pw-new2">Repeat new password</label><input id="pw-new2" type="password" autocomplete="new-password" minlength="8" required></div>
          <button class="primary" type="submit">Save password</button>
        </form>
      </div>`;
    $('#pw').onsubmit = action(async () => {
      if ($('#pw-new').value !== $('#pw-new2').value) throw new Error('The two new passwords do not match.');
      await api('POST', '/api/auth/password', { current: $('#pw-cur').value, password: $('#pw-new').value });
      user.must_change_password = false;
      toast('Password saved');
      location.hash = '#/';
      route();
    });
  }

  // --------------------------------------------------------------- session
  async function renderSession(id) {
    const draw = async () => {
      const d = await api('GET', `/api/sessions/${id}`);
      const s = d.session;
      const byNum = new Map(d.attendance.map((a) => [a.student_number, a]));
      const rows = [...d.members.map((m) => ({ ...m, a: byNum.get(m.student_number) }))];
      for (const a of d.attendance) if (!d.members.some((m) => m.student_number === a.student_number)) rows.push({ student_number: a.student_number, name: a.name, a });
      rows.sort((x, y) => (x.a ? 0 : 1) - (y.a ? 0 : 1) || (x.a && y.a ? x.a.checked_in_at - y.a.checked_in_at : String(x.name).localeCompare(String(y.name))));
      const count = (st) => d.attendance.filter((a) => a.status === st).length;
      const absent = rows.filter((r) => !r.a).length;
      const flagged = d.attendance.filter((a) => a.flags.length).length;

      app.innerHTML = `
        <div class="wrap">
          <a href="#/class/${s.class_id}/sessions" class="muted"><small>← ${esc(s.class_name)}</small></a>
          <div class="row between" style="margin:.25rem 0 1rem">
            <div>
              <h1 style="margin:0">${esc(fmtDate(s.date))}</h1>
              <div class="muted">${esc(s.start_time)}–${esc(s.end_time)} · ${statusPill(s.status)}</div>
            </div>
            <div class="row">
              ${s.status === 'open'
                ? `<a class="btn primary" href="#/present/${s.id}">▣ Show QR code</a><button id="close">Close attendance</button>`
                : `<button class="primary" id="open">${s.status === 'closed' ? 'Re-open attendance' : 'Start attendance & show QR'}</button>`}
            </div>
          </div>
          <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));margin-bottom:1rem">
            <div class="card center"><div class="muted">Present</div><div style="font-size:1.6rem;font-weight:700;color:var(--ok)">${count('present')}</div></div>
            <div class="card center"><div class="muted">Late</div><div style="font-size:1.6rem;font-weight:700;color:var(--warn)">${count('late')}</div></div>
            <div class="card center"><div class="muted">Excused</div><div style="font-size:1.6rem;font-weight:700;color:var(--info)">${count('excused')}</div></div>
            <div class="card center"><div class="muted">Absent</div><div style="font-size:1.6rem;font-weight:700;color:var(--bad)">${absent}</div></div>
          </div>
          ${flagged ? `<div class="notice warn">⚠ ${flagged} check-in${flagged === 1 ? '' : 's'} came from an identical browser on the same network within minutes of each other. That can mean one phone was used for two people (e.g. via a private tab) – or just two friends with the same phone model. Worth a glance.</div>` : ''}
          <div class="card">
            <h2>Attendance</h2>
            ${rows.length ? `<div class="table-scroll"><table>
              <thead><tr><th>Student</th><th>Status</th><th class="hide-sm">Time</th><th class="hide-sm">How</th><th>Change</th></tr></thead>
              <tbody>${rows.map((r) => `<tr>
                <td>${esc(r.name || '—')}<br><small class="muted">${esc(r.student_number)}</small>
                  ${r.a && r.a.flags.length ? `<br>${r.a.flags.map((f) => `<span class="pill warn" style="margin-top:2px">⚠ ${esc(f)}</span>`).join(' ')}` : ''}</td>
                <td>${markPill(r.a?.status)}</td>
                <td class="hide-sm"><small>${r.a ? esc(fmtTime(r.a.checked_in_at)) : ''}</small></td>
                <td class="hide-sm"><small class="muted">${r.a ? (r.a.method === 'qr' ? `QR${r.a.distance_m !== null ? ` · ${Math.round(r.a.distance_m)} m away` : ''}` : 'Manual') : ''}</small></td>
                <td><select data-mark="${esc(r.student_number)}" aria-label="Change status">
                  ${['absent', 'present', 'late', 'excused'].map((o) => `<option value="${o}" ${(r.a?.status || 'absent') === o ? 'selected' : ''}>${o[0].toUpperCase() + o.slice(1)}</option>`).join('')}
                </select></td>
              </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No students yet. They appear here as they scan the QR code.</div>'}
            <form id="manual" class="row" style="margin-top:1rem">
              <input id="mnum" type="text" placeholder="Student ID" style="max-width:200px" required>
              <button type="submit">Mark present manually</button>
            </form>
          </div>
          ${d.events.length ? `<div class="card"><h2>Blocked attempts</h2><table><tbody>${d.events.map((e) => `<tr>
              <td><small>${esc(fmtTime(e.created_at))}</small></td><td>${eventPill(e.kind)}</td><td><code>${esc(e.student_number || '?')}</code></td><td><small>${esc(e.detail)}</small></td>
            </tr>`).join('')}</tbody></table></div>` : ''}
        </div>`;

      const openBtn = $('#open');
      if (openBtn) openBtn.onclick = action(async () => { await api('POST', `/api/sessions/${id}/open`); location.hash = `#/present/${id}`; });
      const closeBtn = $('#close');
      if (closeBtn) closeBtn.onclick = action(async () => { await api('POST', `/api/sessions/${id}/close`); toast('Attendance closed'); draw(); });
      $$('[data-mark]').forEach((sel) => {
        sel.onchange = action(async () => {
          await api('PUT', `/api/sessions/${id}/attendance/${encodeURIComponent(sel.dataset.mark)}`, { status: sel.value });
          draw();
        });
      });
      $('#manual').onsubmit = action(async () => {
        await api('PUT', `/api/sessions/${id}/attendance/${encodeURIComponent($('#mnum').value.trim())}`, { status: 'present' });
        draw();
      });
      return s;
    };
    const s = await draw();
    // Live refresh while students are checking in (skip while a dropdown is focused).
    if (s.status === 'open') every(5000, () => { if (!document.activeElement || document.activeElement.tagName !== 'SELECT') draw().catch(() => {}); });
  }

  // ------------------------------------------------------- live QR display
  async function renderPresent(id) {
    const d = await api('GET', `/api/sessions/${id}`);
    const s = d.session;
    if (s.status !== 'open') await api('POST', `/api/sessions/${id}/open`);
    document.body.style.overflow = 'hidden';
    app.innerHTML = `
      <div class="present">
        <img class="present-logo" src="/brand/lau-logo-green.svg" alt="Lebanese American University">
        <div class="controls">
          <button class="small" id="fs">⛶ Full screen</button>
          <button class="small" id="exit">✕ Exit</button>
        </div>
        <h1>${esc(s.class_name)}</h1>
        <div class="sub">${esc(fmtDate(s.date))} · ${esc(s.start_time)}–${esc(s.end_time)} — scan with your phone camera to check in</div>
        <div class="qr" id="qr"></div>
        <div class="bar"><div id="bar"></div></div>
        <div class="count"><span id="count">0</span> checked in</div>
      </div>`;

    let offset = 0;      // serverNow - clientNow
    let expiresAt = 0;
    let rotateMs = 10000;
    let stopped = false;

    async function refresh() {
      if (stopped) return;
      try {
        const q = await api('GET', `/api/sessions/${id}/qr`);
        offset = q.serverNow - Date.now();
        expiresAt = q.expiresAt;
        rotateMs = q.rotateMs;
        $('#qr').innerHTML = q.svg;
        $('#count').textContent = q.count;
        later(Math.max(300, expiresAt - (Date.now() + offset) + 50), refresh);
      } catch (err) {
        $('#qr').innerHTML = `<div class="notice bad" style="margin-top:40%">${esc(err.message)}</div>`;
        later(3000, refresh);
      }
    }
    every(250, () => {
      const left = Math.max(0, expiresAt - (Date.now() + offset));
      const bar = $('#bar');
      if (bar) bar.style.width = `${(left / rotateMs) * 100}%`;
    });
    every(4000, async () => {
      try {
        const x = await api('GET', `/api/sessions/${id}`);
        $('#count').textContent = x.attendance.filter((a) => a.status === 'present' || a.status === 'late').length;
      } catch {}
    });
    refresh();

    $('#exit').onclick = () => {
      stopped = true;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      location.hash = `#/session/${id}`;
    };
    $('#fs').onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    };
  }

  route();
})();
