## What does this PR change?

<!-- A clear, concise description of the change. -->

## Why?

<!-- Context: a driver or ORM incompatibility, a statement that ran without being checked, a LangChain.js bug, a new driver, an ESM/CJS or types problem. A wrong verdict for a statement, a rule or SQL parsing belong in vericto-engine. -->

## Type of change

- [ ] Driver wrapper (snowflake-sdk, better-sqlite3, a new driver)
- [ ] Runtime API client (retries, fail mode, caching, configuration)
- [ ] LangChain.js integration
- [ ] Packaging (ESM/CJS build, types, entry points)
- [ ] Bug fix
- [ ] Documentation or examples
- [ ] Dependencies or CI

## Tests

- [ ] Added or updated tests that cover the change, including the failure path
- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run test:coverage` passes, at or above 80%
- [ ] `npm run build` and `npm run smoke` pass
- [ ] `npm pack --dry-run` lists only `dist/` and the docs (if `package.json` changed)

## Checklist

- [ ] Commits follow Conventional Commits
- [ ] `CHANGELOG.md` updated under `[Unreleased]` (if a user of the package can see the change)
- [ ] New or changed options, environment variables or errors documented in `README.md`
- [ ] No new runtime dependency; drivers stay optional peer dependencies
- [ ] Parameter values are still never sent to Vericto
- [ ] CI is green
