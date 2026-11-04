// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

import type { EvaluationOptions } from './policy-context.js';
import type { Verdict } from './verdict.js';

/**
 * Turns `(sql, dialect)` into a verdict.
 *
 * Two implementations ship: `RuntimeApiEvaluator` asks the Vericto Runtime API, and
 * `OfflineEvaluator` asks a local `vericto serve --stdio` process (the Vericto CLI,
 * a separate program) with the engine's standard rules. The wrappers work with
 * either, unchanged.
 *
 * Implementations resolve a verdict for every evaluated statement (`BLOCKED`
 * included: blocking is the guard's job), reject with `VerictoUnavailableError` when
 * no verdict can be produced, and with `VerictoConfigError` when the request can
 * never succeed.
 *
 * The guard passes `options` (`context`, `endUser`) when the caller gives them; an
 * evaluator that declares only `(sql, dialect)` still type-checks but ignores them.
 */
export interface Evaluator {
  evaluate(sql: string, dialect: string, options?: EvaluationOptions): Promise<Verdict>;
  /** The dialects this evaluator handles, or `undefined` when it cannot tell. */
  supportedDialects(): Promise<readonly string[] | undefined>;
  /** Shown in error messages. */
  readonly apiUrl?: string;
  /** Release what the evaluator holds (the offline child process). Called by `Vericto.close()`. */
  close?(): Promise<void>;
}
