// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vericto for the Vercel AI SDK (`ai`): database guardrails on the SQL tools a model
 * calls.
 *
 * ```ts
 * import { generateText } from 'ai';
 * import { sqlTool } from '@vericto/sdk/ai';
 *
 * const result = await generateText({
 *   model,
 *   tools: { runSql: sqlTool({ dialect: 'postgres', execute: (sql) => pool.query(sql).then((r) => r.rows) }) },
 *   prompt: 'How many users signed up this week?',
 * });
 * ```
 *
 * - {@link sqlTool} builds a ready `sql` tool around your `execute(sql)`.
 * - {@link guardSqlTool} guards a tool you already have: its input's `sql` field is
 *   checked before its `execute` runs.
 *
 * Every call is checked with `Vericto.enforce`, before anything runs:
 *
 * - `BLOCKED`: the tool returns a {@link VerictoRefusal} to the model (rule code,
 *   severity, reason, `suggested_fix`) and never runs the SQL. With `onBlock:
 *   'raise'` it throws `VerictoBlockedError` instead.
 * - `FLAGGED` / `MONITORED`: the query runs; the guard logs the verdict and calls its
 *   `onVerdict`. `sqlTool` also reports it to the model next to the result.
 * - an approved query (masked columns and/or a LIMIT bound, `approved_query` in the
 *   MCP contract): that query runs instead of the model's, never the original.
 * - no verdict: the guard's fail mode applies. `closed` (default) throws
 *   `VerictoUnavailableError` and nothing runs; `open` runs the query unevaluated.
 *   A configuration error throws in both modes. The AI SDK hands a thrown tool error
 *   to the model as a `tool-error` part: use {@link throwOnVerictoError} on the
 *   result so that your code sees it too.
 *
 * Requires the optional peer `ai` (version 7).
 */
import { jsonSchema, tool, type Tool, type ToolExecuteFunction, type ToolExecutionOptions } from 'ai';

