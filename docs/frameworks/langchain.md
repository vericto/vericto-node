# LangChain.js

**Status: official integration** (`@vericto/sdk/langchain`, since 0.2.0). A
`VerictoSqlDatabase` is a LangChain `SqlDatabase` (`@langchain/classic/sql_db`) whose
TypeORM data source checks every query with Vericto first, so it works wherever a
`SqlDatabase` does: `QuerySqlTool`, `SqlToolkit` / `createSqlAgent`,
`SqlDatabaseChain`. A blocked query comes back to the model as a message with the rule
and the suggested fix, so the agent can correct itself.

Tested with: Node.js 25.8.0 (CI: Node.js 22 and 24), `@vericto/sdk` 0.3.1,
`@langchain/classic` 1.0.55, `@langchain/core` 1.3.0, `typeorm` 1.1.2,
`better-sqlite3` 13.0.3 (peer ranges: `@langchain/classic` and `@langchain/core` 1.x,
`typeorm` >= 0.3.20).

## Install

```bash
npm install @vericto/sdk @langchain/classic @langchain/core typeorm
npm install better-sqlite3   # or the TypeORM driver of your database: pg, mysql2, mssql, oracledb
```

## Example

A SQL agent on SQLite. A scripted LLM stands in for your chat model (it answers in the
ReAct format `createSqlAgent` expects), so the example makes no model call.

```ts
import { createSqlAgent } from '@langchain/classic/agents/toolkits/sql';
import { LLM } from '@langchain/core/language_models/llms';
import { DataSource } from 'typeorm';
import { VerictoCheckSqlTool, VerictoSqlDatabase, VerictoSqlToolkit } from '@vericto/sdk/langchain';

/** Answers in order: a stand-in for your model (ChatOpenAI, ChatAnthropic...). */
class ScriptedLLM extends LLM {
  readonly answers: string[];
  constructor(answers: string[]) { super({}); this.answers = answers; }
  _llmType(): string { return 'scripted'; }
  async _call(): Promise<string> { return this.answers.shift() ?? 'Final Answer: done'; }
}

const appDataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
await appDataSource.initialize();
await appDataSource.query('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
await appDataSource.query("INSERT INTO users VALUES (1, 'ada@example.com'), (2, 'bob@example.com')");

// Reads VERICTO_* from the environment; the dialect comes from the TypeORM type.
const db = await VerictoSqlDatabase.fromDataSourceParams({ appDataSource });

const llm = new ScriptedLLM([
  'Thought: remove the users\nAction: query-sql\nAction Input: DELETE FROM users',
  'Thought: follow the fix\nAction: query-sql\nAction Input: DELETE FROM users WHERE id = 2',
  'Final Answer: deleted user 2',
]);
const agent = createSqlAgent(llm, new VerictoSqlToolkit(db, llm));
const result = (await agent.invoke({ input: 'Delete user 2' })) as { output: string; intermediateSteps: { observation: string }[] };

console.log(result.intermediateSteps[0]?.observation.split('\n')[0]); // what the model read
console.log(result.output);
console.log(await appDataSource.query('SELECT id FROM users')); // the unchecked DELETE never ran

// A check-only tool: asks Vericto, runs nothing.
const check = new VerictoCheckSqlTool({ db });
console.log((await check.invoke('SELECT id, email FROM users')).split('\n')[0]);
await appDataSource.destroy();
```

With the documentation stub (it blocks a `DELETE` without `WHERE` and masks `email`):

<!-- docs-check: output -->
```text
Vericto blocked this SQL query; it was NOT executed.
deleted user 2
[ { id: 1 } ]
Vericto: FLAGGED by VERICTO-085 (severity low). The query is allowed to run, but it was reported.
```

## API

| Name | What it is |
|---|---|
| `VerictoSqlDatabase.fromDataSourceParams(params)` | `SqlDatabase.fromDataSourceParams` plus `vericto` (a `Vericto`; default from `VERICTO_*`), `dialect` (default: from the TypeORM type) and `onBlock` (`'return'`, default, or `'raise'`). Rejects with `VerictoUnsupportedDialectError` when the server does not evaluate the dialect. |
| `VerictoSqlDatabase.fromOptionsParams(params)` | The same from `appDataSourceOptions`. |
| `db.rawDataSource` | The unguarded TypeORM data source: SQL run through it is **not** checked. |
| `VerictoSqlToolkit(db, llm)` | `SqlToolkit` with `VerictoQuerySqlTool` and the Vericto dialect in the prompt. |
| `VerictoQuerySqlTool(db)` | `QuerySqlTool` that rethrows Vericto errors (the stock tool turns every error into text for the model, which would hide "Vericto unavailable"); SQL errors still come back as text. |
| `VerictoCheckSqlTool({ db })` or `({ vericto, dialect })` | Check-only tool (`vericto-check-sql`): returns the verdict as text, executes nothing. |
| `guardDataSource(ds, vericto, dialect)` | The guarded TypeORM `DataSource` on its own: every `query()` is checked first. |
| `dialectFromDataSource(ds)` | The Vericto dialect of a TypeORM type (`postgres`, `aurora-postgres`, `mysql`, `mariadb`, `aurora-mysql`, `mssql`, `oracle`, `sqlite`, `better-sqlite3`, `sqljs`); others throw `VerictoConfigError` (pass `dialect`). |
| `blockedMessage(verdict)`, `describeVerdict(verdict)` | The texts the model reads for a block and for the check tool. |

## What each verdict does

| Verdict | What the agent sees |
|---|---|
| `BLOCKED` | `onBlock: 'return'` (default): a message with the rule, severity, reason and suggested fix; the query did not run. `onBlock: 'raise'`: `VerictoBlockedError`. |
| `FLAGGED` / `MONITORED` | The query runs; the verdict is logged and passed to `onVerdict`. |
| mask | The masked rewrite runs, never the original: the model only sees masked values, sample rows in the table info included. |
| no verdict, config error | Thrown (`VerictoUnavailableError`, `VerictoConfigError`), never returned to the model; the [fail mode](../../README.md#fail-mode) applies. |

Details:

- `VerictoCheckSqlTool` calls `Vericto.check()`, which does not apply the fail mode: when
  Vericto cannot answer it throws `VerictoUnavailableError` even with `failMode: 'open'`
  (it has no verdict to report).
- A blocked sample-rows query is left out of the table info (LangChain logs the error and
  carries on).
- `SqlDatabaseChain` swallows query errors itself (it logs them and answers from an empty
  result), so there a block shows up as "no result" rather than as the message.
- LangChain's schema introspection in `fromDataSourceParams` (its catalogue read of
  tables and columns) runs on the raw data source and is not sent to Vericto.
- Each checked query, and each `VerictoCheckSqlTool` call, is one Runtime API evaluation
  (runtime quota, audit trail).
