/* HWOTG offline backend: the same API and access rules as server.js, running inside the browser.
   Data lives in this browser's IndexedDB on this device (localStorage if IndexedDB is unavailable). */
(function () {
  'use strict';
  const COLLS = ['users', 'vendors', 'drivers', 'bases', 'routes', 'reqs', 'notifs', 'audit'];
  const HWS = ['admin', 'manager', 'hws'], LEAD = ['admin', 'manager'];
  // Role permissions the Administrator can tick or untick. Defaults: [admin, manager, hws, vendor, driver, user].
  const ROLES = ['admin', 'manager', 'hws', 'vendor', 'driver', 'user'];
  const PERM_DEFAULTS = {
    dash: [1, 1, 1, 0, 0, 0], cost: [1, 1, 1, 0, 0, 0], vendorDash: [1, 1, 1, 1, 0, 0], sla: [1, 1, 1, 0, 0, 0], proofs: [1, 1, 1, 0, 0, 0], reports: [1, 1, 1, 0, 0, 0],
    create: [1, 1, 1, 0, 0, 1], validate: [1, 1, 1, 0, 0, 0], assign: [0, 0, 0, 1, 0, 0], collect: [0, 0, 0, 0, 1, 0], accept: [0, 0, 0, 0, 0, 1], vconfirm: [0, 0, 0, 1, 0, 0],
    close: [1, 1, 1, 0, 0, 0], verify: [1, 1, 1, 0, 0, 0], escalate: [1, 1, 0, 0, 0, 0],
    users: [1, 1, 1, 0, 0, 0], bases: [1, 1, 1, 0, 0, 0], vendors: [1, 1, 1, 0, 0, 0], rates: [1, 1, 0, 0, 0, 0], deactivate: [1, 1, 0, 0, 0, 0], delete: [1, 0, 0, 0, 0, 0],
    undo: [1, 0, 0, 0, 0, 0], notif: [1, 1, 1, 0, 0, 0], audit: [1, 1, 1, 0, 0, 0]
  };
  const defaultPerms = () => { const p = {}; Object.keys(PERM_DEFAULTS).forEach(k => { p[k] = {}; ROLES.forEach((r, i) => p[k][r] = !!PERM_DEFAULTS[k][i]) }); return p };
  function permsOf(st) { const p = defaultPerms(), sp = (st && st.perms) || {}; Object.keys(p).forEach(k => ROLES.forEach(r => { if (sp[k] && typeof sp[k][r] === 'boolean') p[k][r] = sp[k][r] })); return p }
  const canW = (w, u, k) => !!permsOf(w.meta('settings', {}))[k][u.role];
  const ROLE = { admin: 'Administrator', manager: 'HWS Manager', hws: 'HWS Staff', vendor: 'Vendor Admin', driver: 'Driver', user: 'Regional User' };
  const NAME = 'hwotg-offline', SKEY = 'hwotg.offline.session', SESSION_DAYS = 14;
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel(NAME) : null;
  const clone = x => JSON.parse(JSON.stringify(x));
  const hex = a => Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  const unhex = h => new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16)));
  const rid = n => hex(crypto.getRandomValues(new Uint8Array(n || 6)));

  /* ---------- storage: IndexedDB with a localStorage fallback ---------- */
  let idb = null, mem = null, dirty = true;
  const K = (s, k) => s + '\u0001' + k;
  function openIdb() {
    return new Promise(res => {
      try {
        const r = indexedDB.open(NAME, 1);
        r.onupgradeneeded = () => { const d = r.result; ['rec', 'meta', 'secrets'].forEach(s => d.createObjectStore(s)) };
        r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null)
      } catch (e) { res(null) }
    })
  }
  const idbReady = openIdb().then(d => { idb = d });
  function readStore(s) {
    if (idb) return new Promise((ok, no) => {
      const out = {}, t = idb.transaction(s, 'readonly'), st = t.objectStore(s), rq = st.openCursor();
      rq.onsuccess = () => { const c = rq.result; if (c) { out[c.key] = c.value; c.continue() } else ok(out) }; rq.onerror = () => no(rq.error)
    });
    const out = {}, pre = 'hwotg.off.' + s + '\u0001';
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(pre)) out[k.slice(pre.length)] = JSON.parse(localStorage.getItem(k)) }
    return Promise.resolve(out)
  }
  function writeOps(ops) {
    if (!ops.length) return Promise.resolve();
    if (idb) return new Promise((ok, no) => {
      const t = idb.transaction(['rec', 'meta', 'secrets'], 'readwrite');
      ops.forEach(o => { const st = t.objectStore(o.s); o.v === undefined ? st.delete(o.k) : st.put(o.v, o.k) });
      t.oncomplete = () => ok(); t.onerror = () => no(t.error); t.onabort = () => no(t.error || new Error('Storage is full'))
    });
    try { ops.forEach(o => { const k = 'hwotg.off.' + o.s + '\u0001' + o.k; o.v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(o.v)) }); return Promise.resolve() }
    catch (e) { return Promise.reject(new Error('Storage on this device is full. Remove some attachments or use smaller files.')) }
  }
  function clearAll() {
    if (idb) return new Promise((ok, no) => { const t = idb.transaction(['rec', 'meta', 'secrets'], 'readwrite');['rec', 'meta', 'secrets'].forEach(s => t.objectStore(s).clear()); t.oncomplete = () => ok(); t.onerror = () => no(t.error) });
    Object.keys(localStorage).filter(k => k.startsWith('hwotg.off.')).forEach(k => localStorage.removeItem(k)); return Promise.resolve()
  }
  async function loadMem() {
    await idbReady;
    const [rec, meta, secrets] = await Promise.all([readStore('rec'), readStore('meta'), readStore('secrets')]);
    const m = { rec: {}, meta, secrets }; COLLS.forEach(c => m.rec[c] = new Map());
    Object.keys(rec).forEach(k => { const i = k.indexOf('\u0001'), c = k.slice(0, i); if (m.rec[c]) m.rec[c].set(k.slice(i + 1), rec[k]) });
    mem = m; dirty = false
  }
  // Other tabs on this device write to the same storage; reload before the next call.
  if (bc) bc.onmessage = () => { dirty = true };
  window.addEventListener('storage', e => { if (e.key && e.key.startsWith('hwotg.off.')) dirty = true });

  /* ---------- a unit of work: reads see staged writes, nothing lands if it throws ---------- */
  class Denied extends Error { }
  function work() {
    const rec = {}, meta = {}, secrets = {}, ops = [];
    const w = {
      all: c => { const m = new Map(mem.rec[c]); Object.keys(rec).forEach(k => { const [cc, id] = k.split('\u0001'); if (cc === c) rec[k] === null ? m.delete(id) : m.set(id, rec[k]) }); return [...m.values()].map(clone) },
      get: (c, id) => { const k = K(c, id); if (k in rec) return rec[k] && clone(rec[k]); const x = mem.rec[c].get(String(id)); return x ? clone(x) : null },
      put: (c, x) => { rec[K(c, x.id)] = clone(x) },
      del: (c, id) => { rec[K(c, id)] = null },
      meta: (k, d) => k in meta ? meta[k] : (k in mem.meta ? mem.meta[k] : d),
      setMeta: (k, v) => { meta[k] = clone(v) },
      secret: id => id in secrets ? secrets[id] : (mem.secrets[id] || null),
      setSecret: (id, v) => { secrets[id] = v },
      async commit() {
        Object.keys(rec).forEach(k => ops.push({ s: 'rec', k, v: rec[k] === null ? undefined : rec[k] }));
        Object.keys(meta).forEach(k => ops.push({ s: 'meta', k, v: meta[k] }));
        Object.keys(secrets).forEach(k => ops.push({ s: 'secrets', k, v: secrets[k] === null ? undefined : secrets[k] }));
        await writeOps(ops);
        Object.keys(rec).forEach(k => { const [c, id] = k.split('\u0001'); rec[k] === null ? mem.rec[c].delete(id) : mem.rec[c].set(id, rec[k]) });
        Object.assign(mem.meta, meta); Object.keys(secrets).forEach(k => { if (secrets[k] === null) delete mem.secrets[k]; else mem.secrets[k] = secrets[k] });
        if (ops.length && bc) bc.postMessage('changed')
      }
    };
    return w
  }
  const bump = w => w.setMeta('version', w.meta('version', 0) + 1);

  /* ---------- passwords: PBKDF2 where the browser offers Web Crypto ---------- */
  async function derive(pw, salt) {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, k, 256))
  }
  async function hashPw(pw) {
    if (!(window.crypto && crypto.subtle)) return 'plain$$' + pw;
    const salt = crypto.getRandomValues(new Uint8Array(16)); return 'pbkdf2$' + hex(salt) + '$' + hex(await derive(pw, salt))
  }
  async function checkPw(pw, stored) {
    if (!stored) return false; const [kind, s, h] = stored.split('$');
    if (kind === 'plain') return stored === 'plain$$' + pw;
    if (!(window.crypto && crypto.subtle)) return false;
    const got = hex(await derive(pw, unhex(s))); let d = got.length ^ h.length; for (let i = 0; i < got.length; i++) d |= got.charCodeAt(i) ^ h.charCodeAt(i % h.length); return d === 0
  }
  const setPw = async (w, id, pw) => { const old = w.secret(String(id)) || { epoch: 0 }; w.setSecret(String(id), { hash: await hashPw(pw), epoch: (old.epoch || 0) + 1 }) };

  /* ---------- fresh start: setup data only, no users or jobs except the administrator ---------- */
  async function seed() {
    if (mem.meta.seeded) return;
    const w = work();
    const S = [['PLS', 'Perlis', 'Kangar', 6.4414, 100.1986, '01000'], ['KDH', 'Kedah', 'Alor Setar', 6.1248, 100.3678, '05000'], ['PNG', 'Pulau Pinang', 'George Town', 5.4141, 100.3288, '10200'], ['PRK', 'Perak', 'Ipoh', 4.5975, 101.0901, '30450'],
      ['SGR', 'Selangor', 'Klang', 3.0449, 101.4456, '41200'], ['KUL', 'WP Kuala Lumpur', 'Kuala Lumpur', 3.1390, 101.6869, '56000'], ['PJY', 'WP Putrajaya', 'Putrajaya', 2.9264, 101.6964, '62250'], ['NSN', 'Negeri Sembilan', 'Seremban', 2.7258, 101.9424, '70200'],
      ['MLK', 'Melaka', 'Melaka', 2.1896, 102.2501, '75000'], ['JHR', 'Johor', 'Johor Bahru', 1.4927, 103.7414, '81100'], ['PHG', 'Pahang', 'Kuantan', 3.8077, 103.3260, '25200'], ['TRG', 'Terengganu', 'Kuala Terengganu', 5.3302, 103.1408, '20200'],
      ['KTN', 'Kelantan', 'Kota Bharu', 6.1254, 102.2381, '15150'], ['SWK', 'Sarawak', 'Kuching', 1.5533, 110.3592, '93350'], ['SBH', 'Sabah', 'Kota Kinabalu', 5.9804, 116.0735, '88300'], ['LBN', 'WP Labuan', 'Labuan', 5.2831, 115.2308, '87000']];
    const bases = [{ id: 'B00', name: 'Central Warehouse Shah Alam', type: 'Warehouse', address: 'Lot 8, Jalan Pelabur 23/1, Seksyen 23, 40300 Shah Alam, Selangor', state: 'SGR', lat: 3.0360, lng: 101.5370, phone: '', active: true },
      { id: 'B01', name: 'Northern Hub Bayan Lepas', type: 'Hub', address: 'Plot 102, Lorong Perindustrian Bayan Lepas 4, 11900 Bayan Lepas, Pulau Pinang', state: 'PNG', lat: 5.2967, lng: 100.2616, phone: '', active: true }];
    S.forEach((s, i) => bases.push({ id: 'S' + s[0], name: s[2] + ' service point', type: 'Store', address: 'Lot G-' + (10 + i) + ', Jalan Niaga ' + (i + 1) + ', ' + s[5] + ' ' + s[2] + ', ' + s[1].replace('WP ', 'Wilayah Persekutuan '), state: s[0], lat: s[3], lng: s[4], phone: '', active: true }));
    bases.forEach(b => w.put('bases', b));
    w.put('users', { id: 'U00', username: 'msyafirol', name: 'M. Syafirol', role: 'admin', email: '', phone: '', address: bases[0].address, base: 'B00', active: true });
    await setPw(w, 'U00', 'admin123');
    w.put('audit', { id: 'a0', ts: Date.now(), user: 'System', role: '', action: 'System set up', no: '', remarks: 'Fresh start: administrator account and bases created' });
    w.setMeta('settings', { rates: { sur: { Standard: 0, Urgent: .25, Critical: .5 } }, sla: { response: 4, collection: 4, delivery: { A: 4, B: 10, C: 36 }, e2e: { A: 24, B: 48, C: 96 } }, ch: { email: true, inapp: true, teams: false, sms: false } });
    w.setMeta('seq', 1000); w.setMeta('version', 1); w.setMeta('seeded', true);
    await w.commit()
  }

  /* ---------- scoping ---------- */
  const isHWS = u => HWS.includes(u.role), isLead = u => LEAD.includes(u.role);
  const userSees = (u, r) => r.requestor === u.id || (!!u.base && r.to === u.base);
  function inScope(u, r) {
    if (!r) return false; if (isHWS(u)) return true;
    if (u.role === 'vendor') return !!u.vendor && r.vendor === u.vendor;
    if (u.role === 'driver') return !!u.driver && r.driver === u.driver;
    return userSees(u, r)
  }
  const pub = x => { const y = Object.assign({}, x); delete y.pw; return y };
  function snapshot(w, u) {
    const reqs = w.all('reqs').filter(r => inScope(u, r)), ids = new Set(reqs.map(r => r.id));
    const users = isHWS(u) || canW(w, u, 'users') ? w.all('users')
      : [w.get('users', u.id)].concat(u.role === 'user' ? w.all('users').filter(x => isHWS(x) && x.active).map(x => ({ id: x.id, username: '', name: x.name, role: x.role, active: true })) : []);
    let drivers = w.all('drivers');
    if (u.role === 'vendor') drivers = drivers.filter(d => d.vendor === u.vendor);
    else if (u.role === 'driver') drivers = drivers.filter(d => d.id === u.driver || reqs.some(r => r.driver === d.id));
    else if (u.role === 'user') drivers = drivers.filter(d => reqs.some(r => r.driver === d.id));
    const st = w.meta('settings', {});
    return Object.assign({ v: 3, version: w.meta('version', 1), seq: w.meta('seq', 1000) }, st, { perms: permsOf(st), permDefaults: defaultPerms() }, {
      users: users.map(pub), vendors: w.all('vendors'), drivers, bases: w.all('bases'),
      routes: isHWS(u) || canW(w, u, 'cost') || canW(w, u, 'rates') ? w.all('routes') : [], reqs: reqs.sort((a, b) => b.t.created - a.t.created),
      notifs: w.all('notifs').filter(n => ids.has(n.rid)).sort((a, b) => b.ts - a.ts).slice(0, 300),
      audit: canW(w, u, 'audit') ? w.all('audit') : []
    })
  }
  const audit = (w, u, action, remarks) => w.put('audit', { id: 'a' + rid(), ts: Date.now(), user: u.name, role: ROLE[u.role] || '', action, no: '', remarks: remarks || '' });

  /* ---------- sync: the page sends the records it changed ---------- */
  async function applySync(w, u, body) {
    const ups = body.upserts || {}, dels = body.deletes || {};
    for (const c of Object.keys(ups)) {
      if (!COLLS.includes(c) || !Array.isArray(ups[c])) continue;
      for (const x of ups[c]) {
        if (!x || x.id == null) continue;
        const old = w.get(c, x.id);
        if (c === 'reqs') {
          if (!isHWS(u) && (old ? !inScope(u, old) : !(canW(w, u, 'create') && x.requestor === u.id))) throw new Denied('That request is outside your access.');
          if (!old && (typeof x.id !== 'number' || x.id > w.meta('seq', 1000))) throw new Denied('Request number was not issued.');
          w.put(c, x)
        } else if (c === 'notifs') w.put(c, x);
        else if (c === 'audit') { if (!old) w.put(c, Object.assign(x, { user: u.name })) }
        else if (c === 'users') {
          const onlyActive = old && Object.keys(Object.assign({}, old, x)).every(k => k === 'active' || k === 'pw' || JSON.stringify(old[k]) === JSON.stringify(x[k]));
          const vendorLogin = !old && ['vendor', 'driver'].includes(x.role) && canW(w, u, 'vendors');
          if (!(canW(w, u, 'users') || vendorLogin || (onlyActive && canW(w, u, 'deactivate')))) throw new Denied('Your role cannot change user accounts.');
          if (old && onlyActive && old.active !== x.active && !canW(w, u, 'deactivate')) throw new Denied('Your role cannot deactivate accounts.');
          if (old && x.pw && !canW(w, u, 'delete')) throw new Denied('Your role cannot reset passwords.');
          if ((x.role === 'admin' || (old && old.role === 'admin')) && u.role !== 'admin') throw new Denied('Only the Administrator can manage administrator accounts.');
          if (x.id === u.id && (x.role !== u.role || x.active === false)) throw new Denied('You cannot change your own role or deactivate yourself.');
          const un = String(x.username || '').toLowerCase();
          if (!un || w.all('users').some(y => y.id !== x.id && String(y.username).toLowerCase() === un)) throw new Denied('That username is taken.');
          if (x.pw) await setPw(w, x.id, x.pw); else if (!old) await setPw(w, x.id, 'welcome123');
          w.put(c, pub(x))
        } else {
          const need = c === 'routes' ? 'rates' : c === 'bases' ? 'bases' : 'vendors';
          const onlyActive = c === 'vendors' && old && Object.keys(Object.assign({}, old, x)).every(k => k === 'active' || JSON.stringify(old[k]) === JSON.stringify(x[k]));
          if (!(canW(w, u, need) || (onlyActive && canW(w, u, 'deactivate')))) throw new Denied('Your role cannot change ' + c + '.');
          w.put(c, x)
        }
      }
    }
    for (const c of Object.keys(dels)) {
      if (!COLLS.includes(c) || !Array.isArray(dels[c])) continue;
      if (!canW(w, u, c === 'reqs' ? 'undo' : 'delete')) throw new Denied('Your role cannot delete ' + c + '.');
      for (const id of dels[c]) {
        if (c === 'users' && id === u.id) throw new Denied('You cannot delete your own account.');
        w.del(c, id); if (c === 'users') w.setSecret(String(id), null)
      }
    }
    if (body.settings) {
      const cur = w.meta('settings', {}), s = body.settings;
      if ((s.sla || s.rates) && !canW(w, u, 'rates')) throw new Denied('Your role cannot change SLA targets and rates.');
      if (s.ch && !canW(w, u, 'notif')) throw new Denied('Your role cannot change notification channels.');
      if (s.perms && u.role !== 'admin') throw new Denied('Only the Administrator can change role permissions.');
      ['sla', 'rates', 'ch'].forEach(k => { if (s[k]) cur[k] = s[k] });
      if (s.perms) cur.perms = permsOf({ perms: s.perms });
      w.setMeta('settings', cur)
    }
    bump(w)
  }

  /* ---------- sessions: per tab, remembered on this device ---------- */
  function readSess() { try { return JSON.parse(sessionStorage.getItem(SKEY) || localStorage.getItem(SKEY) || 'null') } catch (e) { return null } }
  function writeSess(s) { try { if (s) { sessionStorage.setItem(SKEY, JSON.stringify(s)); localStorage.setItem(SKEY, JSON.stringify(s)) } else { sessionStorage.removeItem(SKEY); localStorage.removeItem(SKEY) } } catch (e) { } }
  function whoami(w) {
    const s = readSess(); if (!s || s.exp < Date.now()) return null;
    const u = w.get('users', s.uid), sec = w.secret(String(s.uid));
    return u && u.active && sec && (sec.epoch || 0) === s.epoch ? u : null
  }

  /* ---------- the API ---------- */
  const R = (status, body) => ({ status, body });
  async function handle(p, b) {
    if (!mem || dirty) await loadMem();
    if (!mem.meta.seeded) await seed();
    const w = work();
    if (p === '/api/health') return R(200, { ok: true });
    if (p === '/api/login') {
      const un = String(b.username || '').trim().toLowerCase(), u = w.all('users').find(x => String(x.username).toLowerCase() === un), sec = u && w.secret(String(u.id));
      if (!u || !(await checkPw(b.password || '', sec && sec.hash))) return R(401, { error: 'Username or password is incorrect.' });
      if (!u.active) return R(403, { error: 'This account is deactivated. Ask an administrator to activate it.' });
      writeSess({ uid: u.id, epoch: sec.epoch || 0, exp: Date.now() + SESSION_DAYS * 864e5 });
      audit(w, u, 'User login', 'Password sign-in'); bump(w); await w.commit(); return R(200, { uid: u.id })
    }
    const u = whoami(w);
    if (!u) return R(401, { error: 'Sign in again.' });
    if (p === '/api/logout') { audit(w, u, 'User sign-out'); bump(w); await w.commit(); writeSess(null); return R(200, { ok: true }) }
    if (p === '/api/data') return R(200, Object.assign(snapshot(w, u), { uid: u.id }));
    if (p === '/api/version') return R(200, { version: w.meta('version', 1) });
    if (p === '/api/seq') {
      if (!canW(w, u, 'create')) return R(403, { error: 'Your role cannot create requests.' });
      const id = w.meta('seq', 1000) + 1; w.setMeta('seq', id); await w.commit(); return R(200, { id })
    }
    if (p === '/api/sync') { await applySync(w, u, b || {}); await w.commit(); return R(200, { ok: true, version: w.meta('version', 1) }) }
    if (p === '/api/password') {
      const sec = w.secret(String(u.id));
      if (!(await checkPw(b.current || '', sec && sec.hash))) return R(400, { error: 'Current password is incorrect.' });
      if (String(b.next || '').length < 8) return R(400, { error: 'Use at least 8 characters for the new password.' });
      await setPw(w, u.id, b.next); audit(w, u, 'Password changed'); bump(w); await w.commit();
      const s = readSess(); writeSess(Object.assign(s, { epoch: w.secret(String(u.id)).epoch })); return R(200, { ok: true })
    }
    return R(404, { error: 'Not found' })
  }
  let queue = Promise.resolve();
  function api(p, b) {
    const run = queue.then(() => handle(p, b)).catch(e => e instanceof Denied ? R(403, { error: e.message }) : R(500, { error: e.message || 'Could not save on this device.' }));
    queue = run.catch(() => { }); return run
  }

  /* ---------- backup, restore and fresh start (Administrator) ---------- */
  async function exportAll() {
    await queue; await loadMem();
    const rec = {}; COLLS.forEach(c => rec[c] = [...mem.rec[c].values()]);
    return { format: 'hwotg-offline-backup', version: 1, exported: new Date().toISOString(), rec, meta: mem.meta, secrets: mem.secrets }
  }
  async function importAll(d) {
    if (!d || d.format !== 'hwotg-offline-backup' || !d.rec || !d.meta) throw new Error('This file is not an HWOTG backup.');
    if (!(d.rec.users || []).some(x => x.role === 'admin' && x.active)) throw new Error('This backup has no active administrator account.');
    await queue; await clearAll();
    const ops = [];
    COLLS.forEach(c => (d.rec[c] || []).forEach(x => ops.push({ s: 'rec', k: K(c, x.id), v: x })));
    Object.keys(d.meta).forEach(k => ops.push({ s: 'meta', k, v: d.meta[k] }));
    Object.keys(d.secrets || {}).forEach(k => ops.push({ s: 'secrets', k, v: d.secrets[k] }));
    ops.push({ s: 'meta', k: 'version', v: (d.meta.version || 1) + 1 });
    await writeOps(ops); writeSess(null); dirty = true; if (bc) bc.postMessage('changed')
  }
  async function wipe() { await queue; await clearAll(); writeSess(null); mem = null; dirty = true; if (bc) bc.postMessage('changed') }

  window.HWOTG_LOCAL = { api, exportAll, importAll, wipe, storage: () => idbReady.then(() => idb ? 'IndexedDB' : 'localStorage') };
})();
