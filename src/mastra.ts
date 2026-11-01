// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vericto for Mastra (`@mastra/core`): database guardrails on the SQL tools an agent
 * calls.
 *
 * ```ts
 * import { Agent } from '@mastra/core/agent';
 * import { sqlTool } from '@vericto/sdk/mastra';
 *
 * const agent = new Agent({
 *   id: 'sql-agent',
 *   name: 'SQL agent',
 *   instructions: 'Answer questions with SQL.',
 *   model,
 *   tools: { runSql: sqlTool({ dialect: 'postgres', execute: (sql) => pool.query(sql).then((r) => r.rows) }) },
 * });
 * ```
 *
 * - {@link sqlTool} builds a `run-sql` tool (`createTool`) around your `execute(sql)`.
 * - {@link guardSqlTool} guards a Mastra tool you already have: its input's `sql`
 *   field is checked before its `execute` runs.
 *
 * The extension point is the tool's `execute`: a Mastra processor sees the model's
 * tool calls (`processOutputStep`) but can only abort or retry the whole step, so it
 * could neither answer one call with a refusal nor run an approved query instead.
 *
 * Every call is checked with `Vericto.enforce`, before anything runs: a block becomes
 * a {@link VerictoRefusal} for the model (or `VerictoBlockedError` with `onBlock:
 * 'raise'`) and the SQL never runs; `FLAGGED` / `MONITORED` run (the guard logs them
 * and calls its `onVerdict`); an approved query (masked columns and/or a LIMIT bound)
 * runs instead of the model's. When Vericto cannot answer, the guard's fail mode
 * applies: `closed` (default) throws `VerictoUnavailableError` and nothing runs;
 * `open` runs the query unevaluated. A configuration error throws in both modes.
 * In an agent run, Mastra answers the model with the error text and goes on; its
 * `tool-error` chunk carries the error (as `cause`), so your code can see it:
 *
 * ```ts
 * let failure: VerictoError | undefined;
 * const result = await agent.generate(question, {
 *   onChunk: (chunk) => {
 *     if (chunk.type === 'tool-error') failure ??= verictoErrorOf(chunk.payload.error);
 *   },
 * });
 * if (failure) throw failure; // nothing ran
 * ```
 *
 * Requires the optional peer `@mastra/core`.
 */
import { createTool, type Tool } from '@mastra/core/tools';

import {
  AgentToolGuard,
  reportOf,
  sqlOf,
  sqlToolDescription,
  withSql,
  type AgentToolGuardOptions,
  type VerictoRefusal,
  type VerictoReport,
} from './agent-tool.js';
import { VerictoError } from './errors.js';

export {
  blockedMessage,
  isVerictoRefusal,
  verictoErrorOf,
  type AgentToolGuardOptions,
  type CallSource,
  type OnBlock,
  type VerictoRefusal,
  type VerictoReport,
} from './agent-tool.js';

/** The second argument of a Mastra tool's `execute` (request context, abort signal, agent call data...). */
export type MastraToolContext = Parameters<NonNullable<Tool['execute']>>[1];

/** The options of {@link guardSqlTool}. `context` / `endUser` functions get the tool input and the execution context. */
export interface GuardSqlToolOptions<INPUT = unknown> extends AgentToolGuardOptions<[input: INPUT, context: MastraToolContext]> {
  /** The input field that holds the SQL text. Default `sql`. */
  sqlKey?: string;
}

/**
 * Guard a Mastra tool that runs SQL: before its `execute` runs, Vericto checks the
 * SQL text at `input[sqlKey]` (default `sql`). Blocked: the tool returns a
 * {@link VerictoRefusal} and `execute` is not called. Approved query: `execute` gets
 * the input with the approved query in place of the model's. The other input fields
 * (bind parameters, for example) are passed as they are.
 *
 * The result is a copy (the same `Tool` class, id, description and schemas): the
 * original tool is not changed. If the tool declares an `outputSchema`, widen it to
 * accept the refusal.
 */
