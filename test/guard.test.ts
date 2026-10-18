import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RuntimeApiEvaluator,
  Vericto,
  VerictoBlockedError,
  VerictoConfigError,
  VerictoQuotaExceededError,
  VerictoUnavailableError,
  VerictoUnsupportedDialectError,
  sqlToExecute,
  verdictFromResponse,
  type Evaluator,
  type Verdict,
  type VerictoLogger,
} from '../src/index.js';
import { unevaluatedVerdict } from '../src/verdict.js';
import { API_KEY, DATABASE_ID, FakeVericto } from './fake-vericto.js';

/** An in-memory evaluator: the interface an embedded engine would implement. */
class StubEvaluator implements Evaluator {
  readonly apiUrl = 'stub://';
  calls: [string, string][] = [];
  dialects: readonly string[] | undefined = ['postgres', 'snowflake', 'sqlite'];
  constructor(
    public decide: Record<string, Record<string, unknown>> = {},
    public error?: Error,
  ) {}

  async evaluate(sql: string, dialect: string): Promise<Verdict> {
    this.calls.push([sql, dialect]);
    if (this.error) throw this.error;
    return verdictFromResponse(this.decide[sql] ?? { decision: 'ALLOWED' }, sql, dialect);
  }

  async supportedDialects(): Promise<readonly string[] | undefined> {
    return this.dialects;
  }
}

function recorder(): VerictoLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };
}

const guard = (evaluator: Evaluator, options: ConstructorParameters<typeof Vericto>[0] = {}) =>
  new Vericto({ evaluator, logger: false, env: {}, ...options });

