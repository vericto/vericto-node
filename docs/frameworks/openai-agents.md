# OpenAI Agents SDK (JavaScript)

**Status: official, `@vericto/sdk/openai-agents`** (since `@vericto/sdk` 0.5.0).
Database guardrails on the SQL tools an agent calls, two ways:

- `sqlTool({ dialect, execute })`: a ready `run_sql` function tool with the whole
  contract. A block goes back to the model as the tool output (the rule code and the
  suggested fix); an approved query (masked columns and/or a LIMIT bound) runs instead
  of the model's.
- `verictoToolInputGuardrail({ dialect, sqlKey })`: a native **tool input guardrail**
  for a function tool you already have (`tool({ ..., inputGuardrails: [...] })`). A
  block is answered with the refusal (`rejectContent`) and your tool does not run.

Tested with: Node.js 25.8.0 (CI: Node.js 22 and 24), `@openai/agents` 0.21.0 (unit
tests also with 0.18.0), `zod` 4.6.7, `better-sqlite3` 13.0.3. The example runs a real `Agent` with a
scripted `Model`, so no model is called and no OpenAI key is needed.

## Install

```bash
npm install @vericto/sdk @openai/agents zod
```

`@openai/agents` is an optional peer dependency (`>=0.18 <1`): only
`@vericto/sdk/openai-agents` loads it.

## Example

```ts
import Database from 'better-sqlite3';
import { Agent, Usage, run, setTracingDisabled, tool, type Model, type ModelResponse } from '@openai/agents';
import { z } from 'zod';
import { sqlTool, verictoErrorOf, verictoToolInputGuardrail } from '@vericto/sdk/openai-agents';

setTracingDisabled(true); // this example has no OpenAI key

const db = new Database(':memory:');
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
db.prepare('INSERT INTO users VALUES (?, ?)').run(1, 'ada@example.com');

// 1. A ready tool (reads VERICTO_* from the environment): `execute` gets the approved SQL.
const runSql = sqlTool({ dialect: 'sqlite', execute: (sql) => db.prepare(sql).all() });

// 2. Your own tool, guarded by a tool input guardrail on its `query` argument.
const queryDb = tool({
  name: 'query_db',
  description: 'Run one SQL query with bind parameters (SQLite).',
  parameters: z.object({ query: z.string(), params: z.array(z.union([z.string(), z.number()])) }),
  execute: async ({ query, params }) => JSON.stringify(db.prepare(query).all(...params)),
  inputGuardrails: [verictoToolInputGuardrail({ dialect: 'sqlite', sqlKey: 'query' })],
});

// A scripted model stands in for your provider's model: four tool calls, then an answer.
const calls = [
  { name: 'run_sql', args: { sql: 'SELECT id, email FROM users' } },
  { name: 'run_sql', args: { sql: 'DELETE FROM users' } },
  { name: 'query_db', args: { query: 'SELECT id FROM users WHERE id = ?', params: [1] } },
  { name: 'query_db', args: { query: 'DELETE FROM users', params: [] } },
];
const model: Model = {
  async getResponse(): Promise<ModelResponse> {
    const call = calls.shift();
    return {
      usage: new Usage(),
      output: call
        ? [{ type: 'function_call', callId: `call-${calls.length}`, name: call.name, arguments: JSON.stringify(call.args), status: 'completed' }]
        : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] }],
    };
  },
  getStreamedResponse: () => { throw new Error('not used'); },
};

const agent = new Agent({
  name: 'SQL agent',
  instructions: 'Answer questions with SQL. If a query is blocked, follow the suggested fix.',
  model,
  tools: [runSql, queryDb],
});

try {
  const result = await run(agent, 'Clean up the users table');
  for (const item of result.newItems) {
    if (item.type !== 'tool_call_output_item') continue;
    const out = typeof item.output === 'string' ? JSON.parse(item.output) : item.output;
    console.log(out.decision === 'BLOCKED' ? `BLOCKED ${out.rule_code}: ${out.suggested_fix}` : JSON.stringify(out));
  }
} catch (err) {
  // Fail closed: Vericto unavailable or misconfigured rejects the run; nothing ran.
  const vericto = verictoErrorOf(err);
  if (vericto) console.error('Vericto:', vericto.message);
  throw err;
}
```

