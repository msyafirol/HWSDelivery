'use strict';
// HWOTG Delivery Tracking server: serves the web app, signs users in and keeps one shared database.
// No third-party packages: Node 22+ http, crypto and the built-in node:sqlite module.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';
const MAX_BODY = 40 * 1024 * 1024;
const SESSION_DAYS = 14;
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
const can = (u, k) => !!permsOf(getMeta('settings', {}))[k][u.role];

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'hwotg.db'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS records(coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(coll,id));
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS secrets(uid TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL);`);

const q = {
  all: db.prepare('SELECT id,data FROM records WHERE coll=?'),
  get: db.prepare('SELECT data FROM records WHERE coll=? AND id=?'),
  put: db.prepare('INSERT INTO records(coll,id,data) VALUES(?,?,?) ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data'),
  del: db.prepare('DELETE FROM records WHERE coll=? AND id=?'),
  meta: db.prepare('SELECT value FROM meta WHERE key=?'),
  setMeta: db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
  hash: db.prepare('SELECT hash FROM secrets WHERE uid=?'),
  setHash: db.prepare('INSERT INTO secrets(uid,hash) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET hash=excluded.hash'),
  delHash: db.prepare('DELETE FROM secrets WHERE uid=?'),
  sess: db.prepare('SELECT uid,expires FROM sessions WHERE token=?'),
  addSess: db.prepare('INSERT INTO sessions(token,uid,expires) VALUES(?,?,?)'),
  endSess: db.prepare('DELETE FROM sessions WHERE token=?'),
  endUserSess: db.prepare('DELETE FROM sessions WHERE uid=?'),
  purgeSess: db.prepare('DELETE FROM sessions WHERE expires<?'),
  blob: db.prepare('SELECT type,data FROM blobs WHERE id=?'),
  addBlob: db.prepare('INSERT INTO blobs(id,type,data) VALUES(?,?,?)'),
};
const getMeta = (k, d) => { const r = q.meta.get(k); return r ? JSON.parse(r.value) : d };
const setMeta = (k, v) => q.setMeta.run(k, JSON.stringify(v));
const all = c => q.all.all(c).map(r => JSON.parse(r.data));
const getRec = (c, id) => { const r = q.get.get(c, String(id)); return r ? JSON.parse(r.data) : null };
const putRec = (c, x) => q.put.run(c, String(x.id), JSON.stringify(x));
const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } };
const bump = () => { const v = getMeta('version', 0) + 1; setMeta('version', v); return v };

/* ---------- passwords ---------- */
function hashPw(pw) { const salt = crypto.randomBytes(16); return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(String(pw), salt, 64).toString('hex') }
function checkPw(pw, stored) {
  if (!stored) return false; const [, s, h] = stored.split('$');
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64), want = Buffer.from(h, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

/* ---------- first run: setup data only, no users or jobs except the administrator ---------- */
function seed() {
  if (getMeta('seeded', false)) return;
  const S = [['PLS', 'Perlis', 'Kangar', 6.4414, 100.1986, '01000'], ['KDH', 'Kedah', 'Alor Setar', 6.1248, 100.3678, '05000'], ['PNG', 'Pulau Pinang', 'George Town', 5.4141, 100.3288, '10200'], ['PRK', 'Perak', 'Ipoh', 4.5975, 101.0901, '30450'],
    ['SGR', 'Selangor', 'Klang', 3.0449, 101.4456, '41200'], ['KUL', 'WP Kuala Lumpur', 'Kuala Lumpur', 3.1390, 101.6869, '56000'], ['PJY', 'WP Putrajaya', 'Putrajaya', 2.9264, 101.6964, '62250'], ['NSN', 'Negeri Sembilan', 'Seremban', 2.7258, 101.9424, '70200'],
    ['MLK', 'Melaka', 'Melaka', 2.1896, 102.2501, '75000'], ['JHR', 'Johor', 'Johor Bahru', 1.4927, 103.7414, '81100'], ['PHG', 'Pahang', 'Kuantan', 3.8077, 103.3260, '25200'], ['TRG', 'Terengganu', 'Kuala Terengganu', 5.3302, 103.1408, '20200'],
    ['KTN', 'Kelantan', 'Kota Bharu', 6.1254, 102.2381, '15150'], ['SWK', 'Sarawak', 'Kuching', 1.5533, 110.3592, '93350'], ['SBH', 'Sabah', 'Kota Kinabalu', 5.9804, 116.0735, '88300'], ['LBN', 'WP Labuan', 'Labuan', 5.2831, 115.2308, '87000']];
  tx(() => {
    const bases = [{ id: 'B00', name: 'Central Warehouse Shah Alam', type: 'Warehouse', address: 'Lot 8, Jalan Pelabur 23/1, Seksyen 23, 40300 Shah Alam, Selangor', state: 'SGR', lat: 3.0360, lng: 101.5370, phone: '', active: true },
      { id: 'B01', name: 'Northern Hub Bayan Lepas', type: 'Hub', address: 'Plot 102, Lorong Perindustrian Bayan Lepas 4, 11900 Bayan Lepas, Pulau Pinang', state: 'PNG', lat: 5.2967, lng: 100.2616, phone: '', active: true }];
    S.forEach((s, i) => bases.push({ id: 'S' + s[0], name: s[2] + ' service point', type: 'Store', address: 'Lot G-' + (10 + i) + ', Jalan Niaga ' + (i + 1) + ', ' + s[5] + ' ' + s[2] + ', ' + s[1].replace('WP ', 'Wilayah Persekutuan '), state: s[0], lat: s[3], lng: s[4], phone: '', active: true }));
    bases.forEach(b => putRec('bases', b));
    putRec('users', { id: 'U00', username: 'msyafirol', name: 'M. Syafirol', role: 'admin', email: '', phone: '', address: bases[0].address, base: 'B00', active: true });
    q.setHash.run('U00', hashPw(ADMIN_PASSWORD));
    putRec('audit', { id: 'a0', ts: Date.now(), user: 'System', role: '', action: 'System set up', no: '', remarks: 'Fresh start: administrator account and bases created' });
    setMeta('settings', { rates: { sur: { Standard: 0, Urgent: .25, Critical: .5 } }, sla: { response: 4, collection: 4, delivery: { A: 4, B: 10, C: 36 }, e2e: { A: 24, B: 48, C: 96 } }, ch: { email: true, inapp: true, teams: false, sms: false } });
    setMeta('seq', 1000); setMeta('version', 1); setMeta('seeded', true);
  });
  console.log('First run: created administrator "msyafirol"' + (process.env.ADMIN_PASSWORD ? '' : ' with password admin123. Sign in and change it.'));
}
seed();

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
function snapshot(u) {
  const reqs = all('reqs').filter(r => inScope(u, r)), ids = new Set(reqs.map(r => r.id));
  const users = isHWS(u) || can(u, 'users') ? all('users')
    : [getRec('users', u.id)].concat(u.role === 'user' ? all('users').filter(x => isHWS(x) && x.active).map(x => ({ id: x.id, username: '', name: x.name, role: x.role, active: true })) : []);
  let drivers = all('drivers');
  if (u.role === 'vendor') drivers = drivers.filter(d => d.vendor === u.vendor);
  else if (u.role === 'driver') drivers = drivers.filter(d => d.id === u.driver || reqs.some(r => r.driver === d.id));
  else if (u.role === 'user') drivers = drivers.filter(d => reqs.some(r => r.driver === d.id));
  const st = getMeta('settings', {});
  return Object.assign({ v: 3, version: getMeta('version', 1), seq: getMeta('seq', 1000) }, st, { perms: permsOf(st), permDefaults: defaultPerms() }, {
    users: users.map(pub), vendors: all('vendors'), drivers, bases: all('bases'),
    routes: isHWS(u) || can(u, 'cost') || can(u, 'rates') ? all('routes') : [], reqs: reqs.sort((a, b) => b.t.created - a.t.created),
    notifs: all('notifs').filter(n => ids.has(n.rid)).sort((a, b) => b.ts - a.ts).slice(0, 300),
    audit: can(u, 'audit') ? all('audit') : []
  })
}

/* ---------- attachments and photos go to the blob table; records keep a URL ---------- */
function stash(v) {
  if (typeof v !== 'string' || !v.startsWith('data:')) return v;
  const m = v.match(/^data:([^;,]*)(;base64)?,(.*)$/s); if (!m) return v;
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  const id = crypto.randomBytes(12).toString('hex');
  q.addBlob.run(id, m[1] || 'application/octet-stream', buf); return '/api/blob/' + id
}
function stashReq(r) {
  (r.files || []).forEach(f => { f.data = stash(f.data) });
  const p = r.proof || {};
  if (p.collection) p.collection.photo = stash(p.collection.photo);
  if (p.delivery) { p.delivery.photo = stash(p.delivery.photo); p.delivery.sig = stash(p.delivery.sig) }
}

/* ---------- sync: the page sends the records it changed ---------- */
class Denied extends Error { }
function applySync(u, body) {
  const ups = body.upserts || {}, dels = body.deletes || {};
  tx(() => {
    for (const c of Object.keys(ups)) {
      if (!COLLS.includes(c) || !Array.isArray(ups[c])) continue;
      for (const x of ups[c]) {
        if (!x || x.id == null) continue;
        const old = getRec(c, x.id);
        if (c === 'reqs') {
          if (!isHWS(u)) {
            if (old ? !inScope(u, old) : !(can(u, 'create') && x.requestor === u.id)) throw new Denied('That request is outside your access.');
          }
          if (!old && (typeof x.id !== 'number' || x.id > getMeta('seq', 1000))) throw new Denied('Request number was not issued by the server.');
          stashReq(x); putRec(c, x)
        } else if (c === 'notifs') { putRec(c, x) }
        else if (c === 'audit') { if (!old) putRec(c, Object.assign(x, { user: u.name, role: x.role })) }
        else if (c === 'users') {
          const onlyActive = old && Object.keys(Object.assign({}, old, x)).every(k => k === 'active' || k === 'pw' || JSON.stringify(old[k]) === JSON.stringify(x[k]));
          const vendorLogin = !old && ['vendor', 'driver'].includes(x.role) && can(u, 'vendors');
          if (!(can(u, 'users') || vendorLogin || (onlyActive && can(u, 'deactivate')))) throw new Denied('Your role cannot change user accounts.');
          if (old && onlyActive && old.active !== x.active && !can(u, 'deactivate')) throw new Denied('Your role cannot deactivate accounts.');
          if (old && x.pw && !can(u, 'delete')) throw new Denied('Your role cannot reset passwords.');
          if ((x.role === 'admin' || (old && old.role === 'admin')) && u.role !== 'admin') throw new Denied('Only the Administrator can manage administrator accounts.');
          if (x.id === u.id && (x.role !== u.role || x.active === false)) throw new Denied('You cannot change your own role or deactivate yourself.');
          const un = String(x.username || '').toLowerCase();
          if (!un || all('users').some(y => y.id !== x.id && String(y.username).toLowerCase() === un)) throw new Denied('That username is taken.');
          if (x.pw) { q.setHash.run(String(x.id), hashPw(x.pw)); q.endUserSess.run(String(x.id)) }
          else if (!old) q.setHash.run(String(x.id), hashPw('welcome123'));
          if (old && old.active && x.active === false) q.endUserSess.run(String(x.id));
          putRec(c, pub(x))
        } else {
          const need = c === 'routes' ? 'rates' : c === 'bases' ? 'bases' : 'vendors';
          const onlyActive = c === 'vendors' && old && Object.keys(Object.assign({}, old, x)).every(k => k === 'active' || JSON.stringify(old[k]) === JSON.stringify(x[k]));
          if (!(can(u, need) || (onlyActive && can(u, 'deactivate')))) throw new Denied('Your role cannot change ' + c + '.');
          putRec(c, x)
        }
      }
    }
    for (const c of Object.keys(dels)) {
      if (!COLLS.includes(c) || !Array.isArray(dels[c])) continue;
      // Attachment deletes happen inside a request upsert; whole-record deletes are admin only.
      if (!can(u, c === 'reqs' ? 'undo' : 'delete')) throw new Denied('Your role cannot delete ' + c + '.');
      for (const id of dels[c]) {
        if (c === 'users' && id === u.id) throw new Denied('You cannot delete your own account.');
        q.del.run(c, String(id)); if (c === 'users') { q.delHash.run(String(id)); q.endUserSess.run(String(id)) }
      }
    }
    if (body.settings) {
      const cur = getMeta('settings', {}), s = body.settings;
      if ((s.sla || s.rates) && !can(u, 'rates')) throw new Denied('Your role cannot change SLA targets and rates.');
      if (s.ch && !can(u, 'notif')) throw new Denied('Your role cannot change notification channels.');
      if (s.perms && u.role !== 'admin') throw new Denied('Only the Administrator can change role permissions.');
      ['sla', 'rates', 'ch'].forEach(k => { if (s[k]) cur[k] = s[k] });
      if (s.perms) cur.perms = permsOf({ perms: s.perms });
      setMeta('settings', cur)
    }
    bump()
  })
}

/* ---------- http ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const HDR = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' };
function send(res, code, obj, extra) { const b = JSON.stringify(obj); res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, HDR, extra || {})); res.end(b) }
function body(req) {
  return new Promise((ok, no) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { no(Object.assign(new Error('Upload too large'), { code: 413 })); req.destroy() } else parts.push(c) });
    req.on('end', () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}) } catch (e) { no(Object.assign(new Error('Bad JSON'), { code: 400 })) } });
    req.on('error', no)
  })
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]).map(p => [p[0], decodeURIComponent(p.slice(1).join('='))]));
const sessCookie = (tok, age) => 'hwotg_sid=' + tok + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + age + (SECURE_COOKIE ? '; Secure' : '');
function whoami(req) {
  const tok = cookies(req).hwotg_sid; if (!tok) return null;
  const s = q.sess.get(tok); if (!s || s.expires < Date.now()) return null;
  const u = getRec('users', s.uid); return u && u.active ? Object.assign(u, { _tok: tok }) : null
}
const fails = new Map();
function throttled(key) { const f = fails.get(key); return f && f.n >= 8 && Date.now() - f.t < 10 * 60e3 }
function failed(key) { const f = fails.get(key) || { n: 0, t: 0 }; f.n = Date.now() - f.t > 10 * 60e3 ? 1 : f.n + 1; f.t = Date.now(); fails.set(key, f) }
const audit = (u, action, remarks) => putRec('audit', { id: 'a' + crypto.randomBytes(6).toString('hex'), ts: Date.now(), user: u.name, role: { admin: 'Administrator', manager: 'HWS Manager', hws: 'HWS Staff', vendor: 'Vendor Admin', driver: 'Driver', user: 'Regional User' }[u.role] || '', action, no: '', remarks: remarks || '' });

async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/health') return send(res, 200, { ok: true });
  if (p === '/api/login' && m === 'POST') {
    const b = await body(req), un = String(b.username || '').trim().toLowerCase(), key = un + '|' + req.socket.remoteAddress;
    if (throttled(key)) return send(res, 429, { error: 'Too many attempts. Wait 10 minutes and try again.' });
    const u = all('users').find(x => String(x.username).toLowerCase() === un);
    const h = u && q.hash.get(String(u.id));
    if (!u || !checkPw(b.password || '', h && h.hash)) { failed(key); return send(res, 401, { error: 'Username or password is incorrect.' }) }
    if (!u.active) return send(res, 403, { error: 'This account is deactivated. Ask an administrator to activate it.' });
    fails.delete(key); q.purgeSess.run(Date.now());
    const tok = crypto.randomBytes(32).toString('hex'); q.addSess.run(tok, String(u.id), Date.now() + SESSION_DAYS * 864e5);
    tx(() => { audit(u, 'User login', 'Password sign-in'); bump() });
    return send(res, 200, { uid: u.id }, { 'Set-Cookie': sessCookie(tok, SESSION_DAYS * 86400) })
  }
  const u = whoami(req);
  if (!u) return send(res, 401, { error: 'Sign in again.' });
  if (p === '/api/logout' && m === 'POST') { tx(() => { audit(u, 'User sign-out'); bump() }); q.endSess.run(u._tok); return send(res, 200, { ok: true }, { 'Set-Cookie': sessCookie('', 0) }) }
  if (p === '/api/data' && m === 'GET') return send(res, 200, Object.assign(snapshot(u), { uid: u.id }));
  if (p === '/api/version' && m === 'GET') return send(res, 200, { version: getMeta('version', 1) });
  if (p === '/api/seq' && m === 'POST') {
    if (!can(u, 'create')) return send(res, 403, { error: 'Your role cannot create requests.' });
    const id = tx(() => { const n = getMeta('seq', 1000) + 1; setMeta('seq', n); return n }); return send(res, 200, { id })
  }
  if (p === '/api/sync' && m === 'POST') { const b = await body(req); applySync(u, b); return send(res, 200, { ok: true, version: getMeta('version', 1) }) }
  if (p === '/api/password' && m === 'POST') {
    const b = await body(req), h = q.hash.get(String(u.id));
    if (!checkPw(b.current || '', h && h.hash)) return send(res, 400, { error: 'Current password is incorrect.' });
    if (String(b.next || '').length < 8) return send(res, 400, { error: 'Use at least 8 characters for the new password.' });
    q.setHash.run(String(u.id), hashPw(b.next)); tx(() => { audit(u, 'Password changed'); bump() });
    return send(res, 200, { ok: true })
  }
  const bm = p.match(/^\/api\/blob\/([a-f0-9]{24})$/);
  if (bm && m === 'GET') {
    const b = q.blob.get(bm[1]); if (!b) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, Object.assign({ 'Content-Type': b.type, 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'", 'Content-Disposition': /^image\//.test(b.type) ? 'inline' : 'attachment' }, HDR)); return res.end(Buffer.from(b.data))
  }
  send(res, 404, { error: 'Not found' })
}

const PUB = path.join(__dirname, 'public');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let f = path.normalize(path.join(PUB, decodeURIComponent(url.pathname)));
    if (!f.startsWith(PUB)) return send(res, 403, { error: 'Forbidden' });
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': f.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' }, HDR));
    fs.createReadStream(f).pipe(res)
  } catch (e) {
    if (e instanceof Denied) return send(res, 403, { error: e.message });
    if (e.code === 413 || e.code === 400) return send(res, e.code, { error: e.message });
    console.error(e); send(res, 500, { error: 'Server error' })
  }
});
server.listen(PORT, () => console.log('HWOTG Delivery Tracking on http://localhost:' + PORT));