import {
  AgentToolGuard,
  isVerictoRefusal,
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

/** The options of {@link guardSqlTool}. `context` / `endUser` functions get the tool input and the call options. */
export interface GuardSqlToolOptions<INPUT = unknown, CONTEXT = unknown>
  extends AgentToolGuardOptions<[input: INPUT, options: ToolExecutionOptions<CONTEXT>]> {
  /** The input field that holds the SQL text. Default `sql`. */
  sqlKey?: string;
}

/** A tool with an `execute` function (it may stream its output). */
type ExecutableToolOf<INPUT, OUTPUT, CONTEXT> = Tool<INPUT, OUTPUT, CONTEXT> & {
  execute: ToolExecuteFunction<INPUT, OUTPUT, CONTEXT>;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A tool whose `execute` resolves its output: what the functions of this module return. */
export type GuardedTool<INPUT, OUTPUT, CONTEXT = unknown> = DistributiveOmit<Tool<INPUT, OUTPUT, CONTEXT>, 'execute'> & {
  execute: (input: INPUT, options: ToolExecutionOptions<CONTEXT>) => Promise<OUTPUT>;
};

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

async function finalOutput<OUTPUT>(result: AsyncIterable<OUTPUT> | PromiseLike<OUTPUT> | OUTPUT): Promise<OUTPUT> {
  if (!isAsyncIterable(result)) return await result;
  // A streaming tool: its last value is its output (the preliminary ones are not streamed through).
  let last: OUTPUT | undefined;
  for await (const value of result) last = value;
  return last as OUTPUT;
}

/**
 * Guard an AI SDK tool that runs SQL: before its `execute` runs, Vericto checks the
 * SQL text at `input[sqlKey]` (default `sql`). Blocked: the tool returns a
 * {@link VerictoRefusal} and `execute` is not called. Approved query: `execute` gets
 * the input with the approved query in place of the model's. The other input fields
 * (bind parameters, for example) are passed as they are.
 *
 * The result is a copy: the original tool is not changed. Its `toModelOutput`, if
 * any, is not called for a refusal (the model gets the refusal as JSON). If the tool
 * declares an `outputSchema`, widen it to accept the refusal.
 */
export function guardSqlTool<INPUT, OUTPUT, CONTEXT>(
  sqlTool: ExecutableToolOf<INPUT, OUTPUT, CONTEXT>,
  options: GuardSqlToolOptions<INPUT, CONTEXT>,
): GuardedTool<INPUT, OUTPUT | VerictoRefusal, CONTEXT> {
  const guard = new AgentToolGuard<[INPUT, ToolExecutionOptions<CONTEXT>]>(options);
  const key = options.sqlKey ?? 'sql';
  const { execute, toModelOutput } = sqlTool as ExecutableToolOf<INPUT, OUTPUT, CONTEXT> & {
    execute: unknown;
    toModelOutput?: (options: { toolCallId: string; input: INPUT; output: OUTPUT }) => unknown;
  };
  if (typeof execute !== 'function') {
    throw new VerictoError('guardSqlTool needs a tool with an execute function.');
  }
  const run = execute as ToolExecuteFunction<INPUT, OUTPUT, CONTEXT>;
  const guarded = {
    ...sqlTool,
    execute: async (input: INPUT, callOptions: ToolExecutionOptions<CONTEXT>): Promise<OUTPUT | VerictoRefusal> => {
      const outcome = await guard.check(sqlOf(input, key), input, callOptions);
      if (!outcome.run) return outcome.refusal;
      return finalOutput(run(withSql(input, key, outcome.sql), callOptions));
    },
    ...(toModelOutput
      ? {
          toModelOutput: (args: { toolCallId: string; input: INPUT; output: OUTPUT | VerictoRefusal }) =>
            isVerictoRefusal(args.output)
              ? { type: 'json' as const, value: { ...args.output } }
              : toModelOutput({ ...args, output: args.output }),
        }
      : {}),
  };
  return guarded as unknown as GuardedTool<INPUT, OUTPUT | VerictoRefusal, CONTEXT>;
}

/** The input of a {@link sqlTool}: one SQL statement. */
export interface SqlToolInput {
  sql: string;
}

/** What a {@link sqlTool} returns when the query ran: your `execute`'s result and how Vericto let it run. */
export interface SqlToolResult<RESULT> {
  /** What your `execute` returned (the rows, typically). */
  result: RESULT;
  /** The verdict that let the query run, and the approved query if that ran instead. */
  vericto: VerictoReport;
}

/** The options of {@link sqlTool}. */
export interface SqlToolOptions<RESULT, CONTEXT = unknown>
  extends AgentToolGuardOptions<[input: SqlToolInput, options: ToolExecutionOptions<CONTEXT>]> {
  /** Run the SQL Vericto approved: the model's query, or the approved query that replaces it. */
  execute: (sql: string, options: ToolExecutionOptions<CONTEXT>) => PromiseLike<RESULT> | RESULT;
  /** What the model reads about the tool. Default: what it does and how blocks are answered. */
  description?: string;
}

const SQL_INPUT_SCHEMA = jsonSchema<SqlToolInput>({
  type: 'object',
  properties: { sql: { type: 'string', description: 'One SQL statement.' } },
  required: ['sql'],
  additionalProperties: false,
});

/**
 * A ready SQL tool: the model sends `{ sql }`, Vericto checks it, and your `execute`
 * runs the approved SQL. The model gets `{ result, vericto }` (the verdict, and the
 * approved query when that ran instead), or a {@link VerictoRefusal}.
 */
export function sqlTool<RESULT, CONTEXT = unknown>(
  options: SqlToolOptions<RESULT, CONTEXT>,
): GuardedTool<SqlToolInput, SqlToolResult<RESULT> | VerictoRefusal, CONTEXT> {
  const guard = new AgentToolGuard<[SqlToolInput, ToolExecutionOptions<CONTEXT>]>(options);
  const run = (options as Partial<SqlToolOptions<RESULT, CONTEXT>>).execute;
  if (typeof run !== 'function') throw new VerictoError('sqlTool needs { execute(sql) }.');
  return tool<SqlToolInput, SqlToolResult<RESULT> | VerictoRefusal, Record<string, unknown>>({
    description: options.description ?? sqlToolDescription(guard.dialect),
    inputSchema: SQL_INPUT_SCHEMA,
    execute: async (input, callOptions) => {
      const call = callOptions as unknown as ToolExecutionOptions<CONTEXT>;
      const outcome = await guard.check(sqlOf(input, 'sql'), input, call);
      if (!outcome.run) return outcome.refusal;
      return { result: await run(outcome.sql, call), vericto: reportOf(outcome.verdict) };
    },
  }) as unknown as GuardedTool<SqlToolInput, SqlToolResult<RESULT> | VerictoRefusal, CONTEXT>;
}

/** The part of a `generateText` / `streamText` result {@link throwOnVerictoError} reads. */
export interface StepsResult {
  readonly steps: readonly { readonly content: readonly { readonly type: string; readonly error?: unknown }[] }[];
}

/**
 * Throw the first Vericto error (`VerictoUnavailableError`, `VerictoConfigError`,
 * `VerictoBlockedError` under `onBlock: 'raise'`) a tool threw during the run. The AI
 * SDK hands a thrown tool error to the model as a `tool-error` part instead of
 * rejecting; the SQL did not run either way, and this lets your code see it.
 */
export function throwOnVerictoError(result: StepsResult): void {
  for (const step of result.steps) {
    for (const part of step.content) {
      if (part.type === 'tool-error' && part.error instanceof VerictoError) throw part.error;
    }
  }
}
