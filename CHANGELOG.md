# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - unreleased

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

[0.1.0]: https://github.com/vericto/vericto-node/releases/tag/v0.1.0
