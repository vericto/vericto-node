/** The error hierarchy callers branch on, and the messages they show. */
import { describe, expect, it } from 'vitest';

import {
  VerictoBlockedError,
  VerictoConfigError,
  VerictoError,
  VerictoQuotaExceededError,
  VerictoUnavailableError,
  VerictoUnsupportedDialectError,
  verdictFromResponse,
} from '../src/index.js';

describe('error hierarchy', () => {
  it('every error is a VerictoError named after its class', () => {
    const errors = [
      new VerictoConfigError('c'),
      new VerictoUnsupportedDialectError('sqlite', ['postgres'], 'https://api.vericto.com'),
      new VerictoUnavailableError('u'),
      new VerictoQuotaExceededError('q'),
      new VerictoBlockedError(verdictFromResponse({ decision: 'BLOCKED' }, 'x', 'postgres'), 'x'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(VerictoError);
      expect(err.name).toBe(err.constructor.name);
    }
  });

  it('a quota error is an unavailable error (the fail mode applies), a dialect error is a config error', () => {
    const quota = new VerictoQuotaExceededError('q', { resetsAt: '2026-11-01T00:00:00Z', upgradeUrl: 'https://x' });
    expect(quota).toBeInstanceOf(VerictoUnavailableError);
    expect(quota).toMatchObject({ status: 429, code: 'QUOTA_EXCEEDED', resetsAt: '2026-11-01T00:00:00Z', upgradeUrl: 'https://x' });
    expect(new VerictoQuotaExceededError('q')).toMatchObject({ resetsAt: undefined, upgradeUrl: undefined });

    const dialect = new VerictoUnsupportedDialectError('sqlite', ['postgres'], 'https://api.vericto.com');
    expect(dialect).toBeInstanceOf(VerictoConfigError);
    expect(dialect).not.toBeInstanceOf(VerictoUnavailableError);
  });

  it('config and unavailable errors carry an optional status and code', () => {
    expect(new VerictoConfigError('c', { status: 401, code: 'UNAUTHORIZED' })).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(new VerictoConfigError('c')).toMatchObject({ status: undefined, code: undefined });
    expect(new VerictoUnavailableError('u', { status: 503 })).toMatchObject({ status: 503, code: undefined });
  });
});

describe('VerictoUnsupportedDialectError', () => {
  it('names the dialect, the server and what it supports', () => {
    const err = new VerictoUnsupportedDialectError('sqlite', ['postgres', 'snowflake'], 'https://vericto.internal');
    expect(err.message).toContain("does not support the 'sqlite' dialect (supported: postgres, snowflake)");
    expect(err.message).toContain('https://vericto.internal');
    expect(err.message).toContain('No SQL was executed');
    expect(err).toMatchObject({ dialect: 'sqlite', supported: ['postgres', 'snowflake'], code: 'UNSUPPORTED_DIALECT' });
  });

  it('says so when the server reports no dialect at all', () => {
    expect(new VerictoUnsupportedDialectError('sqlite', [], 'https://x').message).toContain('(supported: none reported)');
  });
});

describe('VerictoBlockedError', () => {
  const blockedBy = (body: Record<string, unknown>) =>
    new VerictoBlockedError(verdictFromResponse({ decision: 'BLOCKED', ...body }, 'DELETE FROM t', 'postgres'), 'DELETE FROM t');

  it('builds the message from the rule, severity, reason and fix', () => {
    const err = blockedBy({
      rule_code: 'VERICTO-010',
      severity: 'critical',
      error: 'DELETE without WHERE',
      suggested_safe_query: 'DELETE FROM t WHERE id = ?',
    });
    expect(err.message).toBe(
      'Query blocked by VERICTO-010 (severity critical): DELETE without WHERE. Suggested fix: DELETE FROM t WHERE id = ?',
    );
    expect(err.sql).toBe('DELETE FROM t');
    expect(err.suggestedFix).toBe('DELETE FROM t WHERE id = ?');
    expect(err.findings).toBe(err.verdict.findings);
  });

  it('still reads well with nothing but the decision', () => {
    const err = blockedBy({});
    expect(err.message).toBe('Query blocked by a Vericto rule');
    expect(err.suggestedFix).toBeUndefined();
    expect(err.findings).toEqual([]);
  });

  it('omits the parts the server did not send', () => {
    expect(blockedBy({ rule_code: 'VERICTO-001' }).message).toBe('Query blocked by VERICTO-001');
    expect(blockedBy({ severity: 'high' }).message).toBe('Query blocked by a Vericto rule (severity high)');
  });
});
