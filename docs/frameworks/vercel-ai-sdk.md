# Vercel AI SDK

**Status: official, `@vericto/sdk/ai`** (since `@vericto/sdk` 0.5.0). Database guardrails
on the SQL tools you give the model: Vericto checks every query the model writes before
your code runs it. A block goes back to the model as the tool result (the rule code and
the suggested fix), so it can rewrite the query; the SQL never runs.

Tested with: Node.js 25.8.0 (CI: Node.js 22 and 24), `ai` 7.0.159 (unit tests also with 7.0.0), `zod`
4.6.7, `better-sqlite3` 13.0.3. The examples use the AI SDK's own scripted test model
(`MockLanguageModelV4` from `ai/test`), so no model is called.

## Install

```bash
npm install @vericto/sdk ai
```

`ai` is an optional peer dependency (`>=7 <8`): only `@vericto/sdk/ai` loads it.

## A ready SQL tool: `sqlTool`

`sqlTool({ dialect, execute })` builds a tool whose input is `{ sql }`. Vericto checks
the query; your `execute(sql)` runs the SQL Vericto approved and returns the rows.

```ts
import Database from 'better-sqlite3';
import { generateText, isStepCount } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { isVerictoRefusal, sqlTool, throwOnVerictoError } from '@vericto/sdk/ai';

const db = new Database(':memory:');
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
db.prepare('INSERT INTO users VALUES (?, ?)').run(1, 'ada@example.com');

// Reads VERICTO_* from the environment. `execute` gets the SQL Vericto approved.
const runSql = sqlTool({ dialect: 'sqlite', execute: (sql) => db.prepare(sql).all() });

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
throwOnVerictoError(result); // Vericto unavailable or misconfigured: throw here, nothing ran

for (const step of result.steps) {
  for (const r of step.toolResults) {
    const out = r.output;
    console.log(isVerictoRefusal(out) ? `BLOCKED ${out.rule_code}: ${out.suggested_fix}` : JSON.stringify(out));
  }
}
```

With the documentation stub (it masks `email` and blocks a `DELETE` without `WHERE`):

<!-- docs-check: output -->
```text
{"result":[{"id":1,"email":"***"}],"vericto":{"decision":"FLAGGED","rule_code":"VERICTO-085","severity":"low","approved_query":"SELECT id, '***' AS email FROM users","note":null}}
BLOCKED VERICTO-001: DELETE FROM users WHERE <condition>
```

The first query read a masked column, so the approved query ran instead of the model's
(`approved_query`). The `DELETE` never ran: the model got the refusal and can follow
`suggested_fix`. In your application `model` is your provider's model
(`openai('...')`, `anthropic('...')`, a gateway id); nothing else changes.

## Guard a tool you already have: `guardSqlTool`

`guardSqlTool(tool, { dialect, sqlKey })` returns a copy of your tool whose input field
`sqlKey` (default `sql`) is checked before its `execute` runs. The other input fields,
bind parameters for example, are passed as they are; an approved query replaces only the
SQL text.

```ts
import Database from 'better-sqlite3';
import { tool } from 'ai';
import { z } from 'zod';
import { guardSqlTool } from '@vericto/sdk/ai';

const db = new Database(':memory:');
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
db.prepare('INSERT INTO users VALUES (?, ?)').run(1, 'ada@example.com');

const queryDb = guardSqlTool(
  tool({
    description: 'Run one SQL query with bind parameters against the application database (SQLite).',
    inputSchema: z.object({ query: z.string(), params: z.array(z.union([z.string(), z.number()])) }),
    execute: async ({ query, params }) => db.prepare(query).all(...params),
  }),
  { dialect: 'sqlite', sqlKey: 'query' },
);

// What the model gets back for two calls (the AI SDK calls `execute` the same way):
const options = { toolCallId: 'call-1', messages: [], context: {} };
console.log(JSON.stringify(await queryDb.execute({ query: 'SELECT id FROM users WHERE id = ?', params: [1] }, options)));
const refusal = await queryDb.execute({ query: 'DELETE FROM users', params: [] }, options);
console.log(JSON.stringify(refusal).includes('"executed":false'));
```

<!-- docs-check: output -->
```text
[{"id":1}]
true
```

## What each verdict does

| Verdict | What the model sees |
|---|---|
| `ALLOWED` | `sqlTool`: `{ result, vericto: { decision: 'ALLOWED', ... } }`. `guardSqlTool`: your tool's output. |
| `FLAGGED` / `MONITORED` | The same: the query runs; the guard logs the verdict and calls its `onVerdict`. `sqlTool` also reports the rule in `vericto`. |
| approved query | The approved query (masked columns and/or a LIMIT bound) runs **instead of** the model's, never the original; `sqlTool` reports it as `vericto.approved_query`. |
| `BLOCKED` | A refusal, `{ decision: 'BLOCKED', executed: false, rule_code, severity, reason, suggested_fix, access_denied, event_id, message }`; your `execute` is not called. With `onBlock: 'raise'` the tool throws `VerictoBlockedError` instead. |
| no verdict, `failMode: 'closed'` (default) | The tool throws `VerictoUnavailableError`; nothing runs. The AI SDK hands it to the model as a `tool-error` part instead of rejecting: `throwOnVerictoError(result)` throws it in your code. |
| no verdict, `failMode: 'open'` | The query runs unevaluated: `vericto.decision` is `UNEVALUATED`, with the reason in `vericto.note`. |
| configuration error | Throws `VerictoConfigError` in both modes (as above, via `throwOnVerictoError`). |

## Options

Both functions take the guard's options; `guardSqlTool` also takes `sqlKey`, `sqlTool`
takes `execute` and `description`.

| Option | Default | |
|---|---|---|
| `dialect` | required | `postgres`, `mysql`, `oracle`, `mssql`, `snowflake`, `sqlite` (driver names such as `pg` are accepted). |
| `vericto` | `new Vericto()` from `VERICTO_*` | The guard: fail mode, verdict cache (`cacheTtlMs`), logger, `onVerdict`. |
| `onBlock` | `'return'` | `'raise'` throws `VerictoBlockedError`. |
| `context`, `endUser` | none | The business policy context, a value or a function `(input, options) => value` read for every call (e.g. from `options.context`, the AI SDK tool context). |

`isVerictoRefusal(output)` tells a refusal from a result; `verictoErrorOf(error)` finds a
Vericto error behind a wrapped one.

## Notes

- `streamText` calls the same `execute`: use `throwOnVerictoError({ steps: await
  result.steps })` after the stream.
- A streaming tool (an `execute` that is an async generator) guarded with
  `guardSqlTool` returns its final value; the preliminary ones are not streamed.
- If your tool declares an `outputSchema`, widen it to accept the refusal.
- Why not language model middleware (`wrapLanguageModel`)? Middleware sees the model's
  tool calls but not your tool's input schema or its `execute`: it could drop a call,
  not answer it with a refusal or run the approved query instead. The guard sits in the
  tool, where the SQL runs.
- Each query the model writes is one Runtime API evaluation (`cacheTtlMs` reuses a
  verdict for an unchanged query).
