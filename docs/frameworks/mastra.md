# Mastra

**Status: official, `@vericto/sdk/mastra`** (since `@vericto/sdk` 0.5.0). Database
guardrails on the SQL tools a Mastra agent calls: Vericto checks every query the model
writes before your code runs it. A block goes back to the model as the tool result (the
rule code and the suggested fix), so it can rewrite the query; the SQL never runs.

- `sqlTool({ dialect, execute })`: a ready `run-sql` tool (`createTool`).
- `guardSqlTool(tool, { dialect, sqlKey })`: guards a Mastra tool you already have.

The extension point is the tool's `execute`. A Mastra processor sees the model's tool
calls (`processOutputStep`) but can only abort or retry the whole step: it could not
answer one call with a refusal, or run an approved query instead.

Tested with: Node.js 25.8.0 (CI: Node.js 22 and 24), `@mastra/core` 1.81.0 (tool
unit tests also with 1.0.4), `zod` 4.6.7, `better-sqlite3` 13.0.3. The example runs a real
`Agent` with the AI SDK's scripted test model (`MockLanguageModelV4` from `ai/test`), so
no model is called.

## Install

```bash
npm install @vericto/sdk @mastra/core zod
```

`@mastra/core` is an optional peer dependency (`>=1 <2`): only `@vericto/sdk/mastra`
loads it.

## Example

```ts
import Database from 'better-sqlite3';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import type { VerictoError } from '@vericto/sdk';
import { guardSqlTool, isVerictoRefusal, sqlTool, verictoErrorOf } from '@vericto/sdk/mastra';

const db = new Database(':memory:');
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
db.prepare('INSERT INTO users VALUES (?, ?)').run(1, 'ada@example.com');

// 1. A ready tool (reads VERICTO_* from the environment): `execute` gets the approved SQL.
const runSql = sqlTool({ dialect: 'sqlite', execute: (sql) => db.prepare(sql).all() });

// 2. Your own tool, guarded on its `query` field; `params` is passed as it is.
const queryDb = guardSqlTool(
  createTool({
    id: 'query-db',
    description: 'Run one SQL query with bind parameters (SQLite).',
    inputSchema: z.object({ query: z.string(), params: z.array(z.union([z.string(), z.number()])) }),
    execute: async ({ query, params }) => ({ rows: db.prepare(query).all(...params) }),
  }),
  { dialect: 'sqlite', sqlKey: 'query' },
);

// A scripted model stands in for your provider's model: three tool calls, then an answer.
const calls = [
  { tool: 'runSql', input: { sql: 'SELECT id, email FROM users' } },
  { tool: 'runSql', input: { sql: 'DELETE FROM users' } },
  { tool: 'queryDb', input: { query: 'SELECT id FROM users WHERE id = ?', params: [1] } },
];
const model = new MockLanguageModelV4({
  doGenerate: async () => {
    const call = calls.shift();
    return {
      content: call
        ? [{ type: 'tool-call', toolCallId: `call-${calls.length}`, toolName: call.tool, input: JSON.stringify(call.input) }]
        : [{ type: 'text', text: 'Done.' }],
      finishReason: { unified: call ? 'tool-calls' : 'stop', raw: undefined },
      usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
      warnings: [],
    };
  },
});

const agent = new Agent({
  id: 'sql-agent',
  name: 'SQL agent',
  instructions: 'Answer questions with SQL. If a query is blocked, follow the suggested fix.',
  model,
  tools: { runSql, queryDb },
});

// Mastra answers the model with the text of an error a tool throws and goes on; the
// `tool-error` chunk carries the error, so fail closed reaches your code too.
let failure: VerictoError | undefined;
const result = await agent.generate('Clean up the users table', {
  maxSteps: 5,
  onChunk: (chunk) => {
    if (chunk.type === 'tool-error') failure ??= verictoErrorOf(chunk.payload.error);
  },
});
if (failure) throw failure; // Vericto unavailable or misconfigured: nothing ran

for (const step of result.steps) {
  for (const part of step.content) {
    if (part.type !== 'tool-result') continue;
    const out = (part.output as { value: unknown }).value;
    console.log(isVerictoRefusal(out) ? `BLOCKED ${out.rule_code}: ${out.suggested_fix}` : JSON.stringify(out));
  }
}
```

With the documentation stub (it masks `email` and blocks a `DELETE` without `WHERE`):

<!-- docs-check: output -->
```text
{"result":[{"id":1,"email":"***"}],"vericto":{"decision":"FLAGGED","rule_code":"VERICTO-085","severity":"low","approved_query":"SELECT id, '***' AS email FROM users","note":null}}
BLOCKED VERICTO-001: DELETE FROM users WHERE <condition>
{"rows":[{"id":1}]}
```

In your application `model` is whatever model your agent uses (`'openai/gpt-5-mini'`,
an AI SDK provider model); nothing else changes.

## What each verdict does

| Verdict | What the model sees |
|---|---|
| `ALLOWED` | `sqlTool`: `{ result, vericto: { decision: 'ALLOWED', ... } }`. `guardSqlTool`: your tool's output. |
| `FLAGGED` / `MONITORED` | The same: the query runs; the guard logs the verdict and calls its `onVerdict`. `sqlTool` also reports the rule in `vericto`. |
| approved query | The approved query (masked columns and/or a LIMIT bound) runs **instead of** the model's, never the original; `sqlTool` reports it as `vericto.approved_query`. |
| `BLOCKED` | A refusal, `{ decision: 'BLOCKED', executed: false, rule_code, severity, reason, suggested_fix, access_denied, event_id, message }`; your `execute` is not called. With `onBlock: 'raise'` the tool throws `VerictoBlockedError` instead. |
| no verdict, `failMode: 'closed'` (default) | The tool throws `VerictoUnavailableError`; nothing runs. Mastra gives the model the error text; the `tool-error` chunk carries the error (`verictoErrorOf`, as above). |
| no verdict, `failMode: 'open'` | The query runs unevaluated: `vericto.decision` is `UNEVALUATED`, with the reason in `vericto.note`. |
| configuration error | Throws `VerictoConfigError` in both modes (reaches your code as above). |

## Options

| Option | Default | |
|---|---|---|
| `dialect` | required | `postgres`, `mysql`, `oracle`, `mssql`, `snowflake`, `sqlite` (driver names such as `pg` are accepted). |
| `vericto` | `new Vericto()` from `VERICTO_*` | The guard: fail mode, verdict cache (`cacheTtlMs`), logger, `onVerdict`. |
| `onBlock` | `'return'` | `'raise'` throws `VerictoBlockedError`. |
| `context`, `endUser` | none | The business policy context: a value, or a function `(input, context) => value` read for every call (e.g. from `context.requestContext`). |
| `sqlKey` (`guardSqlTool`) | `'sql'` | The input field that holds the SQL text. |
| `id`, `description` (`sqlTool`) | `run-sql`, what it does | |

`guardSqlTool` returns a copy (same class, id, description and schemas); the original
tool is not changed. If your tool declares an `outputSchema`, widen it to accept the
refusal. Each query the model writes is one Runtime API evaluation.
