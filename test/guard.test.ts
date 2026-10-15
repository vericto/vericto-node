import { describe, expect, it, vi } from 'vitest';

import {
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
});
