# Mastra

**Status: documented pattern.** There is no Mastra integration in `@vericto/sdk`. The
pattern: the SQL tool you give the agent (`createTool`) runs its query through a
Vericto-guarded driver, so every query the model writes is checked before the database
sees it, and a block goes back to the model as the tool result.

Tested with: Node.js 25.8.0 (CI: Node.js 22), `@vericto/sdk` 0.3.1, `@mastra/core`
1.79.0, `zod` 4.6.7, `better-sqlite3` 13.0.3. The published example calls the tool body
directly (no model); an `agent.generate()` run with a scripted AI SDK test model was also
checked by hand, with the same results.

## Install

```bash
npm install @vericto/sdk @mastra/core zod better-sqlite3
```

## Example

```ts
import Database from 'better-sqlite3';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { VerictoBlockedError } from '@vericto/sdk';
import { guardDatabase } from '@vericto/sdk/better-sqlite3';

const db = await guardDatabase(new Database(':memory:')); // reads VERICTO_* from the environment
await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
await db.run('INSERT INTO users VALUES (?, ?)', 1, 'ada@example.com');

/** The tool body: Vericto checks the query before SQLite runs it. */
async function runSqlQuery({ sql }: { sql: string }) {
  try {
    return { rows: await db.all(sql) };
  } catch (err) {
    // A block goes back to the model, with the rule and the fix, so it can rewrite the
    // query. Anything else (Vericto unavailable, a bad key) is thrown: fail closed.
    if (!(err instanceof VerictoBlockedError)) throw err;
    return { blocked: err.message };
  }
}

export const runSql = createTool({
  id: 'run-sql',
  description: 'Run one SQL query against the application database (SQLite).',
  inputSchema: z.object({ sql: z.string() }),
  execute: runSqlQuery,
});

// Give the tool to an agent as usual; the model id is whatever provider you use.
export const agent = new Agent({
  id: 'sql-agent',
  name: 'SQL agent',
  instructions: 'Answer questions with SQL. If a query is blocked, follow the suggested fix.',
  model: 'openai/gpt-5-mini',
  tools: { runSql },
});

// What the agent gets back when the model calls the tool (no model is called here):
console.log(JSON.stringify(await runSqlQuery({ sql: 'SELECT id, email FROM users' })));
console.log(JSON.stringify(await runSqlQuery({ sql: 'DELETE FROM users' })));
```

With the documentation stub (it masks `email` and blocks a `DELETE` without `WHERE`):

<!-- docs-check: output -->
```text
{"rows":[{"id":1,"email":"***"}]}
{"blocked":"Query blocked by VERICTO-001 (severity critical). Suggested fix: DELETE FROM users WHERE <condition>"}
```

## What each verdict does

| Verdict | What the model sees |
|---|---|
| `ALLOWED`, `FLAGGED`, `MONITORED` | The rows (flagged and monitored queries are logged and passed to `onVerdict`). |
| mask | The rows of the masked rewrite. |
| `BLOCKED` | `{ blocked: "Query blocked by ... Suggested fix: ..." }`; nothing ran. |
| no verdict, config error | The tool throws (`VerictoUnavailableError`, `VerictoConfigError`); nothing runs. How the error reaches your code depends on how you run the agent: check the tool results of the run, as you would for any tool error. |

Each query the model writes is one Runtime API evaluation.
