/**
 * Opt-in end-to-end test of `@vericto/sdk/better-sqlite3` against a real Vericto
 * Runtime API. Skipped unless configured; never run in CI.
 *
 * Vericto here is a real server (staging, by default): statements are evaluated by
 * the real engine against the workspace's real rules and run on a real SQLite file
 * in a temporary directory. Allowed statements must execute; blocked ones must reject
 * with `VerictoBlockedError` before SQLite sees them (checked with better-sqlite3's
 * `verbose` trace, the file's SHA-256 and the filesystem); a FLAGGED one runs and is
 * logged as a warning.
 *
 *   VERICTO_LIVE_SQLITE=1
 *   VERICTO_API_KEY=vtro_...                         # proxy:evaluate scope
 *   VERICTO_API_URL=https://api-staging.vericto.com
 *   VERICTO_DATABASE_ID=<uuid of a database with dialect sqlite>
 *   npx vitest run test/live
 *
 * The database's workspace must use the default rules (VERICTO-001 and
 * VERICTO-098/100/101 block, VERICTO-099 flags). Each run makes about 25 real
 * evaluations, counted against the workspace's monthly quota.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Vericto, VerictoBlockedError, type Verdict } from '../../src/index.js';
import { guardDatabase, type GuardedDatabase } from '../../src/better-sqlite3.js';

const env = process.env;
const enabled =
  env.VERICTO_LIVE_SQLITE === '1' && Boolean(env.VERICTO_API_KEY && env.VERICTO_API_URL && env.VERICTO_DATABASE_ID);

type Row = { id: number; name: string };
const ROWS: Row[] = [
  { id: 1, name: 'ana' },
  { id: 2, name: 'bo' },
];

let dir: string;
let path: string;
let raw: Database.Database; // guarded through `db`; its `verbose` hook records what SQLite ran
let reader: Database.Database; // never guarded
let db: GuardedDatabase<Database.Database>;
let ran: string[];
let verdicts: Verdict[];
let warnings: string[];

const rows = (): Row[] => reader.prepare('SELECT id, name FROM t ORDER BY id').all() as Row[];
const digest = (): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const files = (): string[] => readdirSync(dir).sort();
const snapshot = () => ({ digest: digest(), rows: rows(), files: files(), ran: ran.length });

async function expectBlockedBeforeSqlite(run: () => Promise<unknown>, sql: string, rule: string): Promise<void> {
  const before = snapshot();
  const err = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(VerictoBlockedError);
  const verdict = (err as VerictoBlockedError).verdict;
  expect(verdict.ruleCode).toBe(rule);
  expect(verdict.eventId).toBeTruthy(); // in the server's audit trail
  expect(snapshot()).toEqual(before);
  expect(ran).not.toContain(sql);
}

describe.skipIf(!enabled)('better-sqlite3 against a live Vericto server', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vericto-sqlite-live-'));
    path = join(dir, 'live.db');
    ran = [];
    verdicts = [];
    warnings = [];
    raw = new Database(path, { verbose: (sql) => ran.push(String(sql)) });
    reader = new Database(path);
    const vericto = new Vericto({
      failMode: 'closed',
      onVerdict: (v) => verdicts.push(v),
      logger: { info: () => {}, warn: (m) => warnings.push(m), error: (m) => warnings.push(m) },
    });
    db = await guardDatabase(raw, { vericto });
    expect(await vericto.evaluator.supportedDialects()).toContain('sqlite');
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    const insert = await db.prepare('INSERT INTO t (id, name) VALUES (?, ?)');
    for (const r of ROWS) insert.run([r.id, r.name]);
    expect(rows()).toEqual(ROWS);
    ran.length = 0;
    verdicts.length = 0;
  });

  afterEach(() => {
    raw.close();
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs benign statements', async () => {
    const upsert = 'INSERT INTO t (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name';
    await db.run(upsert, 2, 'bea');
    await db.run(upsert, 3, 'cy');
    await db.run('INSERT INTO t (id, name) VALUES (?, ?)', 4, 'di');
    expect(await db.all('SELECT id, name FROM t WHERE id >= ? ORDER BY id', 2)).toEqual([
      { id: 2, name: 'bea' },
      { id: 3, name: 'cy' },
      { id: 4, name: 'di' },
    ]);
    await db.run('DELETE FROM t WHERE id = ?', 4);
    expect(rows()).toEqual([
      { id: 1, name: 'ana' },
      { id: 2, name: 'bea' },
      { id: 3, name: 'cy' },
    ]);
    expect(verdicts).toHaveLength(5);
    expect(verdicts.every((v) => v.decision !== 'BLOCKED')).toBe(true);
  });

  it('blocks DELETE without WHERE (VERICTO-001)', async () => {
    await expectBlockedBeforeSqlite(() => db.run('DELETE FROM t'), 'DELETE FROM t', 'VERICTO-001');
  });

  it('blocks ATTACH DATABASE (VERICTO-098)', async () => {
    const other = join(dir, 'attached.db');
    const sql = `ATTACH DATABASE '${other}' AS other`;
    await expectBlockedBeforeSqlite(() => db.exec(sql), sql, 'VERICTO-098');
    expect(existsSync(other)).toBe(false);
    const attached = raw.prepare('PRAGMA database_list').all() as { name: string }[];
    expect(attached.map((d) => d.name)).toEqual(['main']);
  });

  it('blocks load_extension (VERICTO-100)', async () => {
    const sql = `SELECT load_extension('${join(dir, 'evil')}')`;
    await expectBlockedBeforeSqlite(() => db.get(sql), sql, 'VERICTO-100');
  });

  it('blocks VACUUM INTO (VERICTO-101)', async () => {
    const copy = join(dir, 'copy.db');
    const sql = `VACUUM INTO '${copy}'`;
    await expectBlockedBeforeSqlite(() => db.exec(sql), sql, 'VERICTO-101');
    expect(existsSync(copy)).toBe(false);
  });

  it('runs PRAGMA foreign_keys = OFF with a FLAGGED warning (VERICTO-099)', async () => {
    raw.pragma('foreign_keys = ON'); // unguarded setup
    await db.exec('PRAGMA foreign_keys = OFF');
    expect(verdicts.at(-1)).toMatchObject({ decision: 'FLAGGED', ruleCode: 'VERICTO-099' });
    expect(warnings.some((w) => w.includes('FLAGGED') && w.includes('VERICTO-099'))).toBe(true);
    expect(ran).toContain('PRAGMA foreign_keys = OFF');
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(0);
  });

  it('runs none of a script with a blocked statement in the middle', async () => {
    const script = "INSERT INTO t (id, name) VALUES (10, 'x');\nDELETE FROM t;\nINSERT INTO t (id, name) VALUES (11, 'y');\n";
    await expectBlockedBeforeSqlite(() => db.exec(script), script, 'VERICTO-001');

    await db.exec(script.replace('DELETE FROM t;\n', '')); // without the DELETE it runs whole
    expect(rows()).toEqual([...ROWS, { id: 10, name: 'x' }, { id: 11, name: 'y' }]);
  });
});
