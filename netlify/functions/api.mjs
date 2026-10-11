// Netlify Functions adapter.
//
// The rest of this app (server.js, db.js, resources.js) is plain Node: it speaks the classic
// http.IncomingMessage / http.ServerResponse API, because that same code also has to run as a
// normal always-on server (npm start, on Render/Railway/your own computer). Netlify Functions
// instead hand you a standard Web `Request` and expect a standard Web `Response` back. This file
// is the (small) translation layer between the two, so server.js never has to know which one is
// being used.
//
// This file must be an ES module (Netlify's modern "default export + config" function format),
// so it uses import/export even though the rest of the project is CommonJS.
import { Readable } from 'node:stream';
// server.js is CommonJS; a plain static import lets Netlify's bundler see (and include) it together with
// db.js, resources.js and their database drivers.
import server from '../../server.js';

const { createApp } = server;

// Reused across "warm" invocations of the same function container, so the database connection
// (Postgres pool / Firestore client) is only created once, not on every single request.
let appPromise;
function getApp() {
  // If start-up fails once (e.g. the database was briefly unreachable) do NOT cache the failure,
  // otherwise this warm container would keep returning errors until it is recycled.
  if (!appPromise) appPromise = createApp().catch((e) => { appPromise = null; throw e; });
  return appPromise;
}

/** Web Request -> the req-like object server.js expects (duck-typed http.IncomingMessage). */
function toNodeReq(request, bodyBuffer) {
  const req = new Readable({ read() {} });
  req.push(bodyBuffer);
  req.push(null);
  const url = new URL(request.url);
  req.method = request.method;
  req.url = url.pathname + url.search;
  req.headers = Object.fromEntries(request.headers.entries()); // Web Headers are already lower-cased
  if (req.headers['content-length'] === undefined) req.headers['content-length'] = String(bodyBuffer.length);
  // Netlify's own CDN already compresses eligible responses; don't also let server.js self-gzip
  // here, or a Response with a self-set Content-Encoding could be double-handled by the platform.
  delete req.headers['accept-encoding'];
  req.socket = { encrypted: true, remoteAddress: req.headers['x-nf-client-connection-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() };
  return req;
}

/** A res-like object (duck-typed http.ServerResponse) that just records what was written, so we can turn it into a Web Response afterwards. */
function makeNodeRes() {
  const chunks = [];
  let statusCode = 200, headers = {}, finished;
  const done = new Promise((resolve) => { finished = resolve; });
  return {
    res: {
      get statusCode() { return statusCode; },
      set statusCode(v) { statusCode = v; },
      headersSent: false,
      setHeader(k, v) { headers[k] = v; },
      writeHead(status, hdrs) { statusCode = status; if (hdrs) Object.assign(headers, hdrs); this.headersSent = true; },
      write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
      end(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); finished(); },
      destroy() { finished(); }
    },
    done,
    result: () => ({ statusCode, headers, body: Buffer.concat(chunks) })
  };
}

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default async (request) => {
  let app;
  try { app = await getApp(); } catch (e) {
    console.error('[startup]', e && e.message);
    const cfg = /ADMIN_PASSWORD|No database|FIREBASE_SERVICE_ACCOUNT|Set only ONE/i.test(String(e && e.message));
    return json(503, { error: cfg ? 'Server is not configured correctly. Check the environment variables in Netlify.' : 'Database is not reachable right now. Please try again in a moment.' });
  }
  const bodyBuffer = request.method === 'GET' || request.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await request.arrayBuffer());
  const nodeReq = toNodeReq(request, bodyBuffer);
  const { res, done, result } = makeNodeRes();
  await app.handle(nodeReq, res);
  await done;
  const { statusCode, headers, body } = result();
  return new Response(body, { status: statusCode, headers });
};

// Serves this function at /api/* with no separate redirect rule needed.
export const config = { path: '/api/*' };
