# Prisma ORM

**Status: documented pattern.** There is no Prisma integration in `@vericto/sdk`.
Prisma ORM 7 runs every query through a **driver adapter** (`@prisma/adapter-pg`,
`@prisma/adapter-better-sqlite3`, ...), and the adapter interface is asynchronous and
receives the final SQL. Wrapping the adapter therefore checks **every** statement Prisma
sends, model queries (`findMany`, `create`, `deleteMany`...) and raw queries alike,
before the database sees it.

The wrapper relies on the driver-adapter interface of
[`@prisma/driver-adapter-utils`](https://www.npmjs.com/package/@prisma/driver-adapter-utils)
(`connect`, `queryRaw`, `executeRaw`, `executeScript`, `startTransaction`). It is a
Prisma API, but not one `@vericto/sdk` controls: pin your Prisma version and re-run your
tests when you upgrade it. For PostgreSQL and MySQL the Vericto **TCP proxy** needs no
code (point `DATABASE_URL` at it) and is the more durable choice there.

Tested with: Node.js 25.8.0 (CI: Node.js 22), `@vericto/sdk` 0.4.0, `prisma` and
`@prisma/client` 7.10.1, `@prisma/adapter-better-sqlite3` 7.10.1 (SQLite). Not tested
with the other adapters; the wrapper does not depend on which one it wraps.

## Install

```bash
npm install @vericto/sdk @prisma/client @prisma/adapter-better-sqlite3
npm install -D prisma
```

The schema of the example (`prisma/schema.prisma`, then `npx prisma generate`):

```prisma
generator client {
  provider = "prisma-client"
  output   = "../generated/prisma"
  // Only to run the .ts files with Node's type stripping; omit it with a bundler or tsc.
  importFileExtension = "ts"
}

datasource db {
  provider = "sqlite"
}

model User {
  id    Int    @id
  email String
}
```

## Example

<!-- docs-check: env PRISMA_SQLITE_URL=file:./.vericto-docs.db -->
```ts
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import type { SqlDriverAdapter, SqlDriverAdapterFactory, SqlQuery, SqlQueryable } from '@prisma/driver-adapter-utils';
import { Vericto, VerictoBlockedError } from '@vericto/sdk';
import { PrismaClient } from './generated/prisma/client.ts';

/** `target` with some methods replaced; the others stay bound to it (adapters use #private fields). */
function override<T extends object>(target: T, methods: Partial<T>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (Object.hasOwn(methods, prop)) return methods[prop as keyof T];
      const value: unknown = Reflect.get(t, prop, t);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
}

/** Check every statement a Prisma driver adapter runs with Vericto first. */
function guardAdapter(factory: SqlDriverAdapterFactory, vericto: Vericto, dialect: string): SqlDriverAdapterFactory {
  const checked = async (query: SqlQuery): Promise<SqlQuery> => ({ ...query, sql: await vericto.prepare(query.sql, dialect) });
  const guardQueryable = <Q extends SqlQueryable>(q: Q): Partial<Q> => ({
    queryRaw: async (query: SqlQuery) => q.queryRaw(await checked(query)),
    executeRaw: async (query: SqlQuery) => q.executeRaw(await checked(query)),
  } as Partial<Q>);
  return override(factory, {
    async connect(): Promise<SqlDriverAdapter> {
      const adapter = await factory.connect();
      return override(adapter, {
        ...guardQueryable(adapter),
        executeScript: async (script: string) => { await adapter.executeScript(await vericto.prepare(script, dialect)); },
        startTransaction: async (...args: Parameters<SqlDriverAdapter['startTransaction']>) => {
          const tx = await adapter.startTransaction(...args);
          return override(tx, guardQueryable(tx));
        },
      });
    },
  });
}

const vericto = new Vericto(); // one per process; reads VERICTO_* from the environment
const adapter = new PrismaBetterSqlite3({ url: process.env.PRISMA_SQLITE_URL ?? 'file:./dev.db' });
const prisma = new PrismaClient({ adapter: guardAdapter(adapter, vericto, 'sqlite') });

await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "User" ("id" INTEGER PRIMARY KEY, "email" TEXT NOT NULL)');
await prisma.user.upsert({ where: { id: 1 }, create: { id: 1, email: 'ada@example.com' }, update: {} });

// A model query: Vericto masks the email column, and the masked rewrite is what runs.
console.log(await prisma.user.findMany({ select: { id: true, email: true } }));

try {
  await prisma.user.deleteMany(); // DELETE without WHERE: blocked, nothing is deleted
} catch (err) {
  const blocked = err instanceof VerictoBlockedError ? err : (err as { cause?: unknown }).cause;
  if (!(blocked instanceof VerictoBlockedError)) throw err;
  console.log(blocked.verdict.ruleCode);
}
await prisma.$disconnect();
```

With the documentation stub (it masks `email` and blocks a `DELETE` without `WHERE`):

<!-- docs-check: output -->
```text
[ { id: 1, email: '***' } ]
VERICTO-001
```

## What each verdict does

- **BLOCKED**: the Prisma call rejects and the statement never reaches the database.
  Prisma may hand the `VerictoBlockedError` through as is or as the `cause` of its own
  error: check both, as above.
- `deleteMany()` / `updateMany()` without a filter send `... WHERE 1=1`, which Vericto
  treats as no `WHERE` at all (VERICTO-001).
- **Mask**: the rewrite runs. Prisma maps the result by column name, so a masked column
  keeps its name; a masked value must still fit the field's type (Vericto masks text
  columns with text).
- **FLAGGED / MONITORED**: the query runs, logged and passed to `onVerdict`.
- **No verdict**: `failMode: 'closed'` (default) rejects; nothing runs. Configuration
  errors (`VerictoConfigError`) reject in both fail modes.
- Every statement is one Runtime API evaluation, including the ones Prisma adds itself
  (transaction statements, the `SELECT` after an `upsert`).

## Without a driver adapter

If you cannot use a driver adapter, the SDK can only check the SQL you write: run
`await vericto.prepare(sql, dialect)` and pass the result to `$queryRawUnsafe` /
`$executeRawUnsafe` (bind values stay separate arguments). Model queries are then
**not** checked before they run; use the TCP proxy for them.
