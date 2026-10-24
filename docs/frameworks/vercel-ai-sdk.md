# Vercel AI SDK

**Status: documented pattern.** There is no AI SDK integration in `@vericto/sdk`. The
pattern: the SQL tool you give the model runs its query through a Vericto-guarded
driver, so Vericto checks every query the model writes before the database sees it. A
block goes back to the model as the tool result (with the rule and the suggested fix),
so it can rewrite the query.

Tested with: Node.js 25.8.0 (CI: Node.js 22), `@vericto/sdk` 0.3.1, `ai` 7.0.152,
`zod` 4.6.7, `better-sqlite3` 13.0.3. The example uses the AI SDK's own scripted test
model (`MockLanguageModelV4` from `ai/test`), so no model is called.

## Install

```bash
npm install @vericto/sdk ai zod better-sqlite3
```

The example uses SQLite through `@vericto/sdk/better-sqlite3`; for another database,
run the tool's query through any guarded driver (see [node-postgres](node-postgres.md),
[mysql2](mysql2.md)) or `vericto.prepare()`.

## Example

```ts
import Database from 'better-sqlite3';
import { generateText, isStepCount, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { VerictoBlockedError, VerictoError } from '@vericto/sdk';
import { guardDatabase } from '@vericto/sdk/better-sqlite3';

const db = await guardDatabase(new Database(':memory:')); // reads VERICTO_* from the environment
await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
await db.run('INSERT INTO users VALUES (?, ?)', 1, 'ada@example.com');

/** The model's SQL tool: Vericto checks each query before SQLite runs it. */
const runSql = tool({
  description: 'Run one SQL query against the application database (SQLite).',
  inputSchema: z.object({ sql: z.string().describe('One SQL statement') }),
  execute: async ({ sql }) => {
    try {
      return { rows: await db.all(sql) };
    } catch (err) {
      // A block goes back to the model, with the rule and the fix, so it can rewrite the
      // query. Anything else (Vericto unavailable, a bad key) is thrown: fail closed.
      if (!(err instanceof VerictoBlockedError)) throw err;
      return { blocked: err.message };
    }
  },
});

// A scripted model stands in for your provider's model: two tool calls, then an answer.
const calls = ['SELECT id, email FROM users', 'DELETE FROM users'];
const model = new MockLanguageModelV4({
  doGenerate: async () => {
    const sql = calls.shift();
    return {
      content: sql
        ? [{ type: 'tool-call', toolCallId: `call-${calls.length}`, toolName: 'runSql', input: JSON.stringify({ sql }) }]
        : [{ type: 'text', text: 'Done.' }],
      finishReason: { unified: sql ? 'tool-calls' : 'stop', raw: undefined },
      usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
      warnings: [],
    };
  },
});

const result = await generateText({ model, tools: { runSql }, stopWhen: isStepCount(5), prompt: 'Clean up the users table' });

// The AI SDK hands a thrown tool error to the model as a `tool-error` part instead of
// rejecting. The statement did not run either way; surface Vericto errors to your code:
const failure = result.steps.flatMap((step) => step.content).find((part) => part.type === 'tool-error');
if (failure?.type === 'tool-error' && failure.error instanceof VerictoError) throw failure.error;

for (const step of result.steps) for (const r of step.toolResults) console.log(JSON.stringify(r.output));
```

With the documentation stub (it masks `email` and blocks a `DELETE` without `WHERE`):

<!-- docs-check: output -->
```text
{"rows":[{"id":1,"email":"***"}]}
{"blocked":"Query blocked by VERICTO-001 (severity critical). Suggested fix: DELETE FROM users WHERE <condition>"}
```

In your application `model` is your provider's model (`openai('...')`,
`anthropic('...')`, a gateway id); nothing else changes.

## What each verdict does

| Verdict | What the model sees |
|---|---|
| `ALLOWED` | The rows. |
| `FLAGGED` / `MONITORED` | The rows; the guard logs the verdict and calls `onVerdict`. |
| mask | The rows of the masked rewrite: masked columns come back masked. |
| `BLOCKED` | `{ blocked: "Query blocked by VERICTO-001 ... Suggested fix: ..." }`; nothing ran. |
| no verdict, config error | The tool throws (`VerictoUnavailableError`, `VerictoConfigError`), so nothing runs. The AI SDK reports it to the model as a `tool-error`; check `result.steps` as above so your code sees it too. |

## Notes

- `streamText` calls the same `execute`: the pattern is identical.
- Each query the model writes is one Runtime API evaluation.
- A tool that only **checks** SQL (no execution) is `vericto.check(sql, dialect)`, which
  resolves the verdict without applying it.
