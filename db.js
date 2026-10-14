'use strict';
/**
 * Database layer. One generic interface, three backends:
 *
 *   - PostgreSQL (DATABASE_URL set)                      -> permanent (Neon, Supabase, ...)
 *   - Firebase Firestore (FIREBASE_SERVICE_ACCOUNT set)   -> permanent, genuinely free forever (Spark plan, no card)
 *   - Local SQLite file (neither set)                     -> DEV/TEST ONLY, not persistent on free hosts
 *
 * All three expose the same small interface, so server.js never needs to know which one is active:
 *
 *   db.list(table)            -> [{ id, ...columns }]
 *   db.get(table, id)         -> { id, ...columns } | null
 *   db.insert(table, id, row) -> void   (row = plain object of column values, no "id")
 *   db.update(table, id, row) -> void   (full replace of the given columns)
 *   db.remove(table, id)      -> void
 *   db.attachments.listMeta() -> [{ id, owner_type, owner_id, name, mime, size, created_at }]  (no binary data)
 *   db.attachments.get(id)    -> { id, owner_type, owner_id, name, mime, data: Buffer } | null
 *   db.attachments.insert(row)-> void   (row.data is a Buffer)
 *   db.attachments.remove(id) -> void
 *   db.attachments.removeWhere(ownerType, ownerId) -> void
 *
 * Filtering/joins (e.g. "payments for this customer") are done in server.js with plain JS array
 * methods after list(). That is intentionally simple: a personal business ledger has, at most,
 * a few thousand rows, so a full read is fast and keeps all three backends easy to reason about.
 */
const fs = require('fs');
const path = require('path');

