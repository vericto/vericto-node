// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vericto for the OpenAI Agents SDK for JavaScript (`@openai/agents`): database
 * guardrails on the SQL tools an agent calls.
 *
 * ```ts
 * import { Agent, run } from '@openai/agents';
 * import { sqlTool } from '@vericto/sdk/openai-agents';
 *
 * const agent = new Agent({
 *   name: 'SQL agent',
 *   tools: [sqlTool({ dialect: 'postgres', execute: (sql) => pool.query(sql).then((r) => r.rows) })],
 * });
 * ```
 *
 * - {@link sqlTool} builds a `run_sql` function tool around your `execute(sql)`, with
 *   the full contract: a block becomes a {@link VerictoRefusal} for the model, an
 *   approved query (masked columns and/or a LIMIT bound) runs instead of the model's.
 * - {@link verictoToolInputGuardrail} is a native tool input guardrail for a function
 *   tool you already have (`tool({ ..., inputGuardrails: [...] })`). A block is
 *   answered with the refusal (`rejectContent`) and the tool does not run. A guardrail
 *   cannot change the tool's input, so a query with an approved query is rejected
 *   too, with the approved query for the model to run instead (as MCP `check_sql`
 *   does); the approved query itself is let through. Use `sqlTool` to run approved
 *   queries without that round trip.
 *
 * Both check with `Vericto.enforce`: when Vericto cannot answer, the guard's fail
 * mode applies. `closed` (default) rejects the run with `VerictoUnavailableError`
 * (wrapped by the runner in a `ToolCallError`: `verictoErrorOf(err)` finds it) and
 * nothing runs (`sqlTool` lets Vericto errors through its `errorFunction`, so
 * they are never turned into text for the model); `open` runs the query unevaluated.
 * A configuration error rejects in both modes. `FLAGGED` / `MONITORED` queries run;
 * the guard logs the verdict and calls its `onVerdict`.
 *
 * Requires the optional peer `@openai/agents`.
 */
import {
  tool,
  ToolGuardrailFunctionOutputFactory,
  type FunctionTool,
  type RunContext,
  type ToolInputGuardrailData,
  type ToolInputGuardrailDefinition,
} from '@openai/agents';

import {
  AgentToolGuard,
  reportOf,
  sqlOf,
  sqlToolDescription,
  type AgentToolGuardOptions,
  type VerictoRefusal,
  type VerictoReport,
} from './agent-tool.js';
import { VerictoError } from './errors.js';
import { isMasked, sqlToExecute } from './verdict.js';

/** The `details` a function tool's `execute` gets (the tool call, an abort signal). */
export type ToolCallDetails = Parameters<FunctionTool['invoke']>[2];

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

/** The input of a {@link sqlTool}: one SQL statement. */
export interface SqlToolInput {
  sql: string;
}

/** What a {@link sqlTool} returns when the query ran: your `execute`'s result and how Vericto let it run. */
export interface SqlToolResult<RESULT> {
  result: RESULT;
  vericto: VerictoReport;
}

/** The options of {@link sqlTool}. `context` / `endUser` functions get the input and the run context. */
export interface SqlToolOptions<RESULT, TContext = unknown>
  extends AgentToolGuardOptions<[input: SqlToolInput, runContext: RunContext<TContext> | undefined]> {
  /** Run the SQL Vericto approved: the model's query, or the approved query that replaces it. */
  execute: (sql: string, runContext: RunContext<TContext> | undefined, details: ToolCallDetails | undefined) => PromiseLike<RESULT> | RESULT;
  /** The tool name the model sees. Default `run_sql`. */
  name?: string;
  /** What the model reads about the tool. Default: what it does and how blocks are answered. */
  description?: string;
  /**
   * What the model gets when `execute` throws. Vericto errors (`VerictoUnavailableError`,
   * `VerictoConfigError`, `VerictoBlockedError` under `onBlock: 'raise'`) are never
   * passed to it: they reject the run. Default: the SDK's generic error text.
   */
  errorFunction?: (runContext: RunContext<TContext>, error: unknown) => string | Promise<string>;
}

const SQL_PARAMETERS = {
  type: 'object' as const,
  properties: { sql: { type: 'string', description: 'One SQL statement.' } },
  required: ['sql'],
  additionalProperties: false as const,
};

