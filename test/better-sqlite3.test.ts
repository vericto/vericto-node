/** End to end with a real better-sqlite3 database and the local Runtime API stand-in. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VerictoBlockedError, VerictoUnsupportedDialectError } from '../src/index.js';
import { guardDatabase, type GuardedDatabase } from '../src/better-sqlite3.js';
import { FakeVericto, DIALECTS_WITHOUT_SQLITE, blocked, masked } from './fake-vericto.js';

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
