# OpenAI Agents SDK (JavaScript)

**Status: documented pattern.** There is no OpenAI Agents SDK integration in
`@vericto/sdk`. The pattern: the SQL function tool you give the agent runs its query
through a Vericto-guarded driver, so every query the model writes is checked before the
database sees it, and a block goes back to the model as the tool output.

Tested with: Node.js 25.8.0 (CI: Node.js 22), `@vericto/sdk` 0.4.0, `@openai/agents`
0.21.0, `zod` 4.6.7, `better-sqlite3` 13.0.3. The example invokes the tool the way the
runner does (`tool.invoke`), without a model.

## Install

```bash
npm install @vericto/sdk @openai/agents zod better-sqlite3
```

## Example

```ts
import Database from 'better-sqlite3';
import { Agent, RunContext, tool } from '@openai/agents';
import { z } from 'zod';
import { VerictoBlockedError } from '@vericto/sdk';
import { guardDatabase } from '@vericto/sdk/better-sqlite3';

const db = await guardDatabase(new Database(':memory:')); // reads VERICTO_* from the environment
await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
await db.run('INSERT INTO users VALUES (?, ?)', 1, 'ada@example.com');

export const runSql = tool({
  name: 'run_sql',
  description: 'Run one SQL query against the application database (SQLite).',
  parameters: z.object({ sql: z.string() }),
  execute: async ({ sql }) => {
    try {
      return JSON.stringify(await db.all(sql));
    } catch (err) {
      // A block goes back to the model, with the rule and the fix, so it can rewrite it.
      if (!(err instanceof VerictoBlockedError)) throw err;
      return err.message;
    }
  },
  // Without this, the SDK turns any thrown error into "An error occurred while running
  // the tool" for the model, and "Vericto unavailable" would never reach your code.
  errorFunction: null,
});

export const agent = new Agent({
  name: 'SQL agent',
  instructions: 'Answer questions with SQL. If a query is blocked, follow the suggested fix.',
  tools: [runSql],
});

// What the agent gets back when the model calls the tool (no model is called here):
const context = new RunContext();
console.log(await runSql.invoke(context, JSON.stringify({ sql: 'SELECT id, email FROM users' })));
console.log(await runSql.invoke(context, JSON.stringify({ sql: 'DELETE FROM users' })));
```

With the documentation stub (it masks `email` and blocks a `DELETE` without `WHERE`):

<!-- docs-check: output -->
```text
[{"id":1,"email":"***"}]
Query blocked by VERICTO-001 (severity critical). Suggested fix: DELETE FROM users WHERE <condition>
```

`await run(agent, 'How many users signed up this week?')` runs it with a model.

## What each verdict does

| Verdict | What the model sees |
|---|---|
| `ALLOWED`, `FLAGGED`, `MONITORED` | The rows (flagged and monitored queries are logged and passed to `onVerdict`). |
| mask | The rows of the masked rewrite. |
| `BLOCKED` | `Query blocked by ... Suggested fix: ...`; nothing ran. |
| no verdict, config error | With `errorFunction: null`, the tool throws `VerictoUnavailableError` / `VerictoConfigError` and the run rejects; nothing runs. With the default `errorFunction`, nothing runs either, but the model only gets a generic error text and your code sees no exception. |

Each query the model writes is one Runtime API evaluation.
