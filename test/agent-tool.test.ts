// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/** The framework-free part of the agent-tool adapters: refusals, reports, the SQL field. */
import { describe, expect, it } from 'vitest';

import { isVerictoRefusal, refusalOf, reportOf, sqlOf, withSql } from '../src/agent-tool.js';
import { verdictFromResponse } from '../src/index.js';

describe('refusals and reports', () => {
  it('a refusal is plain JSON, with null for what the verdict does not say', () => {
    const refusal = refusalOf(verdictFromResponse({ decision: 'BLOCKED', access_denied: [{ table: 'salaries' }] }, 'SELECT 1', 'postgres'));
    expect(refusal).toEqual({
      decision: 'BLOCKED',
      executed: false,
      rule_code: null,
      severity: null,
      reason: null,
      suggested_fix: null,
      access_denied: [{ table: 'salaries' }],
      event_id: null,
      message: expect.stringContaining('Access denied: [{"table":"salaries"}]') as unknown,
    });
    expect(JSON.parse(JSON.stringify(refusal))).toEqual(refusal);
  });

  it('isVerictoRefusal recognizes only refusals', () => {
    const refusal = refusalOf(verdictFromResponse({ decision: 'BLOCKED', rule_code: 'VERICTO-001' }, 'DELETE FROM t', 'postgres'));
    expect(isVerictoRefusal(refusal)).toBe(true);
    for (const value of [null, undefined, 'BLOCKED', 1, {}, { decision: 'BLOCKED' }, { ...refusal, executed: true }, [refusal]]) {
      expect(isVerictoRefusal(value)).toBe(false);
    }
  });

  it('a report says the parser message of an allowed PARSE_ERROR', () => {
    const verdict = verdictFromResponse({ decision: 'PARSE_ERROR', parse_error: 'syntax error' }, 'SELEC 1', 'postgres');
    expect(reportOf(verdict)).toEqual({ decision: 'PARSE_ERROR', rule_code: null, severity: null, approved_query: null, note: 'syntax error' });
  });
});

describe('the SQL field of a tool input', () => {
  it('reads a string and replaces it in a copy', () => {
    const input = { sql: 'SELECT 1', params: [1] };
    expect(sqlOf(input, 'sql')).toBe('SELECT 1');
    const copy = withSql(input, 'sql', 'SELECT 2');
    expect(copy).toEqual({ sql: 'SELECT 2', params: [1] });
    expect(input.sql).toBe('SELECT 1');
  });

  it('anything but a string is a TypeError naming the field and the type, never the value', () => {
    expect(() => sqlOf({ sql: null }, 'sql')).toThrow("no SQL text at 'sql' (got null)");
    expect(() => sqlOf({ query: ['SELECT 1'] }, 'query')).toThrow("(got object)");
    expect(() => sqlOf('SELECT 1', 'sql')).toThrow('(got undefined)');
  });
});
