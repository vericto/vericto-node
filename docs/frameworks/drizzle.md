# Drizzle ORM

**Status: documented pattern.** There is no Drizzle integration in `@vericto/sdk`.
Drizzle runs its SQL through the driver you give it, so you guard the **driver**: on
PostgreSQL, a `pg` pool whose clients check every statement with Vericto (the
[node-postgres](node-postgres.md) pattern). Query-builder calls, `db.execute(sql\`...\`)`
and transactions are all checked, after Drizzle has built the SQL.

For PostgreSQL and MySQL the Vericto **TCP proxy** does the same without code (point
the connection string at it); use this pattern when you cannot.

Tested with: Node.js 25.8.0 (CI: Node.js 22), `@vericto/sdk` 0.3.1, `drizzle-orm`
0.45.4, `pg` 8.23.1, PostgreSQL 17.

## Install

```bash
npm install @vericto/sdk drizzle-orm pg
npm install -D @types/pg
```

## Example

`guardPgClient` is the function from the [node-postgres guide](node-postgres.md),
repeated so the example runs on its own.

```ts
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
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

const users = pgTable('users', { id: integer('id').primaryKey(), email: text('email') });

const vericto = new Vericto();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pool.on('connect', (client) => { guardPgClient(client, vericto); });
const db = drizzle({ client: pool });

await db.execute('CREATE TABLE IF NOT EXISTS users (id int PRIMARY KEY, email text)');
await db.insert(users).values({ id: 1, email: 'ada@example.com' }).onConflictDoNothing();

// Drizzle builds `select "id", "email" from "users" where "users"."id" = $1`;
// Vericto masks the email column, and the masked rewrite is what runs.
console.log(await db.select().from(users).where(eq(users.id, 1)));

try {
  await db.delete(users); // DELETE without WHERE: blocked, nothing is deleted
} catch (err) {
  const blocked = err instanceof VerictoBlockedError ? err : (err as { cause?: unknown }).cause;
  if (!(blocked instanceof VerictoBlockedError)) throw err;
  console.log(blocked.verdict.ruleCode);
}

// Transactions run on a pool client, which is guarded too.
await db.transaction(async (tx) => {
  await tx.update(users).set({ email: 'ada@example.org' }).where(eq(users.id, 1));
});
await pool.end();
```

With the documentation stub (it masks `email` and blocks a `DELETE` without `WHERE`):

<!-- docs-check: output -->
```text
[ { id: 1, email: '***' } ]
VERICTO-001
```

## What each verdict does

- **BLOCKED**: the Drizzle call rejects and the statement never reaches PostgreSQL.
  Drizzle wraps driver errors in its own `DrizzleQueryError`, with the
  `VerictoBlockedError` as `cause` (check both, as above).
- **Mask**: the rewrite runs. Keep the column list of the rewrite in mind if you map
  rows by position: Vericto keeps the columns and their order, only the values change.
- **FLAGGED / MONITORED**: the query runs, logged and passed to `onVerdict`.
- **No verdict**: `failMode: 'closed'` (default) rejects with `VerictoUnavailableError`
  (as the `cause`); nothing runs.

## Other drivers

- **MySQL (`mysql2`)**: `mysql2` has no pool-level hook like `pg`'s `connect` event,
  so there is no tested pattern for `drizzle-orm/mysql2` yet. Use the TCP proxy, or the
  functions of the [mysql2 guide](mysql2.md) for the SQL you run yourself.
- **SQLite (`better-sqlite3`)**: the driver is synchronous and a Vericto check is a
  network call, so a Drizzle database on it cannot be checked transparently. Use
  `@vericto/sdk/better-sqlite3` directly for the SQL you write by hand.
