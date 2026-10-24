# Framework guides

How to use `@vericto/sdk` with each framework. **Official** means an entry point of
this package; **pattern** means a few lines of your own code around the public API
(`Vericto.enforce` / `prepare` and the driver wrappers), tested but not shipped as an
integration.

| Guide | Status | Tested with |
|---|---|---|
| [LangChain.js](langchain.md) | official: `@vericto/sdk/langchain` | `@langchain/classic` 1.0.55, `@langchain/core` 1.3.0, `typeorm` 1.1.2 |
| [Vercel AI SDK](vercel-ai-sdk.md) | pattern | `ai` 7.0.152 |
| [Mastra](mastra.md) | pattern | `@mastra/core` 1.79.0 |
| [OpenAI Agents SDK](openai-agents.md) | pattern | `@openai/agents` 0.21.0 |
| [Prisma ORM](prisma.md) | pattern | `prisma` / `@prisma/client` 7.10.1 |
| [Drizzle ORM](drizzle.md) | pattern | `drizzle-orm` 0.45.4 |
| [Knex](knex.md) | pattern | `knex` 3.3.0 |
| [node-postgres](node-postgres.md) | pattern | `pg` 8.23.1 |
| [mysql2](mysql2.md) | pattern | `mysql2` 3.24.6 |

All with `@vericto/sdk` 0.3.1 on Node.js 25.8.0 locally and Node.js 22 in CI.

Every ```` ```ts ```` block in these guides is type-checked and run by
`scripts/check-docs-examples.mjs` against a local stand-in for the Runtime API
(`scripts/docs-stub.mjs`): no API key, no network, no model calls. This directory's
`package.json` pins the framework versions above for that check; it is not published.
The LangChain.js guide runs with the package's own devDependencies (`npm run
docs:check`); the others with this directory's (`node scripts/check-docs-examples.mjs
frameworks`, with `DATABASE_URL` and `MYSQL_URL` pointing at PostgreSQL and MySQL).
