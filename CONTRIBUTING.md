# Contributing to @vericto/sdk

Thanks for your interest in improving the Vericto SDK for Node.js. This guide
covers the `@vericto/sdk` package in this repository, which is open source
under the [Apache License 2.0](LICENSE).

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be
respectful, constructive, and technically precise.

## What belongs here

The SDK asks the Vericto Runtime API for a verdict before a driver runs each
statement. Contributions that fit here:

- **Driver wrappers** — `snowflake-sdk` (`src/snowflake.ts`) and
  `better-sqlite3` (`src/better-sqlite3.ts`), and new drivers as separate entry
  points with optional peer dependencies.
- **The Runtime API client** — `src/runtime-api.ts`, retries, fail mode and
  caching (`src/guard.ts`), configuration from `VERICTO_*` (`src/env.ts`).
- **The LangChain.js integration** — `src/langchain.ts`.
- **Packaging** — the ESM and CommonJS builds (`tsup.config.ts`), types, the
  Node 18+ runtime promise.
- **Examples and documentation** — `examples/` and `README.md`.

Contributions that belong elsewhere:

- A statement that got the wrong verdict, a new rule, SQL parsing →
  [vericto-engine](https://github.com/vericto/vericto-engine).
- The Python SDK → [vericto-python](https://github.com/vericto/vericto-python).
- The `vericto` command line tool →
  [vericto-cli](https://github.com/vericto/vericto-cli).

## Getting started

```bash
git clone https://github.com/<you>/vericto-node.git
cd vericto-node
npm ci
npm test
```

Development needs Node 22+ (vitest, eslint and better-sqlite3 13); the
published package runs on Node 18+ and has no runtime dependencies. The tests
use a local stand-in for the Runtime API (`test/fake-vericto.ts`), the real
better-sqlite3, a fake snowflake-sdk, and the real LangChain.js and TypeORM with
a scripted LLM; nothing connects to Snowflake or to the Vericto API. The tests
under `test/live/` are opt-in and never run in CI (see the README,
"Live tests").

## Development workflow

1. Fork the repo and create a branch: `feat/pg-wrapper` or
   `fix/snowflake-binds`.
2. Make your change with tests.
3. Run the checks CI runs before opening a PR:
   ```bash
   npm ci
   npm run lint
   npm run typecheck    # also compiles the type tests in test/types/
   npm run test:coverage
   npm run build
   npm run smoke
   npm run docs:check   # README + LangChain.js guide examples against the local stub
   ```
   If you change a framework guide in `docs/frameworks/`, also run its examples
   (`cd docs/frameworks && npm ci`, then `node scripts/check-docs-examples.mjs
   frameworks` from the root with `DATABASE_URL` and `MYSQL_URL` set; CI's `docs` job
   does this with PostgreSQL and MySQL service containers). A new ```` ```ts ```` block in
   the README or a guide is run too: give it an expected output, or a
   `<!-- docs-check: skip <reason> -->` marker if it cannot run offline.
   CI also checks that `npm pack` publishes only `dist/`, `README.md`,
   `CHANGELOG.md`, `SECURITY.md`, `LICENSE`, `NOTICE` and `package.json`; if you change
   `files` in `package.json`, run `npm pack --dry-run` and check the list.
4. Open a PR using the template. Keep PRs focused and under ~500 lines.

### Coverage

`npm run test:coverage` (what CI runs) is the test suite with V8 coverage of
`src/`. It fails under **80%** lines, statements, functions or branches
(`thresholds` in `vitest.config.ts`); the live tests are excluded.

A test that documents a known bug is marked `it.fails` with the reason, so it
fails the run as soon as the bug is fixed and the marker must go.

## Commit convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
test: unit-test coverage gate at 80% and tests for the main and alternate flows
ci: a public repository never runs on self-hosted runners
docs(changelog): one Added and one Changed section in 0.2.0
release: 0.2.2, an empty VERICTO_* variable means its default
```

**Write in English** — commit subjects and bodies, code comments, test names,
identifiers, `CHANGELOG.md` entries and pull request descriptions.

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/). Add an entry
under `## [Unreleased]` for any change a user of the package can see, in the
section that fits (`Added`, `Changed`, `Fixed`, `Removed`, `Security`). Changes
to repository files that are not published (CI, templates, this guide) need no
entry. Maintainers move the entries into a version section when they cut a
release.

## Pull request acceptance criteria

- ✅ Required checks pass: `Lint, type-check and test (Node 22)`,
  `Lint, type-check and test (Node 24)`, `Package contents` and `gitleaks`. The
  `Built package on Node ...` smoke jobs (Node 18, 20, 22 and 24) run too and
  should be green.
- ✅ Coverage stays at or above 80% (lines, statements, functions, branches).
- ✅ New behavior has tests, including the failure path (`failMode`, API errors).
- ✅ `CHANGELOG.md` updated under `[Unreleased]` when a user can see the change.
- ✅ At least one maintainer review (CODEOWNERS requests it).
- ✅ No new runtime dependency; drivers stay optional peer dependencies.
- ✅ Parameter values are never sent to Vericto.

Pull requests are merged with a merge commit; squash and rebase merges are
disabled.

## Releases

Releases are cut by the maintainers:

1. Set the version in `package.json`, `package-lock.json` and `src/version.ts`,
   and turn `## [Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD` in `CHANGELOG.md`,
   in a pull request.
2. After it is merged, tag the merge commit `vX.Y.Z` and push the tag.
3. The tag starts `release.yml`: it checks that the tag matches `package.json`,
   runs lint, typecheck, tests, the build and the smoke test, publishes to npm
   with trusted publishing and provenance (the `npm` environment, which needs a
   maintainer's approval) and creates the GitHub release.

Release tags (`v*.*.*`) are protected: once pushed, they cannot be moved or
deleted.

## Reporting security issues

Do **not** open a public issue for vulnerabilities. See [SECURITY.md](SECURITY.md)
or email [security@vericto.com](mailto:security@vericto.com).

## License

@vericto/sdk is open source under the [Apache License 2.0](LICENSE) since 0.3.0
(versions 0.2.2 and earlier remain under the Elastic License 2.0). Unless you
state otherwise, a contribution you submit for inclusion is under the Apache
License 2.0, as its section 5 says, without additional terms or conditions;
no contributor agreement is needed. Add the `SPDX-FileCopyrightText` and
`SPDX-License-Identifier: Apache-2.0` header to new source files. For
questions about licensing a contribution, write to
[legal@vericto.com](mailto:legal@vericto.com) before opening the pull request.
