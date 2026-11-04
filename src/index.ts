// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vericto: check every SQL statement with Vericto before it runs.
 *
 * - `Vericto` (the guard) applies a verdict: reject on block, run the masked
 *   rewrite, report flags, and apply the fail mode when Vericto cannot answer.
 * - `Evaluator` is how a verdict is obtained; `RuntimeApiEvaluator` asks the Vericto
 *   Runtime API, `OfflineEvaluator` a local `vericto serve` process (offline mode:
 *   `new Vericto({ offline: true })`, the Vericto CLI installed separately).
 *
 * Driver wrappers and agent-framework tools are separate entry points so that
 * importing this module never loads a driver or a framework: `@vericto/sdk/snowflake`,
 * `@vericto/sdk/better-sqlite3`, `@vericto/sdk/ai` (Vercel AI SDK),
 * `@vericto/sdk/openai-agents` (OpenAI Agents SDK), `@vericto/sdk/mastra` (Mastra) and
 * `@vericto/sdk/langchain` (LangChain.js).
 */
export { KNOWN_DIALECTS, normalizeDialect } from './dialects.js';
export {
  VerictoBlockedError,
  VerictoConfigError,
  VerictoError,
  VerictoQuotaExceededError,
  VerictoUnavailableError,
  VerictoUnsupportedDialectError,
} from './errors.js';
export type { Evaluator } from './evaluator.js';
export { Vericto, type FailMode, type VerictoLogger, type VerictoOptions } from './guard.js';
export {
  CLI_PACKAGE,
  MIN_CLI_VERSION,
  OfflineEvaluator,
  SERVE_PROTOCOL,
  type OfflineEvaluatorOptions,
  type OfflineLogger,
  type OfflineProfile,
  type ServeInfo,
} from './offline.js';
export {
  MAX_CONTEXT_VALUE,
  MAX_END_USER_KEYS,
  MAX_END_USER_VALUE,
  type EndUser,
  type EvaluationOptions,
  type PolicyContext,
} from './policy-context.js';
export {
  CONFIG_PATH,
  DEFAULT_API_URL,
  EVALUATE_PATH,
  RuntimeApiEvaluator,
  type RuntimeApiOptions,
} from './runtime-api.js';
export {
  isMasked,
  sqlToExecute,
  verdictFromResponse,
  type Decision,
  type Finding,
  type Verdict,
  type VerdictMode,
} from './verdict.js';
export { VERSION } from './version.js';
