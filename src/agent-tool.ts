// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the agent-framework adapters share (`@vericto/sdk/ai`, `/openai-agents`,
 * `/mastra`, `/langchain`): the guard of one SQL tool call and the answers a model
 * gets. Framework-free: nothing here imports a framework, so the shared chunk it
 * builds into never loads an optional peer.
 *
 * One tool call is checked with `Vericto.enforce`, so the guard's own semantics
 * apply unchanged: the fail mode (`closed` rejects with `VerictoUnavailableError`,
 * `open` runs unevaluated), the verdict cache, the logger and `onVerdict`. A block
 * becomes a {@link VerictoRefusal} for the model (or `VerictoBlockedError` with
 * `onBlock: 'raise'`); an approved query (the masked and/or LIMIT-bound rewrite,
 * `approved_query` in the MCP contract, `rewrittenQuery` here) runs instead of the
 * original.
 */
import { normalizeDialect } from './dialects.js';
import { VerictoBlockedError, VerictoConfigError, VerictoError } from './errors.js';
import { Vericto } from './guard.js';
import { policyFields, type EndUser, type PolicyContext } from './policy-context.js';
import { isMasked, sqlToExecute, type Decision, type Verdict } from './verdict.js';

/** What a blocked query does: `return` a refusal for the model (default), or `raise` `VerictoBlockedError`. */
export type OnBlock = 'return' | 'raise';

/**
 * A wrapper option: a fixed value, or a function called for every tool call with the
 * tool's input and the framework's call options (or with nothing, e.g. to read an
 * `AsyncLocalStorage` set per request).
 */
export type CallSource<T, A extends unknown[]> = T | ((...args: A) => T | undefined);

/** The options every agent-tool adapter takes. */
export interface AgentToolGuardOptions<A extends unknown[] = []> {
  /** The SQL dialect the queries are evaluated as (`postgres`, `mysql`, `sqlite`...; driver names are accepted). */
  dialect: string;
  /** The guard. Default: one built from the `VERICTO_*` environment variables. */
  vericto?: Vericto;
  /** Default `return`: the model gets a {@link VerictoRefusal}. `raise` rejects with `VerictoBlockedError`. */
  onBlock?: OnBlock;
  /** `context` (`{ ticket, tenant }`) sent with every evaluation: a value, or a function read per call. */
  context?: CallSource<PolicyContext, A>;
  /** `end_user` sent with every evaluation: a value, or a function read per call. */
  endUser?: CallSource<EndUser, A>;
}

/**
 * What the model gets instead of a result when Vericto blocks the query: nothing ran.
 * Plain JSON (no `undefined`), in the field names of the MCP `check_sql` contract.
 */
export interface VerictoRefusal {
  readonly decision: 'BLOCKED';
  /** Always `false`: the query was not executed. */
  readonly executed: false;
  /** The deciding rule, e.g. `VERICTO-001`. */
  readonly rule_code: string | null;
  readonly severity: string | null;
  /** The server's explanation, when it adds one to the rule code. */
  readonly reason: string | null;
  /** A safer statement Vericto proposes, when it has one. */
  readonly suggested_fix: string | null;
  /** What the API key's agent allowlist denied, when that is why. */
  readonly access_denied: readonly unknown[];
  /** The audit-trail event id. */
  readonly event_id: string | null;
  /** The same, as instructions for the model: what was blocked, why, and what to do next. */
  readonly message: string;
}

/** True for the {@link VerictoRefusal} a guarded tool returns when Vericto blocks the query. */
export function isVerictoRefusal(value: unknown): value is VerictoRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.decision === 'BLOCKED' && v.executed === false && typeof v.message === 'string';
}

/**
 * The Vericto error behind an error a framework reports, if that is what it is.
 * Frameworks wrap what a tool throws (`ToolCallError.error` in the OpenAI Agents SDK,
 * `error.cause` in Mastra): this follows `error` and `cause` to the
 * `VerictoUnavailableError` (fail closed), `VerictoConfigError`, or
 * `VerictoBlockedError` (`onBlock: 'raise'`) a guarded tool threw. Nothing ran.
 */
export function verictoErrorOf(error: unknown): VerictoError | undefined {
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    if (current instanceof VerictoError) return current;
    if (typeof current !== 'object') return undefined;
    const next = current as { error?: unknown; cause?: unknown };
    current = next.error ?? next.cause;
  }
  return undefined;
}

/** The message a model gets for a blocked query: what was blocked, why, and the fix. */
export function blockedMessage(verdict: Verdict): string {
  const lines = ['Vericto blocked this SQL query; it was NOT executed.'];
  const rule = verdict.ruleCode ?? 'a Vericto rule';
  lines.push(`Rule: ${rule}${verdict.severity ? ` (severity ${verdict.severity})` : ''}`);
  if (verdict.message) lines.push(`Reason: ${verdict.message}`);
  const denied = verdict.accessDenied.length ? JSON.stringify(verdict.accessDenied) : undefined;
  if (denied) lines.push(`Access denied: ${denied}`);
  if (verdict.suggestedFix) {
    lines.push(`Suggested fix: ${verdict.suggestedFix}`);
    lines.push('Use the suggested fix, or rewrite the query so that it complies with the rule, and try again.');
  } else {
    lines.push('Rewrite the query so that it complies with the rule, and try again. Do not retry the same query.');
  }
  return lines.join('\n');
}

/** The {@link VerictoRefusal} of a `BLOCKED` verdict. */
export function refusalOf(verdict: Verdict): VerictoRefusal {
  return {
    decision: 'BLOCKED',
    executed: false,
    rule_code: verdict.ruleCode ?? null,
    severity: verdict.severity ?? null,
    reason: verdict.message ?? null,
    suggested_fix: verdict.suggestedFix ?? null,
    access_denied: verdict.accessDenied,
    event_id: verdict.eventId ?? null,
    message: blockedMessage(verdict),
  };
}

