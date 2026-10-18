// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/** snowflake-sdk wrapper against a fake connection: nothing connects to Snowflake. */
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VerictoBlockedError, VerictoUnavailableError, VerictoUnsupportedDialectError } from '../src/index.js';
import { guardConnection, type GuardedSnowflakeConnection } from '../src/snowflake.js';
import { API_KEY, DATABASE_ID, FakeVericto, blocked, masked } from './fake-vericto.js';

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

  it('streams: streamResult reaches the driver and the resolved statement streams the rows', async () => {
    const streaming = new StreamingConnection([{ ID: 1 }, { ID: 2 }, { ID: 3 }]);
    const guarded = await guardConnection(streaming, { vericto: fake.guard() });
    const statement = await guarded.execute({ sqlText: 'SELECT id FROM orders', streamResult: true });
    const rows: unknown[] = [];
    for await (const row of statement!.streamRows()) rows.push(row);
    expect(rows).toEqual([{ ID: 1 }, { ID: 2 }, { ID: 3 }]);
    expect(streaming.executed).toEqual([{ sqlText: 'SELECT id FROM orders', streamResult: true }]);
  });

  it('a blocked streaming statement never reaches the driver', async () => {
    fake.on((sql) => sql.startsWith('SELECT *'), blocked('VERICTO-030'));
    const streaming = new StreamingConnection([{ ID: 1 }]);
    const guarded = await guardConnection(streaming, { vericto: fake.guard() });
    await expect(guarded.execute({ sqlText: 'SELECT * FROM orders', streamResult: true })).rejects.toBeInstanceOf(
      VerictoBlockedError,
    );
    expect(streaming.executed).toEqual([]);
  });

  it('async: concurrent executes are each checked and each run with their own SQL', async () => {
    fake.on((sql) => sql === 'DELETE FROM b', blocked());
    const results = await Promise.allSettled([
      conn.query('SELECT a FROM a'),
      conn.query('DELETE FROM b'),
      conn.query('SELECT c FROM c'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(raw.executed.map((o) => o.sqlText).sort()).toEqual(['SELECT a FROM a', 'SELECT c FROM c']);
    expect(fake.queries().sort()).toEqual(['DELETE FROM b', 'SELECT a FROM a', 'SELECT c FROM c']);
  });

  it('passes binds through to the driver and never sends their values to Vericto', async () => {
    const rows = await conn.query('SELECT * FROM t WHERE email = :1 AND id = :2', ['ana@example.com', 42]);
    expect(rows).toEqual([{ SQL: 'SELECT * FROM t WHERE email = :1 AND id = :2', BINDS: ['ana@example.com', 42] }]);
    expect(JSON.stringify(fake.requests)).not.toContain('ana@example.com');
    await conn.query('SELECT 1');
    expect(raw.executed[1]).not.toHaveProperty('binds');
  });

  it('the masked rewrite keeps every other driver option', async () => {
    fake.on((sql) => sql.startsWith('SELECT email'), masked("SELECT '***' AS email FROM users"));
    const complete: Complete = () => undefined;
    await conn.execute({ sqlText: 'SELECT email FROM users', binds: [1], parameters: { QUERY_TAG: 't' }, complete });
    expect(raw.executed[0]).toEqual({
      sqlText: "SELECT '***' AS email FROM users",
      binds: [1],
      parameters: { QUERY_TAG: 't' },
      complete,
    });
  });

  it('delivers "Vericto unavailable" to complete when one is given', async () => {
    for (let i = 0; i < 3; i++) fake.queue.push({ status: 503, body: {} });
    const err = await new Promise<unknown>((resolve) => {
      void conn.execute({ sqlText: 'SELECT 1', complete: (e) => { resolve(e); } });
    });
    expect(err).toBeInstanceOf(VerictoUnavailableError);
    expect(raw.executed).toEqual([]);
  });

  it('fails open: runs the original statement unevaluated when Vericto is down', async () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const open = await guardConnection(raw, { vericto: fake.guard({ failMode: 'open' }) });
      await fake.stop();
      expect(await open.query('SELECT 1')).toEqual([{ SQL: 'SELECT 1', BINDS: null }]);
      expect(emit).toHaveBeenCalledOnce();
    } finally {
      emit.mockRestore();
      await fake.start();
    }
  });

  it.each([
    ['an Error', new Error('SQL compilation error'), 'SQL compilation error'],
    ['a string', 'Network is down', 'Network is down'],
    ['an object', { code: 390100 }, '{"code":390100}'],
  ])('query() rejects with an Error when the driver reports %s', async (_name, driverError, message) => {
    const failing = new FailingConnection(driverError);
    const guarded = await guardConnection(failing, { vericto: fake.guard() });
    const err = await guarded.query('SELECT 1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(message);
  });

  it('query() rejects when the driver throws synchronously', async () => {
    const throwing = { execute: () => { throw new Error('not connected'); } };
    const guarded = await guardConnection(throwing, { vericto: fake.guard() });
    await expect(guarded.query('SELECT 1')).rejects.toThrow('not connected');
  });

  it('builds its guard from the VERICTO_* environment by default', async () => {
    vi.stubEnv('VERICTO_API_KEY', API_KEY);
    vi.stubEnv('VERICTO_DATABASE_ID', DATABASE_ID);
    vi.stubEnv('VERICTO_API_URL', fake.url);
    vi.stubEnv('VERICTO_FAIL_MODE', undefined);
    try {
      const guarded = await guardConnection(raw);
      expect(guarded.raw).toBe(raw);
      expect(guarded.vericto.failMode).toBe('closed');
      await guarded.query('SELECT 1');
      expect(fake.requests[0]?.headers['x-api-key']).toBe(API_KEY);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/** Mimics `streamResult: true`: the statement's rows come from `streamRows()`. */
class StreamingConnection {
  readonly executed: Record<string, unknown>[] = [];
  constructor(readonly rows: Record<string, unknown>[]) {}
  execute(options: { sqlText: string; streamResult?: boolean; complete?: Complete }): { streamRows(): Readable } {
    this.executed.push(options);
    return { streamRows: () => Readable.from(this.rows) };
  }
}

/** A connection whose statements always fail in the driver. */
class FailingConnection {
  constructor(readonly error: unknown) {}
  execute(options: { sqlText: string; complete?: Complete }): object {
    setImmediate(() => options.complete?.(this.error, {}, undefined));
    return {};
  }
}
