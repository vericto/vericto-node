// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/** Reading a Runtime API response body into a Verdict: no network involved. */
import { describe, expect, it } from 'vitest';

import { isMasked, sqlToExecute, verdictFromResponse } from '../src/index.js';
import { unevaluatedVerdict } from '../src/verdict.js';

describe('verdictFromResponse', () => {
  it('maps every documented field', () => {
    const body = {
      decision: 'flagged',
      rule_code: 'VERICTO-085',
      severity: 'low',
      error: 'reads a masked column',
      suggested_safe_query: 'SELECT id FROM users',
      rewritten_query: "SELECT '***' AS email FROM users",
      parse_error: null,
      sensitive_columns: [{ table: 'users', column: 'email' }],
      access_denied: [{ table: 'salaries' }],
      event_id: 'evt-1',
      ruleset_version: 'r7',
      future_field: 42,
    };
    const v = verdictFromResponse(body, 'SELECT email FROM users', 'postgres');
    expect(v).toMatchObject({
      decision: 'FLAGGED',
      sql: 'SELECT email FROM users',
      dialect: 'postgres',
      ruleCode: 'VERICTO-085',
      severity: 'low',
      message: 'reads a masked column',
      suggestedFix: 'SELECT id FROM users',
      rewrittenQuery: "SELECT '***' AS email FROM users",
      eventId: 'evt-1',
      rulesetVersion: 'r7',
      cached: false,
    });
    expect(v.parseError).toBeUndefined();
    expect(v.sensitiveColumns).toEqual([{ table: 'users', column: 'email' }]);
    expect(v.accessDenied).toEqual([{ table: 'salaries' }]);
    expect(v.raw).toBe(body); // fields this version does not model stay reachable
    expect(isMasked(v)).toBe(true);
    expect(sqlToExecute(v)).toBe("SELECT '***' AS email FROM users");
  });

  it.each([undefined, '', 'allow', 'UNEVALUATED', 42])(
    'reads an unknown or missing decision (%j) as BLOCKED, never as allowed',
    (decision) => {
      expect(verdictFromResponse({ decision }, 'SELECT 1', 'postgres').decision).toBe('BLOCKED');
    },
  );

  it('drops the generic "Query blocked by rule X" text but keeps a real reason', () => {
    const generic = verdictFromResponse(
      { decision: 'BLOCKED', rule_code: 'VERICTO-010', error: 'Query blocked by rule VERICTO-010' },
      'DELETE FROM t',
      'postgres',
    );
    expect(generic.message).toBeUndefined();
    const specific = verdictFromResponse(
      { decision: 'BLOCKED', rule_code: 'VERICTO-010', error: 'DELETE without WHERE' },
      'DELETE FROM t',
      'postgres',
    );
    expect(specific.message).toBe('DELETE without WHERE');
    // Without a rule code there is nothing to compare with: the text is kept.
    expect(
      verdictFromResponse({ decision: 'BLOCKED', error: 'Query blocked by rule VERICTO-010' }, 'x', 'postgres').message,
    ).toBe('Query blocked by rule VERICTO-010');
  });

  it('reads a parse error and an allowed statement without a rewrite', () => {
    const v = verdictFromResponse({ decision: 'PARSE_ERROR', parse_error: 'unexpected token' }, 'SELEC 1', 'mysql');
    expect(v.decision).toBe('PARSE_ERROR');
    expect(v.parseError).toBe('unexpected token');
    expect(v.findings).toEqual([]);
    expect(isMasked(v)).toBe(false);
    expect(sqlToExecute(v)).toBe('SELEC 1');
  });

  it('serializes non-string scalar fields instead of dropping them', () => {
    const v = verdictFromResponse({ decision: 'ALLOWED', event_id: 1234, ruleset_version: { v: 2 } }, 'x', 'postgres');
    expect(v.eventId).toBe('1234');
    expect(v.rulesetVersion).toBe('{"v":2}');
  });

  it('ignores list fields that are not arrays', () => {
    const v = verdictFromResponse(
      { decision: 'ALLOWED', sensitive_columns: 'email', access_denied: { table: 't' } },
      'x',
      'postgres',
    );
    expect(v.sensitiveColumns).toEqual([]);
    expect(v.accessDenied).toEqual([]);
  });
});

describe('findings', () => {
  it('builds one finding from the deciding rule', () => {
    const v = verdictFromResponse(
      {
        decision: 'BLOCKED',
        rule_code: 'VERICTO-001',
        severity: 'critical',
        rule_id: 'r-1',
        ast_node_path: 'Drop',
        suggested_safe_query: 'DROP TABLE IF EXISTS t',
      },
      'DROP TABLE t',
      'postgres',
    );
    expect(v.findings).toEqual([
      { ruleCode: 'VERICTO-001', severity: 'critical', ruleId: 'r-1', astNodePath: 'Drop', suggestedFix: 'DROP TABLE IF EXISTS t' },
    ]);
  });

  it('prefers a full findings list, skipping malformed items', () => {
    const v = verdictFromResponse(
      {
        decision: 'BLOCKED',
        rule_code: 'VERICTO-010',
        findings: [
          { rule_code: 'VERICTO-010', severity: 'critical', suggested_safe_query: 'DELETE FROM t WHERE id = ?' },
          { code: 'VERICTO-030', severity: 'medium', suggested_fix: 'add LIMIT', rule_id: 'r-30', ast_node_path: 'Select' },
          { severity: 'low' }, // no code
          null,
          'VERICTO-099',
        ],
      },
      'DELETE FROM t',
      'postgres',
    );
    expect(v.findings).toEqual([
      { ruleCode: 'VERICTO-010', severity: 'critical', ruleId: undefined, astNodePath: undefined, suggestedFix: 'DELETE FROM t WHERE id = ?' },
      { ruleCode: 'VERICTO-030', severity: 'medium', ruleId: 'r-30', astNodePath: 'Select', suggestedFix: 'add LIMIT' },
    ]);
  });

  it('accepts the list as "violations"', () => {
    const v = verdictFromResponse({ decision: 'FLAGGED', violations: [{ rule_code: 'VERICTO-099' }] }, 'x', 'sqlite');
    expect(v.findings.map((f) => f.ruleCode)).toEqual(['VERICTO-099']);
  });

  it('falls back to the deciding rule when the list has no usable item', () => {
    const v = verdictFromResponse({ decision: 'BLOCKED', rule_code: 'VERICTO-001', findings: [{}] }, 'x', 'postgres');
    expect(v.findings.map((f) => f.ruleCode)).toEqual(['VERICTO-001']);
    expect(verdictFromResponse({ decision: 'ALLOWED', findings: [] }, 'x', 'postgres').findings).toEqual([]);
  });
});

describe('unevaluatedVerdict', () => {
  it('runs the original SQL and carries the reason', () => {
    const v = unevaluatedVerdict('SELECT 1', 'snowflake', 'Timeout while calling https://api.vericto.com');
    expect(v).toMatchObject({ decision: 'UNEVALUATED', sql: 'SELECT 1', dialect: 'snowflake', cached: false });
    expect(v.message).toContain('Timeout');
    expect(v.findings).toEqual([]);
    expect(isMasked(v)).toBe(false);
    expect(sqlToExecute(v)).toBe('SELECT 1');
  });
});
