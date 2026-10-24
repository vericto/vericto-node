# node-postgres (`pg`)

**Status: documented pattern.** `@vericto/sdk` has no `pg` wrapper (it is on the
[roadmap](../../README.md#integrations-roadmap)). The pattern below uses only the
public API (`Vericto.prepare`) and `pg`'s own `connect` event, so every client the
pool hands out checks its SQL before PostgreSQL sees it.

If you can change the connection string, the Vericto **TCP proxy** protects
PostgreSQL without any code change and also enforces masks; this pattern is for
when you cannot, or want the check in the application.

Tested with: Node.js 25.8.0 (CI: Node.js 22), `@vericto/sdk` 0.3.1, `pg` 8.23.1, PostgreSQL 17.

## Install

```bash
npm install @vericto/sdk pg
npm install -D @types/pg
```

Set `VERICTO_API_KEY` (scope `proxy:evaluate`) and `VERICTO_DATABASE_ID` (see the
[README](../../README.md#configure)).

## Guard the pool

`guardPgClient` replaces one client's `query()` with one that asks Vericto first and
then runs the SQL Vericto returns (the masked rewrite, when there is one). It handles
the forms `pg` itself and the ORMs built on it use: a text or a `QueryConfig`, with a
promise or a callback. `pool.query()`, `pool.connect()` clients, transactions and
`Pool`-based ORMs (Drizzle, Kysely) all go through it.

```ts
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

const vericto = new Vericto(); // one per process; reads VERICTO_* from the environment
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pool.on('connect', (client) => { guardPgClient(client, vericto); });

await pool.query('CREATE TABLE IF NOT EXISTS users (id int PRIMARY KEY, email text)');
await pool.query('INSERT INTO users VALUES ($1, $2) ON CONFLICT DO NOTHING', [1, 'ada@example.com']);

// A masked column comes back masked: Vericto returned a rewrite and that is what ran.
const { rows } = await pool.query('SELECT id, email FROM users WHERE id = $1', [1]);
console.log(rows);

try {
  await pool.query('DELETE FROM users'); // never reaches PostgreSQL
} catch (err) {
  if (!(err instanceof VerictoBlockedError)) throw err;
  console.log(err.verdict.ruleCode, err.suggestedFix);
}
await pool.end();
```

With the documentation stub (`scripts/docs-stub.mjs`), which masks `email` and blocks a
`DELETE` without `WHERE`, this prints:

<!-- docs-check: output -->
```text
[ { id: 1, email: '***' } ]
VERICTO-001 DELETE FROM users WHERE <condition>
```

## What each verdict does

| Verdict | Result |
|---|---|
| `ALLOWED` | The query runs. |
| `FLAGGED` / `MONITORED` | The query runs; the guard logs it and calls `onVerdict`. |
| mask | The rewrite runs instead of your SQL: the masked columns come back masked. |
| `BLOCKED` | `pool.query()` rejects with `VerictoBlockedError` (`verdict`, `findings`, `suggestedFix`); PostgreSQL never sees the statement. With a callback, the callback gets the error. |
| no verdict | `failMode: 'closed'` (default): `VerictoUnavailableError`, nothing runs. `'open'`: the query runs unevaluated, with a `VerictoFailOpenWarning`. |
| key, scope, database id | `VerictoConfigError` in both fail modes. |

Bind values (`$1`, `$2`) are never sent to Vericto: the SQL text goes as written and
`pg` binds the values afterwards.

## Limits of the pattern

- Only the pool's clients are guarded. A `new pg.Client()` you create yourself needs
  `guardPgClient(client, vericto)` after `connect()`.
- Submittable queries (`pg-cursor`, `pg-query-stream`) throw instead of running
  unchecked: check their SQL with `await vericto.prepare(sql, 'postgres')` and build
  them from the result.
- Each statement is one Runtime API call (one network round trip and one query against
  your monthly quota). See [Caching](../../README.md#caching) for hot statements.
