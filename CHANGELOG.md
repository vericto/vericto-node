# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[0.2.2]: https://github.com/vericto/vericto-node/releases/tag/v0.2.2
[0.2.1]: https://github.com/vericto/vericto-node/releases/tag/v0.2.1
[0.2.0]: https://github.com/vericto/vericto-node/releases/tag/v0.2.0
[0.1.0]: https://github.com/vericto/vericto-node/releases/tag/v0.1.0