/**
 * A `run_sql` function tool: the model sends `{ sql }`, Vericto checks it, and your
 * `execute` runs the approved SQL. The model gets `{ result, vericto }` (the verdict,
 * and the approved query when that ran instead), or a {@link VerictoRefusal}.
 */
export function sqlTool<RESULT, TContext = unknown>(
  options: SqlToolOptions<RESULT, TContext>,
): FunctionTool<TContext, typeof SQL_PARAMETERS, SqlToolResult<RESULT> | VerictoRefusal> {
  const guard = new AgentToolGuard<[SqlToolInput, RunContext<TContext> | undefined]>(options);
  const run = (options as Partial<SqlToolOptions<RESULT, TContext>>).execute;
  if (typeof run !== 'function') throw new VerictoError('sqlTool needs { execute(sql) }.');
  const onError = options.errorFunction;
  return tool<typeof SQL_PARAMETERS, TContext, SqlToolResult<RESULT> | VerictoRefusal>({
    name: options.name ?? 'run_sql',
    description: options.description ?? sqlToolDescription(guard.dialect),
    parameters: SQL_PARAMETERS,
    strict: true,
    execute: async (input, runContext, details) => {
      const sql = sqlOf(input, 'sql');
      const outcome = await guard.check(sql, { sql }, runContext);
      if (!outcome.run) return outcome.refusal;
      return { result: await run(outcome.sql, runContext, details), vericto: reportOf(outcome.verdict) };
    },
    errorFunction: async (runContext, error) => {
      // Never as text for the model: "Vericto unavailable" must reach your code.
      if (error instanceof VerictoError) throw error;
      return onError ? onError(runContext, error) : 'An error occurred while running the tool. Please try again.';
    },
  });
}

/** The options of {@link verictoToolInputGuardrail}. `context` / `endUser` functions get the parsed arguments and the guardrail data. */
export interface VerictoToolInputGuardrailOptions<TContext = unknown>
  extends AgentToolGuardOptions<[args: Record<string, unknown>, data: ToolInputGuardrailData<TContext>]> {
  /** The argument that holds the SQL text. Default `sql`. */
  sqlKey?: string;
  /** The guardrail's name (traces, `toolInputGuardrailResults`). Default `vericto`. */
  name?: string;
}

/** Whitespace-insensitive equality: the approved query, sent back as it was approved. */
function sameSql(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/**
 * A tool input guardrail that checks the SQL argument of a function tool before the
 * tool runs. Allowed, flagged or monitored: `allow`. Blocked: `rejectContent` with the
 * {@link VerictoRefusal} as JSON, and the tool does not run (`onBlock: 'raise'`
 * rejects the run with `VerictoBlockedError`). An approved query: `rejectContent` with
 * `approved_query` for the model to run instead; the approved query is then allowed.
 * Arguments that are not JSON are allowed: the tool cannot parse them either, and the
 * SDK answers the model.
 */
export function verictoToolInputGuardrail<TContext = unknown>(
  options: VerictoToolInputGuardrailOptions<TContext>,
): ToolInputGuardrailDefinition<TContext> {
  const guard = new AgentToolGuard<[Record<string, unknown>, ToolInputGuardrailData<TContext>]>(options);
  const key = options.sqlKey ?? 'sql';
  return {
    type: 'tool_input',
    name: options.name ?? 'vericto',
    run: async (data) => {
      let args: unknown;
      try {
        args = JSON.parse(data.toolCall.arguments);
      } catch {
        return ToolGuardrailFunctionOutputFactory.allow({ vericto: 'arguments are not JSON; the tool does not run' });
      }
      const sql = sqlOf(args, key);
      const outcome = await guard.check(sql, args as Record<string, unknown>, data);
      if (!outcome.run) return ToolGuardrailFunctionOutputFactory.rejectContent(JSON.stringify(outcome.refusal), outcome.refusal);
      const { verdict } = outcome;
      const report = reportOf(verdict);
      if (isMasked(verdict) && !sameSql(sqlToExecute(verdict), sql)) {
        const answer = {
          ...report,
          executed: false,
          message:
            'Vericto approved a rewritten version of this query (masked columns and/or a row limit); the original was ' +
            `NOT executed. Run only this approved query instead: ${sqlToExecute(verdict)}`,
        };
        return ToolGuardrailFunctionOutputFactory.rejectContent(JSON.stringify(answer), answer);
      }
      return ToolGuardrailFunctionOutputFactory.allow(report);
    },
  };
}