/**
 * How a query ran, next to its result, in the tools this package builds (`sqlTool`).
 * `approved_query` is set when Vericto's approved query (masked columns and/or a
 * LIMIT bound) ran instead of the model's.
 */
export interface VerictoReport {
  /** `ALLOWED`, `FLAGGED`, `MONITORED`, `PARSE_ERROR` (allowed by the workspace policy) or `UNEVALUATED` (fail open). */
  readonly decision: Exclude<Decision, 'BLOCKED'>;
  readonly rule_code: string | null;
  readonly severity: string | null;
  /** The query that ran instead of the model's, when Vericto rewrote it; `null` otherwise. */
  readonly approved_query: string | null;
  /** Why there is no verdict (`UNEVALUATED`), or the parser's message (`PARSE_ERROR`). */
  readonly note: string | null;
}

/** The {@link VerictoReport} of a verdict that let the query run. */
export function reportOf(verdict: Verdict): VerictoReport {
  return {
    // Only called for a verdict that let the query run.
    decision: verdict.decision as VerictoReport['decision'],
    rule_code: verdict.ruleCode ?? null,
    severity: verdict.severity ?? null,
    approved_query: isMasked(verdict) ? sqlToExecute(verdict) : null,
    note: (verdict.decision === 'UNEVALUATED' ? verdict.message : verdict.parseError) ?? null,
  };
}

/** The outcome of one guarded tool call. */
export type GuardOutcome =
  | { readonly run: true; readonly sql: string; readonly verdict: Verdict }
  | { readonly run: false; readonly refusal: VerictoRefusal; readonly verdict: Verdict };

export function checkOnBlock(onBlock: OnBlock | undefined): OnBlock {
  // Checked at run time too: plain-JS callers get no type error.
  const value: string = onBlock ?? 'return';
  if (value !== 'return' && value !== 'raise') {
    throw new VerictoConfigError(`onBlock must be 'return' or 'raise', got ${JSON.stringify(value)}.`);
  }
  return value;
}

function resolve<T, A extends unknown[]>(source: CallSource<T, A> | undefined, args: A): T | undefined {
  return typeof source === 'function' ? (source as (...a: A) => T | undefined)(...args) : source;
}

/**
 * The guard of one SQL tool: validates the options when the tool is built, then
 * checks every call with `Vericto.enforce`. `A` is what a `context` / `endUser`
 * function receives (the tool's input and the framework's call options).
 */
export class AgentToolGuard<A extends unknown[] = []> {
  readonly vericto: Vericto;
  readonly dialect: string;
  readonly onBlock: OnBlock;
  readonly #context: CallSource<PolicyContext, A> | undefined;
  readonly #endUser: CallSource<EndUser, A> | undefined;

  constructor(options: AgentToolGuardOptions<A>) {
    // Plain-JS callers get no type error: a missing options object or dialect is a config error.
    const { dialect } = (options as Partial<AgentToolGuardOptions<A>> | undefined) ?? {};
    if (typeof dialect !== 'string' || !dialect.trim()) {
      throw new VerictoConfigError("A guarded SQL tool needs { dialect } (e.g. 'postgres', 'mysql', 'sqlite').");
    }
    this.dialect = normalizeDialect(dialect);
    this.onBlock = checkOnBlock(options.onBlock);
    this.#context = options.context;
    this.#endUser = options.endUser;
    // Fixed values are validated now; functions for every call.
    policyFields({
      context: typeof options.context === 'function' ? undefined : options.context,
      endUser: typeof options.endUser === 'function' ? undefined : options.endUser,
    });
    this.vericto = options.vericto ?? new Vericto();
  }

  /**
   * Check `sql`. Resolves `run: true` with the SQL to execute (the approved query
   * when Vericto rewrote it), or `run: false` with the refusal for the model. Rejects
   * with `VerictoBlockedError` under `onBlock: 'raise'`, and with what `enforce`
   * rejects with (`VerictoUnavailableError` under fail closed, `VerictoConfigError`).
   */
  async check(sql: string, ...args: A): Promise<GuardOutcome> {
    const options = { context: resolve(this.#context, args), endUser: resolve(this.#endUser, args) };
    try {
      const verdict = await this.vericto.enforce(sql, this.dialect, options);
      return { run: true, sql: sqlToExecute(verdict), verdict };
    } catch (err) {
      if (!(err instanceof VerictoBlockedError) || this.onBlock === 'raise') throw err;
      return { run: false, refusal: refusalOf(err.verdict), verdict: err.verdict };
    }
  }
}

/** The SQL text of a tool input: the string at `key`; anything else is a `TypeError` (nothing runs). */
export function sqlOf(input: unknown, key: string): string {
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined;
  if (typeof value !== 'string') {
    throw new TypeError(`vericto: the tool input has no SQL text at '${key}' (got ${value === null ? 'null' : typeof value}).`);
  }
  return value;
}

/** A copy of `input` whose `key` is `sql`: the tool runs exactly what Vericto approved. */
export function withSql<T>(input: T, key: string, sql: string): T {
  return { ...(input as Record<string, unknown>), [key]: sql } as T;
}

/** Default description of the SQL tools this package builds. */
export function sqlToolDescription(dialect: string): string {
  return (
    `Run one SQL query against the application database (${dialect}). Database guardrails check every query ` +
    'before it runs. If it is blocked, the result has decision BLOCKED, the rule_code and, when there is ' +
    'one, a suggested_fix: rewrite the query and try again. If approved_query is set, that query ran instead ' +
    'of yours.'
  );
}
