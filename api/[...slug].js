'use strict';
// Vercel adapter. Vercel gives Node functions a normal req/res pair, so server.js can handle it directly.
// NOTE: Vercel's free "Hobby" plan is for NON-COMMERCIAL use only. For a real business use Netlify (or Vercel Pro).
const { createApp } = require('../server.js');

let appPromise;
function getApp() {
  if (!appPromise) appPromise = createApp().catch((e) => { appPromise = null; throw e; });
  return appPromise;
}

module.exports = async (req, res) => {
  try {
    const app = await getApp();
    await app.handle(req, res);
  } catch (e) {
    console.error('[startup]', e && e.message);
    if (res.headersSent) return res.end();
    const cfg = /ADMIN_PASSWORD|No database|FIREBASE_SERVICE_ACCOUNT|Set only ONE/i.test(String(e && e.message));
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: cfg ? 'Server is not configured correctly. Check the environment variables in Vercel.' : 'Database is not reachable right now. Please try again in a moment.' }));
  }
};

// The app reads the request body itself.
module.exports.config = { api: { bodyParser: false } };
