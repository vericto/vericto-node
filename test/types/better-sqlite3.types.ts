// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Type test for `@vericto/sdk/better-sqlite3`, compiled by `npm run typecheck`
 * (tsconfig includes test/). Never executed. Each `@ts-expect-error` must stay an
 * error, so a loosened type fails the build too.
 *
 * Regression (0.3.x): `GuardedDatabase<Database>.prepare()` resolved
 * `Statement<unknown[], unknown> | Statement<[{}], unknown>`, so `stmt.run()` with no
 * argument, or with two, did not compile, and a `Statement<[number], Row>`
 * annotation was rejected.
 */
import type Database from 'better-sqlite3';

import { guardDatabase, type GuardedDatabase, type StatementOf } from '../../src/better-sqlite3.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(): T | undefined {
  return undefined;
}

interface Row {
  id: number;
  email: string;
}

declare const raw: Database.Database;

export async function betterSqlite3(): Promise<void> {
  const db = await guardDatabase(raw);

  // Without type arguments: better-sqlite3's own default statement.
  const stmt = await db.prepare('SELECT 1');
  assertType<Equal<typeof stmt, Database.Statement<unknown[], unknown>>>();
  stmt.run();
  stmt.run(1, 'two', null);
  stmt.all();
  stmt.get(null);
  for (const row of stmt.iterate()) assertType<Equal<typeof row, unknown>>();
  raw.transaction(() => stmt.run())();

  // With type arguments, as raw.prepare<B, R>() takes them.
  const typed: Database.Statement<[number], Row> = await db.prepare<[number], Row>('SELECT id, email FROM users WHERE id = ?');
  const row = typed.get(1);
  assertType<Equal<typeof row, Row | undefined>>();
  // @ts-expect-error: the bind parameters stay checked
  typed.get('one');
  // @ts-expect-error: and their count
  typed.get();
  const rows: Row[] = typed.all(2);
  void rows;

  // Named parameters: Statement<[{ id: number }], Row>, as better-sqlite3 types it.
  const named = await db.prepare<{ id: number }, Row>('SELECT id, email FROM users WHERE id = @id');
  assertType<Equal<typeof named, Database.Statement<{ id: number }, Row>>>();
  named.get({ id: 1 });
  // @ts-expect-error: the named parameter's type stays checked
  named.get({ id: 'one' });

  // The same as the raw driver gives.
  assertType<Equal<Awaited<ReturnType<typeof db.prepare<[number], Row>>>, ReturnType<typeof raw.prepare<[number], Row>>>>();

  const { statement, verdict } = await db.prepareWithVerdict<[number], Row>('SELECT id, email FROM users WHERE id = ?');
  assertType<Equal<typeof statement, Database.Statement<[number], Row>>>();
  void verdict.decision;

  assertType<Equal<Awaited<ReturnType<typeof db.run>>, Database.RunResult>>();
  assertType<Equal<Awaited<ReturnType<typeof db.all<Row>>>, Row[]>>();
  assertType<Equal<Awaited<ReturnType<typeof db.get<Row>>>, Row | undefined>>();
  assertType<Equal<Awaited<ReturnType<typeof db.all>>, unknown[]>>();
}

// Any other driver: the statement type is still whatever its prepare() returns, no looser.
interface OtherStatement {
  execute(id: number): { rows: Row[] };
}
interface OtherDriver {
  prepare(source: string): OtherStatement;
  exec(source: string): void;
}
declare const other: OtherDriver;

export async function otherDriver(): Promise<void> {
  const db: GuardedDatabase<OtherDriver> = await guardDatabase(other);
  const stmt = await db.prepare('SELECT 1');
  assertType<Equal<typeof stmt, OtherStatement>>();
  assertType<Equal<StatementOf<OtherDriver, [number], Row>, OtherStatement>>();
  stmt.execute(1);
  // @ts-expect-error: its methods stay typed
  stmt.execute('one');
  // @ts-expect-error: and it has no better-sqlite3 methods
  stmt.run(); // eslint-disable-line @typescript-eslint/no-unsafe-call -- the expected type error
  // No run/all/get on its statement: unknown, as before.
  assertType<Equal<Awaited<ReturnType<typeof db.run>>, unknown>>();
}

// A driver-shaped object that is not a database is still refused.
export async function notADatabase(): Promise<void> {
  // @ts-expect-error: no exec()
  await guardDatabase({ prepare: (source: string) => source });
}
