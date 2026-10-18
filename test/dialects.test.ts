import { describe, expect, it } from 'vitest';

import { KNOWN_DIALECTS, normalizeDialect } from '../src/index.js';

describe('normalizeDialect', () => {
  it.each([
    ['postgres', 'postgres'],
    ['postgresql', 'postgres'],
    ['pg', 'postgres'],
    ['mysql', 'mysql'],
    ['mysql2', 'mysql'],
    ['mariadb', 'mysql'],
    ['oracle', 'oracle'],
    ['oracledb', 'oracle'],
    ['mssql', 'mssql'],
    ['sqlserver', 'mssql'],
    ['tedious', 'mssql'],
    ['snowflake', 'snowflake'],
    ['sqlite', 'sqlite'],
    ['sqlite3', 'sqlite'],
    ['better-sqlite3', 'sqlite'],
  ])('maps the driver name %s to %s', (name, dialect) => {
    expect(normalizeDialect(name)).toBe(dialect);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(normalizeDialect('  PostgreSQL ')).toBe('postgres');
    expect(normalizeDialect('SNOWFLAKE')).toBe('snowflake');
  });

  it('passes unknown names through lower-cased, for the server to decide', () => {
    expect(normalizeDialect(' CockroachDB ')).toBe('cockroachdb');
    expect(normalizeDialect('')).toBe('');
  });

  it('every known dialect is its own id', () => {
    for (const dialect of KNOWN_DIALECTS) expect(normalizeDialect(dialect)).toBe(dialect);
  });
});
