// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vericto for `snowflake-sdk`.
 *
 * `connection.execute()` returns its statement synchronously, but a Vericto check
 * is a network call, so the guarded `execute()` resolves the statement instead. The
 * options are the driver's own (`sqlText`, `binds`, `complete`, `streamResult`,
 * `parameters`...). When you pass `complete`, a Vericto rejection is delivered to it
 * as `err` (callback style) and the promise resolves `undefined`; without
 * `complete`, the promise rejects. `query()` is a promise-style shortcut.
 *
 * `sqlText` is sent to Vericto as written (`?` and `:1` binds included; bind values
 * are never sent). A multi-statement `sqlText` is evaluated as one request: a block
 * anywhere means nothing runs.
 */
import { Vericto } from './guard.js';

export const DIALECT = 'snowflake';

type Callback = (err: unknown, statement: unknown, rows?: unknown[]) => void;

/** The part of a snowflake-sdk `Connection` this wrapper uses. */
export interface SnowflakeConnectionLike {
  execute(options: { sqlText: string; complete?: Callback }): unknown;
}

type OptionsOf<C extends SnowflakeConnectionLike> = Parameters<C['execute']>[0];
type StatementOf<C extends SnowflakeConnectionLike> = ReturnType<C['execute']>;

export interface GuardOptions {
  /** The guard to use. Default: `new Vericto()` from the `VERICTO_*` environment. */
  vericto?: Vericto;
}

export class GuardedSnowflakeConnection<C extends SnowflakeConnectionLike> {
  /** The underlying connection. SQL run through it directly is **not** checked. */
  readonly raw: C;
  readonly vericto: Vericto;

  constructor(connection: C, vericto: Vericto) {
    this.raw = connection;
    this.vericto = vericto;
  }

  /** Check `options.sqlText`, then `connection.execute()` the SQL to run. */
  async execute(options: OptionsOf<C>): Promise<StatementOf<C> | undefined> {
    let sqlText: string;
    try {
      sqlText = await this.vericto.prepare(options.sqlText, DIALECT);
    } catch (err) {
      if (typeof options.complete === 'function') {
        options.complete(err, undefined, undefined);
        return undefined;
      }
      throw err;
    }
    return this.raw.execute({ ...options, sqlText }) as StatementOf<C>;
  }

  /** Promise style: resolves the rows (not for `streamResult`). */
  query<Row = Record<string, unknown>>(
    sqlText: string,
    binds?: unknown,
    options: Record<string, unknown> = {},
  ): Promise<Row[]> {
    return new Promise<Row[]>((resolve, reject) => {
      const complete: Callback = (err, _statement, rows) => {
        if (err) reject(err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err)));
        else resolve((rows ?? []) as Row[]);
      };
      const request = { ...options, sqlText, complete, ...(binds === undefined ? {} : { binds }) };
      this.execute(request as unknown as OptionsOf<C>).catch(reject);
    });
  }
}

/** Guard a snowflake-sdk connection (connected or not). */
export async function guardConnection<C extends SnowflakeConnectionLike>(
  connection: C,
  options: GuardOptions = {},
): Promise<GuardedSnowflakeConnection<C>> {
  const vericto = options.vericto ?? new Vericto();
  await vericto.requireDialect(DIALECT);
  return new GuardedSnowflakeConnection(connection, vericto);
}
