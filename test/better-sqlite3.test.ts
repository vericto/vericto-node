/** End to end with a real better-sqlite3 database and the local Runtime API stand-in. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VerictoBlockedError, VerictoUnavailableError, VerictoUnsupportedDialectError } from '../src/index.js';
import { guardDatabase, type GuardedDatabase } from '../src/better-sqlite3.js';
import { API_KEY, DATABASE_ID, FakeVericto, DIALECTS_WITHOUT_SQLITE, blocked, masked } from './fake-vericto.js';

let fake: FakeVericto;
let raw: Database.Database;
let db: GuardedDatabase<Database.Database>;

beforeEach(async () => {
  fake = await new FakeVericto().start();
  raw = new Database(':memory:');
  raw.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); INSERT INTO users VALUES (1, 'ana@example.com'), (2, 'bo@example.com');");
  db = await guardDatabase(raw, { vericto: fake.guard() });
});
afterEach(async () => {
  raw.close();
  await fake.stop();
});

const count = () => (raw.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;

describe('better-sqlite3', () => {
  it('prepares a checked statement that stays synchronous', async () => {
    const stmt = await db.prepare('SELECT email FROM users WHERE id = ?');
    expect(stmt.get(1)).toEqual({ email: 'ana@example.com' });
    expect(stmt.get(2)).toEqual({ email: 'bo@example.com' });
    expect(fake.queries()).toEqual(['SELECT email FROM users WHERE id = ?']);
    expect(fake.requests[0]?.dialect).toBe('sqlite');
    expect(JSON.stringify(fake.requests)).not.toContain('ana@example.com'); // values never sent
  });

  it('never runs a blocked statement', async () => {
    fake.on((sql) => sql === 'DELETE FROM users', blocked('VERICTO-010', 'DELETE FROM users WHERE id = ?'));
    const err = await db.run('DELETE FROM users').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoBlockedError);
    expect((err as VerictoBlockedError).suggestedFix).toBe('DELETE FROM users WHERE id = ?');
    await expect(db.prepare('DELETE FROM users')).rejects.toBeInstanceOf(VerictoBlockedError);
    expect(count()).toBe(2);
  });

  it('runs the masked rewrite', async () => {
    fake.on((sql) => sql.startsWith('SELECT email'), masked("SELECT '***' AS email FROM users WHERE id = ?"));
    expect(await db.get('SELECT email FROM users WHERE id = ?', 2)).toEqual({ email: '***' });
    expect(await db.all('SELECT email FROM users WHERE id = ?', 1)).toEqual([{ email: '***' }]);
  });

  it('run, all and get pass parameters through', async () => {
    const info = await db.run('INSERT INTO users (email) VALUES (?)', 'c@x.io');
    expect(info.changes).toBe(1);
    expect(await db.all('SELECT id FROM users ORDER BY id')).toHaveLength(3);
  });

  it('exec evaluates the whole script before running any of it', async () => {
    fake.on((sql) => sql.includes('DROP TABLE'), blocked('VERICTO-001'));
    await expect(db.exec("INSERT INTO users (email) VALUES ('e'); DROP TABLE users;")).rejects.toBeInstanceOf(
      VerictoBlockedError,
    );
    expect(count()).toBe(2);
    await db.exec("INSERT INTO users (email) VALUES ('f');");
    expect(count()).toBe(3);
  });

  it('resolves the verdict on request', async () => {
    const { statement, verdict } = await db.prepareWithVerdict('SELECT 1 AS one');
    expect(verdict.decision).toBe('ALLOWED');
    expect(statement.get([])).toEqual({ one: 1 });
  });

  it('iterate: a checked statement streams its rows lazily', async () => {
    const stmt = await db.prepare('SELECT id, email FROM users ORDER BY id');
    const seen: unknown[] = [];
    for (const row of stmt.iterate([])) seen.push(row);
    expect(seen).toEqual([
      { id: 1, email: 'ana@example.com' },
      { id: 2, email: 'bo@example.com' },
    ]);
    expect(fake.queries()).toEqual(['SELECT id, email FROM users ORDER BY id']);
  });

  it('transactions: statements prepared through the guard commit together, and roll back together', async () => {
    const insert = await db.prepare('INSERT INTO users (email) VALUES (?)');
    const remove = await db.prepare('DELETE FROM users WHERE id = ?');
    const move = raw.transaction((email: string, id: number) => {
      insert.run(email);
      remove.run(id);
    });
    move('c@example.com', 1);
    expect(await db.all('SELECT email FROM users ORDER BY id')).toEqual([{ email: 'bo@example.com' }, { email: 'c@example.com' }]);

    const failing = raw.transaction(() => {
      insert.run('d@example.com');
      throw new Error('abort');
    });
    expect(() => { failing(); }).toThrow('abort');
    expect(count()).toBe(2);
    expect(fake.queries().slice(0, 2)).toEqual(['INSERT INTO users (email) VALUES (?)', 'DELETE FROM users WHERE id = ?']);
  });

  it('transactions: a blocked statement is refused before the transaction starts', async () => {
    fake.on((sql) => sql === 'DELETE FROM users', blocked('VERICTO-010'));
    const insert = await db.prepare('INSERT INTO users (email) VALUES (?)');
    await expect(db.prepare('DELETE FROM users')).rejects.toBeInstanceOf(VerictoBlockedError);
    expect(raw.inTransaction).toBe(false);
    raw.transaction(() => insert.run('e@example.com'))();
    expect(count()).toBe(3);
  });

  it('binds named and positional parameters; their values never reach Vericto', async () => {
    await db.run('INSERT INTO users (id, email) VALUES (@id, @email)', { id: 10, email: 'named@example.com' });
    expect(await db.get('SELECT email FROM users WHERE id = $id', { id: 10 })).toEqual({ email: 'named@example.com' });
    expect(await db.all('SELECT id FROM users WHERE id IN (?, ?) ORDER BY id', 1, 10)).toEqual([{ id: 1 }, { id: 10 }]);
    expect(await db.get('SELECT id FROM users WHERE id = ?', [2])).toEqual({ id: 2 });
    expect(JSON.stringify(fake.requests)).not.toContain('named@example.com');
  });

  it('get resolves undefined for no row', async () => {
    expect(await db.get('SELECT id FROM users WHERE id = ?', 999)).toBeUndefined();
  });

  it('an allowed statement that SQLite rejects surfaces the driver error', async () => {
    await expect(db.prepare('SELECT nope FROM users')).rejects.toThrow(/no such column/);
    await expect(db.prepare('')).rejects.toThrow(RangeError); // better-sqlite3: no statements
    expect(fake.queries()).toEqual(['SELECT nope FROM users', '']); // Vericto was still asked first
  });

  it('exec resolves the guarded database for chaining', async () => {
    expect(await db.exec('CREATE TABLE t (x)')).toBe(db);
  });

  it('a statement without run/all/get is a TypeError, not a silent no-op', async () => {
    const odd = await guardDatabase({ prepare: () => ({}), exec: () => undefined }, { vericto: fake.guard() });
    await expect(odd.run('SELECT 1')).rejects.toThrow('vericto: the prepared statement has no run()');
    await expect(odd.all('SELECT 1')).rejects.toThrow(/no all\(\)/);
  });

  it('fails closed by default and open on request when Vericto is down', async () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const open = await guardDatabase(raw, { vericto: fake.guard({ failMode: 'open' }) });
    await fake.stop();
    try {
      await expect(db.run("INSERT INTO users (email) VALUES ('x')")).rejects.toBeInstanceOf(VerictoUnavailableError);
      expect(count()).toBe(2);
      await open.run("INSERT INTO users (email) VALUES ('x')");
      expect(count()).toBe(3);
      expect(emit).toHaveBeenCalledOnce();
    } finally {
      emit.mockRestore();
      await fake.start();
    }
  });

  it('builds its guard from the VERICTO_* environment by default', async () => {
    vi.stubEnv('VERICTO_API_KEY', API_KEY);
    vi.stubEnv('VERICTO_DATABASE_ID', DATABASE_ID);
    vi.stubEnv('VERICTO_API_URL', fake.url);
    vi.stubEnv('VERICTO_FAIL_MODE', undefined);
    try {
      const fromEnv = await guardDatabase(raw);
      expect(fromEnv.raw).toBe(raw);
      expect(await fromEnv.get('SELECT 1 AS one')).toEqual({ one: 1 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses to guard when the server does not list the sqlite dialect', async () => {
    fake.dialects = [...DIALECTS_WITHOUT_SQLITE];
    const other = new Database(':memory:');
    try {
      await expect(guardDatabase(other, { vericto: fake.guard() })).rejects.toBeInstanceOf(
        VerictoUnsupportedDialectError,
      );
    } finally {
      other.close();
    }
  });
});
