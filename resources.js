'use strict';
/**
 * One place that defines every record type: API key <-> DB column, type, limits.
 * The server validates everything here, so a bad client can never write junk to the database.
 */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const F = (key, col, type, o = {}) => ({ key, col, type, ...o });

const METHODS = ['Cash', 'Bank Transfer', 'Online', 'Cheque', 'Other', 'Sale Payment'];

const RESOURCES = {
  customers: {
    table: 'customers', ownerType: 'customer',
    fields: [
      F('name', 'name', 'str', { required: true, max: 200 }),
      F('phone', 'phone', 'str', { max: 60 }),
      F('address', 'address', 'str', { max: 400 }),
      F('notes', 'notes', 'str', { max: 4000 })
    ]
  },
  income: {
    table: 'income', ownerType: 'income',
    fields: [
      F('date', 'entry_date', 'date', { required: true }),
      F('amount', 'amount', 'num', { required: true, min: 0.01 }),
      F('from', 'from_name', 'str', { required: true, max: 200 }),
      F('source', 'source', 'str', { max: 100 }),
      F('method', 'method', 'str', { max: 60 }),
      F('reference', 'ref_no', 'str', { max: 200 }),
      F('description', 'description', 'str', { max: 1000 }),
      F('notes', 'notes', 'str', { max: 4000 })
    ]
  },
  expenses: {
    table: 'expenses', ownerType: 'expense',
    fields: [
      F('date', 'entry_date', 'date', { required: true }),
      F('amount', 'amount', 'num', { required: true, min: 0.01 }),
      F('paidTo', 'paid_to', 'str', { required: true, max: 200 }),
      F('category', 'category', 'str', { max: 100 }),
      F('method', 'method', 'str', { max: 60 }),
      F('reference', 'ref_no', 'str', { max: 200 }),
      F('description', 'description', 'str', { max: 1000 }),
      F('notes', 'notes', 'str', { max: 4000 })
    ]
  },
  sales: {
    table: 'sales', ownerType: 'sale',
    fields: [
      F('customerId', 'customer_id', 'str', { required: true, max: 100 }),
      F('date', 'entry_date', 'date', { required: true }),
      F('total', 'total', 'num', { required: true, min: 0.01 }),
      F('received', 'received', 'num', { min: 0, default: 0 }),
      F('description', 'description', 'str', { max: 1000 }),
      F('notes', 'notes', 'str', { max: 4000 })
    ]
  },
  payments: {
    table: 'payments', ownerType: 'payment',
    fields: [
      F('customerId', 'customer_id', 'str', { required: true, max: 100 }),
      F('date', 'entry_date', 'date', { required: true }),
      F('amount', 'amount', 'num', { required: true, min: 0.01 }),
      F('method', 'method', 'str', { max: 60 }),
      F('reference', 'ref_no', 'str', { max: 200 }),
      F('description', 'description', 'str', { max: 1000 })
    ],
    readOnlyExtra: [F('saleId', 'sale_id', 'str')]
  },
  returns: {
    table: 'returns', ownerType: 'return',
    fields: [
      F('customerId', 'customer_id', 'str', { required: true, max: 100 }),
      F('date', 'entry_date', 'date', { required: true }),
      F('amount', 'amount', 'num', { required: true, min: 0.01 }),
      F('description', 'description', 'str', { required: true, max: 1000 }),
      F('quantity', 'quantity', 'str', { max: 100 }),
      F('reason', 'reason', 'str', { max: 1000 }),
      F('notes', 'notes', 'str', { max: 4000 })
    ]
  },
  bound: {
    table: 'bound', ownerType: 'bound',
    fields: [
      F('date', 'entry_date', 'date', { required: true }),
      F('amount', 'amount', 'num', { required: true, min: 0.01 }),
      F('customer', 'customer', 'str', { required: true, max: 200 }),
      F('item', 'item', 'str', { required: true, max: 300 }),
      F('status', 'status', 'enum', { values: ['Pending', 'Recovered'], default: 'Pending' }),
      F('recoveryDate', 'recovery_date', 'optdate'),
      F('note', 'note', 'str', { max: 4000 })
    ]
  }
};

const OWNER_TYPES = Object.values(RESOURCES).map((r) => r.ownerType);
const OWNER_TABLE = Object.fromEntries(Object.values(RESOURCES).map((r) => [r.ownerType, r.table]));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
// Exponent-shift avoids float artefacts such as 1.005*100 = 100.49999999999999
const round2 = (n) => {
  const s = String(n);
  return s.includes('e') ? Math.round(n * 100) / 100 : Number(Math.round(s + 'e2') + 'e-2');
};

/** Validate + normalise a request body -> { col: value } */
function clean(res, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request body');
  const out = {};
  for (const f of res.fields) {
    let v = body[f.key];
    const missing = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (missing) {
      if (f.required) throw new HttpError(400, `"${f.key}" is required`);
      v = f.default !== undefined ? f.default : '';
    }
    switch (f.type) {
      case 'str':
        v = String(v).trim();
        if (f.max && v.length > f.max) throw new HttpError(400, `"${f.key}" is too long (max ${f.max})`);
        break;
      case 'num': {
        v = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(v)) throw new HttpError(400, `"${f.key}" must be a number`);
        if (f.min !== undefined && v < f.min) throw new HttpError(400, `"${f.key}" must be at least ${f.min}`);
        if (Math.abs(v) > 1e12) throw new HttpError(400, `"${f.key}" is too large`);
        v = round2(v);
        break;
      }
      case 'date':
        v = String(v);
        if (!validDate(v)) throw new HttpError(400, `"${f.key}" must be a valid date (YYYY-MM-DD)`);
        break;
      case 'optdate':
        v = String(v);
        if (v !== '' && !validDate(v)) throw new HttpError(400, `"${f.key}" must be a valid date (YYYY-MM-DD)`);
        break;
      case 'enum':
        v = String(v);
        if (!f.values.includes(v)) throw new HttpError(400, `"${f.key}" must be one of: ${f.values.join(', ')}`);
        break;
    }
    out[f.col] = v;
  }
  return out;
}

/** DB row -> API object */
function toApi(res, row) {
  const o = { id: row.id, createdAt: row.created_at };
  for (const f of res.fields) o[f.key] = f.type === 'num' ? Number(row[f.col]) : row[f.col];
  for (const f of res.readOnlyExtra || []) o[f.key] = row[f.col] || null;
  return o;
}

function attToApi(r) {
  return { id: r.id, ownerType: r.owner_type, ownerId: r.owner_id, name: r.name, mime: r.mime, size: Number(r.size), createdAt: r.created_at };
}

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);
function allowedMime(m) {
  m = String(m || '').toLowerCase().split(';')[0].trim();
  return IMAGE_MIME.has(m) || /^audio\/[a-z0-9.+-]+$/.test(m);
}

module.exports = { RESOURCES, OWNER_TYPES, OWNER_TABLE, HttpError, clean, toApi, attToApi, allowedMime, METHODS, validDate };