describe('Vericto guard', () => {
  it('rejects a block with findings and the suggested fix', async () => {
    const seen: Verdict[] = [];
    const stub = new StubEvaluator({
      'DELETE FROM users': {
        decision: 'BLOCKED',
        rule_code: 'VERICTO-010',
        severity: 'critical',
        suggested_safe_query: 'DELETE FROM users WHERE id = ?',
        error: 'Query blocked by rule VERICTO-010',
      },
    });
    const err = await guard(stub, { onVerdict: (v) => seen.push(v) })
      .enforce('DELETE FROM users', 'postgres')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoBlockedError);
    const blocked = err as VerictoBlockedError;
    expect(blocked.sql).toBe('DELETE FROM users');
    expect(blocked.suggestedFix).toBe('DELETE FROM users WHERE id = ?');
    expect(blocked.findings.map((f) => f.ruleCode)).toEqual(['VERICTO-010']);
    expect(blocked.message).toMatch(/VERICTO-010 \(severity critical\)\. Suggested fix/);
    expect(seen[0]?.decision).toBe('BLOCKED');
  });

  it('runs a flagged statement and logs it without the SQL', async () => {
    const logger = recorder();
    const sql = 'SELECT * FROM users';
    const stub = new StubEvaluator({ [sql]: { decision: 'FLAGGED', rule_code: 'VERICTO-030', severity: 'medium' } });
    const verdict = await guard(stub, { logger }).enforce(sql, 'postgres');
    expect(verdict.decision).toBe('FLAGGED');
    expect(sqlToExecute(verdict)).toBe(sql);
    expect(logger.lines.join('\n')).toContain('FLAGGED rule=VERICTO-030');
    expect(logger.lines.join('\n')).not.toContain(sql);
  });

  it.each(['MONITORED', 'PARSE_ERROR', 'ALLOWED'])('runs %s', async (decision) => {
    const stub = new StubEvaluator({ X: { decision } });
    expect(await guard(stub).prepare('X', 'postgres')).toBe('X');
  });

  it('runs the masked rewrite', async () => {
    const sql = 'SELECT email FROM users';
    const stub = new StubEvaluator({
      [sql]: { decision: 'FLAGGED', rule_code: 'VERICTO-085', rewritten_query: "SELECT '***' AS email FROM users" },
    });
    expect(await guard(stub).prepare(sql, 'postgres')).toBe("SELECT '***' AS email FROM users");
  });

  it('never carries a rewrite on a block', () => {
    expect(verdictFromResponse({ decision: 'BLOCKED', rewritten_query: 'SELECT 1' }, 'X', 'postgres').rewrittenQuery).toBe(
      undefined,
    );
  });

  it('fails closed by default', async () => {
    const g = guard(new StubEvaluator({}, new VerictoUnavailableError('down')));
    expect(g.failMode).toBe('closed');
    await expect(g.enforce('SELECT 1', 'postgres')).rejects.toBeInstanceOf(VerictoUnavailableError);
  });

  it('fails open with a process warning', async () => {
    const seen: Verdict[] = [];
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const g = guard(new StubEvaluator({}, new VerictoQuotaExceededError('quota')), {
        failMode: 'open',
        onVerdict: (v) => seen.push(v),
      });
      const verdict = await g.enforce('SELECT 1', 'postgres');
      expect(verdict.decision).toBe('UNEVALUATED');
      expect(sqlToExecute(verdict)).toBe('SELECT 1');
      expect(seen).toEqual([verdict]);
      expect(emit).toHaveBeenCalledWith(expect.stringContaining('quota'), expect.objectContaining({ type: 'VerictoFailOpenWarning' }));
    } finally {
      emit.mockRestore();
    }
  });

  it('never fails open on configuration errors', async () => {
    const g = guard(new StubEvaluator({}, new VerictoConfigError('bad key', { status: 401 })), { failMode: 'open' });
    await expect(g.enforce('SELECT 1', 'postgres')).rejects.toBeInstanceOf(VerictoConfigError);
  });

  it('reads the fail mode from the environment and validates it', () => {
    expect(new Vericto({ evaluator: new StubEvaluator(), env: { VERICTO_FAIL_MODE: 'open' } }).failMode).toBe('open');
    expect(() => new Vericto({ evaluator: new StubEvaluator(), env: {}, failMode: 'maybe' as 'open' })).toThrow(
      VerictoConfigError,
    );
  });

  it('refuses an unsupported dialect before evaluating', async () => {
    const stub = new StubEvaluator();
    stub.dialects = ['postgres'];
    await expect(guard(stub).enforce('SELECT 1', 'sqlite')).rejects.toBeInstanceOf(VerictoUnsupportedDialectError);
    expect(stub.calls).toEqual([]);
  });

  it('does not block when the capabilities are unknown, and normalizes names', async () => {
    const stub = new StubEvaluator();
    stub.dialects = undefined;
    await guard(stub).enforce('SELECT 1', 'better-sqlite3');
    await guard(stub).enforce('SELECT 1', 'PostgreSQL');
    expect(stub.calls).toEqual([
      ['SELECT 1', 'sqlite'],
      ['SELECT 1', 'postgres'],
    ]);
  });

  it('refuses non-string SQL', async () => {
    await expect(guard(new StubEvaluator()).enforce(42 as unknown as string, 'postgres')).rejects.toBeInstanceOf(TypeError);
  });

  it('has no cache by default', async () => {
    const stub = new StubEvaluator();
    const g = guard(stub);
    await g.enforce('SELECT 1', 'postgres');
    await g.enforce('SELECT 1', 'postgres');
    expect(stub.calls).toHaveLength(2);
  });

  it('caches until the TTL and drops everything on a new ruleset', async () => {
    const stub = new StubEvaluator({ A: { decision: 'ALLOWED', ruleset_version: 'r1' } });
    const g = guard(stub, { cacheTtlMs: 60_000 });
    expect((await g.enforce('A', 'postgres')).cached).toBe(false);
    expect((await g.enforce('A', 'postgres')).cached).toBe(true);
    stub.decide = { B: { decision: 'ALLOWED', ruleset_version: 'r2' } };
    await g.enforce('B', 'postgres');
    await g.enforce('A', 'postgres');
    expect(stub.calls.map((c) => c[0])).toEqual(['A', 'B', 'A']);

    const short = guard(new StubEvaluator(), { cacheTtlMs: 20 });
    await short.enforce('C', 'postgres');
    await new Promise((r) => setTimeout(r, 30));
    expect((await short.enforce('C', 'postgres')).cached).toBe(false);
  });

  it('ignores a broken callback', async () => {
    const stub = new StubEvaluator({ 'DROP TABLE t': { decision: 'BLOCKED', rule_code: 'VERICTO-001' } });
    const g = guard(stub, {
      onVerdict: () => {
        throw new Error('callback bug');
      },
    });
    await expect(g.enforce('DROP TABLE t', 'postgres')).rejects.toBeInstanceOf(VerictoBlockedError);
  });

  it('enforceAll stops at the first block', async () => {
    const stub = new StubEvaluator({ 'DROP TABLE t': { decision: 'BLOCKED' } });
    await expect(guard(stub).enforceAll(['SELECT 1', 'DROP TABLE t', 'SELECT 2'], 'postgres')).rejects.toBeInstanceOf(
      VerictoBlockedError,
    );
    expect(stub.calls.map((c) => c[0])).toEqual(['SELECT 1', 'DROP TABLE t']);
  });

  it('enforceAll resolves one verdict per statement, in order', async () => {
    const stub = new StubEvaluator({ B: { decision: 'FLAGGED', rule_code: 'VERICTO-030' } });
    const verdicts = await guard(stub).enforceAll(['A', 'B', 'C'], 'pg');
    expect(verdicts.map((v) => [v.sql, v.decision, v.dialect])).toEqual([
      ['A', 'ALLOWED', 'postgres'],
      ['B', 'FLAGGED', 'postgres'],
      ['C', 'ALLOWED', 'postgres'],
    ]);
    expect(await guard(stub).enforceAll([], 'postgres')).toEqual([]);
  });

  it('check() resolves a block instead of rejecting, and applies no fail mode', async () => {
    const stub = new StubEvaluator({ 'DROP TABLE t': { decision: 'BLOCKED', rule_code: 'VERICTO-001' } });
    const g = guard(stub, { failMode: 'open' });
    expect((await g.check('DROP TABLE t', 'postgres')).decision).toBe('BLOCKED');
    const down = guard(new StubEvaluator({}, new VerictoUnavailableError('down')), { failMode: 'open' });
    await expect(down.check('SELECT 1', 'postgres')).rejects.toBeInstanceOf(VerictoUnavailableError);
  });

  it('sends empty and multi-statement SQL as written, in one evaluation', async () => {
    const stub = new StubEvaluator({ 'INSERT INTO t VALUES (1); DROP TABLE t;': { decision: 'BLOCKED' } });
    const g = guard(stub);
    expect(await g.prepare('', 'postgres')).toBe('');
    await expect(g.enforce('INSERT INTO t VALUES (1); DROP TABLE t;', 'postgres')).rejects.toBeInstanceOf(
      VerictoBlockedError,
    );
    expect(stub.calls).toEqual([
      ['', 'postgres'],
      ['INSERT INTO t VALUES (1); DROP TABLE t;', 'postgres'],
    ]);
  });

  it('names the evaluator in a dialect error even without an API URL', async () => {
    const evaluator: Evaluator = {
      evaluate: () => Promise.reject(new Error('not reached')),
      supportedDialects: () => Promise.resolve(['postgres']),
    };
    await expect(guard(evaluator).requireDialect('snowflake')).rejects.toThrow(/the configured evaluator/);
    expect(await guard(evaluator).requireDialect(' PG ')).toBe('postgres');
  });
});