// A Tool of any input and output: `execute` takes its input as a parameter, so `unknown` would not match.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function guardSqlTool<TOOL extends Tool<any, any, any, any, any, any, any>>(
  sqlTool: TOOL,
  options: GuardSqlToolOptions<ToolInput<TOOL>>,
): GuardedTool<TOOL> {
  const guard = new AgentToolGuard<[ToolInput<TOOL>, MastraToolContext]>(options);
  const key = options.sqlKey ?? 'sql';
  const run = (sqlTool as { execute?: unknown }).execute;
  if (typeof run !== 'function') throw new VerictoError('guardSqlTool needs a tool with an execute function.');
  const execute = async (input: ToolInput<TOOL>, context: MastraToolContext): Promise<unknown> => {
    const outcome = await guard.check(sqlOf(input, key), input, context);
    if (!outcome.run) return outcome.refusal;
    return (run as (input: unknown, context: MastraToolContext) => Promise<unknown>).call(
      sqlTool,
      withSql(input, key, outcome.sql),
      context,
    );
  };
  // Same prototype and fields; only `execute` differs.
  const guarded = Object.assign(Object.create(Object.getPrototypeOf(sqlTool) as object) as object, sqlTool, { execute });
  return guarded;
}

/** The input type of a Mastra tool. */
export type ToolInput<TOOL> = TOOL extends { execute?: (input: infer I, ...rest: never[]) => unknown } ? I : never;

/** The tool {@link guardSqlTool} returns: the same tool, whose output may also be a {@link VerictoRefusal}. */
export type GuardedTool<TOOL extends { execute?: unknown }> = Omit<TOOL, 'execute'> & {
  execute: (
    input: ToolInput<TOOL>,
    context: MastraToolContext,
  ) => Promise<Awaited<ReturnType<Extract<TOOL['execute'], (...args: never[]) => unknown>>> | VerictoRefusal>;
};

/** The input of a {@link sqlTool}: one SQL statement. */
export interface SqlToolInput {
  sql: string;
}

/** What a {@link sqlTool} returns when the query ran: your `execute`'s result and how Vericto let it run. */
export interface SqlToolResult<RESULT> {
  result: RESULT;
  vericto: VerictoReport;
}

/** The options of {@link sqlTool}. */
export interface SqlToolOptions<RESULT> extends AgentToolGuardOptions<[input: SqlToolInput, context: MastraToolContext]> {
  /** Run the SQL Vericto approved: the model's query, or the approved query that replaces it. */
  execute: (sql: string, context: MastraToolContext) => PromiseLike<RESULT> | RESULT;
  /** The tool id. Default `run-sql`. */
  id?: string;
  /** What the model reads about the tool. Default: what it does and how blocks are answered. */
  description?: string;
}

const SQL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: { sql: { type: 'string' as const, description: 'One SQL statement.' } },
  required: ['sql'],
  additionalProperties: false,
};

/** A Mastra tool whose input is `{ sql }` and whose output is `OUTPUT`. */
export type SqlTool<OUTPUT> = Tool<SqlToolInput, OUTPUT> & {
  execute: (input: SqlToolInput, context: MastraToolContext) => Promise<OUTPUT>;
};

/**
 * A ready SQL tool: the model sends `{ sql }`, Vericto checks it, and your `execute`
 * runs the approved SQL. The model gets `{ result, vericto }` (the verdict, and the
 * approved query when that ran instead), or a {@link VerictoRefusal}.
 */
export function sqlTool<RESULT>(options: SqlToolOptions<RESULT>): SqlTool<SqlToolResult<RESULT> | VerictoRefusal> {
  const guard = new AgentToolGuard<[SqlToolInput, MastraToolContext]>(options);
  const run = (options as Partial<SqlToolOptions<RESULT>>).execute;
  if (typeof run !== 'function') throw new VerictoError('sqlTool needs { execute(sql) }.');
  const built = createTool({
    id: options.id ?? 'run-sql',
    description: options.description ?? sqlToolDescription(guard.dialect),
    inputSchema: SQL_INPUT_SCHEMA,
    execute: async (input: unknown, context): Promise<SqlToolResult<RESULT> | VerictoRefusal> => {
      const sql = sqlOf(input, 'sql');
      const call = context as unknown as MastraToolContext;
      const outcome = await guard.check(sql, { sql }, call);
      if (!outcome.run) return outcome.refusal;
      return { result: await run(outcome.sql, call), vericto: reportOf(outcome.verdict) };
    },
  });
  return built as unknown as SqlTool<SqlToolResult<RESULT> | VerictoRefusal>;
}
