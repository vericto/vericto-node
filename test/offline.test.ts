// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline mode against a fake `vericto serve --stdio` (scripts/serve-stub.mjs):
 * configuration, hello and version checks, the verdict mapping, id matching, errors,
 * fail modes, crash and restart, timeouts, size limits, concurrency, close and the
 * event loop.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  OfflineEvaluator,
  Vericto,
  VerictoBlockedError,
  VerictoConfigError,
  VerictoUnavailableError,
  VerictoUnsupportedDialectError,
  type VerictoLogger,
  type VerictoOptions,
} from '../src/index.js';
import { resolveCliPath, versionAtLeast } from '../src/offline.js';
import { FakeServe, alive, until } from './fake-serve.js';

// Every test starts real processes; endpoint scanners on developer machines can make the
// first start of a new executable take seconds.
vi.setConfig({ testTimeout: 30_000 });

const serve = new FakeServe();
const open: Vericto[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((v) => v.close()));
});
afterAll(() => {
  serve.cleanup();
});

/** A recording logger: every message, at every level. */
function recorder(): VerictoLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (m: string) => {
    lines.push(`${level}: ${m}`);
  };
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

function offline(flags: string[] = [], options: VerictoOptions = {}): { vericto: Vericto; spawnLog: string } {
  const { path, spawnLog } = serve.cli(flags);
  const vericto = new Vericto({ offline: true, offlineCliPath: path, logger: false, env: {}, ...options });
  open.push(vericto);
  return { vericto, spawnLog };
}

const processHandles = () => process.getActiveResourcesInfo().filter((r) => r === 'ProcessWrap').length;