describe('Vericto guard: fail mode', () => {
  it('logs and rethrows when closed', async () => {
    const logger = recorder();
    const g = guard(new StubEvaluator({}, new VerictoUnavailableError('HTTP 503 from x')), { logger });
    await expect(g.enforce('SELECT secret FROM t', 'postgres')).rejects.toThrow('HTTP 503 from x');
    expect(logger.lines).toEqual([
      'error vericto: no verdict, statement not executed (failMode=closed): HTTP 503 from x',
    ]);
  });

  it('open still rejects a block: fail open is only for "no verdict"', async () => {
    const stub = new StubEvaluator({ 'DROP TABLE t': { decision: 'BLOCKED' } });
    await expect(guard(stub, { failMode: 'open' }).enforce('DROP TABLE t', 'postgres')).rejects.toBeInstanceOf(
      VerictoBlockedError,
    );
  });

  it('open logs a warning (without the SQL) and resolves an UNEVALUATED verdict with the normalized dialect', async () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const logger = recorder();
      const g = guard(new StubEvaluator({}, new VerictoUnavailableError('Timeout')), { failMode: 'open', logger });
      const verdict = await g.enforce('SELECT secret FROM t', 'PostgreSQL');
      expect(verdict).toMatchObject({ decision: 'UNEVALUATED', dialect: 'postgres', message: 'Timeout' });
      expect(await g.prepare('SELECT secret FROM t', 'postgres')).toBe('SELECT secret FROM t');
      expect(logger.lines[0]).toBe('warn vericto: no verdict, statement executed unevaluated (failMode=open): Timeout');
      expect(logger.lines.join('\n')).not.toContain('secret');
      expect(emit).toHaveBeenCalledWith(expect.stringContaining('Timeout'), {
        type: 'VerictoFailOpenWarning',
        code: 'VERICTO_FAIL_OPEN',
      });
    } finally {
      emit.mockRestore();
    }
  });

  it('open never swallows a non-Vericto error from the evaluator', async () => {
    const g = guard(new StubEvaluator({}, new RangeError('bug')), { failMode: 'open' });
    await expect(g.enforce('SELECT 1', 'postgres')).rejects.toBeInstanceOf(RangeError);
  });

  it('the option beats the environment; the value is trimmed and case-insensitive', () => {
    const stub = new StubEvaluator();
    expect(new Vericto({ evaluator: stub, env: { VERICTO_FAIL_MODE: ' OPEN ' } }).failMode).toBe('open');
    expect(new Vericto({ evaluator: stub, env: { VERICTO_FAIL_MODE: 'open' }, failMode: 'closed' }).failMode).toBe('closed');
    expect(() => new Vericto({ evaluator: stub, env: { VERICTO_FAIL_MODE: 'yes' } })).toThrow(/'closed' or 'open'/);
  });

  // Known issue: an empty VERICTO_FAIL_MODE (e.g. `VERICTO_FAIL_MODE=` or a CI variable
  // that is not set) throws VerictoConfigError, while an empty VERICTO_API_URL or
  // VERICTO_TIMEOUT falls back to its documented default. The README documents
  // `closed` as the default. It fails safe (nothing runs unchecked), so the behaviour
  // is left unchanged here; this test flips to passing once empty means "unset".
  it.fails('an empty VERICTO_FAIL_MODE means the default, closed', () => {
    expect(new Vericto({ evaluator: new StubEvaluator(), env: { VERICTO_FAIL_MODE: '' } }).failMode).toBe('closed');
  });
});