const TABLES = ['customers', 'income', 'expenses', 'sales', 'payments', 'returns', 'rp', 'bound', 'meta'];
// 'meta' holds internal bookkeeping (e.g. login-attempt counters) so they survive serverless cold starts.
const SERVERLESS = Boolean(process.env.NETLIFY || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

/* =============================================================================================
 * PostgreSQL (Neon, Supabase, Render Postgres, or any standard Postgres)
 * ========================================================================================== */
function createPg(rawUrl) {
  const { Pool } = require('pg');
  const qi = rawUrl.indexOf('?');
  const kept = qi === -1 ? [] : rawUrl.slice(qi + 1).split('&').filter((p) => p && !/^(sslmode|channel_binding)=/i.test(p));
  const url = (qi === -1 ? rawUrl : rawUrl.slice(0, qi)) + (kept.length ? '?' + kept.join('&') : '');
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
  const useSsl = process.env.DATABASE_SSL !== 'false' && !isLocal;
  const pool = new Pool({ connectionString: url, ssl: useSsl ? { rejectUnauthorized: false } : false, max: SERVERLESS ? 2 : 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 20000 });
  pool.on('error', (e) => console.error('[db] idle client error:', e.message));

  const q = (sql, params = []) => pool.query(sql, params).then((r) => r.rows);

  return {
    kind: 'postgres',
    async init() {
      for (const t of TABLES) await pool.query(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, doc JSONB NOT NULL)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        mime TEXT NOT NULL, size INTEGER NOT NULL, data BYTEA NOT NULL, created_at TEXT NOT NULL DEFAULT '')`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_att_owner ON attachments (owner_type, owner_id)');
    },
    async list(table) { const rows = await q(`SELECT id, doc FROM ${table}`); return rows.map((r) => ({ id: r.id, ...r.doc })); },
    async get(table, id) { const rows = await q(`SELECT id, doc FROM ${table} WHERE id = $1`, [id]); return rows.length ? { id: rows[0].id, ...rows[0].doc } : null; },
    async insert(table, id, row) { await pool.query(`INSERT INTO ${table} (id, doc) VALUES ($1, $2)`, [id, JSON.stringify(row)]); },
    async update(table, id, row) { await pool.query(`UPDATE ${table} SET doc = $2 WHERE id = $1`, [id, JSON.stringify(row)]); },
    async remove(table, id) { await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]); },
    attachments: {
      async listMeta() { return q('SELECT id, owner_type, owner_id, name, mime, size, created_at FROM attachments'); },
      async get(id) { const r = await q('SELECT id, owner_type, owner_id, name, mime, data FROM attachments WHERE id = $1', [id]); return r.length ? { ...r[0], data: Buffer.from(r[0].data) } : null; },
      async insert(row) { await pool.query('INSERT INTO attachments (id, owner_type, owner_id, name, mime, size, data, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [row.id, row.owner_type, row.owner_id, row.name, row.mime, row.size, row.data, row.created_at]); },
      async remove(id) { await pool.query('DELETE FROM attachments WHERE id = $1', [id]); },
      async removeWhere(ownerType, ownerId) { await pool.query('DELETE FROM attachments WHERE owner_type = $1 AND owner_id = $2', [ownerType, ownerId]); }
    },
    async close() { await pool.end(); }
  };
}

/* =============================================================================================
 * Firebase Firestore (Spark plan = free forever, no credit card)
 * NOTE: Firestore documents are capped at ~1 MiB, and Firebase Storage now requires the paid
 * Blaze plan, so attachments are stored *inside* Firestore documents as base64. server.js keeps
 * uploads well under that cap for this backend (see MAX_UPLOAD clamp in server.js).
 * ========================================================================================== */
function createFirestore() {
  const admin = require('firebase-admin');
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  let credential;
  try {
    credential = raw ? admin.credential.cert(JSON.parse(raw)) : admin.credential.applicationDefault();
  } catch (e) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole service-account key file contents, unchanged.');
  }
  const app = admin.initializeApp({ credential }, 'business-ledger-' + Date.now());
  const store = app.firestore();

  return {
    kind: 'firestore',
    async init() { await store.collection('customers').limit(1).get(); }, // connectivity check; collections are created implicitly
    async list(table) { const snap = await store.collection(table).get(); return snap.docs.map((d) => ({ id: d.id, ...d.data() })); },
    async get(table, id) { const doc = await store.collection(table).doc(id).get(); return doc.exists ? { id: doc.id, ...doc.data() } : null; },
    async insert(table, id, row) { await store.collection(table).doc(id).set(row); },
    async update(table, id, row) { await store.collection(table).doc(id).set(row); },
    async remove(table, id) { await store.collection(table).doc(id).delete(); },
    attachments: {
      async listMeta() {
        const snap = await store.collection('attachments').select('owner_type', 'owner_id', 'name', 'mime', 'size', 'created_at').get();
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      },
      async get(id) {
        const doc = await store.collection('attachments').doc(id).get();
        if (!doc.exists) return null;
        const x = doc.data();
        return { id: doc.id, owner_type: x.owner_type, owner_id: x.owner_id, name: x.name, mime: x.mime, data: Buffer.from(x.data, 'base64') };
      },
      async insert(row) {
        await store.collection('attachments').doc(row.id).set({ owner_type: row.owner_type, owner_id: row.owner_id, name: row.name, mime: row.mime, size: row.size, data: row.data.toString('base64'), created_at: row.created_at });
      },
      async remove(id) { await store.collection('attachments').doc(id).delete(); },
      async removeWhere(ownerType, ownerId) {
        const snap = await store.collection('attachments').where('owner_type', '==', ownerType).where('owner_id', '==', ownerId).select().get();
        await Promise.all(snap.docs.map((d) => d.ref.delete()));
      }
    },
    async close() { await app.delete(); }
  };
}

/* =============================================================================================
 * Local SQLite (development / automated tests only - Node's built-in driver, nothing to install)
 * ========================================================================================== */
function createSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const file = process.env.SQLITE_FILE || path.join(__dirname, 'data', 'ledger.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');

  return {
    kind: 'sqlite',
    async init() {
      for (const t of TABLES) db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
      db.exec(`CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL DEFAULT '')`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_att_owner ON attachments (owner_type, owner_id)');
    },
    async list(table) { return db.prepare(`SELECT id, doc FROM ${table}`).all().map((r) => ({ id: r.id, ...JSON.parse(r.doc) })); },
    async get(table, id) { const r = db.prepare(`SELECT id, doc FROM ${table} WHERE id = ?1`).get(id); return r ? { id: r.id, ...JSON.parse(r.doc) } : null; },
    async insert(table, id, row) { db.prepare(`INSERT INTO ${table} (id, doc) VALUES (?1, ?2)`).run(id, JSON.stringify(row)); },
    async update(table, id, row) { db.prepare(`UPDATE ${table} SET doc = ?2 WHERE id = ?1`).run(id, JSON.stringify(row)); },
    async remove(table, id) { db.prepare(`DELETE FROM ${table} WHERE id = ?1`).run(id); },
    attachments: {
      async listMeta() { return db.prepare('SELECT id, owner_type, owner_id, name, mime, size, created_at FROM attachments').all().map((r) => ({ ...r })); },
      async get(id) { const r = db.prepare('SELECT id, owner_type, owner_id, name, mime, data FROM attachments WHERE id = ?1').get(id); return r ? { ...r, data: Buffer.from(r.data) } : null; },
      async insert(row) { db.prepare('INSERT INTO attachments (id, owner_type, owner_id, name, mime, size, data, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)').run(row.id, row.owner_type, row.owner_id, row.name, row.mime, row.size, row.data, row.created_at); },
      async remove(id) { db.prepare('DELETE FROM attachments WHERE id = ?1').run(id); },
      async removeWhere(ownerType, ownerId) { db.prepare('DELETE FROM attachments WHERE owner_type = ?1 AND owner_id = ?2').run(ownerType, ownerId); }
    },
    async close() { db.close(); }
  };
}

function createDb() {
  const hasPg = Boolean(process.env.DATABASE_URL);
  const hasFirebase = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (hasPg && hasFirebase) throw new Error('Set only ONE of DATABASE_URL or FIREBASE_SERVICE_ACCOUNT, not both.');
  if (hasPg) return createPg(process.env.DATABASE_URL);
  if (hasFirebase) return createFirestore();
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_LOCAL_DB !== 'true') {
    throw new Error(
      'No database configured. Refusing to start in production with a local file database, because your ' +
      'data would be lost on the next restart/redeploy. Set DATABASE_URL (Postgres) or FIREBASE_SERVICE_ACCOUNT (Firestore).'
    );
  }
  console.warn('[db] No DATABASE_URL / FIREBASE_SERVICE_ACCOUNT -> using LOCAL SQLite file (development only, not persistent on free hosts).');
  return createSqlite();
}

module.exports = { createDb, TABLES };
