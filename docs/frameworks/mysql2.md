# mysql2

**Status: documented pattern.** `@vericto/sdk` has no `mysql2` wrapper (it is on the
[roadmap](../../README.md#integrations-roadmap)). The pattern is a small pair of
functions in front of the pool: check the SQL with `Vericto.prepare`, then run the SQL
it returns (the masked rewrite, when there is one).

For MySQL the Vericto **TCP proxy** protects every connection without code changes
(and enforces masks); use this pattern when you cannot point the connection at it.

Tested with: Node.js 25.8.0 (CI: Node.js 22), `@vericto/sdk` 0.4.0, `mysql2` 3.24.6,
MySQL 8.4.

## Install

```bash
npm install @vericto/sdk mysql2
```

## Example

```ts
import mysql from 'mysql2/promise';
import { Vericto, VerictoBlockedError } from '@vericto/sdk';

const vericto = new Vericto(); // one per process; reads VERICTO_* from the environment
const pool = mysql.createPool(process.env.MYSQL_URL ?? '');

/** `pool.query`, after Vericto. Bind values are never sent to Vericto. */
async function query<T extends mysql.QueryResult>(sql: string, values?: unknown[]): Promise<T> {
  const [result] = await pool.query<T>(await vericto.prepare(sql, 'mysql'), values);
  return result;
}

/** `pool.execute` (server-side prepared statement), after Vericto. */
async function execute<T extends mysql.QueryResult>(sql: string, values?: mysql.ExecuteValues): Promise<T> {
  const [result] = await pool.execute<T>(await vericto.prepare(sql, 'mysql'), values);
  return result;
}

await query('CREATE TABLE IF NOT EXISTS users (id int PRIMARY KEY, email varchar(255))');
await execute('INSERT IGNORE INTO users VALUES (?, ?)', [1, 'ada@example.com']);

console.log(await query<mysql.RowDataPacket[]>('SELECT id, email FROM users WHERE id = ?', [1])); // masked

try {
  await query('DELETE FROM users'); // never reaches MySQL
} catch (err) {
  if (!(err instanceof VerictoBlockedError)) throw err;
  console.log(err.verdict.ruleCode, err.suggestedFix);
}
await pool.end();
```

With the documentation stub (it masks `email` and blocks a `DELETE` without `WHERE`):

<!-- docs-check: output -->
```text
[ { id: 1, email: '***' } ]
VERICTO-001 DELETE FROM users WHERE <condition>
```

## What each verdict does

| Verdict | Result |
|---|---|
| `ALLOWED` | The statement runs. |
| `FLAGGED` / `MONITORED` | It runs; the guard logs it and calls `onVerdict`. |
| mask | The rewrite runs instead of your SQL. |
| `BLOCKED` | `VerictoBlockedError` (`verdict`, `findings`, `suggestedFix`); MySQL never sees the statement. |
| no verdict | `failMode: 'closed'` (default): `VerictoUnavailableError`, nothing runs. `'open'`: runs unevaluated, with a `VerictoFailOpenWarning`. |
| key, scope, database id | `VerictoConfigError` in both fail modes. |

## Limits of the pattern

- Only SQL that goes through `query` / `execute` is checked: `pool.query()` called
  directly, `pool.getConnection()` connections and ORMs on the same pool are not. Use the
  functions for every statement, or the TCP proxy for a guarantee.
- A multi-statement string (`multipleStatements: true`) is evaluated as one request; a
  block anywhere means nothing runs.