describe('configuration', () => {
  it('is opt-in: offline: true or VERICTO_OFFLINE, never automatic', () => {
    expect(() => new Vericto({ env: {} })).toThrow(/No Vericto API key.*offline: true/);
    expect(new Vericto({ offline: true, env: {} }).offline).toBe(true);
    for (const value of ['1', 'true', 'YES', 'on']) {
      expect(new Vericto({ env: { VERICTO_OFFLINE: value } }).offline).toBe(true);
    }
    for (const value of ['0', 'false', 'off', '']) {
      expect(() => new Vericto({ env: { VERICTO_OFFLINE: value } })).toThrow(/No Vericto API key/);
    }
    // The option wins over the environment.
    expect(
      new Vericto({ offline: false, apiKey: 'vtro_x', databaseId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', env: { VERICTO_OFFLINE: '1' } })
        .offline,
    ).toBe(false);
    expect(() => new Vericto({ env: { VERICTO_OFFLINE: 'maybe' } })).toThrow(VerictoConfigError);
    expect(() => new Vericto({ offline: 'yes' as unknown as boolean, env: {} })).toThrow(/offline must be true or false/);
  });

  it('refuses offline together with an API key or an evaluator: choose one', () => {
    const conflict = (options: VerictoOptions) => {
      try {
        new Vericto({ env: {}, ...options });
      } catch (err) {
        return err as VerictoConfigError;
      }
      throw new Error('expected a VerictoConfigError');
    };
    expect(conflict({ offline: true, apiKey: 'vtro_abc' }).message).toMatch(/choose one/);
    expect(conflict({ offline: true, env: { VERICTO_API_KEY: 'vtro_abc' } }).message).toMatch(/VERICTO_API_KEY.*choose one/);
    expect(conflict({ env: { VERICTO_OFFLINE: '1', VERICTO_API_KEY: 'vtro_abc' } }).code).toBe('OFFLINE_CONFLICT');
    const evaluator = new OfflineEvaluator();
    expect(conflict({ offline: true, evaluator }).message).toMatch(/an evaluator.*choose one/);
  });

  it('validates the profile and refuses offline-only options online', () => {
    expect(() => new Vericto({ offline: true, offlineProfile: 'prod' as 'ci', env: {} })).toThrow(/'runtime' or 'ci'/);
    expect(() => new Vericto({ apiKey: 'vtro_x', databaseId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', offlineProfile: 'ci', env: {} })).toThrow(
      /need offline: true/,
    );
    expect(() => new OfflineEvaluator({ timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => new OfflineEvaluator({ startTimeoutMs: -1 })).toThrow(/startTimeoutMs/);
    expect(new OfflineEvaluator({ env: {} }).timeoutMs).toBe(30_000);
    expect(new OfflineEvaluator({ env: { VERICTO_TIMEOUT: '2' } }).timeoutMs).toBe(30_000);
    expect(new OfflineEvaluator({ timeoutMs: 2000 }).timeoutMs).toBe(2000);
    const e = new OfflineEvaluator({ profile: 'ci' });
    expect(String(e)).toBe('OfflineEvaluator(profile=ci)');
    expect(JSON.parse(JSON.stringify(e))).toEqual({ mode: 'offline', profile: 'ci' });
  });

  it('starts nothing until the first check', async () => {
    const { vericto, spawnLog } = offline();
    await new Promise((r) => setTimeout(r, 50));
    expect(FakeServe.pids(spawnLog)).toEqual([]);
    await vericto.check('SELECT 1', 'postgres');
    expect(FakeServe.pids(spawnLog)).toHaveLength(1);
  });
});

describe('hello and the CLI version', () => {
  it('reads the hello (ignoring unknown fields) and reports it', async () => {
    const { path } = serve.cli();
    const e = new OfflineEvaluator({ cliPath: path, env: {} });
    const info = await e.start();
    expect(info).toMatchObject({ path, cliVersion: '2.1.0', engineVersion: '5.0.0', profiles: ['runtime', 'ci'], maxLineBytes: 1048576 });
    expect(String(e)).toBe('OfflineEvaluator(profile=runtime, cli=2.1.0, engine=5.0.0)');
    await e.ping();
    await e.close();
  });

  it.each([
    [['--version-of', '2.0.0'], 'CLI_TOO_OLD', /is 2\.0\.0; offline mode needs 2\.1\.0/],
    [['--version-of', '2.1.0-rc.1'], 'CLI_TOO_OLD', /needs 2\.1\.0/],
    [['--no-serve', '--version-of', '1.8.1'], 'CLI_TOO_OLD', /is 1\.8\.1; offline mode needs 2\.1\.0/],
    [['--protocol', '2', '--version-of', '3.0.0'], 'CLI_PROTOCOL_MISMATCH', /protocol 2; this SDK speaks 1/],
    [['--garbage-hello'], 'CLI_PROTOCOL_MISMATCH', /no hello line/],
  ])('%j is a VerictoConfigError (%s), in both fail modes, and is not retried', async (flags, code, message) => {
    for (const failMode of ['closed', 'open'] as const) {
      const { vericto, spawnLog } = offline(flags, { failMode });
      const err = await vericto.enforce('SELECT 1', 'postgres').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VerictoConfigError);
      expect((err as VerictoConfigError).code).toBe(code);
      expect((err as Error).message).toMatch(message);
      if (code === 'CLI_TOO_OLD') expect((err as Error).message).toContain('npm install --save-dev @vericto/vericto-cli');
      // Cached: the second check gets the same error without starting a process.
      await expect(vericto.check('SELECT 1', 'postgres')).rejects.toBe(err);
      expect(FakeServe.pids(spawnLog)).toHaveLength(1);
    }
  });

  it('compares versions as semver', () => {
    expect(versionAtLeast('2.1.0', '2.1.0')).toBe(true);
    expect(versionAtLeast('v2.10.0', '2.9.9')).toBe(true);
    expect(versionAtLeast('3.0.0', '2.1.0')).toBe(true);
    expect(versionAtLeast('2.0.9', '2.1.0')).toBe(false);
    expect(versionAtLeast('2.1.0-rc.1', '2.1.0')).toBe(false);
    expect(versionAtLeast('2.1.0-rc.2', '2.1.0-rc.1')).toBe(true);
    expect(versionAtLeast('nope', '2.1.0')).toBe(false);
  });

  it('a process that never says hello is unavailable (fail mode applies)', async () => {
    const hang = join(serve.dir, 'silent-vericto');
    writeFileSync(hang, `#!/bin/sh\nexec sleep 30\n`, { mode: 0o755 });
    const e = new OfflineEvaluator({ cliPath: hang, startTimeoutMs: 100, env: {} });
    const err = await e.evaluate('SELECT 1', 'postgres').catch((x: unknown) => x);
    expect(err).toBeInstanceOf(VerictoUnavailableError);
    expect((err as VerictoUnavailableError).code).toBe('CLI_START_TIMEOUT');
    await e.close();
  });
});

describe('finding the binary', () => {
  it('offlineCliPath / VERICTO_CLI that do not exist are CLI_NOT_FOUND with the install command', async () => {
    const e = new OfflineEvaluator({ cliPath: '/nonexistent/vericto', env: {} });
    const err = await e.evaluate('SELECT 1', 'postgres').catch((x: unknown) => x);
    expect(err).toBeInstanceOf(VerictoConfigError);
    expect((err as VerictoConfigError).code).toBe('CLI_NOT_FOUND');
    expect((err as Error).message).toMatch(/offlineCliPath points to "\/nonexistent\/vericto"/);
    expect((err as Error).message).toMatch(/npm install --save-dev @vericto\/vericto-cli@\^2\.1\.0/);
    await expect(resolveCliPath('/nope', 'VERICTO_CLI', {})).rejects.toThrow(/VERICTO_CLI points to/);
    // Fail open does not run anything unchecked on a missing CLI.
    const v = new Vericto({ offline: true, failMode: 'open', logger: false, env: { VERICTO_CLI: '/nonexistent/vericto' } });
    await expect(v.enforce('SELECT 1', 'postgres')).rejects.toMatchObject({ code: 'CLI_NOT_FOUND' });
  });

  it('order: explicit path, then @vericto/vericto-cli in node_modules, then PATH', async () => {
    const app = join(serve.dir, 'app');
    const pkg = join(app, 'node_modules', '@vericto', 'vericto-cli');
    mkdirSync(join(pkg, 'node_modules', '.bin_real'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@vericto/vericto-cli', bin: { vericto: 'run-vericto.js' } }));
    writeFileSync(join(pkg, 'run-vericto.js'), '// the launcher: never run by the SDK\n');
    const onPath = serve.cli([], { dir: join(serve.dir, 'bin') }).path;
    const env = { PATH: join(serve.dir, 'bin') };

    // The package is there but its binary is not (its install script did not run): PATH.
    expect(await resolveCliPath(undefined, 'VERICTO_CLI', env, [join(app, 'src')])).toBe(onPath);
    const missing = await resolveCliPath(undefined, 'VERICTO_CLI', {}, [join(app, 'src')]).catch((x: unknown) => x);
    expect((missing as VerictoConfigError).code).toBe('CLI_NOT_FOUND');
    expect((missing as Error).message).toMatch(/is installed at .*but its binary is not.*npm rebuild @vericto\/vericto-cli/);

    // Its native binary, found next to the bin metadata, wins over PATH.
    const native = serve.cli([], { dir: join(pkg, 'node_modules', '.bin_real') }).path;
    expect(await resolveCliPath(undefined, 'VERICTO_CLI', env, [join(app, 'src')])).toBe(native);
    // A package whose bin is the binary itself.
    const direct = join(serve.dir, 'app2', 'node_modules', '@vericto', 'vericto-cli');
    mkdirSync(direct, { recursive: true });
    writeFileSync(join(direct, 'package.json'), JSON.stringify({ name: '@vericto/vericto-cli', bin: 'vericto-bin' }));
    const directBin = serve.cli([], { dir: direct, name: 'vericto-bin' }).path;
    expect(await resolveCliPath(undefined, 'VERICTO_CLI', {}, [join(serve.dir, 'app2')])).toBe(directBin);

    // An explicit path wins over everything; a bare name is looked up on PATH.
    const explicit = serve.cli().path;
    expect(await resolveCliPath(explicit, 'offlineCliPath', env, [join(app, 'src')])).toBe(explicit);
    expect(await resolveCliPath('vericto', 'VERICTO_CLI', env, [])).toBe(onPath);
    await expect(resolveCliPath(undefined, 'VERICTO_CLI', {}, [])).rejects.toThrow(/could not find the Vericto CLI/);

    // End to end through the guard: the node_modules binary is the one started.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(app, 'src'));
    try {
      const v = new Vericto({ offline: true, logger: false, env });
      open.push(v);
      expect((await (v.evaluator as OfflineEvaluator).start()).path).toBe(native);
    } finally {
      cwd.mockRestore();
    }
  });

  it('a binary that cannot be run is a configuration error', async () => {
    const file = join(serve.dir, 'not-executable');
    writeFileSync(file, 'plain text\n', { mode: 0o644 });
    const e = new OfflineEvaluator({ cliPath: file, env: {} });
    await expect(e.evaluate('SELECT 1', 'postgres')).rejects.toMatchObject({ code: 'CLI_NOT_FOUND' });
  });
});

describe('verdicts', () => {
  it('maps a result through the online path: mode, engineVersion, rulesetVersion', async () => {
    const { vericto } = offline();
    const v = await vericto.check('DROP TABLE users', 'postgres');
    expect(v).toMatchObject({
      decision: 'BLOCKED',
      sql: 'DROP TABLE users',
      dialect: 'postgres',
      ruleCode: 'VERICTO-010',
      severity: 'critical',
      suggestedFix: 'Use a versioned migration tool (Flyway, Prisma Migrate, Alembic, Rails migrations)',
      mode: 'offline',
      engineVersion: '5.0.0',
      rulesetVersion: 'standard@engine-5.0.0',
      rewrittenQuery: undefined,
      sensitiveColumns: [],
      accessDenied: [],
      eventId: undefined,
      cached: false,
    });
    expect(v.findings).toEqual([{ ruleCode: 'VERICTO-010', severity: 'critical', ruleId: undefined, astNodePath: 'DropStmt', suggestedFix: 'Use a versioned migration tool (Flyway, Prisma Migrate, Alembic, Rails migrations)' }]);
    expect(v.raw).toMatchObject({ mode: 'offline', profile: 'runtime', action: 'block' });
    expect((v.raw.result as { exit_code: number }).exit_code).toBe(1);
    await expect(vericto.enforce('DELETE FROM users', 'pg')).rejects.toBeInstanceOf(VerictoBlockedError);
    expect((await vericto.check('SELECT 1', 'postgres')).decision).toBe('ALLOWED');
    const parse = await vericto.check('SELEC 1', 'postgres');
    expect(parse).toMatchObject({ decision: 'PARSE_ERROR', ruleCode: undefined, findings: [] });
  });

  it("the ci profile caps schema DDL at FLAGGED, as vericto check --offline", async () => {
    const { vericto } = offline([], { offlineProfile: 'ci' });
    const v = await vericto.enforce('DROP TABLE users', 'postgres');
    expect(v).toMatchObject({ decision: 'FLAGGED', ruleCode: 'VERICTO-010', mode: 'offline' });
    expect(v.raw.profile).toBe('ci');
  });

  it('caches verdicts and calls onVerdict as online', async () => {
    const seen: string[] = [];
    const { vericto, spawnLog } = offline([], { cacheTtlMs: 60_000, onVerdict: (v) => seen.push(v.decision) });
    await vericto.enforce('SELECT 1', 'postgres');
    const again = await vericto.enforce('SELECT 1', 'postgres');
    expect(again.cached).toBe(true);
    expect(seen).toEqual(['ALLOWED', 'ALLOWED']);
    expect(FakeServe.pids(spawnLog)).toHaveLength(1);
  });

  it('context and endUser have no effect offline: noted once at info level', async () => {
    const log = recorder();
    const { vericto } = offline([], { logger: log });
    await vericto.check('SELECT 1', 'postgres', { context: { ticket: 'CHG-1' } });
    await vericto.check('SELECT 2', 'postgres', { endUser: { role: 'admin' } });
    expect(log.lines.filter((l) => l.includes('no effect offline'))).toHaveLength(1);
  });

  it('matches responses by id, whatever their order', async () => {
    const { vericto } = offline(['--reverse']);
    const [a, b] = await Promise.all([vericto.check('DELETE FROM t', 'postgres'), vericto.check('SELECT 1', 'postgres')]);
    expect([a.sql, a.decision, b.sql, b.decision]).toEqual(['DELETE FROM t', 'BLOCKED', 'SELECT 1', 'ALLOWED']);
  });

  it('answers 200 concurrent checks, each with its own verdict', async () => {
    const { vericto, spawnLog } = offline();
    const sqls = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? `DELETE FROM t${String(i)}` : `SELECT ${String(i)}`));
    const verdicts = await Promise.all(sqls.map((sql) => vericto.check(sql, 'postgres')));
    verdicts.forEach((v, i) => {
      expect(v.sql).toBe(sqls[i]);
      expect(v.decision).toBe(i % 3 === 0 ? 'BLOCKED' : 'ALLOWED');
    });
    expect(FakeServe.pids(spawnLog)).toHaveLength(1);
  });

  it('applies backpressure: a large pipelined batch is written as the pipe drains', async () => {
    const { vericto } = offline();
    const big = `SELECT '${'x'.repeat(200_000)}'`;
    const verdicts = await Promise.all(Array.from({ length: 20 }, () => vericto.check(big, 'postgres')));
    expect(verdicts.every((v) => v.decision === 'ALLOWED')).toBe(true);
  });
});

describe('errors', () => {
  it('UNSUPPORTED_DIALECT is VerictoUnsupportedDialectError, INVALID_REQUEST a VerictoConfigError', async () => {
    const { vericto } = offline([], { failMode: 'open' });
    const err = await vericto.check('SELECT 1', 'db2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoUnsupportedDialectError);
    expect((err as Error).message).toMatch(/local Vericto engine.*'db2'.*No SQL was executed/);
    expect((err as VerictoUnsupportedDialectError).supported).toContain('sqlite');
    const invalid = await vericto.check('   ', 'postgres').catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(VerictoConfigError);
    expect((invalid as VerictoConfigError).code).toBe('INVALID_REQUEST');
    // The session survives request errors.
    expect((await vericto.check('SELECT 1', 'postgres')).decision).toBe('ALLOWED');
  });

  it('too-large input is VerictoConfigError TOO_LARGE (no HTTP status), checked before it is sent', async () => {
    const { vericto } = offline(['--max-line-bytes', '1024'], { failMode: 'open' });
    const err = await vericto.enforce(`SELECT '${'x'.repeat(2000)}'`, 'postgres').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoConfigError);
    expect(err).toMatchObject({ code: 'TOO_LARGE' });
    expect((err as { status?: number }).status).toBeUndefined();
    expect((err as Error).message).not.toContain('xxxx');
    // A TOO_LARGE answer from the server (id null) goes to the oldest request in flight.
    const nullId = await vericto.enforce('NULLID', 'postgres').catch((e: unknown) => e);
    expect(nullId).toMatchObject({ code: 'TOO_LARGE' });
    expect((await vericto.check('SELECT 1', 'postgres')).decision).toBe('ALLOWED');
  });

  it('INTERNAL is VerictoUnavailableError: closed rejects, open answers UNEVALUATED', async () => {
    const { vericto } = offline();
    await expect(vericto.enforce('INTERNAL', 'postgres')).rejects.toMatchObject({ name: 'VerictoUnavailableError', code: 'INTERNAL' });
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const { vericto: lenient } = offline([], { failMode: 'open' });
      const v = await lenient.enforce('INTERNAL', 'postgres');
      expect(v).toMatchObject({ decision: 'UNEVALUATED', mode: 'offline' });
      expect(v.message).toMatch(/engine failure/);
      expect(warn).toHaveBeenCalledOnce();
      expect((await lenient.check('INTERNAL', 'postgres')).decision).toBe('UNEVALUATED');
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['MALFORMED', /not JSON/],
    ['WRONGID', /id that was not sent/],
  ])('a protocol violation (%s) is unavailable, and the next check restarts the process', async (sql, message) => {
    const { vericto, spawnLog } = offline();
    const err = await vericto.check(sql, 'postgres').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoUnavailableError);
    expect((err as VerictoUnavailableError).code).toBe('MALFORMED_RESPONSE');
    expect((err as Error).message).toMatch(message);
    expect((await vericto.check('SELECT 1', 'postgres')).decision).toBe('ALLOWED');
    expect(FakeServe.pids(spawnLog)).toHaveLength(2);
  });

  it('a result without a status, or a response without ok, is unavailable; the session survives', async () => {
    const { vericto, spawnLog } = offline();
    await expect(vericto.check('NOSTATUS', 'postgres')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    await expect(vericto.check('NOOK', 'postgres')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
    expect((await vericto.check('SELECT 1', 'postgres')).decision).toBe('ALLOWED');
    expect(FakeServe.pids(spawnLog)).toHaveLength(1);
  });

  it('a check with no answer times out (unavailable) and the process is replaced', async () => {
    const { vericto, spawnLog } = offline([], { timeoutMs: 150 });
    const err = await vericto.check('HANG', 'postgres').catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'VerictoUnavailableError', code: 'TIMEOUT' });
    const [first] = FakeServe.pids(spawnLog);
    await until(() => !alive(first!));
    expect((await vericto.check('SELECT 1', 'postgres')).decision).toBe('ALLOWED');
    expect(FakeServe.pids(spawnLog)).toHaveLength(2);
  });
});

describe('crash and restart', () => {
  it('rejects what was pending with VerictoUnavailableError, then restarts once', async () => {
    const { vericto, spawnLog } = offline();
    const pending = Promise.all([vericto.check('SELECT 1', 'postgres'), vericto.check('CRASH', 'postgres')].map((p) => p.catch((e: unknown) => e)));
    const [ok, crashed] = await pending;
    expect((ok as { decision: string }).decision).toBe('ALLOWED');
    expect(crashed).toBeInstanceOf(VerictoUnavailableError);
    expect((crashed as VerictoUnavailableError).code).toBe('CLI_EXITED');
    expect((crashed as Error).message).toMatch(/exited unexpectedly \(code 3\)/);
    // Restarted on the next check, which also resets the restart budget.
    expect((await vericto.check('SELECT 2', 'postgres')).decision).toBe('ALLOWED');
    await expect(vericto.check('CRASH', 'postgres')).rejects.toBeInstanceOf(VerictoUnavailableError);
    expect((await vericto.check('SELECT 3', 'postgres')).decision).toBe('ALLOWED');
    expect(FakeServe.pids(spawnLog)).toHaveLength(3);
  });

  it('stops restarting after two failures in a row; fail open runs unevaluated', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const { vericto, spawnLog } = offline([], { failMode: 'open' });
      expect((await vericto.enforce('CRASH', 'postgres')).decision).toBe('UNEVALUATED');
      expect((await vericto.enforce('CRASH', 'postgres')).decision).toBe('UNEVALUATED');
      const third = await vericto.enforce('SELECT 1', 'postgres');
      expect(third).toMatchObject({ decision: 'UNEVALUATED', mode: 'offline' });
      expect(third.message).toMatch(/not restarted any more/);
      expect(FakeServe.pids(spawnLog)).toHaveLength(2);
      const closed = new Vericto({ offline: true, offlineCliPath: serve.cli().path, logger: false, env: {} });
      open.push(closed);
      await expect(closed.enforce('CRASH', 'postgres')).rejects.toBeInstanceOf(VerictoUnavailableError);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('lifecycle', () => {
  it('close() answers what was sent, stops the process, and refuses later checks', async () => {
    const { vericto, spawnLog } = offline();
    const inFlight = vericto.check('DELETE FROM t', 'postgres');
    await new Promise((r) => setTimeout(r, 0));
    const closing = vericto.close();
    expect((await inFlight).decision).toBe('BLOCKED');
    await closing;
    const [pid] = FakeServe.pids(spawnLog);
    expect(alive(pid!)).toBe(false);
    await expect(vericto.check('SELECT 1', 'postgres')).rejects.toMatchObject({ name: 'VerictoConfigError', code: 'CLOSED' });
    await vericto.close(); // idempotent
  });

  it('Symbol.asyncDispose closes the client; an online client closes as a no-op', async () => {
    const { vericto, spawnLog } = offline();
    await vericto.check('SELECT 1', 'postgres');
    await vericto[Symbol.asyncDispose]();
    expect(alive(FakeServe.pids(spawnLog)[0]!)).toBe(false);
    const online = new Vericto({ apiKey: 'vtro_x', databaseId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', env: {} });
    await online.close();
    // Closed before it ever started: nothing is spawned.
    const { vericto: idle, spawnLog: idleLog } = offline();
    await idle.close();
    await expect(idle.check('SELECT 1', 'postgres')).rejects.toMatchObject({ code: 'CLOSED' });
    expect(FakeServe.pids(idleLog)).toEqual([]);
  });

  it('closing while the binary is being resolved starts nothing', async () => {
    const { path, spawnLog } = serve.cli();
    const e = new OfflineEvaluator({ cliPath: path, env: {} });
    const check = e.evaluate('SELECT 1', 'postgres').catch((x: unknown) => x);
    await e.close();
    expect(await check).toMatchObject({ code: 'CLOSED' });
    expect(FakeServe.pids(spawnLog)).toEqual([]);
  });

  it('the child keeps the event loop alive only while a check is pending', async () => {
    // The processes of the previous tests are gone first.
    await until(() => processHandles() === 0);
    const before = 0;
    const { vericto } = offline([], { timeoutMs: 300 });
    await vericto.check('SELECT 1', 'postgres');
    expect(processHandles()).toBe(before);
    const hanging = vericto.check('HANG', 'postgres').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(processHandles()).toBe(before + 1);
    await hanging;
    // close() keeps it alive until the process has exited, or `await close()` would never settle.
    await vericto.check('SELECT 1', 'postgres');
    expect(processHandles()).toBe(before);
    const closing = vericto.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(processHandles()).toBe(before + 1);
    await closing;
    await until(() => processHandles() === before);
  });

  it("the child's stderr goes to the logger at debug level; SQL never reaches the logs", async () => {
    const log = recorder();
    const { vericto } = offline([], { logger: log });
    const secret = "SELECT 'ana@example.com' AS secret_literal";
    await vericto.check(secret, 'postgres');
    await vericto.check('STDERR', 'postgres');
    await expect(vericto.check('DELETE FROM secret_table', 'postgres').then((v) => v.decision)).resolves.toBe('BLOCKED');
    await vericto.enforce('DELETE FROM secret_table', 'postgres').catch(() => undefined);
    await vericto.close();
    expect(log.lines).toContain('debug: vericto serve: serve-stub: ready');
    expect(log.lines).toContain('debug: vericto serve: serve-stub: a diagnostic line');
    expect(log.lines.some((l) => l.startsWith('debug: vericto: offline mode, vericto serve 2.1.0 (engine 5.0.0)'))).toBe(true);
    expect(log.lines.join('\n')).not.toMatch(/ana@example|secret_literal|secret_table/);
  });
});
