---
name: Bug report
about: Something the SDK gets wrong with a driver, LangChain.js, the build or the Vericto API
title: "[BUG] "
labels: bug
---

<!--
Security vulnerabilities: do not open an issue. Report them privately, see
https://github.com/vericto/vericto-node/security/policy

Rules and SQL parsing live in vericto-engine. If a specific statement got the wrong
verdict, you can report it here or in vericto-engine; we move issues to the right
repository.
-->

**What happened**
A clear description of what went wrong, and what you expected instead.

**Driver or integration**
- [ ] snowflake-sdk (`@vericto/sdk/snowflake`)
- [ ] better-sqlite3 (`@vericto/sdk/better-sqlite3`)
- [ ] LangChain.js (`@vericto/sdk/langchain`)
- [ ] Another driver, through the Runtime API client (`@vericto/sdk`)

Driver, ORM or framework and its version (for example `snowflake-sdk 2.x`,
`better-sqlite3 13.0.3`, `@langchain/classic 1.0.52 + typeorm 1.1.2`):

**Dialect**
- [ ] postgres
- [ ] mysql
- [ ] oracle
- [ ] mssql
- [ ] snowflake
- [ ] sqlite

**Environment**
- SDK version (`npm ls @vericto/sdk`):
- Node.js version (`node --version`) and OS:
- Module system: ESM (`import`) / CommonJS (`require`); TypeScript version, if any:
- `failMode` (`closed` or `open`):
- `VERICTO_API_URL`, if not the default. Remove API keys before pasting.

**Steps to reproduce**
A minimal script, with the API key and connection details removed.
```ts
import { } from '@vericto/sdk';
```

**SQL statement (if a query was blocked or allowed when it should not have been)**
```sql
-- the exact statement
```

**Error or logs**
The error with its stack trace and the logged verdicts. Remove anything sensitive.
```
paste relevant output here
```
