'use strict';

// /api/admin/*: the developer admin area. Enabled only when ADMIN_PASSWORD is set.
// Resolves { status, json, setToken?, maxAge?, download? }.

const { HttpError } = require('./store');

async function handleAdminApi(platform, { method, parts, readBody, token, clientKey }) {
  if (!platform.adminEnabled()) throw new HttpError(404, 'Not found');
  const [section, id, action] = parts;

  if (section === 'login' && method === 'POST') {
    const body = await readBody();
    const session = await platform.adminLogin(body.password, clientKey);
    return { status: 200, json: { ok: true }, setToken: session.token, maxAge: session.maxAge };
  }
  if (section === 'logout' && method === 'POST') {
    await platform.adminLogout(token);
    return { status: 200, json: { ok: true }, setToken: '', maxAge: 0 };
  }
  if (!(await platform.isAdmin(token))) throw new HttpError(401, 'Admin login required');

  if (section === 'me' && method === 'GET') return { status: 200, json: { ok: true, storage: platform.storage } };
  if (section === 'analytics' && method === 'GET') return { status: 200, json: await platform.analytics() };
  if (section === 'log' && method === 'GET') return { status: 200, json: await platform.adminLogEntries() };

  if (section === 'settings') {
    if (method === 'GET') return { status: 200, json: await platform.settings() };
    if (method === 'PATCH') return { status: 200, json: await platform.updateSettings(await readBody()) };
  }

  if (section === 'feedback') {
    if (!id && method === 'GET') return { status: 200, json: await platform.listFeedback() };
    if (id && method === 'PATCH') {
      const body = await readBody();
      await platform.setFeedbackResolved(id, Boolean(body.resolved));
      return { status: 200, json: { ok: true } };
    }
  }

  if (section === 'companies' && id && /^\d+$/.test(id)) {
    if (method === 'GET' && action === 'export') {
      return { status: 200, json: await platform.exportCompany(id), download: `company-${id}-export.json` };
    }
    if (method === 'POST' && action === 'suspend') {
      await platform.setCompanyStatus(id, 'suspended');
      return { status: 200, json: { ok: true } };
    }
    if (method === 'POST' && action === 'activate') {
      await platform.setCompanyStatus(id, 'active');
      return { status: 200, json: { ok: true } };
    }
    if (method === 'POST' && action === 'sign-out') {
      return { status: 200, json: { ok: true, sessions: await platform.signOutCompany(id) } };
    }
    if (method === 'POST' && action === 'reset-password') {
      await platform.resetPassword(id, (await readBody()).password);
      return { status: 200, json: { ok: true } };
    }
    if (method === 'DELETE' && !action) {
      await platform.deleteCompany(id, (await readBody()).confirm);
      return { status: 200, json: { ok: true } };
    }
  }
  throw new HttpError(404, 'Not found');
}

module.exports = { handleAdminApi };