describe('Vericto guard: logging', () => {
  const cases: [string, Record<string, unknown>, string[]][] = [
    ['ALLOWED', { decision: 'ALLOWED' }, []],
    [
      'BLOCKED',
      { decision: 'BLOCKED', rule_code: 'VERICTO-001', severity: 'critical', event_id: 'e1' },
      ['warn vericto: statement BLOCKED rule=VERICTO-001 severity=critical event_id=e1'],
    ],
    ['FLAGGED', { decision: 'FLAGGED' }, ['warn vericto: statement FLAGGED rule=- severity=- event_id=-']],
    [
      'PARSE_ERROR',
      { decision: 'PARSE_ERROR' },
      ['warn vericto: statement not parsed, allowed by workspace policy rule=- severity=- event_id=-'],
    ],
    ['MONITORED', { decision: 'MONITORED', rule_code: 'VERICTO-050' }, ['info vericto: statement MONITORED rule=VERICTO-050 severity=- event_id=-']],
    [
      'a masked rewrite',
      { decision: 'ALLOWED', rewritten_query: 'SELECT mask(email) FROM users' },
      ['info vericto: running the masked rewrite rule=- severity=- event_id=-'],
    ],
  ];

  it.each(cases)('logs %s without the SQL', async (_name, body, expected) => {
    const logger = recorder();
    const sql = "SELECT email FROM users WHERE email = 'ana@example.com'";
    await guard(new StubEvaluator({ [sql]: body }), { logger })
      .enforce(sql, 'postgres')
      .catch(() => undefined);
    expect(logger.lines).toEqual(expected);
  });

  it('defaults to console for warnings and errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const stub = new StubEvaluator({ F: { decision: 'FLAGGED' } });
      await new Vericto({ evaluator: stub, env: {} }).enforce('F', 'postgres');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('FLAGGED'));
      const down = new Vericto({ evaluator: new StubEvaluator({}, new VerictoUnavailableError('down')), env: {} });
      await down.enforce('A', 'postgres').catch(() => undefined);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('failMode=closed'));
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('reports a broken onVerdict callback to the logger', async () => {
    const logger = recorder();
    const g = guard(new StubEvaluator(), {
      logger,
      onVerdict: () => {
        throw 'not an Error'; // eslint-disable-line @typescript-eslint/only-throw-error
      },
    });
    expect((await g.enforce('SELECT 1', 'postgres')).decision).toBe('ALLOWED');
    expect(logger.lines).toEqual(['error vericto: onVerdict callback threw: not an Error']);
  });
});

