'use strict';

// Uploaded documents, stored in the company's own database (`files` table) so
// a Supabase/Postgres deployment keeps everything in one place.
// `legacyDir` (SQLite servers only) holds uploads saved as files by older versions.

const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./store');

function dbFiles(db, { decodeBase64, legacyDir = null }) {
  const legacyPath = (stored) => (legacyDir && /^[0-9a-f-]{36}$/.test(stored) ? path.join(legacyDir, stored) : null);
  return {
    async save(base64) {
      const bytes = decodeBase64(base64);
      const stored = globalThis.crypto.randomUUID();
      await db.run('INSERT INTO files (stored, data) VALUES (?, ?)', stored, bytes);
      return { stored, size: bytes.length };
    },
    async read(stored) {
      const row = await db.get('SELECT data FROM files WHERE stored = ?', stored);
      if (row) return row.data;
      const legacy = legacyPath(stored);
      if (legacy && fs.existsSync(legacy)) return fs.readFileSync(legacy);
      throw new HttpError(404, 'File is missing');
    },
    async remove(stored) {
      if (!stored) return;
      await db.run('DELETE FROM files WHERE stored = ?', stored);
      const legacy = legacyPath(stored);
      if (legacy) fs.rmSync(legacy, { force: true });
    },
  };
}

module.exports = { dbFiles };
