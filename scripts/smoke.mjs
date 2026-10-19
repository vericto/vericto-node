// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

// Smoke test of the BUILT package (dist/), ESM and CJS, on any Node >= 18, with no
// dev dependencies: a local stand-in API, one allowed and one blocked statement
// through the snowflake entry point, and the error class identity across entries.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/meta/config') {
      res.end(JSON.stringify({ dialects: [{ id: 'snowflake' }] }));
      return;
    }
    const { query } = JSON.parse(body);
    if (query.startsWith('DELETE')) {
      res.statusCode = 403;
      res.end(JSON.stringify({ decision: 'BLOCKED', rule_code: 'VERICTO-010' }));
    } else {
      res.end(JSON.stringify({ decision: 'ALLOWED' }));
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

const fakeConnection = {
  executed: [],
  execute(options) {
    this.executed.push(options.sqlText);
    setImmediate(() => options.complete?.(undefined, {}, []));
    return {};
  },
};

async function run(core, snowflake, label) {
  const vericto = new core.Vericto({
    apiKey: 'vtro_smoke_test',
    databaseId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    apiUrl,
    logger: false,
    env: {},
  });
  const conn = await snowflake.guardConnection(fakeConnection, { vericto });
  await conn.query('SELECT 1');
  await assert.rejects(conn.query('DELETE FROM t'), (err) => err instanceof core.VerictoBlockedError);
  console.log(`${label}: ok (${core.VERSION})`);
}

// The LangChain entry is opt-in: nothing but dist/langchain.* may load its peers, so
// the root and driver entries work without @langchain/* or typeorm installed (this
// job runs with no node_modules at all).
for (const file of readdirSync(new URL('../dist/', import.meta.url))) {
  if (!/\.(c?js)$/.test(file) || file.startsWith('langchain.')) continue;
  const code = readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8');
  assert.ok(!/@langchain\/|typeorm/.test(code), `${file} references an optional LangChain peer`);
}

try {
  await run(await import('../dist/index.js'), await import('../dist/snowflake.js'), 'esm');
  await run(require('../dist/index.cjs'), require('../dist/snowflake.cjs'), 'cjs');
  assert.deepEqual(fakeConnection.executed, ['SELECT 1', 'SELECT 1']);
} finally {
  server.close();
}
