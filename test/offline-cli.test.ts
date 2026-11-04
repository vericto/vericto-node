// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline mode against the real Vericto CLI (`vericto serve --stdio`, 2.1.0 or later),
 * and parity with `vericto check --offline --format json`.
 *
 * The binary is `VERICTO_CLI`, else what offline mode itself would find
 * (`@vericto/vericto-cli` in node_modules, then `vericto` on PATH). Without a CLI
 * 2.1.0 or later these tests are skipped, and say so; with `VERICTO_CLI_REQUIRED=1`
 * (the CI offline job) they fail instead.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { OfflineEvaluator, Vericto, VerictoBlockedError, VerictoConfigError, VerictoUnsupportedDialectError } from '../src/index.js';
import { MIN_CLI_VERSION, resolveCliPath, versionAtLeast } from '../src/offline.js';
import { alive, until } from './fake-serve.js';

async function findCli(): Promise<{ path: string; version: string } | { skip: string }> {
  let path: string;
  try {
    path = await resolveCliPath(process.env.VERICTO_CLI?.trim() || undefined, 'VERICTO_CLI', process.env);
  } catch {
    return { skip: 'no Vericto CLI found (set VERICTO_CLI, or install @vericto/vericto-cli)' };
  }
  let out: string;
  try {
    out = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  } catch {
    return { skip: `${path} --version failed` };
  }
  const version = /(\d+\.\d+\.\d+[\w.+-]*)/.exec(out)?.[1] ?? '';
  if (!versionAtLeast(version, MIN_CLI_VERSION)) return { skip: `${path} is ${version || 'unknown'}, older than ${MIN_CLI_VERSION}` };
  return { path, version };
}

const found = await findCli();
const cli = 'path' in found ? found : undefined;
if (!cli) {
  const why = (found as { skip: string }).skip;
  if (process.env.VERICTO_CLI_REQUIRED === '1') throw new Error(`[offline-cli] VERICTO_CLI_REQUIRED=1 but ${why}`);
  console.warn(`[offline-cli] skipped: ${why}`);
}

/** Cases across the six dialects; the CLI is the oracle for every field. */
const CASES: [name: string, dialect: string, sql: string][] = [
  ['delete-no-where', 'postgres', 'DELETE FROM users'],
  ['drop-table', 'postgres', 'DROP TABLE users'],
  ['update-no-where', 'postgres', 'UPDATE accounts SET balance = 0'],
  ['insert-no-columns', 'postgres', 'INSERT INTO audit VALUES (1, 2)'],
  ['safe-select', 'postgres', 'SELECT id, email FROM users WHERE id = 42 LIMIT 10'],
  ['parse-error', 'postgres', 'SELEC id FROM users'],
  ['multi-statement', 'postgres', 'DROP TABLE a; UPDATE accounts SET balance = 0;'],
  ['constant-predicate', 'postgres', 'DELETE FROM users WHERE 1 = 1'],
  ['pg-sleep', 'postgres', 'SELECT pg_sleep(10)'],
  ['mysql-backticks', 'mysql', 'DELETE FROM `users`'],
  ['mysql-select', 'mysql', 'SELECT * FROM users WHERE id = 1'],
  ['mssql-select-into', 'mssql', 'SELECT * INTO users_backup FROM users'],
  ['snowflake-insert-select-star', 'snowflake', 'INSERT INTO t SELECT * FROM s'],
  ['oracle-truncate', 'oracle', 'TRUNCATE TABLE users'],
  ['sqlite-alter-drop-column', 'sqlite', 'ALTER TABLE users DROP COLUMN email'],
  ['sqlite-update', 'sqlite', "UPDATE users SET email = 'x'"],
];