With the documentation stub (it masks `email` and blocks a `DELETE` without `WHERE`):

<!-- docs-check: output -->
```text
{"result":[{"id":1,"email":"***"}],"vericto":{"decision":"FLAGGED","rule_code":"VERICTO-085","severity":"low","approved_query":"SELECT id, '***' AS email FROM users","note":null}}
BLOCKED VERICTO-001: DELETE FROM users WHERE <condition>
[{"id":1}]
BLOCKED VERICTO-001: DELETE FROM users WHERE <condition>
```

In your application, leave `model` out (or name one) and keep your OpenAI key in the
environment; nothing else changes.

## What each verdict does

| Verdict | `sqlTool` | `verictoToolInputGuardrail` |
|---|---|---|
| `ALLOWED` | `{ result, vericto: { decision: 'ALLOWED', ... } }` | `allow`: your tool runs. |
| `FLAGGED` / `MONITORED` | Runs; reported in `vericto`; the guard logs it and calls `onVerdict`. | `allow`, with the verdict as the guardrail's `outputInfo`; the guard logs it. |
| approved query | Runs the approved query **instead of** the model's (`vericto.approved_query`). | A guardrail cannot change the tool's input: `rejectContent` with `approved_query` and "run only this approved query instead" (as MCP `check_sql` answers); the approved query is then let through. `sqlTool` saves that round trip. |
| `BLOCKED` | The refusal `{ decision: 'BLOCKED', executed: false, rule_code, severity, reason, suggested_fix, access_denied, event_id, message }`. | `rejectContent` with the same refusal as JSON; your tool does not run. |
| `onBlock: 'raise'` | The run rejects with `VerictoBlockedError`. | The same. |
| no verdict, `failMode: 'closed'` (default) | The run rejects with `VerictoUnavailableError` (inside the runner's `ToolCallError`: `verictoErrorOf(err)` finds it); nothing runs. `sqlTool` never hands Vericto errors to `errorFunction`. | The same. |
| no verdict, `failMode: 'open'` | Runs unevaluated: `vericto.decision` is `UNEVALUATED`, with the reason. | `allow`. |
| configuration error | Rejects with `VerictoConfigError` in both modes. | The same. |

## Options

| Option | Default | |
|---|---|---|
| `dialect` | required | `postgres`, `mysql`, `oracle`, `mssql`, `snowflake`, `sqlite` (driver names such as `pg` are accepted). |
| `vericto` | `new Vericto()` from `VERICTO_*` | The guard: fail mode, verdict cache (`cacheTtlMs`), logger, `onVerdict`. |
| `onBlock` | `'return'` | `'raise'` rejects the run with `VerictoBlockedError`. |
| `context`, `endUser` | none | The business policy context: a value, or a function read for every call. `sqlTool` passes it `(input, runContext)`; the guardrail `(args, data)`, `data.context` being the `RunContext`. |
| `sqlKey` (guardrail) | `'sql'` | The argument that holds the SQL text. |
| `name` | `run_sql` / `vericto` | The tool name / the guardrail name. |
| `description`, `errorFunction` (`sqlTool`) | | What the model reads; what it gets when `execute` throws something other than a Vericto error. |

Each query the model writes is one Runtime API evaluation.

## Offline (no account)

To try the guardrails before you create an API key, use [offline
mode](../../README.md#offline-mode-no-account): a local `vericto serve` process
(Vericto CLI 2.1.0 or later, installed separately, e.g. `npm install --save-dev
@vericto/vericto-cli@^2.1.0`) checks each query with the engine's standard rules, with
no network. Pass `vericto: new Vericto({ offline: true })` to `sqlTool` or `verictoToolInputGuardrail`, or set `VERICTO_OFFLINE=1` (with no `VERICTO_API_KEY`) and every tool and guardrail built without `vericto` uses it. The contract above holds as it is: a block is a refusal for the
model, and a failure of the local process applies the fail mode. Offline there are no
masks, allowlists, business policies or audit trail, so `approved_query` is never set and
`event_id` is `null`.