describe('Vericto guard: verdict cache', () => {
  it('validates its options', () => {
    const stub = new StubEvaluator();
    expect(() => guard(stub, { cacheTtlMs: -1 })).toThrow(/cacheTtlMs/);
    expect(() => guard(stub, { cacheTtlMs: 1000, cacheSize: 0 })).toThrow(/cacheSize/);
  });

  it('keys by dialect and SQL', async () => {
    const stub = new StubEvaluator();
    const g = guard(stub, { cacheTtlMs: 60_000 });
    await g.enforce('SELECT 1', 'postgres');
    await g.enforce('SELECT 1', 'snowflake');
    await g.enforce('SELECT 1', 'pg'); // same dialect as the first, after normalization
    await g.enforce('SELECT 2', 'postgres');
    expect(stub.calls).toEqual([
      ['SELECT 1', 'postgres'],
      ['SELECT 1', 'snowflake'],
      ['SELECT 2', 'postgres'],
    ]);
  });

  it('a cached block still rejects, without a new evaluation', async () => {
    const stub = new StubEvaluator({ 'DROP TABLE t': { decision: 'BLOCKED', rule_code: 'VERICTO-001' } });
    const g = guard(stub, { cacheTtlMs: 60_000 });
    await expect(g.enforce('DROP TABLE t', 'postgres')).rejects.toBeInstanceOf(VerictoBlockedError);
    const err = (await g.enforce('DROP TABLE t', 'postgres').catch((e: unknown) => e)) as VerictoBlockedError;
    expect(err.verdict.cached).toBe(true);
    expect(stub.calls).toHaveLength(1);
  });

  it('evicts the least recently used entry beyond cacheSize', async () => {
    const stub = new StubEvaluator();
    const g = guard(stub, { cacheTtlMs: 60_000, cacheSize: 2 });
    await g.enforce('A', 'postgres');
    await g.enforce('B', 'postgres');
    await g.enforce('A', 'postgres'); // hit: A becomes the most recent
    await g.enforce('C', 'postgres'); // evicts B
    await g.enforce('A', 'postgres'); // still cached
    await g.enforce('B', 'postgres'); // evaluated again
    expect(stub.calls.map((c) => c[0])).toEqual(['A', 'B', 'C', 'B']);
  });

  it('clearCache forgets every verdict', async () => {
    const stub = new StubEvaluator();
    const g = guard(stub, { cacheTtlMs: 60_000 });
    await g.enforce('A', 'postgres');
    g.clearCache();
    await g.enforce('A', 'postgres');
    expect(stub.calls).toHaveLength(2);
    guard(stub).clearCache(); // no cache: a no-op
  });

  it('never caches an UNEVALUATED verdict', async () => {
    let calls = 0;
    const evaluator: Evaluator = {
      evaluate: (sql, dialect) => {
        calls++;
        return Promise.resolve(unevaluatedVerdict(sql, dialect, 'embedded engine not loaded'));
      },
      supportedDialects: () => Promise.resolve(undefined),
    };
    const g = guard(evaluator, { cacheTtlMs: 60_000 });
    await g.enforce('A', 'postgres');
    expect((await g.enforce('A', 'postgres')).cached).toBe(false);
    expect(calls).toBe(2);
  });
});

describe('Vericto guard against the Runtime API stand-in', () => {
  let fake: FakeVericto;
  beforeEach(async () => {
    fake = await new FakeVericto().start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('builds its evaluator from the VERICTO_* environment', async () => {
    const g = new Vericto({
      logger: false,
      backoffMs: 0,
      env: { VERICTO_API_KEY: API_KEY, VERICTO_DATABASE_ID: DATABASE_ID, VERICTO_API_URL: fake.url },
    });
    expect(g.evaluator).toBeInstanceOf(RuntimeApiEvaluator);
    expect((await g.enforce('SELECT 1', 'postgres')).eventId).toBe('evt-allowed');
    expect(fake.requests[0]?.headers['x-api-key']).toBe(API_KEY);
  });

  it('refuses to start without configuration', () => {
    expect(() => new Vericto({ env: {} })).toThrow(VerictoConfigError);
    expect(() => new Vericto({ env: { VERICTO_API_KEY: API_KEY } })).toThrow(/VERICTO_DATABASE_ID/);
  });

  it('fails open end to end when the server is down', async () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const g = fake.guard({ failMode: 'open' });
      await fake.stop();
      const verdict = await g.enforce('SELECT 1', 'postgres');
      expect(verdict.decision).toBe('UNEVALUATED');
      expect(verdict.message).toMatch(/after 3 attempt/);
    } finally {
      emit.mockRestore();
      await fake.start();
    }
  });

  it('a revoked key is never failed open', async () => {
    fake.queue.push({ status: 401, body: { error: { code: 'UNAUTHORIZED' } } });
    await expect(fake.guard({ failMode: 'open' }).enforce('SELECT 1', 'postgres')).rejects.toBeInstanceOf(
      VerictoConfigError,
    );
  });

  it('a quota error follows the fail mode', async () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const quota = { status: 429, body: { error: { code: 'QUOTA_EXCEEDED' } } };
      fake.queue.push(quota, quota);
      await expect(fake.guard().enforce('SELECT 1', 'postgres')).rejects.toBeInstanceOf(VerictoQuotaExceededError);
      expect((await fake.guard({ failMode: 'open' }).enforce('SELECT 1', 'postgres')).decision).toBe('UNEVALUATED');
    } finally {
      emit.mockRestore();
    }
  });
});
