# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-10-23

One fail-open contract for both SDKs (shared with vericto-python 0.5.0), the
business policy context of the Runtime API, and a better-sqlite3 typing fix.

### Breaking change

- **`check()` follows the fail mode.** Under `failMode: 'open'` (or
  `VERICTO_FAIL_MODE=open`), when Vericto cannot answer (network error, timeout,
  HTTP 5xx, a response that is not JSON or has no decision, rate limit after the
  retries, monthly quota), `Vericto.check()` now resolves an `UNEVALUATED` verdict
  whose `message` is the reason, and logs a warning, instead of rejecting with
  `VerictoUnavailableError`. `VerictoCheckSqlTool` (LangChain.js) answers
  `Vericto: UNEVALUATED. Vericto could not evaluate the query (<reason>).` instead of
  throwing. vericto-python already answered `UNEVALUATED` from its LangChain check
  tool; both SDKs now do it from `check()` and every wrapper.
  Unchanged: under `failMode: 'closed'` (the default) `check()`, `enforce()` and every
  wrapper reject with `VerictoUnavailableError` (the safest contract: a returned
  `BLOCKED` would read as a rule decision that never happened); `enforce()` under
  `'open'` resolves `UNEVALUATED` as before; `VerictoConfigError` (key, scope,
  dialect, request) rejects in both modes.
  Migration, for code that caught the error under `'open'`:

  ```ts
  // 0.3.x
  try {
    const verdict = await vericto.check(sql, 'postgres');
    use(verdict);
  } catch (err) {
    if (!(err instanceof VerictoUnavailableError)) throw err;
    noVerdict(err.message);
  }

  // 0.4.0 (failMode: 'open')
  const verdict = await vericto.check(sql, 'postgres');
  if (verdict.decision === 'UNEVALUATED') noVerdict(verdict.message);
  else use(verdict);
  ```

  Code that runs with `failMode: 'closed'` needs no change.

### Added

- **Business policy context** (Runtime API M2): `check`, `enforce`, `prepare` and
  `enforceAll` take an optional third argument `{ context: { ticket, tenant },
  endUser }`, sent as `context` and `end_user`; so does `RuntimeApiEvaluator.evaluate`.
  The values are checked before anything is sent, with the limits of the service
  (vericto-fmw `policyContextSchema`): `ticket` and `tenant` 1 to 128 characters,
  `end_user` up to 16 attributes with identifier keys (at most 63 characters) and
  values of 1 to 256 characters, no control characters, no other `context` key. An
  invalid value rejects with `VerictoConfigError` in both fail modes; the message
  names the field, never the value. They take effect when business policies are
  enabled in the workspace; they carry the API key's trust. The verdict cache keys on
  them. New exports: the types `PolicyContext`, `EndUser`, `EvaluationOptions`, and
  the limits `MAX_CONTEXT_VALUE`, `MAX_END_USER_KEYS`, `MAX_END_USER_VALUE`.
- LangChain.js: `VerictoSqlDatabase.fromDataSourceParams` / `fromOptionsParams`,
  `VerictoCheckSqlTool` and `guardDataSource` take `context` and `endUser`, as a value
  or as a function read for every statement (for example from an
  `AsyncLocalStorage`). Fixed values are validated at construction.
- `Evaluator.evaluate(sql, dialect, options?)`: the guard passes `options` only when
  the caller gives `context` or `endUser`, so an existing `evaluate(sql, dialect)`
  implementation keeps type-checking and working.
- `scripts/docs-stub.mjs` validates and records `context` and `end_user` like the
  service; `scripts/docs-stub.d.mts` types it for the tests.
- Tests: the fail-mode contract over HTTP in both modes for a network error, a
  timeout, a 5xx and a body that is not JSON (`test/fail-mode-contract.test.ts`);
  `context` / `end_user` in the request body, the limits, the cache, against the fake
  server and the docs stub (`test/policy-context.test.ts`); the LangChain.js tools
  under both fail modes and with the context.

