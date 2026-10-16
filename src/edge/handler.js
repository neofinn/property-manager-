'use strict';

// The API as a fetch-style handler (Request -> Response), for hosting on
// Supabase Edge Functions while the pages are served from GitHub Pages.
// Same routes as the Node server, with two differences because the pages and
// the API are on different sites:
//   - sessions travel in headers (X-Session for companies, X-Admin-Session
//     for /api/admin), returned as `token` from login/signup, not cookies;
//   - responses carry CORS headers for the allowed page origins.

const { Platform } = require('../platform');
const { Store, HttpError } = require('../store');
const { handleTenantApi } = require('../api');
const { handleAdminApi } = require('../admin');
const { dbFiles } = require('../files');

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function fromBase64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

function createEdgeHandler(options) {
  const platform = new Platform({
    dataDir: options.dataDir || '/tmp/property-manager',
    databaseUrl: options.databaseUrl,
    defaultCountryCode: options.defaultCountryCode || '91',
    inviteCode: options.inviteCode || '',
    adminPassword: options.adminPassword || '',
    poolSize: options.poolSize,
  });
  const ready = platform.init();
  const currency = options.currency || 'INR';
  const allowed = new Set(options.allowedOrigins || []);

  function cors(request) {
    const origin = request.headers.get('origin') || '';
    return {
      'Access-Control-Allow-Origin': allowed.has(origin) ? origin : [...allowed][0] || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-requested-with, x-session, x-admin-session, authorization, apikey, x-client-info',
      'Access-Control-Expose-Headers': 'content-disposition',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
  }

  function json(request, status, body, extra = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors(request), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
    });
  }

  async function readBody(request) {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request is too large');
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
    throw new HttpError(400, 'Invalid JSON');
  }

  const clientKey = (request) =>
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('cf-connecting-ip') || 'unknown';

  async function handle(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
    try {
      await ready;
      const url = new URL(request.url);
      const at = url.pathname.indexOf('/api/');
      if (at < 0) return json(request, 200, { ok: true, service: 'property-manager' });
      const parts = url.pathname.slice(at + 5).split('/').filter(Boolean);
      const query = Object.fromEntries(url.searchParams);
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('x-requested-with') !== 'fetch') {
        throw new HttpError(403, 'Missing X-Requested-With header');
      }

      if (parts[0] === 'admin') {
        const result = await handleAdminApi(platform, {
          method: request.method,
          parts: parts.slice(1),
          readBody: () => readBody(request),
          token: request.headers.get('x-admin-session') || '',
          clientKey: clientKey(request),
        });
        const body = result.setToken !== undefined ? { ...result.json, token: result.setToken } : result.json;
        const extra = result.download ? { 'Content-Disposition': `attachment; filename="${result.download}"` } : {};
        return json(request, result.status, body, extra);
      }

      const token = request.headers.get('x-session') || '';
      if (parts[0] === 'auth') {
        const action = parts[1];
        if (action === 'config' && request.method === 'GET') return json(request, 200, await platform.publicConfig());
        if (action === 'me' && request.method === 'GET') {
          const company = await platform.companyForToken(token);
          if (!company) throw new HttpError(401, 'Please log in');
          return json(request, 200, { company });
        }
        if ((action === 'signup' || action === 'login') && request.method === 'POST') {
          const body = await readBody(request);
          const company =
            action === 'signup' ? await platform.signup(body) : await platform.login(body.phone, body.password, clientKey(request));
          const session = await platform.createSession(company.id);
          return json(request, action === 'signup' ? 201 : 200, { company, token: session.token });
        }
        if (action === 'logout' && request.method === 'POST') {
          await platform.logout(token);
          return json(request, 200, { ok: true, token: '' });
        }
        throw new HttpError(404, 'Not found');
      }

      const company = await platform.companyForToken(token);
      if (!company) throw new HttpError(401, 'Please log in');
      const settings = await platform.settings();
      const result = await platform.withTenant(company.id, (database) =>
        handleTenantApi(
          {
            database,
            store: new Store(database),
            files: dbFiles(database, { decodeBase64: fromBase64 }),
            currency,
            maxFileBytes: MAX_FILE_BYTES,
            notice: settings.notice,
            readOnly: settings.read_only === '1',
            onFeedback: (body) => platform.addFeedback(company.id, body),
          },
          { method: request.method, parts, query, company, readBody: () => readBody(request) },
        ),
      );
      if (result.file) {
        const { bytes, mime, name } = result.file;
        return new Response(bytes, {
          status: result.status,
          headers: {
            ...cors(request),
            'Content-Type': mime,
            'Content-Disposition': `attachment; filename="${name.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            'Cache-Control': 'private, no-store',
          },
        });
      }
      if (result.text !== undefined) {
        return new Response(result.text, { status: result.status, headers: { ...cors(request), ...result.headers } });
      }
      return json(request, result.status, result.json);
    } catch (err) {
      if (err instanceof HttpError) return json(request, err.status, { error: err.message, details: err.details || null });
      console.error(err);
      return json(request, 500, { error: 'Internal server error' });
    }
  }

  handle.ready = ready;
  handle.platform = platform;
  handle.close = async () => {
    await ready.catch(() => {});
    await platform.close();
  };
  return handle;
}

module.exports = { createEdgeHandler };
