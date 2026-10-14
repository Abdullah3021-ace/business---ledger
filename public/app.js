'use strict';
(() => {
  /* ============================ tiny helpers ============================ */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round2 = (n) => { n = Number(n) || 0; const s = String(n); return s.includes('e') ? Math.round(n * 100) / 100 : Number(Math.round(s + 'e2') + 'e-2'); };
  const sum = (arr, f) => round2(arr.reduce((s, x) => s + (Number(f(x)) || 0), 0));
  const money = (n) => 'Rs ' + round2(n).toLocaleString('en-PK', { maximumFractionDigits: 2 });
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }; // local date, not UTC
  const dateFmt = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
  const initials = (n) => (n || '?').split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
  const bytesFmt = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const byNewest = (a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt));

  const svg = (inner) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const ICON = {
    dashboard: svg('<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>'),
    income: svg('<path d="M17 7 7 17"/><path d="M17 17H7V7"/>'),
    expense: svg('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>'),
    users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    lock: svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    settings: svg('<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>'),
    plus: svg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
    x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    clip: svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>')
  };

  /* ================================ API ================================= */
  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

  async function readError(r) {
    let msg = 'Something went wrong (' + r.status + ')';
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (_) { /* not json */ }
    return msg;
  }
  async function api(method, url, body, opts = {}) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(url, init); } catch (_) { throw new ApiError(0, 'No connection to the server. Check your internet and try again.'); }
    if (r.status === 401 && !opts.noRedirect) { showLogin('Session expired. Please sign in again.'); throw new ApiError(401, 'Please sign in again'); }
    if (!r.ok) throw new ApiError(r.status, await readError(r));
    return r.json();
  }

  /* ================================ state =============================== */
  const S = {
    d: null, att: {}, route: { page: 'dashboard', id: null }, lastLoad: 0,
    f: { dash: 'all', income: { q: '', p: 'all' }, expenses: { q: '', p: 'all' }, bound: { q: '', p: 'all' }, customers: { q: '', s: 'name' } }
  };

  async function load() {
    S.d = await api('GET', '/api/data');
    S.att = {};
    for (const a of S.d.attachments) (S.att[a.ownerType + ':' + a.ownerId] ||= []).push(a);
    S.lastLoad = Date.now();
  }
  const atts = (type, id) => S.att[type + ':' + id] || [];
  // Balance is ALWAYS all-time: everything sold, minus goods returned, minus money received. Never limited to a period.
  const RP_KINDS = ['Wax', 'Designing'];
  const rpRows = (cid, kind) => S.d.rp.filter((x) => x.customerId === cid && (!kind || x.kind === kind));
  const rpSum = (cid, kind) => sum(rpRows(cid, kind), (x) => x.amount);
  const custRet = (id) => sum(S.d.returns.filter((x) => x.customerId === id), (x) => x.amount);
  const custBal = (id) => round2(sum(S.d.sales.filter((x) => x.customerId === id), (x) => x.total) - custRet(id) - sum(S.d.payments.filter((x) => x.customerId === id), (x) => x.amount));
  const balLabel = (b) => (b > 0 ? money(b) : b < 0 ? money(-b) + ' advance' : money(0));
  function downloadCsv(filename, header, rows) {
    const q = (v) => { v = String(v ?? ''); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const text = '\ufeff' + [header, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = filename; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const custName = (id) => (S.d.customers.find((c) => c.id === id) || {}).name || 'Unknown';

  function inPeriod(date, p) {
    if (p === 'all') return true;
    const d = new Date(date + 'T00:00:00'), now = new Date();
    if (p === 'year') return d.getFullYear() === now.getFullYear();
    if (p === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    const mon = new Date(now); mon.setHours(0, 0, 0, 0); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return d >= mon;
  }

  /* ============================== UI pieces ============================= */
  const main = () => $('#main');
  const header = (title, sub, buttons = '') => `<div class="top"><div class="title"><h1>${esc(title)}</h1><p>${esc(sub)}</p></div><div class="actions">${buttons}</div></div>`;
  const periodSel = (key, val) => `<select class="sel" data-filter="${key}" aria-label="Time period">${[['all', 'All Data'], ['week', 'This Week'], ['month', 'This Month'], ['year', 'This Year']].map(([v, l]) => `<option value="${v}"${val === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const addBtn = (label, attrs) => `<button class="btn" ${attrs}>${ICON.plus}<span>${label}</span></button>`;
  const metric = (label, value, cls = '') => `<div class="card"><div class="label">${label}</div><div class="metric ${cls}">${value}</div></div>`;
  const attBadge = (type, id) => { const n = atts(type, id).length; return n ? `<span class="badge">${ICON.clip}${n}</span>` : ''; };

  function toast(msg, type = 'ok') {
    $$('#toasts .toast').forEach((x) => x.remove()); // one toast at a time
    const t = document.createElement('div');
    t.className = 'toast ' + type; t.textContent = msg;
    $('#toasts').append(t);
    setTimeout(() => t.classList.add('out'), type === 'error' ? 5200 : 2600);
    setTimeout(() => t.remove(), type === 'error' ? 5600 : 3000);
  }

  function attHTML(a, editable) {
    const del = editable ? `<button type="button" class="att-del" data-action="del-att" data-id="${a.id}" aria-label="Remove attachment">${ICON.x}</button>` : '';
    if (a.mime.startsWith('audio/')) return `<div class="att audio"><audio controls preload="none" src="/api/attachments/${a.id}"></audio><div class="att-name">${esc(a.name)}</div>${del}</div>`;
    return `<div class="att"><img class="thumb" loading="lazy" alt="${esc(a.name)}" src="/api/attachments/${a.id}" data-action="view-img" data-id="${a.id}">${del}</div>`;
  }
  const attBlock = (type, id, editable) => { const l = atts(type, id); return l.length ? `<div class="attachments">${l.map((a) => attHTML(a, editable)).join('')}</div>` : ''; };
  const avatarHTML = (c) => { const a = atts('customer', c.id)[0]; return `<div class="avatar">${a ? `<img src="/api/attachments/${a.id}" alt="">` : esc(initials(c.name))}</div>`; };

  /* ========================= entity configuration ======================= */
  const METHODS = ['Cash', 'Bank Transfer', 'Online', 'Cheque', 'Other'];
  const CFG = {
    income: {
      ownerType: 'income', title: 'Income', sub: 'Record and retrieve all money coming into the business', addLabel: 'Add Income',
      search: 'Search source, reference, description...', empty: 'No income entries found.', amountKey: 'amount',
      formTitle: (id) => (id ? 'Income Details' : 'Add Income'), saveLabel: 'Save Income',
      cols: [['Date', (r) => dateFmt(r.date)], ['From', (r) => esc(r.from)], ['Source', (r) => esc(r.source)], ['Amount', (r) => `<b>${money(r.amount)}</b>`], ['Payment', (r) => esc(r.method)], ['Files', (r) => attBadge('income', r.id)]],
      fields: [
        { n: 'date', l: 'Date', t: 'date', req: 1 }, { n: 'amount', l: 'Amount (Rs)', t: 'number', req: 1 },
        { n: 'from', l: 'Received From', t: 'text', req: 1 },
        { n: 'source', l: 'Income Source', t: 'select', o: ['Service', 'Bank Transfer', 'Online Payment', 'Refund', 'Owner Capital', 'Other'] },
        { n: 'method', l: 'Payment Method', t: 'select', o: METHODS }, { n: 'reference', l: 'Reference / Invoice', t: 'text' },
        { n: 'description', l: 'Description', t: 'text', full: 1 },
        { n: 'files', l: 'Attach images, screenshots, or audio message', t: 'files', full: 1 },
        { n: 'notes', l: 'Notes', t: 'textarea', full: 1 }
      ],
      defaults: () => ({ date: todayStr(), source: 'Other', method: 'Cash' }),
      notice: 'Money from your customers should NOT be entered here. Add it from Customers → Add Sale / Add Payment — it is counted on the dashboard automatically. Use this page for other money coming in.'
    },
    expenses: {
      ownerType: 'expense', title: 'Expenses', sub: 'Record every business expense and keep its receipt attached', addLabel: 'Add Expense',
      search: 'Search paid to, category, reference...', empty: 'No expense entries found.', amountKey: 'amount',
      formTitle: (id) => (id ? 'Expense Details' : 'Add Expense'), saveLabel: 'Save Expense',
      cols: [['Date', (r) => dateFmt(r.date)], ['Paid To', (r) => esc(r.paidTo)], ['Category', (r) => esc(r.category)], ['Amount', (r) => `<b>${money(r.amount)}</b>`], ['Payment', (r) => esc(r.method)], ['Receipt', (r) => attBadge('expense', r.id)]],
      fields: [
        { n: 'date', l: 'Date', t: 'date', req: 1 }, { n: 'amount', l: 'Amount (Rs)', t: 'number', req: 1 },
        { n: 'paidTo', l: 'Paid To', t: 'text', req: 1 },
        { n: 'category', l: 'Category', t: 'select', o: ['Inventory', 'Transport', 'Electricity', 'Internet', 'Rent', 'Salaries', 'Office', 'Equipment', 'Marketing', 'Repairs', 'Bank Charges', 'Other'] },
        { n: 'method', l: 'Payment Method', t: 'select', o: METHODS }, { n: 'reference', l: 'Reference', t: 'text' },
        { n: 'description', l: 'Description', t: 'text', full: 1 },
        { n: 'files', l: 'Attach receipt, screenshot, or audio message', t: 'files', full: 1 },
        { n: 'notes', l: 'Notes', t: 'textarea', full: 1 }
      ],
      defaults: () => ({ date: todayStr(), category: 'Inventory', method: 'Cash' })
    },
    bound: {
      ownerType: 'bound', title: 'Bound', sub: "Money you paid yourself for an item/material for a customer, to be recovered later", addLabel: 'Add Bound',
      search: 'Search customer, item, notes...', empty: 'No bound entries found.', amountKey: 'amount',
      formTitle: (id) => (id ? 'Bound Details' : 'Add Bound Money'), saveLabel: 'Save Bound',
      notice: "Use this section for money you personally paid for a customer's item/material and expect to receive back later.",
      cols: [['Date', (r) => dateFmt(r.date)], ['Customer', (r) => esc(r.customer)], ['Item / Material', (r) => esc(r.item)], ['Amount', (r) => `<b>${money(r.amount)}</b>`],
        ['Status', (r) => `<span class="pill ${r.status === 'Recovered' ? 'payment' : 'expense'}">${esc(r.status)}</span>`], ['Files', (r) => attBadge('bound', r.id)]],
      fields: [
        { n: 'date', l: 'Date', t: 'date', req: 1 }, { n: 'amount', l: 'Amount (Rs)', t: 'number', req: 1 },
        { n: 'customer', l: 'Customer Name', t: 'text', req: 1, list: 'custNames' }, { n: 'item', l: 'Item / Material', t: 'text', req: 1 },
        { n: 'status', l: 'Status', t: 'select', o: ['Pending', 'Recovered'] }, { n: 'recoveryDate', l: 'Expected / Recovery Date', t: 'date' },
        { n: 'files', l: 'Attach image, receipt, screenshot, or audio message', t: 'files', full: 1 },
        { n: 'note', l: 'Note', t: 'textarea', full: 1 }
      ],
      defaults: () => ({ date: todayStr(), status: 'Pending' }),
      confirmDelete: 'Delete this bound entry?',
      cards: (rows) => `<div class="cards">${metric('Total Bound Money', money(sum(rows, (x) => x.amount)), 'red-text')}${metric('Bound Entries', rows.length)}${metric('Recovered', money(sum(rows.filter((x) => x.status === 'Recovered'), (x) => x.amount)), 'green-text')}${metric('Still Bound', money(sum(rows.filter((x) => x.status !== 'Recovered'), (x) => x.amount)))}</div>`
    },
    customers: {
      ownerType: 'customer', formTitle: (id) => (id ? 'Edit Customer' : 'Add Customer'), saveLabel: 'Save Customer',
      confirmDelete: 'Delete this customer and ALL of their sales, payments and attachments? This cannot be undone.',
      fields: [
        { n: 'name', l: 'Customer Name', t: 'text', req: 1 }, { n: 'phone', l: 'Phone', t: 'tel' },
        { n: 'address', l: 'Address', t: 'text', full: 1 }, { n: 'avatar', l: 'Profile Image', t: 'avatar', full: 1 },
        { n: 'notes', l: 'Notes', t: 'textarea', full: 1 }
      ],
      defaults: () => ({})
    },
    sales: {
      ownerType: 'sale', formTitle: (id, cx) => `${id ? 'Edit' : 'Add'} Sale — ${custName(cx.customerId)}`, saveLabel: 'Save Sale',
      confirmDelete: 'Delete this sale? The payment received with it (if any) will also be deleted.',
      fields: [
        { n: 'date', l: 'Date', t: 'date', req: 1 }, { n: 'total', l: 'Total Sale Amount (Rs)', t: 'number', req: 1 },
        { n: 'received', l: 'Amount Received Now (Rs)', t: 'number', min: 0 }, { n: 'description', l: 'Items / Goods', t: 'text', ph: 'e.g. 5 × Product A' },
        { n: 'files', l: 'Attach product photo, delivery proof, invoice, audio message, etc.', t: 'files', full: 1 },
        { n: 'notes', l: 'Notes', t: 'textarea', full: 1 }
      ],
      defaults: () => ({ date: todayStr(), received: 0 }),
      validate: (b) => (Number(b.received || 0) > Number(b.total) ? 'Amount received cannot be more than the total sale amount.' : '')
    },
    returns: {
      ownerType: 'return', formTitle: (id, cx) => `${id ? 'Edit' : 'Add'} Return — ${custName(cx.customerId)}`, saveLabel: 'Save Return', saveClass: 'red',
      confirmDelete: 'Delete this return? The customer\'s balance will go back up.',
      notice: 'Goods the customer gave back. The value you enter is subtracted from this customer\'s total bill.',
      fields: [
        { n: 'date', l: 'Return Date', t: 'date', req: 1 }, { n: 'amount', l: 'Value of Returned Goods (Rs)', t: 'number', req: 1 },
        { n: 'description', l: 'Items Returned', t: 'text', req: 1, full: 1, ph: 'e.g. 3 × Product A' },
        { n: 'quantity', l: 'Quantity', t: 'text', ph: 'e.g. 3 pcs / 2 kg' }, { n: 'reason', l: 'Reason for Return', t: 'text', ph: 'e.g. damaged, wrong size' },
        { n: 'files', l: 'Attach photo of returned goods, proof, or audio message', t: 'files', full: 1 },
        { n: 'notes', l: 'Notes', t: 'textarea', full: 1 }
      ],
      defaults: () => ({ date: todayStr() })
    },
    rp: {
      ownerType: 'rp', formTitle: (id, cx) => `${id ? 'Edit' : 'Add'} RP-${cx.kind} Money — ${custName(cx.customerId)}`, saveLabel: 'Save', saveClass: 'green',
      confirmDelete: 'Delete this RP entry?',
      notice: 'Money this customer paid for RP. It is added to this RP account\'s total and to "Money In" on the dashboard. It does not change the customer\'s sales balance.',
      fields: [
        { n: 'date', l: 'Date', t: 'date', req: 1 }, { n: 'amount', l: 'Amount (Rs)', t: 'number', req: 1 },
        { n: 'method', l: 'Payment Method', t: 'select', o: METHODS }, { n: 'description', l: 'Note', t: 'text', ph: 'e.g. advance for design' },
        { n: 'files', l: 'Attach screenshot, receipt, or audio message', t: 'files', full: 1 },
        { n: 'notes', l: 'Notes', t: 'textarea', full: 1 }
      ],
      defaults: () => ({ date: todayStr(), method: 'Cash' })
    },
    payments: {
      ownerType: 'payment', formTitle: (id, cx) => `${id ? 'Edit' : 'Add'} Payment — ${custName(cx.customerId)}`, saveLabel: 'Save Payment', saveClass: 'green',
      confirmDelete: 'Delete this payment?',
      fields: [
        { n: 'date', l: 'Date', t: 'date', req: 1 }, { n: 'amount', l: 'Amount (Rs)', t: 'number', req: 1 },
        { n: 'method', l: 'Payment Method', t: 'select', o: METHODS }, { n: 'reference', l: 'Reference', t: 'text' },
        { n: 'description', l: 'Description', t: 'text', full: 1, ph: 'Payment against previous sale' },
        { n: 'files', l: 'Attach payment screenshot, proof, or audio message', t: 'files', full: 1 }
      ],
      defaults: () => ({ date: todayStr(), method: 'Cash' })
    }
  };

  /* ============================ generic ledger pages ==================== */
  function ledgerRows(key) {
    const f = S.f[key], q = f.q.trim().toLowerCase();
    return S.d[key].filter((x) => inPeriod(x.date, f.p) && (!q || Object.values(x).join(' ').toLowerCase().includes(q)));
  }
  function ledgerList(key) {
    const c = CFG[key], rows = ledgerRows(key);
    if (!rows.length) return `<div class="empty">${c.empty}</div>`;
    return `<div class="tablewrap"><table class="rt"><thead><tr>${c.cols.map((x) => `<th>${x[0]}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map((r) =>
      `<tr class="clickable" data-action="edit" data-res="${key}" data-id="${r.id}">${c.cols.map((x) => `<td data-label="${x[0]}">${x[1](r)}</td>`).join('')}<td class="act"><button class="btn secondary sm" data-action="edit" data-res="${key}" data-id="${r.id}">View</button></td></tr>`).join('')}</tbody></table></div>
      <div class="list-foot"><span>${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}</span><span>Total <b>${money(sum(rows, (x) => x.amount))}</b></span></div>`;
  }
  function ledgerPage(key) {
    const c = CFG[key], f = S.f[key];
    const periodRows = S.d[key].filter((x) => inPeriod(x.date, f.p));
    main().innerHTML = header(c.title, c.sub, `<button class="btn secondary" data-action="csv" data-res="${key}">Export CSV</button>` + addBtn(c.addLabel, `data-action="add" data-res="${key}"`)) +
      (c.cards ? c.cards(periodRows) : '') +
      `<div class="section"><div class="toolbar"><input type="search" data-filter="${key}.q" value="${esc(f.q)}" placeholder="${esc(c.search)}" aria-label="Search">${periodSel(key + '.p', f.p)}</div><div id="list">${ledgerList(key)}</div></div>`;
  }

  /* ================================ pages =============================== */
  function dashboardPage() {
    const p = S.f.dash, d = S.d;
    const inRows = d.income.filter((x) => inPeriod(x.date, p)), exRows = d.expenses.filter((x) => inPeriod(x.date, p));
    const payRows = d.payments.filter((x) => inPeriod(x.date, p)), saleRows = d.sales.filter((x) => inPeriod(x.date, p)), retRows = d.returns.filter((x) => inPeriod(x.date, p));
    const retTotal = sum(retRows, (x) => x.amount);
    const rpPeriod = d.rp.filter((x) => inPeriod(x.date, p));
    const rpWax = sum(rpPeriod.filter((x) => x.kind === 'Wax'), (x) => x.amount), rpDes = sum(rpPeriod.filter((x) => x.kind === 'Designing'), (x) => x.amount);
    const otherIn = sum(inRows, (x) => x.amount), custIn = sum(payRows, (x) => x.amount), exp = sum(exRows, (x) => x.amount);
    const moneyIn = round2(otherIn + custIn + rpWax + rpDes), net = round2(moneyIn - exp);
    // Receivables are all-time on purpose: what customers owe you today does not depend on the period picker.
    const owing = d.customers.map((c) => ({ c, b: custBal(c.id) })).filter((x) => x.b > 0).sort((a, b) => b.b - a.b);
    const receivable = sum(owing, (x) => x.b);
    const boundPending = sum(d.bound.filter((x) => x.status !== 'Recovered'), (x) => x.amount);
    const recent = [
      ...inRows.map((x) => ({ ...x, type: 'Income', person: x.from })),
      ...exRows.map((x) => ({ ...x, type: 'Expense', person: x.paidTo })),
      ...payRows.map((x) => ({ ...x, type: 'Payment', person: custName(x.customerId) })),
      ...rpPeriod.map((x) => ({ ...x, type: 'RP-' + x.kind, person: custName(x.customerId) }))
    ].sort(byNewest).slice(0, 8);
    main().innerHTML = header('Dashboard', 'Your business financial overview', periodSel('dash', p)) +
      `<div class="cards">${metric('Money In', money(moneyIn), 'green-text')}${metric('Expenses', money(exp), 'red-text')}${metric('Net (In − Expenses)', money(net), net < 0 ? 'red-text' : '')}${metric('Customers Owe You (today)', money(receivable), receivable > 0 ? 'red-text' : '')}</div>
       <div class="cards">${metric('Sales Made', money(sum(saleRows, (x) => x.total)))}${metric('Received From Customers', money(custIn), 'green-text')}${metric('Other Income', money(otherIn))}${metric('Bound Money Pending (today)', money(boundPending))}</div>
       <div class="cards">${metric('Goods Returned (value)', money(retTotal), retTotal > 0 ? 'red-text' : '')}${metric('Net Sales (after returns)', money(round2(sum(saleRows, (x) => x.total) - retTotal)))}${metric('RP-Wax Received', money(rpWax), 'green-text')}${metric('RP-Designing Received', money(rpDes), 'green-text')}</div>
       <div class="grid2">
         <div class="section"><h2>Recent Transactions</h2>${recent.length ? `<div class="tablewrap"><table class="rt"><thead><tr><th>Date</th><th>Type</th><th>Person</th><th>Amount</th></tr></thead><tbody>${recent.map((x) =>
            `<tr><td data-label="Date">${dateFmt(x.date)}</td><td data-label="Type"><span class="pill ${x.type === 'Expense' ? 'expense' : (x.type === 'Payment' || x.type.startsWith('RP-')) ? 'payment' : ''}">${x.type}</span></td><td data-label="Person">${esc(x.person || '')}</td><td data-label="Amount"><b>${money(x.amount)}</b></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No transactions found for this period.</div>'}</div>
         <div class="section"><h2>Who Owes You</h2>${owing.slice(0, 10).map((x) => `<a class="tx" style="display:block" href="#/customers/${x.c.id}"><b>${esc(x.c.name)}</b><div class="desc">Outstanding: <strong>${money(x.b)}</strong></div></a>`).join('') || '<div class="empty">Nobody owes you anything right now.</div>'}${owing.length > 10 ? `<a class="muted" style="display:block;margin-top:10px;font-size:13px" href="#/customers">+ ${owing.length - 10} more — see Customers</a>` : ''}</div>
       </div>`;
  }

  const customerCards = () => {
    const f = S.f.customers, q = f.q.trim().toLowerCase();
    let rows = S.d.customers.filter((c) => !q || `${c.name} ${c.phone} ${c.address} ${c.notes}`.toLowerCase().includes(q)).map((c) => ({ c, b: custBal(c.id) }));
    if (f.s === 'balance') rows.sort((x, y) => y.b - x.b);
    if (f.s === 'owing') rows = rows.filter((x) => x.b > 0).sort((x, y) => y.b - x.b);
    if (!rows.length) return '<div class="empty">No customers found.</div>';
    return rows.map(({ c, b }) => {
      const s = sum(S.d.sales.filter((x) => x.customerId === c.id), (x) => x.total);
      const p = sum(S.d.payments.filter((x) => x.customerId === c.id), (x) => x.amount), rt = custRet(c.id);
      return `<a class="customer-card" href="#/customers/${c.id}"><div class="customer-head">${avatarHTML(c)}<div><h3>${esc(c.name)}</h3><p>${esc(c.phone || '')}</p></div></div>
        <div class="cstats"><span>Sales<br><b>${money(s)}</b></span><span>Received<br><b>${money(p)}</b></span>${rt > 0 ? `<span>Returns<br><b>${money(rt)}</b></span>` : ''}<span>${b < 0 ? 'Advance' : 'Balance'}<br><b class="${b > 0 ? 'red-text' : 'green-text'}">${money(Math.abs(b))}</b></span></div></a>`;
    }).join('');
  };
  function customersPage() {
    const f = S.f.customers;
    const sortSel = `<select class="sel" data-filter="customers.s" aria-label="Sort customers">${[['name', 'Sort: Name'], ['balance', 'Sort: Highest balance'], ['owing', 'Only who owe me']].map(([v, l]) => `<option value="${v}"${f.s === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    main().innerHTML = header('Customers', 'Customer ledger, sales, payments and attached transaction evidence', `<button class="btn secondary" data-action="csv" data-res="customers">Export CSV</button>` + addBtn('Add Customer', 'data-action="add" data-res="customers"')) +
      `<div class="section"><div class="toolbar"><input type="search" data-filter="customers.q" value="${esc(f.q)}" placeholder="Search customers..." aria-label="Search customers">${sortSel}</div><div id="list" class="customer-grid">${customerCards()}</div></div>`;
  }

  function customerDetailPage(id) {
    const c = S.d.customers.find((x) => x.id === id);
    if (!c) { location.hash = '#/customers'; return; }
    const sales = S.d.sales.filter((x) => x.customerId === id), pays = S.d.payments.filter((x) => x.customerId === id);
    const rets = S.d.returns.filter((x) => x.customerId === id);
    const s = sum(sales, (x) => x.total), p = sum(pays, (x) => x.amount), rt = sum(rets, (x) => x.amount), b = custBal(id);
    const timeline = [...sales.map((x) => ({ ...x, type: 'Sale', amount: x.total })), ...pays.map((x) => ({ ...x, type: 'Payment' })), ...rets.map((x) => ({ ...x, type: 'Return' }))].sort(byNewest);
    main().innerHTML = `<a class="back" href="#/customers">← Back to Customers</a><div class="print-only"><h2>Account statement — ${esc(c.name)}</h2><p>${esc([c.phone, c.address].filter(Boolean).join(' · '))}<br>Printed on ${dateFmt(todayStr())}</p></div>` +
      header(c.name, 'Customer profile and complete ledger',
        `<button class="btn secondary" data-action="print">Print Statement</button><button class="btn secondary" data-action="edit" data-res="customers" data-id="${id}">Edit Customer</button>${addBtn('Add Sale', `data-action="add" data-res="sales" data-customer="${id}"`)}<button class="btn green" data-action="add" data-res="payments" data-customer="${id}">${ICON.plus}<span>Add Payment</span></button><button class="btn red" data-action="add" data-res="returns" data-customer="${id}">${ICON.plus}<span>Add Return</span></button>`) +
      `<div class="section"><div class="customer-head">${avatarHTML(c)}<div><h2 style="margin:0">${esc(c.name)}</h2><div class="muted" style="font-size:13px">${esc([c.phone, c.address].filter(Boolean).join(' · '))}</div></div></div>
        ${c.notes ? `<p class="muted" style="font-size:14px;margin:12px 0 0">${esc(c.notes)}</p>` : ''}
        <div class="detail-grid">${metric('Total Sales', money(s))}${metric('Returned Goods', rt ? '− ' + money(rt) : money(0), rt ? 'red-text' : '')}${metric('Total Received', money(p), 'green-text')}${metric(b < 0 ? 'Advance Paid' : 'Remaining Balance', money(Math.abs(b)), b > 0 ? 'red-text' : 'green-text')}</div></div>
       <div class="section"><h2>RP <span class="muted" style="font-weight:500;font-size:15px">— total received ${money(rpSum(id))}</span></h2>
         <p class="muted" style="margin:-6px 0 14px;font-size:13px">Money this customer paid for RP. Kept separate from the sales balance above.</p>
         <div class="rp-grid">${RP_KINDS.map((k) => {
           const rows = rpRows(id, k);
           return `<div class="rp-block"><div class="tx-top"><div><b>RP-${k}</b><div class="desc">${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}</div></div><b class="green-text">${money(rpSum(id, k))}</b></div>
             <div class="tx-actions"><button class="btn green sm" data-action="add" data-res="rp" data-customer="${id}" data-kind="${k}">${ICON.plus}<span>Add Money</span></button></div>
             ${rows.map((x) => `<div class="tx"><div class="tx-top"><div><b>${dateFmt(x.date)}</b><div class="desc">${[x.method, x.description].filter(Boolean).map(esc).join(' · ')}</div></div><b class="green-text">${money(x.amount)}</b></div>
               ${x.notes ? `<div class="desc">${esc(x.notes)}</div>` : ''}${attBlock('rp', x.id, false)}
               <div class="tx-actions"><button class="btn secondary sm" data-action="edit" data-res="rp" data-id="${x.id}">Edit</button><button class="btn red sm" data-action="del-tx" data-res="rp" data-id="${x.id}">Delete</button></div></div>`).join('') || '<div class="empty" style="padding:14px">Nothing added yet.</div>'}</div>`;
         }).join('')}</div></div>
       <div class="section"><h2>Transaction History</h2>${timeline.map((x) => {
         const isSale = x.type === 'Sale', isRet = x.type === 'Return', linked = x.type === 'Payment' && x.saleId;
         const res = isSale ? 'sales' : isRet ? 'returns' : 'payments', owner = isSale ? 'sale' : isRet ? 'return' : 'payment';
         const detail = isRet ? [x.description, x.quantity && 'Qty: ' + x.quantity, x.reason && 'Reason: ' + x.reason].filter(Boolean).map(esc).join(' · ') : (x.description ? esc(x.description) : '');
         const sub = isSale || isRet ? '' : (x.method ? ' · ' + esc(x.method) : '');
         const amountHtml = isRet ? `<b class="red-text">− ${money(x.amount)}</b>` : `<b class="${isSale ? '' : 'green-text'}">${money(x.amount)}</b>`;
         return `<div class="tx"><div class="tx-top"><div><b>${isRet ? 'Return (goods back)' : x.type}</b><div class="desc">${dateFmt(x.date)}${detail ? ' · ' + detail : ''}${sub}</div></div>${amountHtml}</div>
           ${isSale ? `<div class="desc">Received in sale: ${money(x.received || 0)} · Sale balance: ${money(x.total - (x.received || 0))}</div>` : ''}
           ${x.notes ? `<div class="desc">${esc(x.notes)}</div>` : ''}
           ${attBlock(owner, x.id, false)}
           <div class="tx-actions">${linked ? '<span class="badge">Linked to a sale</span>' : `<button class="btn secondary sm" data-action="edit" data-res="${res}" data-id="${x.id}">Edit</button>`}<button class="btn red sm" data-action="del-tx" data-res="${res}" data-id="${x.id}"${linked ? ' data-linked="1"' : ''}>Delete</button></div></div>`;
       }).join('') || '<div class="empty">No customer transactions yet.</div>'}</div>`;
  }

  const DB_LABEL = { postgres: 'PostgreSQL (permanent)', firestore: 'Firebase Firestore (permanent)', sqlite: 'Local file (temporary!)' };
  function settingsPage() {
    const m = S.d.meta, pct = Math.min(100, Math.round((m.attachmentBytes / m.maxStorageBytes) * 100));
    main().innerHTML = header('Settings', 'Account, backup and storage') +
      (m.db === 'sqlite' ? `<div class="notice warn"><b>Warning:</b> this server is using a local file database. On free hosting that file is deleted on restart/redeploy. Set <code>DATABASE_URL</code> (Postgres) or <code>FIREBASE_SERVICE_ACCOUNT</code> (Firestore) to keep your data permanently.</div>` : '') +
      `<div class="section"><h2>Account</h2><div class="kv"><span>Signed in as</span><b>${esc(m.user)}</b></div><div class="actions" style="margin-top:12px"><button class="btn secondary" data-action="logout">Sign out</button><button class="btn secondary" data-action="refresh">Refresh data</button></div></div>
       <div class="section"><h2>Backup</h2><p class="muted" style="margin-top:0;font-size:14px">Download all your entries (customers, sales, payments, income, expenses, bound) as a JSON file. Attachment files stay safely in your database.</p><a class="btn" href="/api/export" download>Download backup</a></div>
       <div class="section"><h2>Restore from backup</h2><p class="muted" style="margin-top:0;font-size:14px">Choose a backup file you downloaded earlier. Existing entries are kept as they are; only missing ones are added back. (Attachment files are not part of the backup file.)</p><div class="actions"><input type="file" id="restoreFile" accept="application/json,.json"><button class="btn secondary" data-action="restore">Restore</button></div></div>
       <div class="section"><h2>Storage</h2><div class="kv"><span>Database</span><b>${DB_LABEL[m.db] || m.db}</b></div>
        <div class="kv"><span>Attachments</span><b>${m.attachmentCount} files · ${bytesFmt(m.attachmentBytes)}</b></div>
        <div class="bar"><i style="width:${pct}%"></i></div><div class="muted" style="font-size:12px">${pct}% of ${bytesFmt(m.maxStorageBytes)} attachment limit · max ${bytesFmt(m.maxUploadBytes)} per file</div></div>
       <div class="section"><h2>Use like an app on your phone</h2><p class="muted" style="margin:0;font-size:14px">Open this site in Chrome (Android) or Safari (iPhone), then choose <b>Add to Home Screen</b>. It will open full-screen like a normal app.</p></div>`;
  }

  const PAGES = {
    dashboard: () => dashboardPage(),
    income: () => ledgerPage('income'),
    expenses: () => ledgerPage('expenses'),
    bound: () => ledgerPage('bound'),
    customers: () => (S.route.id ? customerDetailPage(S.route.id) : customersPage()),
    settings: () => settingsPage()
  };

  /* ================================ router ============================== */
  function parseRoute() {
    const [page, id] = (location.hash || '#/dashboard').replace(/^#\/?/, '').split('/');
    return { page: PAGES[page] ? page : 'dashboard', id: id ? decodeURIComponent(id) : null };
  }
  function render() {
    if (!S.d) return;
    S.route = parseRoute();
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === S.route.page));
    PAGES[S.route.page]();
  }
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

  /* ============================ modal + forms =========================== */
  const modal = () => $('#modal'), box = () => $('#modalBox');
  function openModal(html) {
    box().innerHTML = html;
    modal().classList.add('open');
    document.body.classList.add('noscroll');
    box().scrollTop = 0;
  }
  function closeModal() {
    modal().classList.remove('open');
    box().innerHTML = '';
    document.body.classList.remove('noscroll');
  }
  const findRec = (key, id) => S.d[key].find((x) => x.id === id);

  function fieldHTML(f, v, id, key) {
    const val = v[f.n] ?? '';
    const cls = `field${f.full ? ' full' : ''}`, label = `<label for="f_${f.n}">${esc(f.l)}</label>`;
    switch (f.t) {
      case 'select': {
        const opts = f.o.includes(val) || !val ? f.o : [val, ...f.o];
        return `<div class="${cls}">${label}<select id="f_${f.n}" name="${f.n}">${opts.map((o) => `<option${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
      }
      case 'textarea': return `<div class="${cls}">${label}<textarea id="f_${f.n}" name="${f.n}" maxlength="4000">${esc(val)}</textarea></div>`;
      case 'number': return `<div class="${cls}">${label}<input id="f_${f.n}" name="${f.n}" type="number" step="0.01" min="${f.min ?? 0.01}" inputmode="decimal" value="${esc(val)}"${f.req ? ' required' : ''}></div>`;
      case 'files': return `<div class="${cls}">${label}<input id="f_${f.n}" name="files" type="file" accept="image/*,audio/*" multiple>${id ? attBlock(CFG[key].ownerType, id, true) : ''}</div>`;
      case 'avatar': return `<div class="${cls}">${label}<input id="f_${f.n}" name="avatar" type="file" accept="image/*"></div>`;
      default: return `<div class="${cls}">${label}<input id="f_${f.n}" name="${f.n}" type="${f.t}" value="${esc(val)}"${f.req ? ' required' : ''}${f.list ? ` list="${f.list}"` : ''}${f.ph ? ` placeholder="${esc(f.ph)}"` : ''} maxlength="400" autocomplete="off"></div>`;
    }
  }

  function openEntry(key, id, cx = {}) {
    const c = CFG[key], rec = id ? findRec(key, id) : null;
    if (id && !rec) return toast('Record not found', 'error');
    const v = rec ? { ...rec } : c.defaults();
    const customerId = cx.customerId || (rec && rec.customerId) || '';
    const kind = cx.kind || (rec && rec.kind) || '';
    const lists = c.fields.some((f) => f.list) ? `<datalist id="custNames">${S.d.customers.map((x) => `<option value="${esc(x.name)}"></option>`).join('')}</datalist>` : '';
    openModal(`<div class="modal-head"><h2>${esc(c.formTitle(id, { customerId, kind }))}</h2><button class="icon-btn" data-action="close" aria-label="Close">${ICON.x}</button></div>
      <div class="modal-body">${c.notice ? `<div class="notice">${esc(c.notice)}</div>` : ''}
        <form id="entryForm" class="form" data-res="${key}" data-id="${id || ''}" data-customer="${esc(customerId)}" data-kind="${esc(kind)}">${c.fields.map((f) => fieldHTML(f, v, id, key)).join('')}<button type="submit" hidden></button></form>${lists}
        <div class="form-error" id="formError" hidden></div></div>
      <div class="modal-actions">${id ? '<button class="btn red" data-action="delete" type="button">Delete</button>' : ''}<button class="btn secondary" data-action="close" type="button">Close</button><button class="btn ${c.saveClass || ''}" id="saveBtn" data-action="save" type="button">${esc(c.saveLabel)}</button></div>`);
  }

  function setBusy(on, label) {
    $$('#modalBox .modal-actions button').forEach((b) => { b.disabled = on; });
    const s = $('#saveBtn');
    if (s) { if (on) { s.dataset.label = s.dataset.label || s.textContent; s.textContent = label || 'Saving…'; } else if (s.dataset.label) { s.textContent = s.dataset.label; } }
  }
  function formError(msg) { const e = $('#formError'); if (e) { e.textContent = msg; e.hidden = !msg; if (msg) e.scrollIntoView({ block: 'nearest' }); } }

  async function saveEntry() {
    const form = $('#entryForm');
    if (!form || !form.reportValidity()) return;
    const key = form.dataset.res, id = form.dataset.id || null, c = CFG[key];
    const body = {};
    for (const f of c.fields) if (f.t !== 'files' && f.t !== 'avatar') body[f.n] = form.elements.namedItem(f.n).value;
    if (form.dataset.customer) body.customerId = form.dataset.customer;
    if (form.dataset.kind) body.kind = form.dataset.kind;
    const bad = c.validate && c.validate(body);
    if (bad) return formError(bad);
    if (key === 'sales' && id) {
      const old = findRec('sales', id);
      if (old && old.received > 0 && !(Number(body.received) > 0) && !confirm('You set "Amount Received" to 0. The payment recorded with this sale (and its attachments) will be deleted. Continue?')) return;
    }
    formError('');
    setBusy(true);
    let prepared = [], preparedAvatar = [];
    try {
      const files = form.elements.namedItem('files'), avatar = form.elements.namedItem('avatar');
      if (files && files.files.length) prepared = await prepareFiles(files.files);
      if (avatar && avatar.files.length) preparedAvatar = await prepareFiles(avatar.files, { maxDim: 320 });
    } catch (e) { setBusy(false); return formError(e.message); }
    try {
      const rec = await api(id ? 'PUT' : 'POST', `/api/${key}${id ? '/' + id : ''}`, body);
      let upErr = null;
      try {
        if (prepared.length) await sendFiles(c.ownerType, rec.id, prepared);
        if (preparedAvatar.length) await sendFiles(c.ownerType, rec.id, preparedAvatar, { replace: true });
      } catch (e) { upErr = e; }
      await load();
      closeModal();
      render();
      if (upErr) toast('Saved, but the attachment failed: ' + upErr.message, 'error'); else toast('Saved ✓');
    } catch (e) {
      setBusy(false);
      formError(e.message);
      return;
    }
  }

  async function deleteEntry() {
    const form = $('#entryForm');
    if (!form) return;
    const key = form.dataset.res, id = form.dataset.id, c = CFG[key];
    if (!confirm(c.confirmDelete || 'Delete this entry?')) return;
    setBusy(true, 'Deleting…');
    try {
      await api('DELETE', `/api/${key}/${id}`);
      await load();
      closeModal();
      if (key === 'customers') location.hash = '#/customers';
      render();
      toast('Deleted');
    } catch (e) { setBusy(false); formError(e.message); }
  }

  /* ============================== attachments =========================== */
  function compressImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // PNG transparency -> white, not black
        ctx.drawImage(img, 0, 0, w, h);
        cv.toBlob((b) => (b ? resolve(b) : reject(new Error('compress failed'))), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  // Step 1 (before anything is saved): compress + size-check every file, so a too-big file is reported
  // BEFORE the entry is created, not after.
  async function prepareFiles(fileList, opts = {}) {
    const files = [...fileList], out = [], cap = S.d.meta.maxUploadBytes;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setBusy(true, `Preparing ${i + 1}/${files.length}…`);
      let blob = file, name = file.name || 'file';
      if (file.type.startsWith('image/') && file.type !== 'image/gif') {
        try {
          const attempts = [[opts.maxDim || 1600, 0.8], [1280, 0.7], [1024, 0.6], [800, 0.5], [640, 0.4]];
          for (const [dim, q] of attempts) {
            const small = await compressImage(file, dim, q);
            if (small.size < file.size) { blob = small; name = name.replace(/\.[^.]+$/, '') + '.jpg'; }
            if (blob.size <= cap) break;
          }
        } catch (_) { /* keep the original file */ }
      }
      if (blob.size > cap) throw new Error(`"${file.name}" is too large (max ${bytesFmt(cap)} per file${file.type.startsWith('audio/') ? ' — record a shorter audio message' : ' — try a smaller photo'}). Nothing was saved.`);
      out.push({ blob, name });
    }
    return out;
  }
  // Step 2: upload the already-checked files.
  async function sendFiles(ownerType, ownerId, prepared, opts = {}) {
    for (let i = 0; i < prepared.length; i++) {
      const { blob, name } = prepared[i];
      setBusy(true, `Uploading ${i + 1}/${prepared.length}…`);
      const q = new URLSearchParams({ ownerType, ownerId, name });
      if (opts.replace) q.set('replace', '1');
      let r;
      try { r = await fetch('/api/attachments?' + q, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob }); }
      catch (_) { throw new Error('connection lost while uploading'); }
      if (r.status === 401) { showLogin('Session expired. Please sign in again.'); throw new Error('session expired'); }
      if (!r.ok) throw new Error(await readError(r));
    }
  }

  async function deleteAttachment(id, el) {
    if (!confirm('Remove this attachment?')) return;
    try {
      await api('DELETE', '/api/attachments/' + id);
      S.d.attachments = S.d.attachments.filter((a) => a.id !== id);
      S.att = {};
      for (const a of S.d.attachments) (S.att[a.ownerType + ':' + a.ownerId] ||= []).push(a);
      const holder = el.closest('.att'); if (holder) holder.remove();
      render();
      toast('Attachment removed');
    } catch (e) { toast(e.message, 'error'); }
  }

  function viewImage(id) {
    const lb = $('#lightbox');
    lb.innerHTML = `<button class="icon-btn" data-action="close-lightbox" aria-label="Close">${ICON.x}</button><img src="/api/attachments/${esc(id)}" alt="">`;
    lb.hidden = false;
  }
  const closeLightbox = () => { const lb = $('#lightbox'); lb.hidden = true; lb.innerHTML = ''; };

  /* ================================ session ============================= */
  const ACTIONS = {
    add: (d) => openEntry(d.res, null, { customerId: d.customer, kind: d.kind }),
    edit: (d) => openEntry(d.res, d.id),
    close: closeModal,
    save: saveEntry,
    delete: deleteEntry,
    'del-att': (d, el) => deleteAttachment(d.id, el),
    'view-img': (d) => viewImage(d.id),
    'close-lightbox': closeLightbox,
    logout: async () => { try { await api('POST', '/api/logout', {}, { noRedirect: true }); } catch (_) { /* ignore */ } S.d = null; showLogin(); },
    'del-tx': async (d) => {
      const msg = d.linked ? 'Delete this payment? The sale it was received with will show "nothing received" again (balance goes up).' : (CFG[d.res].confirmDelete || 'Delete this entry?');
      if (!confirm(msg)) return;
      try { await api('DELETE', `/api/${d.res}/${d.id}`); await load(); render(); toast('Deleted'); } catch (e) { toast(e.message, 'error'); }
    },
    print: () => window.print(),
    csv: (d) => {
      if (d.res === 'customers') {
        return downloadCsv('customers-' + todayStr() + '.csv', ['Name', 'Phone', 'Address', 'Total Sales', 'Total Returns', 'Total Received', 'RP-Wax Received', 'RP-Designing Received', 'Balance (positive = owes you)'],
          S.d.customers.map((c) => [c.name, c.phone, c.address, sum(S.d.sales.filter((x) => x.customerId === c.id), (x) => x.total), custRet(c.id), sum(S.d.payments.filter((x) => x.customerId === c.id), (x) => x.amount), rpSum(c.id, 'Wax'), rpSum(c.id, 'Designing'), custBal(c.id)]));
      }
      const fields = CFG[d.res].fields.filter((f) => f.t !== 'files');
      downloadCsv(d.res + '-' + todayStr() + '.csv', fields.map((f) => f.l), ledgerRows(d.res).map((r) => fields.map((f) => r[f.n] ?? '')));
    },
    restore: async () => {
      const inp = $('#restoreFile');
      if (!inp || !inp.files.length) return toast('Choose a backup file first', 'error');
      let data;
      try { data = JSON.parse(await inp.files[0].text()); } catch (_) { return toast('This file is not a valid backup', 'error'); }
      if (!confirm('Restore missing entries from this backup? Existing entries will not be changed.')) return;
      try {
        const r = await api('POST', '/api/import', data);
        await load(); render();
        const n = Object.values(r.added).reduce((a, b) => a + b, 0);
        toast(`Restored ${n} entries` + (r.problemCount ? `, ${r.problemCount} skipped (invalid)` : ''), r.problemCount ? 'error' : 'ok');
      } catch (e) { toast(e.message, 'error'); }
    },
    refresh: async () => { try { await load(); render(); toast('Data refreshed'); } catch (e) { toast(e.message, 'error'); } }
  };

  document.addEventListener('click', (e) => {
    const lb = $('#lightbox');
    if (!lb.hidden && e.target === lb) return closeLightbox();
    const el = e.target.closest('[data-action]');
    if (!el || !ACTIONS[el.dataset.action]) return;
    e.preventDefault();
    ACTIONS[el.dataset.action](el.dataset, el, e);
  });
  let downOnBackdrop = false;
  document.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === modal(); });
  document.addEventListener('touchstart', (e) => { downOnBackdrop = e.target === modal(); }, { passive: true });
  modal().addEventListener('click', (e) => { if (e.target === modal() && downOnBackdrop) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#lightbox').hidden) closeLightbox(); else if (modal().classList.contains('open')) closeModal();
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'entryForm') { e.preventDefault(); saveEntry(); }
  });
  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-filter]');
    if (!el) return;
    const path = el.dataset.filter;
    if (path === 'dash') { S.f.dash = el.value; return render(); }
    const [k, f] = path.split('.');
    S.f[k][f] = el.value;
    if (f !== 'q') return render();
    const list = $('#list');
    if (list) list.innerHTML = k === 'customers' ? customerCards() : ledgerList(k);
  });

  // keep data fresh when you come back to the app (e.g. after using it on another device)
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !S.d || modal().classList.contains('open') || Date.now() - S.lastLoad < 120000) return;
    try { await load(); if (!modal().classList.contains('open')) render(); } catch (_) { /* silent */ }
  });

  /* ============================ shell / login / boot ==================== */
  const NAV = [['dashboard', 'Dashboard', 'dashboard'], ['income', 'Income', 'income'], ['expenses', 'Expenses', 'expense'], ['customers', 'Customers', 'users'], ['bound', 'Bound', 'lock']];
  function buildShell() {
    const link = (n) => `<a href="#/${n[0]}" data-nav="${n[0]}">${ICON[n[2]]}<span>${n[1]}</span></a>`;
    $('#app').innerHTML = `<aside class="sidebar"><div class="brand">Business <span>Ledger</span></div><nav class="nav">${NAV.map(link).join('')}</nav>
      <div class="sidebar-foot"><a href="#/settings" data-nav="settings">${ICON.settings}<span>Settings</span></a></div></aside>
      <header class="appbar"><div class="brand">Business <span>Ledger</span></div><a href="#/settings" class="icon-btn" aria-label="Settings">${ICON.settings}</a></header>
      <main class="main" id="main"></main>
      <nav class="tabbar" aria-label="Main">${NAV.map(link).join('')}</nav>`;
  }
  function showApp() {
    $('#boot').hidden = true; $('#login').hidden = true; $('#app').hidden = false;
    if (!$('#main')) buildShell();
    render();
  }
  function showLogin(msg) {
    closeModal(); closeLightbox();
    $('#boot').hidden = true; $('#app').hidden = true;
    const l = $('#login'); l.hidden = false;
    l.innerHTML = `<form class="login-card" id="loginForm"><div class="brand">Business <span>Ledger</span></div><p class="muted">Sign in to continue</p>
      <label>Username<input name="username" autocomplete="username" autocapitalize="none" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <div class="form-error" id="loginError"${msg ? '' : ' hidden'}>${esc(msg || '')}</div>
      <button class="btn block" type="submit">Sign in</button></form>`;
  }
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'loginForm') return;
    e.preventDefault();
    const f = e.target, btn = $('button', f), err = $('#loginError');
    btn.disabled = true; btn.textContent = 'Signing in…'; err.hidden = true;
    try {
      await api('POST', '/api/login', { username: f.elements.namedItem('username').value.trim(), password: f.elements.namedItem('password').value }, { noRedirect: true });
      await start();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Sign in';
    }
  });

  function showFatal(e) {
    $('#boot').hidden = false;
    $('#boot').innerHTML = `<div><b>Could not load your ledger</b></div><div>${esc(e.message)}</div><button class="btn" id="retryBtn">Try again</button>`;
    $('#retryBtn').onclick = () => { $('#boot').textContent = 'Loading…'; start(); };
  }

  async function start() {
    try {
      await api('GET', '/api/session', undefined, { noRedirect: true });
    } catch (e) {
      if (e.status === 401) return showLogin();
      return showFatal(e);
    }
    try { await load(); } catch (e) { if (e.status !== 401) showFatal(e); return; }
    showApp();
  }
  start();
})();
