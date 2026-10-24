# Knex

**Status: documented pattern.** There is no Knex integration in `@vericto/sdk`. Knex
opens its own driver connections, and its pool's `afterCreate` hook hands you each new
one: on PostgreSQL, guard it with the `guardPgClient` function of the
[node-postgres guide](node-postgres.md), and every statement Knex sends afterwards (query
builder, `knex.raw`, transactions, migrations) is checked with Vericto first.

Knex's `query` event cannot do this: it is a notification, it cannot stop or rewrite a
query. For PostgreSQL and MySQL the Vericto **TCP proxy** needs no code at all.

Tested with: Node.js 25.8.0 (CI: Node.js 22), `@vericto/sdk` 0.3.1, `knex` 3.3.0,
`pg` 8.23.1, PostgreSQL 17.

## Install

```bash
npm install @vericto/sdk knex pg
npm install -D @types/pg
```

## Example

```ts
import knexFactory from 'knex';
import pg from 'pg';
import { Vericto, VerictoBlockedError } from '@vericto/sdk';

type Callback = (err: Error | null, result?: pg.QueryResult) => void;

/** Check every statement `client` runs with Vericto before PostgreSQL sees it. */
export function guardPgClient(client: pg.ClientBase, vericto: Vericto): void {
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  const guarded = (config: string | pg.QueryConfig, ...rest: unknown[]): unknown => {
    if (typeof config !== 'string' && typeof (config as { submit?: unknown }).submit === 'function') {
      // pg-cursor and pg-query-stream objects: check their SQL yourself with vericto.prepare().
      throw new TypeError('vericto: Submittable queries are not checked by guardPgClient');
    }
    const text = typeof config === 'string' ? config : config.text;
    const last = rest[rest.length - 1];
    const callback = typeof last === 'function' ? (last as Callback) : undefined;
    const args = callback ? rest.slice(0, -1) : rest;
    const run = vericto.prepare(text, 'postgres').then((sql) =>
      query(typeof config === 'string' ? sql : { ...config, text: sql }, ...args),
    );
    if (!callback) return run;
    run.then(
      (result) => { callback(null, result as pg.QueryResult); },
      (err: unknown) => { callback(err instanceof Error ? err : new Error(String(err))); },
    );
    return undefined;
  };
  (client as unknown as { query: unknown }).query = guarded;
}

const vericto = new Vericto();
const knex = knexFactory({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: {
    afterCreate(conn: pg.Client, done: (err: Error | null, conn: pg.Client) => void) {
      guardPgClient(conn, vericto);
      done(null, conn);
    },
  },
});

await knex.raw('CREATE TABLE IF NOT EXISTS users (id int PRIMARY KEY, email text)');
await knex('users').insert({ id: 1, email: 'ada@example.com' }).onConflict('id').ignore();

console.log(await knex('users').select('id', 'email').where({ id: 1 })); // masked by Vericto

try {
  await knex('users').del(); // DELETE without WHERE: blocked before PostgreSQL sees it
} catch (err) {
  if (!(err instanceof VerictoBlockedError)) throw err;
  console.log(err.verdict.ruleCode, err.suggestedFix);
}
await knex.destroy();
```

With the documentation stub (it masks `email` and blocks a `DELETE` without `WHERE`):

<!-- docs-check: output -->
```text
[ { id: 1, email: '***' } ]
VERICTO-001 delete from "users" WHERE <condition>
```

## What each verdict does

- **BLOCKED**: the Knex promise rejects with `VerictoBlockedError` (`verdict`,
  `findings`, `suggestedFix`); the statement never reaches the database.
- **Mask**: the rewrite runs; the masked columns come back masked.
- **FLAGGED / MONITORED**: the statement runs, logged and passed to `onVerdict`.
- **No verdict**: `failMode: 'closed'` (default) rejects with `VerictoUnavailableError`;
  nothing runs.
- Knex's own connection setup (its server-version query, `search_path`) runs before
  `afterCreate` and is not checked; everything after it is.

## Other clients

- **MySQL**: Knex's `mysql2` connections take callback-style `query()` calls with
  Knex's own option objects; there is no tested pattern for them yet. Use the TCP proxy,
  or the functions of the [mysql2 guide](mysql2.md) for the SQL you run yourself.
- **SQLite (`better-sqlite3`)**: synchronous, so it cannot be checked transparently;
  use `@vericto/sdk/better-sqlite3` for the SQL you write by hand.
