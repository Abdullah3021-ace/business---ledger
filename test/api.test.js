'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
process.env.SQLITE_FILE = path.join(tmp, 'test.db');
process.env.ADMIN_USERNAME = 'owner';
process.env.ADMIN_PASSWORD = 'secret-pass-123';
process.env.MAX_UPLOAD_MB = '1';
delete process.env.DATABASE_URL;
delete process.env.NODE_ENV;

const { start } = require('../server');
let app, base, cookie;

async function call(method, url, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie && !opts.noCookie) headers.cookie = cookie;
  let payload = body;
  if (body !== undefined && !Buffer.isBuffer(body)) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers, body: payload });
  const type = r.headers.get('content-type') || '';
  const data = type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  app = await start({ port: 0 });
  base = 'http://127.0.0.1:' + app.port;
});
after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('health is public and reports the database', async () => {
  const r = await call('GET', '/api/health', undefined, { noCookie: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('API is locked without login', async () => {
  for (const [m, u] of [['GET', '/api/data'], ['POST', '/api/income'], ['GET', '/api/export'], ['GET', '/api/attachments/x']]) {
    const r = await call(m, u, m === 'POST' ? {} : undefined, { noCookie: true });
    assert.equal(r.status, 401, `${m} ${u}`);
  }
});

test('login: wrong password rejected, right password sets a session cookie', async () => {
  let r = await call('POST', '/api/login', { username: 'owner', password: 'nope' }, { noCookie: true });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/login', { username: 'owner', password: 'secret-pass-123' }, { noCookie: true });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  cookie = sc.split(';')[0];
  r = await call('GET', '/api/session');
  assert.equal(r.status, 200);
  assert.equal(r.data.user, 'owner');
});

test('tampered session cookie is rejected', async () => {
  const bad = cookie.slice(0, -3) + 'AAA';
  const r = await fetch(base + '/api/data', { headers: { cookie: bad } });
  assert.equal(r.status, 401);
});

test('income: create, validate, update, list', async () => {
  let r = await call('POST', '/api/income', { date: '2026-09-19', amount: '2500.555', from: 'Ali', method: 'Cash' });
  assert.equal(r.status, 201);
  assert.equal(r.data.amount, 2500.56);
  const id = r.data.id;

  assert.equal((await call('POST', '/api/income', { date: '2026-09-19', from: 'X' })).status, 400); // amount missing
  assert.equal((await call('POST', '/api/income', { date: '2026-13-45', amount: 5, from: 'X' })).status, 400); // bad date
  assert.equal((await call('POST', '/api/income', { date: '2026-09-19', amount: -5, from: 'X' })).status, 400); // negative
  assert.equal((await call('POST', '/api/income', { date: '2026-09-19', amount: 'abc', from: 'X' })).status, 400);

  r = await call('PUT', '/api/income/' + id, { date: '2026-09-18', amount: 3000, from: 'Ali Traders', source: 'Service' });
  assert.equal(r.status, 200);
  assert.equal(r.data.from, 'Ali Traders');
  assert.equal((await call('PUT', '/api/income/nope', { date: '2026-09-18', amount: 1, from: 'x' })).status, 404);

  r = await call('GET', '/api/data');
  assert.equal(r.data.income.length, 1);
  assert.equal(r.data.income[0].amount, 3000);
  await call('DELETE', '/api/income/' + id);
});

test('sales create/update/delete keep the linked payment in sync', async () => {
  const cust = (await call('POST', '/api/customers', { name: 'Bilal Store', phone: '0312' })).data;

  let r = await call('POST', '/api/sales', { customerId: cust.id, date: '2026-09-19', total: 10000, received: 4000, description: '5 x A' });
  assert.equal(r.status, 201);
  const sale = r.data;
  let d = (await call('GET', '/api/data')).data;
  assert.equal(d.payments.length, 1);
  assert.equal(d.payments[0].amount, 4000);
  assert.equal(d.payments[0].saleId, sale.id);

  assert.equal((await call('POST', '/api/sales', { customerId: cust.id, date: '2026-09-19', total: 100, received: 500 })).status, 400); // over-received
  assert.equal((await call('POST', '/api/sales', { customerId: 'ghost', date: '2026-09-19', total: 100 })).status, 400);

  r = await call('PUT', '/api/sales/' + sale.id, { customerId: cust.id, date: '2026-09-19', total: 10000, received: 6000 });
  assert.equal(r.status, 200);
  d = (await call('GET', '/api/data')).data;
  assert.equal(d.payments.length, 1);
  assert.equal(d.payments[0].amount, 6000);

  // a linked payment can't be edited directly (edit the sale), but it CAN be deleted: the sale then has nothing received
  assert.equal((await call('PUT', '/api/payments/' + d.payments[0].id, { customerId: cust.id, date: '2026-09-19', amount: 1 })).status, 400);

  // received -> 0 removes the linked payment
  await call('PUT', '/api/sales/' + sale.id, { customerId: cust.id, date: '2026-09-19', total: 10000, received: 0 });
  d = (await call('GET', '/api/data')).data;
  assert.equal(d.payments.length, 0);

  // standalone payment works and is editable
  r = await call('POST', '/api/payments', { customerId: cust.id, date: '2026-09-20', amount: 1500, method: 'Cash' });
  assert.equal(r.status, 201);
  assert.equal((await call('PUT', '/api/payments/' + r.data.id, { customerId: cust.id, date: '2026-09-20', amount: 1600 })).data.amount, 1600);

  // deleting the sale removes its payments; deleting the customer removes everything
  await call('PUT', '/api/sales/' + sale.id, { customerId: cust.id, date: '2026-09-19', total: 10000, received: 2000 });
  assert.equal((await call('DELETE', '/api/sales/' + sale.id)).status, 200);
  d = (await call('GET', '/api/data')).data;
  assert.equal(d.sales.length, 0);
  assert.equal(d.payments.length, 1); // only the standalone one remains
  assert.equal((await call('DELETE', '/api/customers/' + cust.id)).status, 200);
  d = (await call('GET', '/api/data')).data;
  assert.equal(d.customers.length, 0);
  assert.equal(d.payments.length, 0);
});

test('attachments: upload, range playback, type/size limits, replace, delete', async () => {
  const inc = (await call('POST', '/api/income', { date: '2026-09-19', amount: 100, from: 'A' })).data;
  const other = (await call('POST', '/api/income', { date: '2026-09-19', amount: 200, from: 'B' })).data;
  const up = (owner, mime, buf, extra = '') => call('POST', `/api/attachments?ownerType=income&ownerId=${owner}&name=receipt.png${extra}`, buf, { headers: { 'content-type': mime } });

  let r = await up(inc.id, 'image/png', PNG);
  assert.equal(r.status, 201);
  const attId = r.data.id;
  await up(other.id, 'image/png', PNG);

  r = await call('GET', '/api/attachments/' + attId);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, PNG);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('content-security-policy'), /sandbox/);

  r = await call('GET', '/api/attachments/' + attId, undefined, { headers: { range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.equal(r.data.length, 10);
  assert.match(r.headers.get('content-range'), new RegExp(`^bytes 0-9/${PNG.length}$`));

  assert.equal((await up(inc.id, 'image/svg+xml', Buffer.from('<svg/>'))).status, 415);
  assert.equal((await up(inc.id, 'text/html', Buffer.from('<script>'))).status, 415);
  assert.equal((await up(inc.id, 'audio/webm', Buffer.from('fake-audio-bytes'))).status, 201);
  assert.equal((await up('missing', 'image/png', PNG)).status, 404);
  assert.equal((await call('POST', '/api/attachments?ownerType=evil&ownerId=1&name=x', PNG, { headers: { 'content-type': 'image/png' } })).status, 400);
  assert.equal((await up(inc.id, 'image/png', Buffer.alloc(1.5 * 1024 * 1024, 1))).status, 413); // MAX_UPLOAD_MB=1

  let d = (await call('GET', '/api/data')).data;
  assert.equal(d.attachments.filter((a) => a.ownerId === inc.id).length, 2);
  assert.ok(d.meta.attachmentBytes > 0);

  // replace=1 keeps exactly one (used for customer profile photos)
  await up(inc.id, 'image/png', PNG, '&replace=1');
  d = (await call('GET', '/api/data')).data;
  assert.equal(d.attachments.filter((a) => a.ownerId === inc.id).length, 1);

  // REGRESSION (bug in old prototype): deleting one entry must not wipe other entries' attachments
  await call('DELETE', '/api/income/' + inc.id);
  d = (await call('GET', '/api/data')).data;
  assert.equal(d.attachments.filter((a) => a.ownerId === inc.id).length, 0);
  assert.equal(d.attachments.filter((a) => a.ownerId === other.id).length, 1);

  const keep = d.attachments.find((a) => a.ownerId === other.id);
  assert.equal((await call('DELETE', '/api/attachments/' + keep.id)).status, 200);
  assert.equal((await call('GET', '/api/attachments/' + keep.id)).status, 404);
  await call('DELETE', '/api/income/' + other.id);
});

test('bound + expenses + export', async () => {
  let r = await call('POST', '/api/bound', { date: '2026-09-19', amount: 7000, customer: 'Usman', item: 'Steel', status: 'Pending', recoveryDate: '2026-10-01' });
  assert.equal(r.status, 201);
  assert.equal((await call('POST', '/api/bound', { date: '2026-09-19', amount: 7000, customer: 'U', item: 'S', status: 'Weird' })).status, 400);
  r = await call('POST', '/api/expenses', { date: '2026-09-19', amount: 850, paidTo: 'Supplier', category: 'Inventory' });
  assert.equal(r.status, 201);

  r = await call('GET', '/api/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="ledger-backup-\d{4}-\d{2}-\d{2}\.json"/);
  assert.equal(r.data.bound.length, 1);
  assert.equal(r.data.expenses.length, 1);
});

test('security: static traversal blocked, cross-site writes blocked, HTML is served', async () => {
  let r = await call('GET', '/', undefined, { noCookie: true });
  assert.equal(r.status, 200);
  assert.match(r.data.toString(), /Business Ledger/);

  const raw = (p, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: p, method, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(method === 'POST' ? '{}' : undefined);
  });
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/%2e%2e%2f%2e%2e%2fetc/passwd']) {
    const x = await raw(p);
    assert.ok(x.status === 404 || x.status === 400, `${p} -> ${x.status}`);
    assert.doesNotMatch(x.body, /createServer|root:/);
  }
  const x = await raw('/api/income', { cookie, origin: 'http://evil.example', 'content-type': 'application/json' }, 'POST');
  assert.equal(x.status, 403);
});

test('data cache is cleared by every write (dashboard never shows stale numbers)', async () => {
  const a = (await call('GET', '/api/data')).data;
  await call('POST', '/api/income', { date: '2026-09-20', amount: 123, from: 'Cache check' });
  const b = (await call('GET', '/api/data')).data;
  assert.equal(b.income.length, a.income.length + 1);
  const id = b.income.find((x) => x.from === 'Cache check').id;
  await call('DELETE', '/api/income/' + id);
  assert.equal((await call('GET', '/api/data')).data.income.length, a.income.length);
});

test('restore: missing entries come back, existing ones are untouched, bad files are rejected', async () => {
  let r = await call('POST', '/api/customers', { name: 'Restore Me' });
  const cid = r.data.id;
  r = await call('POST', '/api/sales', { customerId: cid, date: '2026-09-21', total: 1000, received: 400 });
  assert.equal(r.status, 201);
  const backup = (await call('GET', '/api/export')).data;

  await call('DELETE', '/api/customers/' + cid); // cascades: sale + its payment vanish
  let d = (await call('GET', '/api/data')).data;
  assert.equal(d.customers.some((c) => c.id === cid), false);

  r = await call('POST', '/api/import', backup);
  assert.equal(r.status, 200);
  assert.ok(r.data.added.customers >= 1 && r.data.added.sales >= 1 && r.data.added.payments >= 1);
  d = (await call('GET', '/api/data')).data;
  assert.ok(d.customers.some((c) => c.id === cid));
  const pay = d.payments.find((p) => p.customerId === cid);
  assert.equal(pay.amount, 400);
  assert.ok(pay.saleId, 'restored payment is still linked to its sale');

  r = await call('POST', '/api/import', backup); // second time: nothing new
  assert.equal(Object.values(r.data.added).reduce((x, y) => x + y, 0), 0);

  assert.equal((await call('POST', '/api/import', { hello: 'world' })).status, 400);
  const evil = { app: 'business-ledger', sales: [{ id: 'x1', customerId: 'nope', date: '2026-01-01', total: 5 }], income: [{ id: 'bad id', date: '2026-01-01', amount: 5, from: 'x' }] };
  r = await call('POST', '/api/import', evil);
  assert.equal(r.data.problemCount, 2);
});

test('returns: validated, stored, cascade-deleted, backed up; linked payment can be deleted on its own', async () => {
  let r = await call('POST', '/api/customers', { name: 'Return Customer' });
  const cid = r.data.id;
  r = await call('POST', '/api/sales', { customerId: cid, date: '2026-10-01', total: 5000, received: 1000, description: '10 x Chair' });
  const saleId = r.data.id;

  // validation
  assert.equal((await call('POST', '/api/returns', { customerId: cid, date: '2026-10-02', amount: 100 })).status, 400, 'items description required');
  assert.equal((await call('POST', '/api/returns', { customerId: cid, date: '2026-10-02', amount: 0, description: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/returns', { customerId: 'nope', date: '2026-10-02', amount: 10, description: 'x' })).status, 400);

  r = await call('POST', '/api/returns', { customerId: cid, date: '2026-10-03', amount: 1500, description: '3 x Chair', quantity: '3 pcs', reason: 'Damaged', notes: 'scratched' });
  assert.equal(r.status, 201);
  const retId = r.data.id;
  assert.equal(r.data.quantity, '3 pcs');
  assert.equal(r.data.reason, 'Damaged');
  let d = (await call('GET', '/api/data')).data;
  assert.equal(d.returns.length >= 1, true);

  // edit
  r = await call('PUT', '/api/returns/' + retId, { customerId: cid, date: '2026-10-03', amount: 2000, description: '4 x Chair', quantity: '4 pcs', reason: 'Damaged' });
  assert.equal(r.status, 200);
  assert.equal(r.data.amount, 2000);

  // attachment on a return
  r = await call('POST', `/api/attachments?ownerType=return&ownerId=${retId}&name=p.png`, PNG, { headers: { 'content-type': 'image/png' } });
  assert.equal(r.status, 201);

  // export contains returns; delete customer removes them and their attachments
  const backup = (await call('GET', '/api/export')).data;
  assert.ok(backup.returns.some((x) => x.id === retId));

  // linked payment (received with the sale) can be deleted alone -> sale.received back to 0
  d = (await call('GET', '/api/data')).data;
  const pay = d.payments.find((p) => p.saleId === saleId);
  assert.ok(pay);
  assert.equal((await call('DELETE', '/api/payments/' + pay.id)).status, 200);
  d = (await call('GET', '/api/data')).data;
  assert.equal(d.payments.some((p) => p.saleId === saleId), false);
  assert.equal(d.sales.find((x) => x.id === saleId).received, 0);
  // editing a linked payment directly is still blocked (edit the sale instead)
  // (re-save the sale with a received amount -> a new linked payment appears)
  r = await call('PUT', '/api/sales/' + saleId, { customerId: cid, date: '2026-10-01', total: 5000, received: 700 });
  assert.equal(r.status, 200);
  d = (await call('GET', '/api/data')).data;
  const pay2 = d.payments.find((p) => p.saleId === saleId);
  assert.equal(pay2.amount, 700);
  assert.equal((await call('PUT', '/api/payments/' + pay2.id, { customerId: cid, date: '2026-10-01', amount: 1 })).status, 400);

  // delete one return alone
  assert.equal((await call('DELETE', '/api/returns/' + retId)).status, 200);
  d = (await call('GET', '/api/data')).data;
  assert.equal(d.returns.some((x) => x.id === retId), false);
  assert.equal(d.attachments.some((a) => a.ownerId === retId), false);

  // restore brings returns back
  r = await call('POST', '/api/import', backup);
  assert.equal(r.status, 200);
  assert.ok(r.data.added.returns >= 1);
  d = (await call('GET', '/api/data')).data;
  assert.ok(d.returns.some((x) => x.id === retId));

  // deleting the customer removes the returns too
  await call('DELETE', '/api/customers/' + cid);
  d = (await call('GET', '/api/data')).data;
  assert.equal(d.returns.some((x) => x.customerId === cid), false);
});

test('RP: Wax/Designing money entries are validated, kept per account, backed up, cascade-deleted', async () => {
  let r = await call('POST', '/api/customers', { name: 'RP Customer' });
  const cid = r.data.id;
  const base = { customerId: cid, date: '2026-10-05', amount: 2500 };
  assert.equal((await call('POST', '/api/rp', { ...base })).status, 400, 'kind required');
  assert.equal((await call('POST', '/api/rp', { ...base, kind: 'Other' })).status, 400);
  assert.equal((await call('POST', '/api/rp', { ...base, kind: 'Wax', amount: 0 })).status, 400);
  assert.equal((await call('POST', '/api/rp', { ...base, kind: 'Wax', customerId: 'nope' })).status, 400);
  r = await call('POST', '/api/rp', { ...base, kind: 'Wax', description: 'advance' });
  assert.equal(r.status, 201);
  const wid = r.data.id;
  assert.equal((await call('POST', '/api/rp', { ...base, kind: 'Designing', amount: 1000 })).status, 201);
  assert.equal((await call('POST', '/api/rp', { ...base, kind: 'Wax', entry: 'Bad' })).status, 400);
  r = await call('POST', '/api/rp', { ...base, kind: 'Wax', entry: 'Sale', amount: 9000, description: '5 kg wax' });
  assert.equal(r.status, 201);
  assert.equal(r.data.entry, 'Sale');
  let d = (await call('GET', '/api/data')).data;
  const mine = d.rp.filter((x) => x.customerId === cid);
  assert.equal(mine.filter((x) => x.kind === 'Wax' && x.entry === 'Payment').reduce((a, x) => a + x.amount, 0), 2500);
  assert.equal(mine.filter((x) => x.kind === 'Wax' && x.entry === 'Sale').reduce((a, x) => a + x.amount, 0), 9000);
  assert.equal(mine.filter((x) => x.kind === 'Designing').reduce((a, x) => a + x.amount, 0), 1000);
  assert.equal((await call('PUT', '/api/rp/' + wid, { ...base, kind: 'Wax', amount: 3000 })).status, 200);
  const backup = (await call('GET', '/api/export')).data;
  assert.ok(backup.rp && backup.rp.length >= 2);
  assert.equal((await call('DELETE', '/api/rp/' + wid)).status, 200);
  r = await call('POST', '/api/import', backup);
  assert.equal(r.status, 200);
  d = (await call('GET', '/api/data')).data;
  assert.ok(d.rp.some((x) => x.id === wid));
  await call('DELETE', '/api/customers/' + cid);
  d = (await call('GET', '/api/data')).data;
  assert.equal(d.rp.some((x) => x.customerId === cid), false);
});

test('login is rate limited after repeated failures', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await call('POST', '/api/login', { username: 'owner', password: 'wrong' + i }, { noCookie: true });
  assert.equal(last.status, 429);
  // the counter lives in the database, so it survives a restart (important on serverless hosts)
  await app.close();
  app = await start({ port: 0 });
  base = 'http://127.0.0.1:' + app.port;
  const again = await call('POST', '/api/login', { username: 'owner', password: 'secret-pass-123' }, { noCookie: true });
  assert.equal(again.status, 429);
});

test('data persists across a server restart (same database)', async () => {
  await call('POST', '/api/customers', { name: 'Persistent Customer' });
  const before = (await call('GET', '/api/data')).data;
  await app.close();
  app = await start({ port: 0 });
  base = 'http://127.0.0.1:' + app.port;
  // the same cookie still works because the session secret is derived from the password
  const after = (await call('GET', '/api/data')).data;
  assert.deepEqual(after.customers.map((c) => c.name), before.customers.map((c) => c.name));
  assert.ok(after.customers.some((c) => c.name === 'Persistent Customer'));
});