const DDL_RULE = /^VERICTO-01\d$/;
vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!cli)(`offline mode against the real CLI (${cli ? `${cli.version} at ${cli.path}` : 'skipped'})`, () => {
  // Made here, not at collection: a skipped suite leaves nothing behind.
  let scratch = '';
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'vericto-node-offline-cli-'));
  });
  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  /** `vericto check --offline --format json` in an empty directory, with no Vericto settings. */
  function checkOffline(sql: string, dialect: string): Record<string, unknown> {
    const env: Record<string, string> = { HOME: scratch, PATH: process.env.PATH ?? '' };
    const r = spawnSync(cli!.path, ['check', '--offline', '--format', 'json', '--dialect', dialect, '--sql', sql], {
      cwd: scratch,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.status === 0 || r.status === 1, r.stderr).toBe(true);
    return JSON.parse(r.stdout) as Record<string, unknown>;
  }

  it('says hello with protocol 1 and its versions', async () => {
    const e = new OfflineEvaluator({ cliPath: cli!.path });
    try {
      const info = await e.start();
      expect(info.cliVersion).toBe(cli!.version);
      expect(info.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(info.profiles).toEqual(expect.arrayContaining(['runtime', 'ci']));
      await e.ping();
    } finally {
      await e.close();
    }
  });

  it(`parity, ci profile: every result equals vericto check --offline --format json (${String(CASES.length)} cases)`, async () => {
    const vericto = new Vericto({ offline: true, offlineProfile: 'ci', offlineCliPath: cli!.path, logger: false, env: {} });
    try {
      for (const [name, dialect, sql] of CASES) {
        const expected = checkOffline(sql, dialect);
        const verdict = await vericto.check(sql, dialect);
        expect(verdict.raw.result, name).toEqual(expected);
        const query = (expected.queries as Record<string, unknown>[])[0]!;
        expect([name, verdict.decision, verdict.ruleCode ?? null], name).toEqual([name, query.status, query.rule_code]);
        expect(verdict.mode).toBe('offline');
        expect(verdict.rulesetVersion).toBe((expected.summary as Record<string, unknown>).ruleset_version);
        expect(verdict.engineVersion).toBe(expected.engine_version);
      }
    } finally {
      await vericto.close();
    }
  });

  it('runtime profile: DROP TABLE is BLOCKED; outside schema DDL it matches ci', async () => {
    const runtime = new Vericto({ offline: true, offlineCliPath: cli!.path, logger: false, env: {} });
    const ci = new Vericto({ offline: true, offlineProfile: 'ci', offlineCliPath: cli!.path, logger: false, env: {} });
    try {
      const drop = await runtime.check('DROP TABLE users', 'postgres');
      expect(drop).toMatchObject({ decision: 'BLOCKED', ruleCode: 'VERICTO-010', mode: 'offline' });
      await expect(runtime.enforce('DROP TABLE users', 'postgres')).rejects.toBeInstanceOf(VerictoBlockedError);
      expect((await ci.check('DROP TABLE users', 'postgres')).decision).toBe('FLAGGED');
      for (const [name, dialect, sql] of CASES) {
        const [r, c] = await Promise.all([runtime.check(sql, dialect), ci.check(sql, dialect)]);
        if (DDL_RULE.test(c.ruleCode ?? '') || DDL_RULE.test(r.ruleCode ?? '')) {
          expect([name, r.decision], name).toEqual([name, 'BLOCKED']);
        } else {
          expect([name, r.decision, r.ruleCode], name).toEqual([name, c.decision, c.ruleCode]);
        }
      }
    } finally {
      await Promise.all([runtime.close(), ci.close()]);
    }
  });

  it('multi-statement input is one verdict, the strongest finding (as online)', async () => {
    const vericto = new Vericto({ offline: true, offlineCliPath: cli!.path, logger: false, env: {} });
    try {
      const v = await vericto.check('SELECT 1; UPDATE accounts SET balance = 0;', 'postgres');
      expect(v).toMatchObject({ decision: 'BLOCKED', ruleCode: 'VERICTO-030' });
      const each = await vericto.enforceAll(['SELECT id FROM users WHERE id = 1 LIMIT 1'], 'postgres');
      expect(each).toHaveLength(1);
    } finally {
      await vericto.close();
    }
  });

  it('errors: unknown dialect, empty SQL, input over the line limit', async () => {
    const vericto = new Vericto({ offline: true, failMode: 'open', offlineCliPath: cli!.path, logger: false, env: {} });
    try {
      await expect(vericto.check('SELECT 1', 'db2')).rejects.toBeInstanceOf(VerictoUnsupportedDialectError);
      await expect(vericto.check('  ', 'postgres')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      const big = `SELECT '${'x'.repeat(1_100_000)}'`;
      const err = await vericto.enforce(big, 'postgres').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VerictoConfigError);
      expect(err).toMatchObject({ code: 'TOO_LARGE' });
      expect((err as { status?: number }).status).toBeUndefined();
      expect((await vericto.check('SELECT 1', 'sqlite3')).mode).toBe('offline');
    } finally {
      await vericto.close();
    }
  });

  it('200 concurrent checks on one process; close() leaves no process behind', async () => {
    const e = new OfflineEvaluator({ cliPath: cli!.path });
    const vericto = new Vericto({ evaluator: e, logger: false, env: {} });
    const sqls = Array.from({ length: 200 }, (_, i) => (i % 2 ? `DELETE FROM t${String(i)}` : `SELECT id FROM t${String(i)} WHERE id = 1 LIMIT 1`));
    const verdicts = await Promise.all(sqls.map((sql) => vericto.check(sql, 'postgres')));
    verdicts.forEach((v, i) => {
      expect(v.sql).toBe(sqls[i]);
      expect(v.decision).toBe(i % 2 ? 'BLOCKED' : 'ALLOWED');
    });
    const pid = e.pid;
    expect(pid).toBeGreaterThan(0);
    await vericto.close();
    expect(e.pid).toBeUndefined();
    await until(() => !alive(pid!));
  });
});
