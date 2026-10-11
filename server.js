'use strict';
/**
 * Business Ledger - backend server.
 * Zero framework: only Node built-ins (+ "pg" for Postgres, or "firebase-admin" for Firestore).
 *
 *   npm start           -> run server
 *   npm test            -> run API tests (uses a temporary local SQLite file)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { createDb } = require('./db');
const R = require('./resources');

const gzip = promisify(zlib.gzip);
const { HttpError } = R;
const PUBLIC = path.join(__dirname, 'public');
const SESSION_COOKIE = 'bl_session';
const SESSION_DAYS = 30;
const FIRESTORE_MAX_ATTACHMENT = 700 * 1024; // stay safely under Firestore's ~1 MiB document limit (base64 adds ~33%)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json'
};

const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Builds the whole app (db + routes + request handler) without opening a network port.
 * Used both by start() below (for Render/Railway/local/"npm start") and by the Netlify Functions
 * adapter (netlify/functions/api.mjs), which calls handle(req, res) itself for every request
 * instead of listening on a socket.
 */
async function createApp() {
  const PROD = process.env.NODE_ENV === 'production';
  const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';
  if (ADMIN_PASS.length < (PROD ? 8 : 4)) {
    throw new Error('ADMIN_PASSWORD is not set (or too short). Set a strong password (8+ characters) in your environment variables.');
  }
  const db = createDb();
  await db.init();

  const MAX_UPLOAD_CONFIGURED = (Number(process.env.MAX_UPLOAD_MB) || 10) * 1024 * 1024;
  const MAX_UPLOAD = db.kind === 'firestore' ? Math.min(MAX_UPLOAD_CONFIGURED, FIRESTORE_MAX_ATTACHMENT) : MAX_UPLOAD_CONFIGURED;
  const MAX_STORAGE = (Number(process.env.MAX_STORAGE_MB) || (db.kind === 'firestore' ? 800 : 400)) * 1024 * 1024;
  const SECRET = process.env.SESSION_SECRET ||
    crypto.scryptSync(ADMIN_USER + ':' + ADMIN_PASS, 'business-ledger-session-v1', 32).toString('hex');

  /* ------------------------------ sessions ------------------------------ */
  const mac = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  function signSession(user) {
    const body = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
    return body + '.' + mac(body);
  }
  function readSession(req) {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return null;
    const [body, sig] = raw.split('.');
    if (!body || !sig) return null;
    const expected = mac(body);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (p.exp < Date.now() || p.u !== ADMIN_USER) return null;
      return p.u;
    } catch (_) { return null; }
  }
  function parseCookies(h) {
    const o = {};
    for (const part of String(h || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) { try { o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { /* skip */ } }
    }
    return o;
  }
  const isHttps = (req) => Boolean(req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  function cookieHeader(req, value, maxAge) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PROD || isHttps(req) ? '; Secure' : ''}`;
  }

  /* --------------------------- login rate limit --------------------------- */
  // Counters live in the database (table "meta"), so they still work on serverless hosts where every
  // request may land on a fresh container and an in-memory Map would be empty each time.
  const WINDOW_MS = 15 * 60 * 1000, MAX_FAILS = 10;
  const clientIp = (req) => {
    const h = req.headers;
    // Only trust platform-set headers when we are really running on that platform (clients can forge them elsewhere).
    if (process.env.NETLIFY && h['x-nf-client-connection-ip']) return String(h['x-nf-client-connection-ip']);
    if (process.env.VERCEL && h['x-vercel-forwarded-for']) return String(h['x-vercel-forwarded-for']).split(',')[0].trim();
    const xff = String(h['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    return xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress) || 'unknown';
  };
  const rlId = (ip) => 'rl_' + crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 24);
  async function checkRate(ip) {
    const rec = await db.get('meta', rlId(ip));
    if (!rec) return;
    if (Date.now() - rec.first > WINDOW_MS) { await db.remove('meta', rlId(ip)); return; }
    if (rec.count >= MAX_FAILS) throw new HttpError(429, 'Too many failed attempts. Please wait 15 minutes and try again.');
  }
  async function recordFail(ip) {
    const id = rlId(ip), rec = await db.get('meta', id), now = Date.now();
    if (rec && now - rec.first <= WINDOW_MS) await db.update('meta', id, { count: rec.count + 1, first: rec.first });
    else if (rec) await db.update('meta', id, { count: 1, first: now });
    else await db.insert('meta', id, { count: 1, first: now });
  }
  const clearFails = (ip) => db.remove('meta', rlId(ip));

  /* ------------------------------- helpers ------------------------------- */
  async function send(req, res, status, buf, headers = {}) {
    const type = headers['Content-Type'] || '';
    if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /json|text|javascript|svg|manifest/.test(type)) {
      buf = await gzip(buf);
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }
    headers['Content-Length'] = buf.length;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : buf);
  }
  const sendJson = (req, res, status, obj, extra = {}) =>
    send(req, res, status, Buffer.from(JSON.stringify(obj)), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > limit) return reject(new HttpError(413, `File is too large (max ${Math.round(limit / 1048576)} MB)`));
      const chunks = [];
      let size = 0, tooBig = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { tooBig = true; chunks.length = 0; } else if (!tooBig) chunks.push(c);
      });
      req.on('end', () => (tooBig ? reject(new HttpError(413, 'File is too large')) : resolve(Buffer.concat(chunks))));
      req.on('error', reject);
    });
  }
  async function jsonBody(req, limit = 1024 * 1024) {
    const buf = await readBody(req, limit);
    try { return JSON.parse(buf.toString('utf8') || '{}'); } catch (_) { throw new HttpError(400, 'Invalid JSON'); }
  }

  /* -------------------------------- routes -------------------------------- */
  const routes = [];
  function route(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false });
  }
  const HANDLED = Symbol('handled');

  route('GET', '/api/health', async () => {
    await db.list('customers');
    return { ok: true, db: db.kind };
  }, { auth: false });

  route('POST', '/api/login', async (c) => {
    const ip = clientIp(c.req);
    await checkRate(ip);
    const b = await jsonBody(c.req);
    const okUser = safeEq(b.username || '', ADMIN_USER);
    const okPass = safeEq(b.password || '', ADMIN_PASS);
    if (!(okUser && okPass)) {
      await recordFail(ip);
      await sleep(400);
      throw new HttpError(401, 'Wrong username or password');
    }
    await clearFails(ip);
    return [200, { ok: true, user: ADMIN_USER }, { 'Set-Cookie': cookieHeader(c.req, signSession(ADMIN_USER), SESSION_DAYS * 86400) }];
  }, { auth: false });

  route('POST', '/api/logout', async (c) => [200, { ok: true }, { 'Set-Cookie': cookieHeader(c.req, '', 0) }], { auth: false });

  route('GET', '/api/session', async (c) => {
    const user = readSession(c.req);
    if (!user) throw new HttpError(401, 'Not logged in');
    return { user };
  }, { auth: false });

  // Read-cache for /api/data. Only used on an always-on server (one process), where every write goes through us
  // and clears it. Never on serverless, where another container could have written in the meantime.
  const CACHE_OK = !(process.env.NETLIFY || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  let cache = null;

  const byNewest = (a, b) => String(b.entry_date).localeCompare(String(a.entry_date)) || String(b.created_at).localeCompare(String(a.created_at));

  async function loadAll() {
    const [customers, income, expenses, sales, payments, returns, bound, attMeta] = await Promise.all([
      db.list('customers'), db.list('income'), db.list('expenses'), db.list('sales'), db.list('payments'), db.list('returns'), db.list('bound'), db.attachments.listMeta()
    ]);
    customers.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const arr of [income, expenses, sales, payments, returns, bound]) arr.sort(byNewest);
    const map = (name, rows) => rows.map((r) => R.toApi(R.RESOURCES[name], r));
    const attBytes = attMeta.reduce((s, a) => s + Number(a.size || 0), 0);
    return {
      customers: map('customers', customers), income: map('income', income), expenses: map('expenses', expenses),
      sales: map('sales', sales), payments: map('payments', payments), returns: map('returns', returns), bound: map('bound', bound),
      attachments: attMeta.map(R.attToApi),
      meta: { db: db.kind, user: ADMIN_USER, attachmentCount: attMeta.length, attachmentBytes: attBytes, maxStorageBytes: MAX_STORAGE, maxUploadBytes: MAX_UPLOAD }
    };
  }

  route('GET', '/api/data', async () => {
    if (CACHE_OK && cache) return cache;
    const d = await loadAll();
    if (CACHE_OK) cache = d;
    return d;
  });

  route('GET', '/api/export', async () => {
    const d = await loadAll();
    const day = new Date().toISOString().slice(0, 10);
    return [200, { app: 'business-ledger', version: 3, exportedAt: new Date().toISOString(), note: 'Attachment files stay in the database; this file lists them by id.', ...d, meta: undefined }, {
      'Content-Disposition': `attachment; filename="ledger-backup-${day}.json"`
    }];
  });

  /* ---- generic CRUD ---- */
  async function getOne(name, id) {
    const row = await db.get(R.RESOURCES[name].table, id);
    return row ? R.toApi(R.RESOURCES[name], row) : null;
  }
  async function beforeWrite(name, v) {
    if (name === 'sales' || name === 'payments' || name === 'returns') {
      const c = await db.get('customers', v.customer_id);
      if (!c) throw new HttpError(400, 'Customer not found');
    }
    if (name === 'sales' && v.received > v.total) throw new HttpError(400, '"received" cannot be more than the sale total');
  }
  async function syncSalePayment(saleId, v, now) {
    const linked = (await db.list('payments')).find((p) => p.sale_id === saleId);
    if (v.received > 0) {
      if (linked) {
        const row = { ...linked, customer_id: v.customer_id, entry_date: v.entry_date, amount: v.received };
        delete row.id;
        await db.update('payments', linked.id, row);
      } else {
        await db.insert('payments', crypto.randomUUID(), { customer_id: v.customer_id, sale_id: saleId, entry_date: v.entry_date, amount: v.received, method: 'Sale Payment', ref_no: '', description: 'Payment received with sale', created_at: now });
      }
    } else if (linked) {
      await db.attachments.removeWhere('payment', linked.id);
      await db.remove('payments', linked.id);
    }
  }
  async function assertNotLinkedPayment(name, id) {
    if (name !== 'payments') return;
    const r = await db.get('payments', id);
    if (r && r.sale_id) throw new HttpError(400, 'This payment belongs to a sale. Edit or delete the sale instead.');
  }

  for (const [name, res] of Object.entries(R.RESOURCES)) {
    route('POST', `/api/${name}`, async (c) => {
      const v = R.clean(res, await jsonBody(c.req));
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await beforeWrite(name, v);
      await db.insert(res.table, id, { ...v, created_at: now });
      if (name === 'sales') await syncSalePayment(id, v, now);
      return [201, await getOne(name, id)];
    });

    route('PUT', `/api/${name}/:id`, async (c) => {
      const id = c.params.id;
      if (!(await db.get(res.table, id))) throw new HttpError(404, 'Record not found');
      await assertNotLinkedPayment(name, id);
      const v = R.clean(res, await jsonBody(c.req));
      await beforeWrite(name, v);
      const existing = await db.get(res.table, id);
      const row = { ...existing, ...v };
      delete row.id;
      await db.update(res.table, id, row);
      if (name === 'sales') await syncSalePayment(id, v, new Date().toISOString());
      return await getOne(name, id);
    });

    route('DELETE', `/api/${name}/:id`, async (c) => {
      const id = c.params.id;
      if (!(await db.get(res.table, id))) throw new HttpError(404, 'Record not found');
      if (name === 'payments') {
        // A payment that was created together with a sale can be deleted on its own: the sale simply
        // becomes "nothing received yet" (its balance goes back up). Never leave sale and payment disagreeing.
        const pay = await db.get('payments', id);
        if (pay && pay.sale_id) {
          const sale = await db.get('sales', pay.sale_id);
          if (sale) { const row = { ...sale, received: 0 }; delete row.id; await db.update('sales', sale.id, row); }
        }
      }
      if (name === 'customers') {
        const sales = (await db.list('sales')).filter((x) => x.customer_id === id);
        const payments = (await db.list('payments')).filter((x) => x.customer_id === id);
        const rets = (await db.list('returns')).filter((x) => x.customer_id === id);
        for (const r of rets) { await db.attachments.removeWhere('return', r.id); await db.remove('returns', r.id); }
        for (const s of sales) await db.attachments.removeWhere('sale', s.id);
        for (const p of payments) await db.attachments.removeWhere('payment', p.id);
        await db.attachments.removeWhere('customer', id);
        for (const p of payments) await db.remove('payments', p.id);
        for (const s of sales) await db.remove('sales', s.id);
      } else if (name === 'sales') {
        const payments = (await db.list('payments')).filter((x) => x.sale_id === id);
        for (const p of payments) { await db.attachments.removeWhere('payment', p.id); await db.remove('payments', p.id); }
        await db.attachments.removeWhere('sale', id);
      } else {
        await db.attachments.removeWhere(res.ownerType, id);
      }
      await db.remove(res.table, id);
      return { ok: true };
    });
  }

  /* ---- attachments (raw body upload; images/audio only) ---- */
  route('POST', '/api/attachments', async (c) => {
    const { ownerType, ownerId } = c.query;
    const name = String(c.query.name || 'file').slice(0, 200);
    if (!R.OWNER_TYPES.includes(ownerType) || !ownerId) throw new HttpError(400, 'Invalid attachment owner');
    const mime = String(c.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!R.allowedMime(mime)) throw new HttpError(415, 'Only image and audio files are allowed');
    const owner = await db.get(R.OWNER_TABLE[ownerType], ownerId);
    if (!owner) throw new HttpError(404, 'The record for this attachment was not found');
    const buf = await readBody(c.req, MAX_UPLOAD);
    if (!buf.length) throw new HttpError(400, 'Empty file');
    const allMeta = await db.attachments.listMeta();
    const bytes = allMeta.reduce((s, a) => s + Number(a.size || 0), 0);
    if (bytes + buf.length > MAX_STORAGE) throw new HttpError(507, 'Attachment storage is full. Delete some old attachments first.');
    const forOwner = allMeta.filter((a) => a.owner_type === ownerType && a.owner_id === ownerId);
    if (c.query.replace === '1') { for (const a of forOwner) await db.attachments.remove(a.id); }
    else if (forOwner.length >= 20) throw new HttpError(400, 'Maximum 20 attachments per entry');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.attachments.insert({ id, owner_type: ownerType, owner_id: ownerId, name, mime, size: buf.length, data: buf, created_at: now });
    return [201, R.attToApi({ id, owner_type: ownerType, owner_id: ownerId, name, mime, size: buf.length, created_at: now })];
  });

  route('GET', '/api/attachments/:id', async (c) => {
    const a = await db.attachments.get(c.params.id);
    if (!a) throw new HttpError(404, 'File not found');
    const data = a.data;
    const headers = {
      'Content-Type': a.mime,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      'Accept-Ranges': 'bytes'
    };
    // Range support is required for audio playback on iPhone/Safari.
    const m = /^bytes=(\d*)-(\d*)$/.exec(c.req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] === '' ? Math.max(0, data.length - Number(m[2])) : Number(m[1]);
      let end = m[1] === '' || m[2] === '' ? data.length - 1 : Math.min(Number(m[2]), data.length - 1);
      if (start > end || start >= data.length) {
        c.res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
        c.res.end();
        return HANDLED;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
      await send(c.req, c.res, 206, data.subarray(start, end + 1), headers);
      return HANDLED;
    }
    await send(c.req, c.res, 200, data, headers);
    return HANDLED;
  });

  route('DELETE', '/api/attachments/:id', async (c) => {
    const rows = await db.attachments.listMeta();
    if (!rows.some((a) => a.id === c.params.id)) throw new HttpError(404, 'File not found');
    await db.attachments.remove(c.params.id);
    return { ok: true };
  });

  /* ---- restore from a backup file (merge: existing ids are kept, only missing records are added) ---- */
  route('POST', '/api/import', async (c) => {
    const b = await jsonBody(c.req, 5 * 1024 * 1024);
    if (!b || b.app !== 'business-ledger') throw new HttpError(400, 'This is not a Business Ledger backup file');
    const order = ['customers', 'income', 'expenses', 'sales', 'payments', 'returns', 'bound'];
    const known = new Set((await db.list('customers')).map((x) => x.id));
    const added = {}, skipped = {}, problems = [];
    for (const name of order) {
      const res = R.RESOURCES[name];
      added[name] = 0; skipped[name] = 0;
      const rows = Array.isArray(b[name]) ? b[name] : [];
      const have = new Set((await db.list(res.table)).map((x) => x.id));
      for (const r of rows) {
        try {
          if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 100 || /[\/\s]/.test(r.id)) throw new Error('bad id');
          if (have.has(r.id)) { skipped[name]++; continue; }
          const v = R.clean(res, r);
          if ((name === 'sales' || name === 'payments' || name === 'returns') && !known.has(v.customer_id)) throw new Error('customer missing');
          if (name === 'sales' && v.received > v.total) throw new Error('received > total');
          const row = { ...v, created_at: typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : new Date().toISOString() };
          if (name === 'payments' && r.saleId) row.sale_id = String(r.saleId);
          await db.insert(res.table, r.id, row);
          have.add(r.id);
          if (name === 'customers') known.add(r.id);
          added[name]++;
        } catch (e) { problems.push(`${name}: ${e.message}`); }
      }
    }
    return { ok: true, added, skipped, problems: problems.slice(0, 20), problemCount: problems.length };
  });

  /* ------------------------------ static files ------------------------------ */
  async function serveStatic(req, res, pathname) {
    let p;
    try { p = decodeURIComponent(pathname); } catch (_) { throw new HttpError(400, 'Bad URL'); }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.resolve(PUBLIC, '.' + p);
    if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, 'Not found');
    let st;
    try { st = await fs.promises.stat(file); } catch (_) { throw new HttpError(404, 'Not found'); }
    if (!st.isFile()) throw new HttpError(404, 'Not found');
    const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', ETag: etag, 'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
    await send(req, res, 200, await fs.promises.readFile(file), headers);
  }

  /* ------------------------------ dispatcher ------------------------------ */
  function secHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }

  async function handle(req, res) {
    secHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    if (!url.pathname.startsWith('/api/')) {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    }

    let hit = null, params = {};
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(url.pathname);
      if (m) { hit = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; }
    }
    if (!hit) throw new HttpError(404, 'Not found');

    if (method !== 'GET') { // basic CSRF guard on top of SameSite cookies
      const origin = req.headers.origin;
      if (origin) {
        let oh = '';
        try { oh = new URL(origin).host; } catch (_) { /* bad origin */ }
        if (oh !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked');
      }
    }
    const ctx = { req, res, params, url, query: Object.fromEntries(url.searchParams) };
    if (hit.auth) {
      ctx.user = readSession(req);
      if (!ctx.user) throw new HttpError(401, 'Please log in');
    }
    let out;
    try { out = await hit.handler(ctx); } finally { if (method !== 'GET') cache = null; }
    if (out === HANDLED) return;
    if (Array.isArray(out)) return sendJson(req, res, out[0], out[1], out[2] || {});
    return sendJson(req, res, 200, out);
  }

  async function safeHandle(req, res) {
    try {
      await handle(req, res);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      let status = 500, msg = 'Server error. Please try again.';
      if (e instanceof HttpError) { status = e.status; msg = e.message; }
      else {
        console.error('[error]', req.method, req.url, e && e.stack || e);
        const t = `${e && e.code} ${e && e.message}`;
        if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|timeout|terminating connection|57P03|UNAVAILABLE|DEADLINE_EXCEEDED/i.test(t)) {
          status = 503; msg = 'Database is not reachable right now. Please try again in a moment.';
        }
      }
      try { await sendJson(req, res, status, { error: msg }, status === 413 ? { Connection: 'close' } : {}); } catch (_) { res.destroy(); }
    }
  }

  return { handle: safeHandle, db };
}

/** Starts a normal, always-on Node server (Render, Railway, Fly.io, your own computer, ...). */
async function start({ port } = {}) {
  const app = await createApp();
  const server = http.createServer((req, res) => { app.handle(req, res); });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  await new Promise((resolve) => server.listen(port === undefined ? Number(process.env.PORT) || 3000 : port, '0.0.0.0', resolve));
  return { server, db: app.db, port: server.address().port, close: async () => { await new Promise((r) => server.close(r)); await app.db.close(); } };
}

if (require.main === module) {
  start().then((app) => {
    console.log(`Business Ledger running on port ${app.port} (database: ${app.db.kind})`);
    const stop = async () => { try { await app.close(); } finally { process.exit(0); } };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch((e) => {
    console.error('\nSTARTUP ERROR: ' + e.message + '\n');
    process.exit(1);
  });
}

module.exports = { start, createApp };
