Official Vericto SDK for Node.js: check SQL before it runs (snowflake-sdk, better-sqlite3, LangChain.js SQL agents and chains, and any driver through the Runtime API client).

# @vericto/sdk

> Check every SQL statement with [Vericto](https://vericto.com) **before** it runs:
> thin wrappers for `snowflake-sdk` and `better-sqlite3`, a LangChain.js
> integration for SQL agents, and a client for the Vericto Runtime API you can put
> in front of any driver.

Vericto is a deterministic SQL firewall: it parses each statement into an AST and
evaluates it against your workspace's rules (destructive statements, missing
`WHERE`/`LIMIT`, risky DDL, data exposure, sensitive columns, agent allowlists).
This package checks SQL before your driver runs it: blocked statements reject
before they reach the database, flagged ones run and are reported, and statements
that read masked columns run as the masked rewrite Vericto returns.

It is a thin client of the **Vericto Runtime API** (`POST /api/v1/proxy/query`).
Evaluation happens in your Vericto workspace; nothing is evaluated locally in this
release (see [Evaluators](#evaluators)).

- TypeScript types, ESM and CommonJS builds, Node.js 18+ (uses the global `fetch`).
- No runtime dependencies. Drivers and LangChain are optional peer dependencies
  and separate entry points: importing `@vericto/sdk` never loads them.
- Asynchronous only: a check is a network call, so every API that checks SQL
  returns a promise. There is no synchronous variant.

Python (snowflake-connector-python, sqlite3, SQLAlchemy, LangChain, LlamaIndex,
dbt and Airflow) lives in [vericto-python](https://github.com/vericto/vericto-python).

## Contents

- [Install](#install) · [Configure](#configure) · [Quickstart](#quickstart)
- [Core API](#core-api): `Vericto`, `Verdict`, helpers, options
- [What each decision does](#what-each-decision-does) · [Fail mode](#fail-mode) ·
  [Timeouts and retries](#timeouts-and-retries) · [Errors](#errors)
- Drivers: [snowflake-sdk](#snowflake-sdk) · [better-sqlite3](#better-sqlite3)
- [Frameworks](#frameworks): LangChain.js (official), and tested patterns for the
  Vercel AI SDK, Mastra, the OpenAI Agents SDK, Prisma, Drizzle, Knex, node-postgres
  and mysql2
- [Caching](#caching) · [SQLite status](#sqlite-status) ·
  [Enforcement boundary](#enforcement-boundary) · [Evaluators](#evaluators) ·
  [Development](#development)

## Install

```bash
npm install @vericto/sdk
```

## Configure

Create an API key with the **`proxy:evaluate`** scope in the Vericto dashboard
(API keys) and register the database you are protecting. Then:

| Variable | Option | Meaning | Default |
|---|---|---|---|
| `VERICTO_API_KEY` | `apiKey` | API key (`vtro_...`), scope `proxy:evaluate` | required |
| `VERICTO_DATABASE_ID` | `databaseId` | The registered database (UUID): its rules, sensitive-column tags and agent allowlists apply | required |
| `VERICTO_API_URL` | `apiUrl` | API base URL | `https://api.vericto.com` |
| `VERICTO_FAIL_MODE` | `failMode` | `closed` or `open` (see [Fail mode](#fail-mode)) | `closed` |
| `VERICTO_TIMEOUT` | `timeoutMs` | Per-attempt timeout (env in seconds, option in ms) | 5 s |

An option beats its variable. An empty or whitespace-only variable counts as
unset, so it gets the default; an invalid value throws `VerictoConfigError` from
the constructor. `options.env` replaces `process.env` as the source of the
variables (useful in tests and workers).

The key is sent only in the `X-API-Key` header, only over HTTPS (plain HTTP is
accepted for `localhost`, `127.0.0.1` and `::1` alone), and never appears in
messages, `toString()` or `JSON.stringify()`. To trust an extra CA, use Node's
`NODE_EXTRA_CA_CERTS`; to go through a proxy or a custom agent, pass your own
`fetch`.

## Quickstart

Ask Vericto, then run the SQL it returns. One `Vericto` per process; it reads the
variables above.

```ts
import { Vericto, VerictoBlockedError, sqlToExecute } from '@vericto/sdk';

const vericto = new Vericto();

// Allowed, flagged or masked: run sqlToExecute(verdict), never the original.
const verdict = await vericto.enforce('SELECT id, email FROM users WHERE id = 1', 'postgres');
console.log(verdict.decision, verdict.ruleCode, sqlToExecute(verdict));

// Blocked: enforce() rejects, and the statement must not run.
try {
  await vericto.enforce('DELETE FROM users', 'postgres');
} catch (err) {
  if (!(err instanceof VerictoBlockedError)) throw err; // unavailable or misconfigured: fail closed
  console.log(err.verdict.ruleCode, err.suggestedFix);
}
```

Against the documentation stub (`scripts/docs-stub.mjs`, which masks `email` and
blocks a `DELETE` without `WHERE`), this prints:

<!-- docs-check: output -->
```text
FLAGGED VERICTO-085 SELECT id, '***' AS email FROM users WHERE id = 1
VERICTO-001 DELETE FROM users WHERE <condition>
```

`vericto.prepare(sql, dialect)` is `enforce` resolving the SQL text to run, the
shortest way to put Vericto in front of any driver:

```ts
import { Vericto } from '@vericto/sdk';

const vericto = new Vericto();

/** Any driver: check, then run what Vericto returns. */
export async function guardedQuery<T>(run: (sql: string) => Promise<T>, sql: string): Promise<T> {
  return run(await vericto.prepare(sql, 'postgres'));
}

console.log(await guardedQuery(async (sql) => `ran: ${sql}`, 'SELECT 1'));
```

For a specific driver or framework, see [Drivers](#snowflake-sdk) and
[Frameworks](#frameworks).

## Core API

### `new Vericto(options?)`

| Method | Resolves | Rejects with |
|---|---|---|
| `enforce(sql, dialect)` | the `Verdict` (allowed, flagged, monitored, parse error, masked, or `UNEVALUATED` under fail-open) | `VerictoBlockedError` on `BLOCKED`; `VerictoUnavailableError` under `failMode: 'closed'`; `VerictoConfigError` |
| `prepare(sql, dialect)` | the SQL text to run (`sqlToExecute(verdict)`) | as `enforce` |
| `enforceAll(statements, dialect)` | one verdict per statement, in order; a block anywhere rejects before you run any of them | as `enforce` |
| `check(sql, dialect)` | the verdict, whatever it is (`BLOCKED` included): to ask, not to guard | `VerictoUnavailableError` (the fail mode is **not** applied), `VerictoConfigError` |
| `requireDialect(dialect)` | the normalized dialect id | `VerictoUnsupportedDialectError` when the server does not list it |
| `clearCache()` | (sync) drops the verdict cache | |

`dialect` is a Vericto dialect (`postgres`, `mysql`, `oracle`, `mssql`, `snowflake`,
`sqlite`) or a driver name `normalizeDialect` maps to one (`postgresql`, `pg`,
`mysql2`, `mariadb`, `oracledb`, `sqlserver`, `tedious`, `sqlite3`,
`better-sqlite3`). `KNOWN_DIALECTS` lists the six.

Options (`VerictoOptions`; all optional):

| Option | Meaning | Default |
|---|---|---|
| `apiKey`, `databaseId`, `apiUrl`, `timeoutMs` | See [Configure](#configure). | environment |
| `maxRetries` | Retries after the first attempt. | `2` |
| `backoffMs` | Base of the exponential backoff between retries (with jitter, capped at 2 s). | `200` |
| `dialectsTtlMs` | How long the server's dialect list is cached. | 10 minutes |
| `failMode` | `closed` or `open`. | `VERICTO_FAIL_MODE`, else `closed` |
| `onVerdict` | Called with every verdict, `BLOCKED` and `UNEVALUATED` included (metrics, your own audit). A throwing callback is logged and ignored. | none |
| `logger` | `{ info, warn, error }`, or `false` to silence it. Lines carry the rule code, severity and event id, **never the SQL text**. | `console` for warnings and errors, silent for info |
| `cacheTtlMs`, `cacheSize` | See [Caching](#caching). | `0` (off), `1024` |
| `evaluator` | Replace the Runtime API client (see [Evaluators](#evaluators)). | `RuntimeApiEvaluator` |
| `fetch` | A `fetch` implementation (proxies, tests). | global `fetch` |
| `env` | Where the `VERICTO_*` defaults are read from. | `process.env` |

### `Verdict`

| Field | Meaning |
|---|---|
| `decision` | `ALLOWED`, `FLAGGED`, `MONITORED`, `PARSE_ERROR`, `BLOCKED`, or `UNEVALUATED` (local: fail-open ran it without a verdict). An unknown decision from the server is read as `BLOCKED`. |
| `sql`, `dialect` | The statement as submitted, and the dialect it was evaluated as. |
| `ruleCode`, `severity`, `message` | The deciding rule, its severity, and the server's explanation when it adds one. |
| `suggestedFix` | A safer statement Vericto proposes, when it has one. |
| `rewrittenQuery` | When set, the statement to run **instead of** `sql`: the masked rewrite. |
| `findings` | The rules that matched: `{ ruleCode, severity?, ruleId?, astNodePath?, suggestedFix? }`. |
| `sensitiveColumns`, `accessDenied` | The tagged columns the statement reads, and what the key's agent allowlist denied, as the server reports them. |
| `parseError` | The parser's message, on a parse error. |
| `eventId` | The audit-trail event, to look the evaluation up in the dashboard. |
| `rulesetVersion`, `cached` | Cache bookkeeping (see [Caching](#caching)). |
| `raw` | The response body, for fields this version does not model yet. |

Helpers: `sqlToExecute(verdict)` (the rewrite when there is one, else `sql`),
`isMasked(verdict)`, `verdictFromResponse(body, sql, dialect)` (build a verdict from a
Runtime API body, for a custom evaluator or a test double), `VERSION`, and the
constants `DEFAULT_API_URL`, `EVALUATE_PATH`, `CONFIG_PATH`.

## What each decision does

| Verdict | What the wrapper does |
|---|---|
| `ALLOWED` | Runs the statement. |
| `FLAGGED` | Runs it, logs a warning, calls `onVerdict`. |
| `MONITORED` | Runs it, logs at info, calls `onVerdict`. |
| `PARSE_ERROR` (allowed) | The workspace's `parse_error_action` let it through: runs it and logs a warning. When the workspace blocks unparseable SQL, the server answers `BLOCKED` (rule `VERICTO-PARSE-ERROR`). |
| `BLOCKED` | Rejects with `VerictoBlockedError` (`verdict`, `findings`, `suggestedFix`) **before** the driver is called. |
| mask (`rewrittenQuery`) | Runs `rewrittenQuery` **instead of** your SQL: the sensitive columns come back masked. Never the original. |
| no verdict | The [fail mode](#fail-mode) decides. |

Every evaluation is recorded in the Vericto audit trail and counts against the
workspace's monthly query quota.

## Fail mode

When Vericto cannot answer (network error, timeout, HTTP 5xx, rate limit after
retries, or the monthly quota `QUOTA_EXCEEDED`):

- `failMode: 'closed'` (default): reject with `VerictoUnavailableError`; the
  statement does not run.
- `failMode: 'open'`: run the statement unevaluated, emit a process warning of type
  `VerictoFailOpenWarning`, log it, and pass an `UNEVALUATED` verdict to `onVerdict`.

Configuration errors are **never** failed open: a missing or revoked key (401), a
key without the scope or for another database (403), a malformed request (400) or
an unsupported dialect reject with `VerictoConfigError` in both modes.

<!-- docs-check: env VERICTO_API_URL={stub}/stall -->
```ts
import { Vericto, VerictoUnavailableError } from '@vericto/sdk';

// The server sends its headers and then stalls (the stub's /stall mode): the timeout
// still applies, closed rejects, and nothing runs.
const closed = new Vericto({ timeoutMs: 200, maxRetries: 1, logger: false });
try {
  await closed.enforce('UPDATE accounts SET balance = 0 WHERE id = 7', 'postgres');
} catch (err) {
  if (!(err instanceof VerictoUnavailableError)) throw err;
  console.log(err.name);
}

// Nothing listening at all: the same error.
const unreachable = new Vericto({ apiUrl: 'http://127.0.0.1:9', maxRetries: 0, logger: false });
await unreachable.enforce('SELECT 1', 'postgres').catch((err: unknown) => {
  console.log(err instanceof VerictoUnavailableError);
});

// Open: the statement may run, unevaluated, and you are told.
const open = new Vericto({ failMode: 'open', timeoutMs: 200, maxRetries: 0, logger: false });
const verdict = await open.enforce('SELECT 1', 'postgres');
console.log(verdict.decision, verdict.sql);
```

<!-- docs-check: output -->
```text
VerictoUnavailableError
true
UNEVALUATED SELECT 1
```

<!-- docs-check: env VERICTO_API_URL={stub}/401 -->
```ts
import { Vericto, VerictoConfigError } from '@vericto/sdk';

// A revoked key (the stub's /401 mode) is a configuration error, even under failMode 'open'.
const vericto = new Vericto({ failMode: 'open', logger: false });
await vericto.enforce('SELECT 1', 'postgres').catch((err: unknown) => {
  if (err instanceof VerictoConfigError) console.log(err.name, err.status);
});
```

<!-- docs-check: output -->
```text
VerictoConfigError 401
```

## Timeouts and retries

- Each attempt, response body included, is bounded by `timeoutMs` (default 5 s,
  `VERICTO_TIMEOUT` in seconds).
- Network errors, timeouts, HTTP 5xx and 429 `RATE_LIMIT_EXCEEDED` are retried
  `maxRetries` times (default 2), with exponential backoff and jitter from
  `backoffMs` (default 200 ms), honouring `Retry-After`; every wait is capped at 2 s.
- 429 `QUOTA_EXCEEDED` (the monthly quota) is not retried:
  `VerictoQuotaExceededError` (`resetsAt`, `upgradeUrl`). 400, 401 and 403 are not
  retried: `VerictoConfigError`.
- The first check (and the first after `dialectsTtlMs`) also asks the server which
  dialects it evaluates (`GET /api/v1/meta/config`, one attempt, `timeoutMs`). If
  that cannot be answered nothing is cached and the evaluation request decides.
- Worst case for one statement while Vericto is unreachable: the dialect request
  plus `maxRetries + 1` attempts and the waits between them; with the defaults about
  `5 + 3 × 5 + 2 × 2` = 24 s. Lower `timeoutMs` and `maxRetries` on latency-sensitive
  paths; the fail mode then applies sooner.

## Errors

All extend `VerictoError`.

| Error | When | Fields |
|---|---|---|
| `VerictoBlockedError` | Vericto blocked the statement; it was not executed. | `verdict`, `findings`, `suggestedFix`, `sql` |
| `VerictoUnavailableError` | No verdict after the retries and `failMode: 'closed'` (always from `check()`). | `status`, `code` |
| `VerictoQuotaExceededError` | Extends `VerictoUnavailableError`: monthly quota used (429 `QUOTA_EXCEEDED`). | `resetsAt`, `upgradeUrl` |
| `VerictoConfigError` | Key, scope, database id, URL, timeout or request problem; thrown in both fail modes. | `status`, `code` |
| `VerictoUnsupportedDialectError` | Extends `VerictoConfigError`: the server does not evaluate that dialect. | `dialect`, `supported` |

Error messages never contain the key or the SQL's bind values.

## snowflake-sdk

<!-- docs-check: skip needs snowflake-sdk and a Snowflake account; covered by test/snowflake.test.ts with a fake connection -->
```ts
import snowflake from 'snowflake-sdk';
import { VerictoBlockedError } from '@vericto/sdk';
import { guardConnection } from '@vericto/sdk/snowflake';

const raw = snowflake.createConnection({
  account: 'myorg-myaccount',
  username: 'APP',
  authenticator: 'SNOWFLAKE_JWT',
  privateKeyPath: 'rsa_key.p8',
});
await raw.connectAsync();
const conn = await guardConnection(raw); // rejects if the server does not evaluate snowflake

const rows = await conn.query('SELECT id, email FROM customers WHERE id = ?', [42]);

// Callback style, with the driver's own options:
await conn.execute({
  sqlText: 'DELETE FROM customers',
  complete: (err) => {
    if (err instanceof VerictoBlockedError) console.log(err.verdict.ruleCode); // never reached Snowflake
  },
});
```

`connection.execute()` returns its statement synchronously, but a Vericto check is
a network call, so the guarded `execute()` resolves the statement. With
`complete`, a Vericto rejection is delivered to it as `err` (and the promise
resolves `undefined`); without it, the promise rejects. `query(sqlText, binds?,
options?)` is a promise-style shortcut that resolves the rows (not for
`streamResult`). A multi-statement `sqlText` (`MULTI_STATEMENT_COUNT`) is evaluated
as one request: a block anywhere means nothing runs. `conn.raw` is the unguarded
connection.

## better-sqlite3

```ts
import Database from 'better-sqlite3';
import { VerictoBlockedError } from '@vericto/sdk';
import { guardDatabase } from '@vericto/sdk/better-sqlite3';

const db = await guardDatabase(new Database(':memory:')); // rejects if the server does not evaluate sqlite

await db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY, expires_at INTEGER)'); // whole script checked first
await db.run('INSERT INTO sessions (expires_at) VALUES (?)', 0);

const expire = await db.prepare('DELETE FROM sessions WHERE expires_at < ?'); // checked once
console.log(expire.run(Date.now()).changes);                               // synchronous, as usual

const { statement, verdict } = await db.prepareWithVerdict('SELECT count(*) AS n FROM sessions WHERE id > ?');
console.log(verdict.decision, statement.get(0));

try {
  await db.run('DELETE FROM sessions'); // never reaches SQLite
} catch (err) {
  if (!(err instanceof VerictoBlockedError)) throw err;
  console.log(err.verdict.ruleCode);
}
```

<!-- docs-check: output -->
```text
1
ALLOWED { n: 0 }
VERICTO-001
```

better-sqlite3 is synchronous, so the SQL-carrying entry points (`prepare`,
`prepareWithVerdict`, `exec`, and the `run`/`all`/`get` shortcuts) become async. A
prepared statement's SQL cannot change, so its `run`/`all`/`get`/`iterate` stay
synchronous: prepare statements before `db.raw.transaction(...)` and use them inside
it. An `exec` script is evaluated as one request. Bind values (`?`, `:name`, `@name`,
`$name`) are never sent. See [SQLite status](#sqlite-status).

## Frameworks

One guide per framework, each with a minimal example that CI runs against a local
stand-in of the Runtime API, and the exact versions it was tested with. **Official**
means an entry point of this package; **pattern** means a few lines of your own code
around the public API (`Vericto.enforce` / `prepare` and the driver wrappers). There is
no package-level integration for the patterns.

| Framework | Status | Approach | Tested with |
|---|---|---|---|
| [LangChain.js](https://github.com/vericto/vericto-node/blob/main/docs/frameworks/langchain.md) | official: `@vericto/sdk/langchain` | `VerictoSqlDatabase` (a `SqlDatabase`), `VerictoSqlToolkit`, `VerictoQuerySqlTool`, `VerictoCheckSqlTool` | `@langchain/classic` 1.0.55, `@langchain/core` 1.3.0, `typeorm` 1.1.2 |
| [Vercel AI SDK](https://github.com/vericto/vericto-node/blob/main/docs/frameworks/vercel-ai-sdk.md) | pattern | a `tool()` whose `execute` runs the query through a guarded driver | `ai` 7.0.152 |
| [Mastra](https://github.com/vericto/vericto-node/blob/main/docs/frameworks/mastra.md) | pattern | a `createTool()` tool, same approach | `@mastra/core` 1.79.0 |
| [OpenAI Agents SDK](https://github.com/vericto/vericto-node/blob/main/docs/frameworks/openai-agents.md) | pattern | a function `tool()`, with `errorFunction: null` so Vericto errors reach your code | `@openai/agents` 0.21.0 |
| [Prisma ORM](https://github.com/vericto/vericto-node/blob/main/docs/frameworks/prisma.md) | pattern | wrap the driver adapter: model and raw queries are checked | `prisma` / `@prisma/client` 7.10.1 |
| [Drizzle ORM](https://github.com/vericto/vericto-node/blob/main/docs/frameworks/drizzle.md) | pattern | a guarded `pg` pool | `drizzle-orm` 0.45.4 |
| [Knex](https://github.com/vericto/vericto-node/blob/main/docs/frameworks/knex.md) | pattern | guard each connection in `pool.afterCreate` | `knex` 3.3.0 |
| [node-postgres](https://github.com/vericto/vericto-node/blob/main/docs/frameworks/node-postgres.md) | pattern | guard each pool client on `connect` | `pg` 8.23.1 |
| [mysql2](https://github.com/vericto/vericto-node/blob/main/docs/frameworks/mysql2.md) | pattern | `query` / `execute` functions in front of the pool | `mysql2` 3.24.6 |

For PostgreSQL and MySQL, the Vericto TCP proxy protects every connection without
code changes (and enforces masks); the patterns are for when you cannot use it.

### LangChain.js in short

```bash
npm install @vericto/sdk @langchain/classic @langchain/core typeorm
```

`VerictoSqlDatabase.fromDataSourceParams({ appDataSource })` is a LangChain
`SqlDatabase` (`@langchain/classic/sql_db`; `langchain/sql_db` no longer exists in
LangChain.js 1.x) whose TypeORM data source checks every query: the agent's queries,
the sample rows `getTableInfo` puts in the prompt, and the SQL `SqlDatabaseChain`
generates. Use `new VerictoSqlToolkit(db, llm)` with `createSqlAgent`. A block comes
back to the model as a message with the rule and the suggested fix (`onBlock:
'return'`, default) or rejects with `VerictoBlockedError` (`onBlock: 'raise'`); Vericto
being unavailable or misconfigured is thrown, never handed to the model. The full,
tested example and the API table are in the [LangChain.js guide](https://github.com/vericto/vericto-node/blob/main/docs/frameworks/langchain.md).

## Caching

Off by default (`cacheTtlMs: 0`). With `cacheTtlMs: 30_000`, identical
`(sql, dialect)` pairs reuse a verdict for 30 seconds (LRU, `cacheSize: 1024`), and
the cache is dropped when a response reports a new `ruleset_version`. A cached hit
is not evaluated, so it is **not in the Vericto audit trail**, and rule changes
apply only when the entry expires (the Runtime API does not report the ruleset
version today). Enable it only for hot, repetitive statements, with a short TTL.

## SQLite status

SQLite has no server, so there is no Vericto proxy for it: this wrapper is the
enforcement point. The **Vericto server evaluates the `sqlite` dialect**
(vericto-engine 4.1.0+; `GET /api/v1/meta/config` lists `postgres`, `mysql`,
`oracle`, `mssql`, `snowflake`, `sqlite`), including SQLite-specific rules such
as `ATTACH DATABASE` (VERICTO-098), `PRAGMA foreign_keys = OFF` (VERICTO-099),
`load_extension()` (VERICTO-100) and `VACUUM INTO` (VERICTO-101).

`guardDatabase()` still asks the server first and rejects with
`VerictoUnsupportedDialectError`, before any SQL runs, if it does not list
`sqlite` (for example an older self-hosted server). There is deliberately no
fallback to another dialect. See [Live tests](#live-tests) for an end-to-end
check against a real server.

## Enforcement boundary

The wrapper protects the SQL that goes through it. `db.raw`, `conn.raw`,
`rawDataSource`, another connection or another process with the same credentials
are not checked. Pair the wrapper with database-side least privilege (and, for
Snowflake, a network policy) when the guarantee matters, and use the Vericto TCP
proxy where one exists (PostgreSQL, MySQL).

## Evaluators

`Vericto` takes an `evaluator`: any object with `evaluate(sql, dialect)` and
`supportedDialects()` (and optionally `apiUrl`, shown in messages). This release
ships `RuntimeApiEvaluator`. An embedded evaluator (the Vericto engine in-process,
for example WASM, with synced rules) can be added later behind the same interface
without changing the wrappers.

A custom evaluator is also how you test your own code without the network:

```ts
import { Vericto, verdictFromResponse, type Evaluator } from '@vericto/sdk';

// Blocks every DELETE, allows the rest. Never use a fake like this in production.
const fake: Evaluator = {
  evaluate: async (sql, dialect) =>
    verdictFromResponse(
      sql.startsWith('DELETE') ? { decision: 'BLOCKED', rule_code: 'VERICTO-001' } : { decision: 'ALLOWED' },
      sql,
      dialect,
    ),
  supportedDialects: async () => undefined,
};
const vericto = new Vericto({ evaluator: fake, logger: false });
console.log((await vericto.check('DELETE FROM t', 'postgres')).decision);
```

<!-- docs-check: output -->
```text
BLOCKED
```

## Integrations roadmap

Not implemented yet; each is meant to be a thin layer over `Vericto.enforce`:

- **LlamaIndex.TS** SQL tools.
- **`pg` and `mysql2`** `pool.query` wrappers in this package (until then, the
  [node-postgres](https://github.com/vericto/vericto-node/blob/main/docs/frameworks/node-postgres.md) and [mysql2](https://github.com/vericto/vericto-node/blob/main/docs/frameworks/mysql2.md)
  guides document tested patterns; the TCP proxy already covers PostgreSQL and MySQL
  without code changes).
- **Cloudflare D1** Workers binding helper.
- **Embedded evaluator** (WASM).

## Development

```bash
npm ci
npm run lint && npm run typecheck
npm test            # vitest: local Runtime API stand-in, real better-sqlite3, fake snowflake-sdk,
                    # real LangChain.js + TypeORM with a scripted LLM (no model calls)
npm run test:coverage  # the same suite with V8 coverage of src/ (what CI runs); fails under 80%
                       # lines, statements, functions or branches. Live tests are excluded.
npm run build       # tsup → dist/ (ESM + CJS + .d.ts)
npm run smoke       # the built package, ESM and CJS, on any Node >= 18
npm run docs:check  # README + LangChain.js guide examples, type-checked and run against the stub
```

Development needs Node 22+ (the tooling; the docs check uses type stripping, 22.6+);
the published package runs on Node 18+. Nothing in the test suite connects to
Snowflake.

### Documentation examples

`scripts/check-docs-examples.mjs` extracts every ```` ```ts ```` block of this README
and of `docs/frameworks/*.md`, type-checks them (strict) and runs each with Node's type
stripping against `scripts/docs-stub.mjs`, a local stand-in for the Runtime API with
the documented response shapes (no key, no network). A block can declare extra
environment, an expected output (compared exactly), or a skip with its reason, in
HTML comments (see the script's header). The framework guides run in their own
project, `docs/frameworks/` (pinned framework versions, not published), against
PostgreSQL and MySQL:

```bash
npm run build && npm run docs:check                         # core suite
cd docs/frameworks && npm ci && cd ../..
DATABASE_URL=postgres://... MYSQL_URL=mysql://... node scripts/check-docs-examples.mjs frameworks
```

CI runs both (`docs` job, with PostgreSQL 17 and MySQL 8.4 service containers).

### Live tests

`test/live/sqlite.live.test.ts` is an opt-in end-to-end test of
`@vericto/sdk/better-sqlite3` against a **real Vericto Runtime API** and a real
SQLite file in a temporary directory. It is skipped unless the variables below
are set, and never runs in CI. Benign statements (`CREATE TABLE`, `INSERT` with
`?` binds, UPSERT `ON CONFLICT ... DO UPDATE`, `SELECT`, `DELETE ... WHERE`) must
run; `DELETE` without `WHERE` (VERICTO-001), `ATTACH DATABASE` (VERICTO-098),
`load_extension()` (VERICTO-100) and `VACUUM INTO` (VERICTO-101) must reject with
`VerictoBlockedError` before SQLite sees them (checked with better-sqlite3's
`verbose` trace, the file's SHA-256 and the absence of the attached/copy files);
`PRAGMA foreign_keys = OFF` (VERICTO-099) must run and log a FLAGGED warning; an
`exec` script with a blocked statement in the middle must run none of it. The
database's workspace must use the default rules; a run makes about 25
evaluations, counted against the workspace's monthly quota.

| Variable | Value |
|---|---|
| `VERICTO_LIVE_SQLITE` | `1` |
| `VERICTO_API_KEY` | a `vtro_...` key with the `proxy:evaluate` scope |
| `VERICTO_API_URL` | `https://api-staging.vericto.com` (or another server that lists `sqlite`) |
| `VERICTO_DATABASE_ID` | the id of a database of dialect `sqlite` in that workspace |

On the host (Node 22+):

```bash
export VERICTO_LIVE_SQLITE=1 VERICTO_API_URL=https://api-staging.vericto.com
export VERICTO_API_KEY=vtro_... VERICTO_DATABASE_ID=...
npm ci && npx vitest run test/live
```

Or in a throwaway `node:22-slim` container (the repository is mounted read-only
and copied; better-sqlite3 installs its prebuilt linux binary; the SQLite file
never leaves the container):

```bash
docker run --rm -v "$PWD":/src:ro \
  -e VERICTO_LIVE_SQLITE=1 -e VERICTO_API_KEY -e VERICTO_API_URL -e VERICTO_DATABASE_ID \
  node:22-slim sh -c 'mkdir /work && cd /src && tar --exclude=node_modules --exclude=dist -cf - . | tar -xf - -C /work \
    && cd /work && npm ci --no-audit --no-fund && npx vitest run test/live'
```

A skipped run (`7 skipped`) means a variable is missing.

## Contributing

See [CONTRIBUTING.md](https://github.com/vericto/vericto-node/blob/main/CONTRIBUTING.md)
for the checks CI runs, the coverage gate, and how releases are cut.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities to security@vericto.com,
not in public issues.

## License

Open source under the [Apache License 2.0](LICENSE) (SPDX `Apache-2.0`) since
0.3.0. Versions 0.2.2 and earlier were released under the Elastic License 2.0
and remain under it. Copyright 2026 Vericto S.A.S.; see [NOTICE](NOTICE). The
license grants no right to the Vericto name or logo: see
[TRADEMARKS.md](TRADEMARKS.md). The Vericto service the SDK calls is offered
under its own [terms](https://vericto.com/terms).

---

## En español

`@vericto/sdk` valida cada sentencia SQL con Vericto **antes** de ejecutarla:
wrappers para `snowflake-sdk` y `better-sqlite3`, una integración oficial con
LangChain.js (`@vericto/sdk/langchain`) y un cliente de la Runtime API para cualquier
otro driver. Toda la API es asíncrona: cada validación es una llamada de red.

- **BLOCKED**: rechaza con `VerictoBlockedError` (hallazgos y corrección sugerida) y
  la sentencia no llega a la base de datos.
- **FLAGGED / MONITORED**: se ejecuta y se registra (`onVerdict`, logger).
- **Máscara de columnas sensibles**: se ejecuta `rewrittenQuery`, nunca la original.
- **Sin respuesta de Vericto**: `failMode: 'closed'` (por defecto) bloquea; `'open'`
  ejecuta y emite el aviso `VerictoFailOpenWarning`. Los errores de configuración
  (clave revocada, permiso, dialecto) nunca se dejan pasar. Cada intento, incluida la
  lectura de la respuesta, tiene el límite de `timeoutMs` (5 s por defecto), con 2
  reintentos.

Configuración: `VERICTO_API_KEY` (clave `vtro_...` con el scope `proxy:evaluate`),
`VERICTO_DATABASE_ID` y, opcionalmente, `VERICTO_API_URL`, `VERICTO_FAIL_MODE`,
`VERICTO_TIMEOUT`. Los valores de los parámetros nunca se envían a Vericto.

Frameworks: LangChain.js tiene integración oficial. Para el Vercel AI SDK, Mastra, el
OpenAI Agents SDK, Prisma, Drizzle, Knex, node-postgres y mysql2 hay patrones
documentados y probados (unas pocas líneas propias alrededor de la API pública, no
una integración del paquete), cada uno con su guía en
[docs/frameworks](https://github.com/vericto/vericto-node/blob/main/docs/frameworks/README.md) y las versiones con las que se probó. Los
ejemplos de este README y de las guías se ejecutan en CI contra un simulador local de
la Runtime API.

SQLite: el servidor de Vericto evalúa el dialecto `sqlite` (vericto-engine
4.1.0+). `guardDatabase()` igual consulta `GET /api/v1/meta/config` y, si un
servidor no lo anuncia, rechaza con `VerictoUnsupportedDialectError` sin ejecutar
nada.

Licencia: código abierto bajo la [Apache License 2.0](LICENSE) desde 0.3.0. Las
versiones 0.2.2 y anteriores se publicaron bajo la Elastic License 2.0 y siguen
bajo ella. La licencia no otorga derechos sobre la marca Vericto
([TRADEMARKS.md](TRADEMARKS.md)).
