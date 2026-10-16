# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-16

### Changed

- The package is now **`@vericto/sdk`** (it was `@vericto/vericto`, never
  published). Entry points: `@vericto/sdk`, `@vericto/sdk/snowflake`,
  `@vericto/sdk/better-sqlite3`, `@vericto/sdk/langchain`.

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

### Changed

- Documentation: the Vericto server now evaluates the `sqlite` dialect
  (vericto-engine 4.1.0; `GET /api/v1/meta/config` lists it), so
  `@vericto/sdk/better-sqlite3` and `@vericto/sdk/langchain` on SQLite work
  against it. The 0.1.0 known limitation no longer applies to such servers.
  Unchanged behaviour: `guardDatabase()` still asks `/meta/config` and rejects
  with `VerictoUnsupportedDialectError`, before any SQL runs, against a server
  that does not list `sqlite`.

### Added

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

[0.2.0]: https://github.com/vericto/vericto-node/releases/tag/v0.2.0
[0.1.0]: https://github.com/vericto/vericto-node/releases/tag/v0.1.0