### Fixed

- **better-sqlite3 typing.** `GuardedDatabase<Database>.prepare()` resolved
  `Statement<unknown[], unknown> | Statement<[{}], unknown>` (inferred from
  better-sqlite3's generic `prepare`), so `stmt.run()` with no argument, or with more
  than one, did not compile, `stmt.get(null)` was refused, and a
  `Statement<[number], Row>` annotation was rejected. `prepare` and
  `prepareWithVerdict` now take better-sqlite3's type arguments
  (`prepare<[number], Row>(sql)`) and resolve exactly its `Statement` type
  (`Statement<unknown[], unknown>` without them); `all<Row>` / `get<Row>` type the
  rows. Other drivers keep the statement type their own `prepare` returns. Type test:
  `test/types/better-sqlite3.types.ts` (compiled by `npm run typecheck`, fails on
  0.3.1).
- `describeVerdict` (the text of `VerictoCheckSqlTool`) has an `UNEVALUATED` case; it
  would have described such a verdict as `ALLOWED`.

### Changed

- README: the fail-mode contract for `check()`, `enforce()` and the wrappers, with a
  0.3.x to 0.4.0 example; a **Business policy context** section; the typed
  better-sqlite3 `prepare`; `evaluate(sql, dialect, options?)`. LangChain.js guide:
  the check tool under both fail modes and a `context` / `endUser` example. All
  examples run in `npm run docs:check` and the framework job.
- Dependencies: compatible lockfile refresh (rollup 4.65.0, @babel/parser 7.29.11,
  js-yaml 5.5.0, postcss 8.5.31, among others; the pinned dev dependencies are already
  the newest of their major). No runtime dependency; peer ranges unchanged.

## [0.3.1] - 2026-10-23

Documentation release, with one fail-closed fix.

### Fixed

- **A stalled response body no longer hangs an evaluation.** `timeoutMs` stopped
  applying once the response headers arrived, so a server (or a proxy in between)
  that sent its headers and then never finished the body left `evaluate()`, and the
  statement waiting on it, pending forever instead of failing closed. The timeout now
  covers the whole exchange, body included: such a response is a timeout, retried
  like any other and then `VerictoUnavailableError` (or, under `failMode: 'open'`, an
  `UNEVALUATED` run). New test in `test/runtime-api.test.ts`.

### Documentation

- README rewritten around the real public API: the `Vericto` methods and every
  option (`maxRetries`, `backoffMs`, `dialectsTtlMs`, `logger`, `evaluator`, `fetch`,
  `env` were undocumented), the `Verdict` fields, the helpers, what `check()` does
  under fail-open, timeouts and retries with the worst-case wait, the errors and their
  fields, `prepareWithVerdict` and `query()` on the driver wrappers, and that the API
  is asynchronous only. The Quickstart no longer uses undefined variables.
- **Framework guides** in `docs/frameworks/`, each with a tested example and the
  versions it was tested with: LangChain.js (the official integration) and documented
  patterns for the Vercel AI SDK, Mastra, the OpenAI Agents SDK, Prisma ORM (a
  driver-adapter wrapper that also checks model queries), Drizzle ORM, Knex,
  node-postgres and mysql2. None of the patterns is a package integration.
- JSDoc on the public API that lacked it (`Verdict` and `Finding` fields, `isMasked`,
  `RuntimeApiEvaluator.evaluate`, the path constants, the wrapper classes).
- The Spanish summary in the README covers the frameworks and the timeout.

### Changed

- CI runs the README and guide examples: `npm run docs:check` (README and
  LangChain.js guide) in the `check` job, and a new `docs` job for the other guides,
  with the framework versions pinned in `docs/frameworks/package.json` and PostgreSQL
  17 and MySQL 8.4 service containers. `scripts/docs-stub.mjs` is the local stand-in
  for the Runtime API they run against; `scripts/check-docs-examples.mjs` extracts,
  type-checks and runs the blocks. Neither is published.
- Dev dependencies (not published): `@langchain/classic` 1.0.55, `@langchain/core`
  1.3.0, `eslint` 10.13.0, `typescript-eslint` 8.72.0, `vitest` and
  `@vitest/coverage-v8` 5.0.5.

## [0.3.0] - 2026-10-18

**Now open source under the Apache License 2.0.** From this version on,
`@vericto/sdk` is licensed under the Apache License, Version 2.0 (SPDX
`Apache-2.0`) instead of the Elastic License 2.0. **All previously released
versions, 0.2.2 and earlier, remain under the Elastic License 2.0.** No code
change: the package behaves exactly as 0.2.2.

### Changed

- **License: Apache-2.0.** `LICENSE` is the Apache License 2.0 text from
  apache.org, verbatim. New `NOTICE` (product name and copyright, Vericto
  S.A.S.), which the license asks redistributors to keep and which the npm
  package now carries (`files` in `package.json`, and the CI package-contents
  check), and `TRADEMARKS.md`: the license grants no right to the Vericto name
  or logo.
- `package.json` and `package-lock.json`: `"license": "Apache-2.0"` and version
  0.3.0 (`VERSION` too).
- Every TypeScript and JavaScript source file starts with
  `SPDX-FileCopyrightText` and `SPDX-License-Identifier: Apache-2.0` lines (the
  REUSE convention).
- README (License section, in English and Spanish) and CONTRIBUTING name the
  new license. Contributions are accepted under the Apache License 2.0
  (inbound = outbound, its section 5); no contributor agreement is needed.

## [0.2.2] - 2026-10-18

### Fixed

- An empty or whitespace-only `VERICTO_*` variable now counts as unset, for
  every variable the SDK reads. `VERICTO_FAIL_MODE=` (or a CI variable that
  expands to nothing) threw `VerictoConfigError` instead of meaning the
  documented default, `closed`; `VERICTO_API_URL` and `VERICTO_TIMEOUT` already
  fell back, and a blank `VERICTO_API_KEY` or `VERICTO_DATABASE_ID` is reported
  as missing, as before. An invalid non-empty value still throws, and an error
  about `VERICTO_FAIL_MODE` now names the variable rather than the `failMode`
  option.

### Added

- Development: `npm run test:coverage` (V8 coverage of `src/`, `@vitest/coverage-v8`)
  with an 80% threshold for lines, statements, functions and branches; CI runs it
  in place of `npm test`. New offline tests for the Runtime API error paths
  (401/403/400/413, redirects, malformed JSON, timeouts, network errors,
  `Retry-After` and backoff, the dialect list cache), the guard (fail modes,
  logging, verdict cache), verdict parsing, dialects, errors, snowflake-sdk
  streaming and binds, better-sqlite3 `iterate` and transactions, and LangChain.js
  construction paths. No change to the published package.

## [0.2.1] - 2026-10-17

### Changed

- Releases are published only through npm trusted publishing (OIDC) with
  provenance. The release workflow no longer reads an npm token; 0.2.0 was the
  one-time bootstrap publish. No code changes.

## [0.2.0] - 2026-10-16

### Changed

- The package is now **`@vericto/sdk`** (it was `@vericto/vericto`, never
  published). Entry points: `@vericto/sdk`, `@vericto/sdk/snowflake`,
  `@vericto/sdk/better-sqlite3`, `@vericto/sdk/langchain`.

- Documentation: the Vericto server now evaluates the `sqlite` dialect
  (vericto-engine 4.1.0; `GET /api/v1/meta/config` lists it), so
  `@vericto/sdk/better-sqlite3` and `@vericto/sdk/langchain` on SQLite work
  against it. The 0.1.0 known limitation no longer applies to such servers.
  Unchanged behaviour: `guardDatabase()` still asks `/meta/config` and rejects
  with `VerictoUnsupportedDialectError`, before any SQL runs, against a server
  that does not list `sqlite`.

### Added

- `@vericto/sdk/langchain`, for LangChain.js 1.x (`@langchain/classic`):
  - `VerictoSqlDatabase`, a `SqlDatabase` whose TypeORM data source checks every
    `query()` (agent queries, `getTableInfo` sample rows, `SqlDatabaseChain`).
    BLOCKED returns a message with the rule, reason and suggested fix for the
    model (`onBlock: 'return'`, default) or throws `VerictoBlockedError`
    (`onBlock: 'raise'`); masked queries run as the rewrite; Vericto
    unavailable/config errors are thrown, never returned to the model. Dialect
    from the TypeORM type, or `dialect`.
  - `VerictoQuerySqlTool` and `VerictoSqlToolkit` (for `createSqlAgent`), which
    let Vericto errors through instead of turning them into text.
  - `VerictoCheckSqlTool`, a check-only tool that returns the verdict.
  - `guardDataSource`, `dialectFromDataSource`, `blockedMessage`,
    `describeVerdict` helpers.
- Optional peer dependencies `@langchain/classic`, `@langchain/core`, `typeorm`.
  Tested with `@langchain/classic` 1.0.52, `@langchain/core` 1.2.17,
  `typeorm` 1.1.2.

- `test/live/sqlite.live.test.ts`: an opt-in end-to-end test of
  `@vericto/sdk/better-sqlite3` against a real Runtime API (allowed statements,
  UPSERT, the SQLite rules VERICTO-098/099/100/101, DELETE without WHERE, scripts
  with a blocked statement). Skipped unless `VERICTO_LIVE_SQLITE=1` and the
  `VERICTO_*` variables are set; see "Live tests" in the README.

## [0.1.0] - unreleased (never published)

First release: Vericto checks in front of Node.js database drivers, evaluated by
the Vericto Runtime API (`POST /api/v1/proxy/query`).

### Added

- `Vericto` guard: rejects with `VerictoBlockedError` on BLOCKED, runs the masked
  `rewrittenQuery` for sensitive columns, logs FLAGGED / MONITORED / allowed
  PARSE_ERROR verdicts and passes every verdict to `onVerdict`.
- Fail mode per guard: `closed` (default) rejects with `VerictoUnavailableError`
  when Vericto cannot answer; `open` runs the statement and emits a
  `VerictoFailOpenWarning` process warning. Configuration errors are never failed
  open.
- `RuntimeApiEvaluator` on the global `fetch`: `VERICTO_*` environment
  configuration as in vericto-cli, HTTPS-only key handling, timeouts, retries with
  backoff on 5xx / 429 rate limits, `VerictoQuotaExceededError` for the monthly
  quota, and dialect discovery through `GET /api/v1/meta/config`.
- `Evaluator` interface, so an embedded evaluator can be added later.
- `@vericto/vericto/snowflake`: `guardConnection()` for snowflake-sdk
  (`execute` with the driver's options, callback or promise style, and `query`).
- `@vericto/vericto/better-sqlite3`: `guardDatabase()` (`prepare`, `exec`, `run`,
  `all`, `get`).
- ESM and CommonJS builds with type declarations; Node.js 18+.
- Optional verdict cache (off by default).

### Known limitations

- The Vericto engine does not evaluate the `sqlite` dialect yet:
  `guardDatabase()` rejects with `VerictoUnsupportedDialectError` until the server
  lists it.

[0.4.0]: https://github.com/vericto/vericto-node/releases/tag/v0.4.0
[0.3.1]: https://github.com/vericto/vericto-node/releases/tag/v0.3.1
[0.2.2]: https://github.com/vericto/vericto-node/releases/tag/v0.2.2
[0.2.1]: https://github.com/vericto/vericto-node/releases/tag/v0.2.1
[0.2.0]: https://github.com/vericto/vericto-node/releases/tag/v0.2.0
[0.1.0]: https://github.com/vericto/vericto-node/releases/tag/v0.1.0
