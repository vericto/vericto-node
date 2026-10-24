// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vericto for `better-sqlite3`.
 *
 * better-sqlite3 is synchronous and Vericto is a network call, so the SQL-carrying
 * entry points become async: `await db.prepare(sql)` checks the SQL once and
 * resolves the real `Statement`, whose `run`/`all`/`get`/`iterate` then stay
 * synchronous (the SQL of a prepared statement cannot change). Prepare statements
 * before a `db.raw.transaction(...)` and use them inside it.
 *
 * SQLite has no server, so this wrapper is the enforcement point: SQL run through
 * `db.raw` or another connection to the same file is not checked. The Vericto server
 * evaluates the `sqlite` dialect (vericto-engine 4.1.0+); `guardDatabase` still asks
 * it (`GET /api/v1/meta/config`) and rejects with `VerictoUnsupportedDialectError`,
 * with no SQL run, against a server that does not list `sqlite`.
 */
import { Vericto } from './guard.js';
import { sqlToExecute, type Verdict } from './verdict.js';

/** The Vericto dialect this wrapper evaluates statements as. */
export const DIALECT = 'sqlite';

/** The part of a better-sqlite3 `Database` this wrapper uses. */
export interface SqliteDatabaseLike {
  prepare(source: string): unknown;
  exec(source: string): unknown;
}

type StatementOf<D> = D extends { prepare(source: string): infer S } ? S : never;
type ResultOf<S, K extends string> = S extends Record<K, (...args: never[]) => infer R> ? R : unknown;

export interface GuardOptions {
  /** The guard to use. Default: `new Vericto()` from the `VERICTO_*` environment. */
  vericto?: Vericto;
}

/** A better-sqlite3 database whose SQL is checked by Vericto first. Build it with {@link guardDatabase}. */
export class GuardedDatabase<D extends SqliteDatabaseLike> {
  /** The underlying database. SQL run through it directly is **not** checked. */
  readonly raw: D;
  /** The guard every statement is checked with. */
  readonly vericto: Vericto;

  constructor(db: D, vericto: Vericto) {
    this.raw = db;
    this.vericto = vericto;
  }

  /** Check `sql`, then `db.prepare()` the SQL to run (the masked rewrite, if any). */
  async prepare(sql: string): Promise<StatementOf<D>> {
    const final = await this.vericto.prepare(sql, DIALECT);
    return this.raw.prepare(final) as StatementOf<D>;
  }

  /** Like `prepare`, also resolving the verdict (decision, rule, event id). */
  async prepareWithVerdict(sql: string): Promise<{ statement: StatementOf<D>; verdict: Verdict }> {
    const verdict = await this.vericto.enforce(sql, DIALECT);
    return { statement: this.raw.prepare(sqlToExecute(verdict)) as StatementOf<D>, verdict };
  }

  /**
   * Check a script, then `db.exec()` it. The script is evaluated as one request (the
   * engine evaluates every statement in it); a block anywhere means nothing runs.
   */
  async exec(sql: string): Promise<this> {
    const final = await this.vericto.prepare(sql, DIALECT);
    this.raw.exec(final);
    return this;
  }

  /** `prepare(sql)` then `statement.run(...params)`. */
  async run(sql: string, ...params: unknown[]): Promise<ResultOf<StatementOf<D>, 'run'>> {
    return call(await this.prepare(sql), 'run', params) as ResultOf<StatementOf<D>, 'run'>;
  }

  /** `prepare(sql)` then `statement.all(...params)`. */
  async all(sql: string, ...params: unknown[]): Promise<ResultOf<StatementOf<D>, 'all'>> {
    return call(await this.prepare(sql), 'all', params) as ResultOf<StatementOf<D>, 'all'>;
  }

  /** `prepare(sql)` then `statement.get(...params)`. */
  async get(sql: string, ...params: unknown[]): Promise<ResultOf<StatementOf<D>, 'get'>> {
    return call(await this.prepare(sql), 'get', params) as ResultOf<StatementOf<D>, 'get'>;
  }
}

function call(statement: unknown, method: string, params: unknown[]): unknown {
  const fn = (statement as Record<string, unknown>)[method];
  if (typeof fn !== 'function') throw new TypeError(`vericto: the prepared statement has no ${method}()`);
  return (fn as (...args: unknown[]) => unknown).apply(statement, params);
}

/**
 * Guard a better-sqlite3 `Database`. Rejects with `VerictoUnsupportedDialectError`
 * when the server does not list the `sqlite` dialect.
 */
export async function guardDatabase<D extends SqliteDatabaseLike>(
  db: D,
  options: GuardOptions = {},
): Promise<GuardedDatabase<D>> {
  const vericto = options.vericto ?? new Vericto();
  await vericto.requireDialect(DIALECT);
  return new GuardedDatabase(db, vericto);
}
