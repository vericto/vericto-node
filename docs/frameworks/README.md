# Framework guides

How to use `@vericto/sdk` with each framework. **Official** means an entry point of
this package; **pattern** means a few lines of your own code around the public API
(`Vericto.enforce` / `prepare` and the driver wrappers), tested but not shipped as an
integration.

| Guide | Status | Tested with |
|---|---|---|
| [LangChain.js](langchain.md) | official: `@vericto/sdk/langchain` | `@langchain/classic` 1.0.55, `@langchain/core` 1.3.0, `typeorm` 1.1.2 |
| [Vercel AI SDK](vercel-ai-sdk.md) | official: `@vericto/sdk/ai` | `ai` 7.0.159 (unit tests also with 7.0.0) |
| [OpenAI Agents SDK](openai-agents.md) | official: `@vericto/sdk/openai-agents` | `@openai/agents` 0.21.0 (unit tests also with 0.18.0) |
| [Mastra](mastra.md) | official: `@vericto/sdk/mastra` | `@mastra/core` 1.81.0 (tool unit tests also with 1.0.4) |
| [Prisma ORM](prisma.md) | pattern | `prisma` / `@prisma/client` 7.10.1 |
| [Drizzle ORM](drizzle.md) | pattern | `drizzle-orm` 0.45.4 |
| [Knex](knex.md) | pattern | `knex` 3.3.0 |
| [node-postgres](node-postgres.md) | pattern | `pg` 8.23.1 |
| [mysql2](mysql2.md) | pattern | `mysql2` 3.24.6 |

Every guide also works in [offline mode](../../README.md#offline-mode-no-account)
(`new Vericto({ offline: true })` or `VERICTO_OFFLINE=1`): no account, the engine's
standard rules in a local `vericto serve` process (Vericto CLI 2.1.0 or later, installed
separately). The official integrations' guides say what changes; for the patterns,
pass the offline guard where they pass `vericto`.

All on Node.js 25.8.0 locally and Node.js 22 in CI; the official integrations with
`@vericto/sdk` 0.5.0, the patterns with 0.4.0 and later.

Every ```` ```ts ```` block in these guides is type-checked and run by
`scripts/check-docs-examples.mjs` against a local stand-in for the Runtime API
(`scripts/docs-stub.mjs`), and the offline examples against a stand-in for `vericto
serve` (`scripts/serve-stub.mjs`): no API key, no network, no model calls. This directory's
`package.json` pins the versions of the pattern guides for that check; it is not published.
The guides of the official integrations (LangChain.js, Vercel AI SDK, OpenAI Agents
SDK, Mastra) run with the package's own devDependencies (`npm run docs:check`); the
others with this directory's (`node scripts/check-docs-examples.mjs
frameworks`, with `DATABASE_URL` and `MYSQL_URL` pointing at PostgreSQL and MySQL).
