// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

// Smoke test of the BUILT package (dist/), ESM and CJS, on any Node >= 18, with no
// dev dependencies: a local stand-in API, one allowed and one blocked statement
// through the snowflake entry point, the error class identity across entries, and no
// framework entry leaking into another. Offline mode (POSIX): checks through a fake
// `vericto serve --stdio` (scripts/serve-stub.mjs), `node:child_process` loaded
// only on first use, and a process that does not close its client still exits and
// leaves no child behind.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// The framework entries are opt-in: only dist/<entry>.* may load that framework, so
// the root, the driver entries and every other framework entry work without it (this
// job runs with no node_modules at all).
const FRAMEWORKS = {
  langchain: /@langchain\/|typeorm/,
  ai: /from ["']ai["']|require\(["']ai["']\)/,
  'openai-agents': /@openai\/agents/,
  mastra: /@mastra\//,
};
// Offline mode spawns the CLI with node:child_process, imported on first use only: no
// entry (the root included) loads it at import time.
const STATIC_CHILD_PROCESS = /^\s*import\s[^;]*from\s*["'](node:)?child_process["']|require\(["'](node:)?child_process["']\)/m;
for (const file of readdirSync(new URL('../dist/', import.meta.url))) {
  if (!/\.(c?js)$/.test(file)) continue;
  const code = readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8');
  for (const [entry, pattern] of Object.entries(FRAMEWORKS)) {
    if (file.startsWith(`${entry}.`)) continue;
    assert.ok(!pattern.test(code), `${file} references the optional ${entry} peer`);
  }
  assert.ok(!STATIC_CHILD_PROCESS.test(code), `${file} loads node:child_process at import time`);
}

/** Offline mode end to end on the built package, against the fake `vericto serve`. */
async function runOffline(core, label, cli) {
  const vericto = new core.Vericto({ offline: true, offlineCliPath: cli, logger: false, env: {} });
  try {
    // A bare start() keeps the process alive until the hello, as a pending check does.
    assert.equal((await vericto.evaluator.start()).cliVersion, '2.1.0');
    const allowed = await vericto.check('SELECT 1', 'postgres');
    assert.equal(allowed.decision, 'ALLOWED');
    assert.equal(allowed.mode, 'offline');
    assert.equal(allowed.rulesetVersion, 'standard@engine-5.0.0');
    await assert.rejects(vericto.enforce('DELETE FROM t', 'postgres'), (err) => err instanceof core.VerictoBlockedError);
  } finally {
    await vericto.close();
  }
  console.log(`${label} offline: ok`);
}

function offlineFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'vericto-smoke-'));
  const script = fileURLToPath(new URL('./serve-stub.mjs', import.meta.url));
  const spawnLog = join(dir, 'spawns.log');
  const cli = join(dir, 'vericto');
  writeFileSync(cli, `#!/bin/sh\nexec '${process.execPath}' '${script}' --spawn-log '${spawnLog}' "$@"\n`);
  chmodSync(cli, 0o755);
  return { dir, cli, spawnLog };
}

/** A script that checks once and never closes its client: it must still exit, child included. */
function exitsWithoutClose(entry, cli, spawnLog) {
  const code =
    entry.endsWith('.cjs')
      ? `const { Vericto } = require(${JSON.stringify(entry)});`
      : `import { Vericto } from ${JSON.stringify(entry)};`;
  const body = `${code}
const v = new Vericto({ offline: true, offlineCliPath: ${JSON.stringify(cli)}, logger: false, env: {} });
v.check('SELECT 1', 'postgres').then((r) => { if (r.decision !== 'ALLOWED') process.exit(5); });`;
  const before = readSpawns(spawnLog).length;
  const r = spawnSync(process.execPath, [entry.endsWith('.cjs') ? '-e' : '--input-type=module', ...(entry.endsWith('.cjs') ? [body] : ['-e', body])], {
    timeout: 20_000,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `the process did not exit by itself (${String(r.signal ?? r.status)}): ${r.stderr}`);
  const pids = readSpawns(spawnLog).slice(before);
  assert.equal(pids.length, 1);
  return pids[0];
}

function readSpawns(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

try {
  await run(await import('../dist/index.js'), await import('../dist/snowflake.js'), 'esm');
  await run(require('../dist/index.cjs'), require('../dist/snowflake.cjs'), 'cjs');
  assert.deepEqual(fakeConnection.executed, ['SELECT 1', 'SELECT 1']);
} finally {
  server.close();
}

if (process.platform !== 'win32') {
  const { dir, cli, spawnLog } = offlineFixture();
  try {
    await runOffline(await import('../dist/index.js'), 'esm', cli);
    await runOffline(require('../dist/index.cjs'), 'cjs', cli);
    for (const entry of ['../dist/index.js', '../dist/index.cjs']) {
      const pid = exitsWithoutClose(fileURLToPath(new URL(entry, import.meta.url)), cli, spawnLog);
      // The child gets EOF (or SIGTERM) when its parent exits: no orphan.
      const end = Date.now() + 5000;
      while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      assert.ok(!alive(pid), `vericto serve (pid ${String(pid)}) outlived its parent`);
    }
    console.log('offline: no import-time child_process, exits without close(), no orphan');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
