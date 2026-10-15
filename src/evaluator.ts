import type { Verdict } from './verdict.js';

/**
 * Turns `(sql, dialect)` into a verdict.
 *
 * This release ships one implementation, `RuntimeApiEvaluator`, which asks the Vericto
 * Runtime API. An embedded evaluator (the engine in-process, for example as WASM or a
 * native addon with synced rules) can be added later behind the same interface
 * without touching the wrappers.
 *
 * Implementations resolve a verdict for every evaluated statement (`BLOCKED`
 * included: blocking is the guard's job), reject with `VerictoUnavailableError` when
 * no verdict can be produced, and with `VerictoConfigError` when the request can
 * never succeed.
 */
export interface Evaluator {
  evaluate(sql: string, dialect: string): Promise<Verdict>;
  /** The dialects this evaluator handles, or `undefined` when it cannot tell. */
  supportedDialects(): Promise<readonly string[] | undefined>;
  /** Shown in error messages. */
  readonly apiUrl?: string;
}
