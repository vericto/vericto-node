# @vericto/vericto (Node.js)

> Check every SQL statement with [Vericto](https://vericto.com) **before** it runs:
> thin wrappers for `snowflake-sdk` and `better-sqlite3`, and a client for the
> Vericto Runtime API you can put in front of any driver.

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
- No runtime dependencies. Drivers are optional peer dependencies and separate
  entry points: importing `@vericto/vericto` never loads a driver.

## Install

```bash
npm install @vericto/vericto
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

The key is sent only in the `X-API-Key` header, only over HTTPS (plain HTTP is
accepted for localhost alone), and never appears in messages, `toString()` or
`JSON.stringify()`. To trust an extra CA, use Node's `NODE_EXTRA_CA_CERTS`.

## Quickstart

### snowflake-sdk

```ts
import snowflake from 'snowflake-sdk';
import { VerictoBlockedError } from '@vericto/vericto';
import { guardConnection } from '@vericto/vericto/snowflake';

const raw = snowflake.createConnection({ account, username, authenticator: 'SNOWFLAKE_JWT', privateKeyPath });
await raw.connectAsync();
const conn = await guardConnection(raw);

const rows = await conn.query('SELECT id, email FROM customers WHERE id = ?', [42]);

// Callback style, with the driver's own options:
await conn.execute({
  sqlText: 'DELETE FROM customers',
  complete: (err, stmt, rows) => {
    // err is a VerictoBlockedError: the statement never reached Snowflake
  },
});
```

`connection.execute()` returns its statement synchronously, but a Vericto check is
a network call, so the guarded `execute()` resolves the statement. With
`complete`, a Vericto rejection is delivered to it as `err` (and the promise
resolves `undefined`); without it, the promise rejects. A multi-statement
`sqlText` (`MULTI_STATEMENT_COUNT`) is evaluated as one request: a block anywhere
means nothing runs.

### better-sqlite3

```ts
import Database from 'better-sqlite3';
import { guardDatabase } from '@vericto/vericto/better-sqlite3';

const db = await guardDatabase(new Database('app.db'));

const expire = await db.prepare('DELETE FROM sessions WHERE expires_at < ?'); // checked once
expire.run(Date.now());                                                    // synchronous, as usual

await db.run('INSERT INTO audit (event) VALUES (?)', 'login');
const user = await db.get('SELECT * FROM users WHERE id = ?', 1);
await db.exec(migrationSql);                                               // whole script checked first
```

better-sqlite3 is synchronous, so the SQL-carrying entry points (`prepare`,
`exec`, and the `run`/`all`/`get` shortcuts) become async. A prepared statement's
SQL cannot change, so its `run`/`all`/`get`/`iterate` stay synchronous: prepare
statements before `db.raw.transaction(...)` and use them inside it. See
[SQLite status](#sqlite-status).

### Any driver, by hand

```ts
import { Vericto, sqlToExecute } from '@vericto/vericto';

const vericto = new Vericto();                        // one per process
const verdict = await vericto.enforce(sql, 'postgres'); // rejects with VerictoBlockedError
await pool.query(sqlToExecute(verdict));              // the masked rewrite, if any
```

`vericto.prepare(sql, dialect)` resolves the SQL text directly; `vericto.check()`
resolves the verdict without applying it.

## What each decision does

| Verdict | What the wrapper does |
|---|---|
| `ALLOWED` | Runs the statement. |
| `FLAGGED` | Runs it, logs a warning, calls `onVerdict`. |
| `MONITORED` | Runs it, logs at info, calls `onVerdict`. |
| `PARSE_ERROR` (allowed) | The workspace's `parse_error_action` let it through: runs it and logs a warning. When the workspace blocks unparseable SQL, the server answers `BLOCKED`. |
| `BLOCKED` | Rejects with `VerictoBlockedError` (`verdict`, `findings`, `suggestedFix`) **before** the driver is called. |
| mask (`rewrittenQuery`) | Runs `rewrittenQuery` **instead of** your SQL: the sensitive columns come back masked. Never the original. |
| no verdict | The [fail mode](#fail-mode) decides. |

`onVerdict` receives every verdict, blocked and unevaluated ones included. The
default logger is `console` for warnings and errors (`logger: false` silences it,
or pass your own `{ info, warn, error }`). Log lines carry the rule code, severity
and Vericto event id, **never the SQL text**. Every evaluation is recorded in the
Vericto audit trail.

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

Retries: network errors, timeouts, 5xx and 429 `RATE_LIMIT_EXCEEDED` are retried
`maxRetries` times (default 2) with exponential backoff and jitter (capped at 2 s,
honouring `Retry-After`). `QUOTA_EXCEEDED` is not retried.

## Parameters

Bind values are **never** sent to Vericto. The SQL text goes as written,
placeholders included (`?`, `:1` for Snowflake; `?`, `:name`, `@name`, `$name` for
SQLite), and the driver binds the values afterwards.

## Caching

Off by default (`cacheTtlMs: 0`). With `cacheTtlMs: 30_000`, identical
`(sql, dialect)` pairs reuse a verdict for 30 seconds (LRU, `cacheSize: 1024`), and
the cache is dropped when a response reports a new `ruleset_version`. A cached hit
is not evaluated, so it is **not in the Vericto audit trail**, and rule changes
apply only when the entry expires (the Runtime API does not report the ruleset
version today). Enable it only for hot, repetitive statements, with a short TTL.

## SQLite status

SQLite has no server, so there is no Vericto proxy for it: this wrapper is the
enforcement point. The wrapper is ready, but the **Vericto engine does not
evaluate the `sqlite` dialect yet** (the server lists `postgres`, `mysql`,
`oracle`, `mssql`, `snowflake`). `guardDatabase()` asks the server
(`GET /api/v1/meta/config`) and rejects with `VerictoUnsupportedDialectError`,
before any SQL runs, while it is not listed. It starts working, unchanged, when
the server adds it. There is deliberately no fallback to another dialect.

## Enforcement boundary

The wrapper protects the SQL that goes through it. `db.raw`, `conn.raw`, another
connection or another process with the same credentials are not checked. Pair the
wrapper with database-side least privilege (and, for Snowflake, a network policy)
when the guarantee matters.

## Errors

All extend `VerictoError`.

| Error | When |
|---|---|
| `VerictoBlockedError` | Vericto blocked the statement. `.verdict`, `.findings`, `.suggestedFix`, `.sql`. |
| `VerictoUnavailableError` | No verdict and `failMode: 'closed'`. |
| `VerictoQuotaExceededError` | Extends `VerictoUnavailableError`: monthly quota used (`.resetsAt`). |
| `VerictoConfigError` | Key, scope, database id, URL or request problem. Thrown in both fail modes. |
| `VerictoUnsupportedDialectError` | Extends `VerictoConfigError`: the server does not evaluate that dialect. |

## Evaluators

`Vericto` takes an `evaluator`: any object with `evaluate(sql, dialect)` and
`supportedDialects()`. This release ships `RuntimeApiEvaluator`. An embedded
evaluator (the Vericto engine in-process, for example WASM, with synced rules) can
be added later behind the same interface without changing the wrappers.

## Integrations roadmap

Not implemented in 0.1.0; each is meant to be a thin layer over `Vericto.enforce`:

- **LangChain.js / LlamaIndex.TS SQL tools**: check the generated SQL and return
  `suggestedFix` to the agent instead of throwing.
- **`pg` and `mysql2`**: `pool.query` wrappers (the TCP proxy already covers
  PostgreSQL and MySQL without code changes).
- **Cloudflare D1** Workers binding helper.
- **Embedded evaluator** (WASM).

## Development

```bash
npm ci
npm run lint && npm run typecheck
npm test            # vitest: local Runtime API stand-in, real better-sqlite3, fake snowflake-sdk
npm run build       # tsup → dist/ (ESM + CJS + .d.ts)
npm run smoke       # the built package, ESM and CJS, on any Node >= 18
```

Development needs Node 22+ (the tooling); the published package runs on Node 18+.
Nothing in the test suite connects to Snowflake.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities to security@vericto.com,
not in public issues.

## License

[Elastic License 2.0](LICENSE).

---

## En español

`@vericto/vericto` valida cada sentencia SQL con Vericto **antes** de ejecutarla:
wrappers para `snowflake-sdk` y `better-sqlite3`, y un cliente de la Runtime API
para cualquier otro driver.

- **BLOCKED**: rechaza con `VerictoBlockedError` (hallazgos y corrección sugerida) y
  la sentencia no llega a la base de datos.
- **FLAGGED / MONITORED**: se ejecuta y se registra (`onVerdict`, logger).
- **Máscara de columnas sensibles**: se ejecuta `rewrittenQuery`, nunca la original.
- **Sin respuesta de Vericto**: `failMode: 'closed'` (por defecto) bloquea; `'open'`
  ejecuta y emite el aviso `VerictoFailOpenWarning`. Los errores de configuración
  nunca se dejan pasar.

Configuración: `VERICTO_API_KEY` (clave `vtro_...` con el scope `proxy:evaluate`),
`VERICTO_DATABASE_ID` y, opcionalmente, `VERICTO_API_URL`, `VERICTO_FAIL_MODE`,
`VERICTO_TIMEOUT`. Los valores de los parámetros nunca se envían a Vericto.

SQLite: el wrapper está listo, pero el motor de Vericto todavía no evalúa el
dialecto `sqlite`; hasta que el servidor lo anuncie, `guardDatabase()` rechaza con
`VerictoUnsupportedDialectError` sin ejecutar nada.
