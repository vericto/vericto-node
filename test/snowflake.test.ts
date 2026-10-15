/** snowflake-sdk wrapper against a fake connection: nothing connects to Snowflake. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VerictoBlockedError, VerictoUnavailableError, VerictoUnsupportedDialectError } from '../src/index.js';
import { guardConnection, type GuardedSnowflakeConnection } from '../src/snowflake.js';
import { FakeVericto, blocked, masked } from './fake-vericto.js';

type Complete = (err: unknown, stmt: unknown, rows?: unknown[]) => void;
interface StatementOption {
  sqlText: string;
  binds?: unknown[];
  complete?: Complete;
  parameters?: Record<string, unknown>;
}

/** Mimics snowflake-sdk's Connection.execute: returns a statement, calls complete later. */
class FakeConnection {
  readonly executed: StatementOption[] = [];
  execute(options: StatementOption): { getSqlText(): string } {
    this.executed.push(options);
    setImmediate(() => options.complete?.(undefined, {}, [{ SQL: options.sqlText, BINDS: options.binds ?? null }]));
    return { getSqlText: () => options.sqlText };
  }
}

let fake: FakeVericto;
let raw: FakeConnection;
let conn: GuardedSnowflakeConnection<FakeConnection>;

beforeEach(async () => {
  fake = await new FakeVericto().start();
  raw = new FakeConnection();
  conn = await guardConnection(raw, { vericto: fake.guard() });
});
afterEach(async () => {
  await fake.stop();
});

describe('snowflake-sdk', () => {
  it('executes an allowed statement and returns the driver statement', async () => {
    const rows = await new Promise<unknown[]>((resolve) => {
      void conn.execute({ sqlText: 'SELECT * FROM orders WHERE id = ?', binds: [7], complete: (_e, _s, r) => { resolve(r ?? []); } });
    });
    expect(rows).toEqual([{ SQL: 'SELECT * FROM orders WHERE id = ?', BINDS: [7] }]);
    expect(fake.requests[0]).toMatchObject({ query: 'SELECT * FROM orders WHERE id = ?', dialect: 'snowflake' });
    expect(JSON.stringify(fake.requests)).not.toContain('"7"');
  });

  it('resolves the statement object', async () => {
    const statement = await conn.execute({ sqlText: 'SELECT 1' });
    expect(statement?.getSqlText()).toBe('SELECT 1');
  });

  it('delivers a block to complete and never calls the driver', async () => {
    fake.on((sql) => sql.startsWith('DELETE'), blocked());
    const err = await new Promise<unknown>((resolve) => {
      void conn.execute({ sqlText: 'DELETE FROM orders', complete: (e) => { resolve(e); } }).then((s) => {
        expect(s).toBeUndefined();
      });
    });
    expect(err).toBeInstanceOf(VerictoBlockedError);
    expect(raw.executed).toEqual([]);
  });

  it('rejects without complete', async () => {
    fake.on((sql) => sql.startsWith('DROP'), blocked('VERICTO-001'));
    await expect(conn.execute({ sqlText: 'DROP TABLE orders' })).rejects.toBeInstanceOf(VerictoBlockedError);
    expect(raw.executed).toEqual([]);
  });

  it('runs the masked rewrite', async () => {
    fake.on((sql) => sql.startsWith('SELECT email'), masked("SELECT '***' AS email FROM users WHERE id = ?"));
    const rows = await conn.query('SELECT email FROM users WHERE id = ?', [1]);
    expect(rows).toEqual([{ SQL: "SELECT '***' AS email FROM users WHERE id = ?", BINDS: [1] }]);
  });

  it('query() is promise style and rejects on a block', async () => {
    fake.on((sql) => sql.startsWith('TRUNCATE'), blocked('VERICTO-011'));
    await expect(conn.query('TRUNCATE TABLE t')).rejects.toBeInstanceOf(VerictoBlockedError);
    expect(await conn.query('SELECT 1', undefined, { parameters: { QUERY_TAG: 'x' } })).toHaveLength(1);
    expect(raw.executed[0]?.parameters).toEqual({ QUERY_TAG: 'x' });
  });

  it('a multi-statement text is one evaluation', async () => {
    fake.on((sql) => sql.includes('DROP'), blocked('VERICTO-001'));
    await expect(
      conn.execute({ sqlText: 'INSERT INTO t VALUES (1); DROP TABLE t;', parameters: { MULTI_STATEMENT_COUNT: 2 } }),
    ).rejects.toBeInstanceOf(VerictoBlockedError);
    expect(fake.requests).toHaveLength(1);
    expect(raw.executed).toEqual([]);
  });

  it('fails closed when Vericto is down', async () => {
    await fake.stop();
    const down = await guardConnection(raw, { vericto: fake.guard() }).catch((e: unknown) => e);
    expect(down).not.toBeInstanceOf(Error); // the dialect cannot be asked: not fatal here
    await expect(
      (down as GuardedSnowflakeConnection<FakeConnection>).execute({ sqlText: 'SELECT 1' }),
    ).rejects.toBeInstanceOf(VerictoUnavailableError);
    await fake.start();
  });

  it('refuses to guard when the server lacks the dialect', async () => {
    fake.dialects = ['postgres'];
    await expect(guardConnection(raw, { vericto: fake.guard() })).rejects.toBeInstanceOf(VerictoUnsupportedDialectError);
  });
});
