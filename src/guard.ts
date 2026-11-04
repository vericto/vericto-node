// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

import { normalizeDialect } from './dialects.js';
import { defaultEnv, readEnv } from './env.js';
import {
  VerictoBlockedError,
  VerictoConfigError,
  VerictoUnavailableError,
  VerictoUnsupportedDialectError,
} from './errors.js';
import type { Evaluator } from './evaluator.js';
import { OfflineEvaluator, type OfflineProfile } from './offline.js';
import { policyFields, type EvaluationOptions, type PolicyFields } from './policy-context.js';
import { RuntimeApiEvaluator, type RuntimeApiOptions } from './runtime-api.js';
import { isMasked, sqlToExecute, unevaluatedVerdict, type Verdict } from './verdict.js';

export type FailMode = 'closed' | 'open';

/** Where the guard reports. The SQL text is never passed to it. */
export interface VerictoLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Offline mode: the `vericto serve` process's stderr and lifecycle. Optional. */
  debug?(message: string): void;
}

export interface VerictoOptions extends RuntimeApiOptions {
  /** What evaluates statements. Default: a `RuntimeApiEvaluator` from the options above. */
  evaluator?: Evaluator;
  /**
   * Check SQL with a local `vericto serve --stdio` process (Vericto CLI 2.1.0 or
   * later, installed separately) and the engine's standard rules: no account, no
   * network. Default: `VERICTO_OFFLINE` (`1`/`true`), else `false`. Never turned on
   * automatically. Combined with an API key or an `evaluator` it is a
   * `VerictoConfigError`: choose one.
   */
  offline?: boolean;
  /**
   * Offline only. `runtime` (default): the Runtime API's verdicts for a workspace
   * with no overrides (a `DROP TABLE` is BLOCKED). `ci`: `vericto check --offline`'s
   * (schema DDL is capped at FLAGGED).
   */
  offlineProfile?: OfflineProfile;
  /**
   * Offline only: the `vericto` binary. Default: `VERICTO_CLI`, then the
   * `@vericto/vericto-cli` package in your `node_modules`, then `vericto` on PATH.
   */
  offlineCliPath?: string;
  /**
   * `closed` (default, or `VERICTO_FAIL_MODE`): when Vericto cannot answer, reject with
   * `VerictoUnavailableError` (from `check`, `enforce` and every wrapper) and do not run
   * the statement. `open`: never reject for it; `check` resolves an `UNEVALUATED`
   * verdict with the reason, and `enforce` also lets the statement run unevaluated,
   * emits a process warning (`VerictoFailOpenWarning`) and logs it.
   */
  failMode?: FailMode;
  /** Milliseconds to reuse a verdict for the same `(sql, dialect)`. 0 (default) disables it. */
  cacheTtlMs?: number;
  /** Maximum cached verdicts. Default 1024. */
  cacheSize?: number;
  /** Called with every verdict, including `UNEVALUATED` and `BLOCKED` ones. */
  onVerdict?: (verdict: Verdict) => void;
  /** Default: `console` for warnings and errors, silent for info. `false` silences it. */
  logger?: VerictoLogger | false;
}

const DEFAULT_LOGGER: VerictoLogger = {
  debug: () => {},
  info: () => {},
  warn: (m) => { console.warn(m); },
  error: (m) => { console.error(m); },
};
const SILENT: VerictoLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

/**
 * Checks SQL with Vericto before it runs. Share one instance per process; the
 * wrappers call `enforce` for every statement, and you can call it yourself around
 * any other driver.
 *
 * Every check is a network call (or, offline, a round trip to a local process), so
 * every method that checks SQL is asynchronous; there is no synchronous variant. The
 * constructor throws `VerictoConfigError` for a missing or malformed key, database
 * id, URL, timeout or fail mode, and for offline mode combined with a key or an
 * evaluator.
 *
 * Offline (`{ offline: true }` or `VERICTO_OFFLINE=1`), the client starts one
 * `vericto serve --stdio` child process on its first check. The child does not keep
 * the event loop alive while idle, and is stopped when the process exits; call
 * `close()` (or `await using`) to stop it earlier.
 */
export class Vericto {
  /** What evaluates statements (a {@link RuntimeApiEvaluator} unless `options.evaluator`). */
  readonly evaluator: Evaluator;
  /** `closed` or `open`: what happens when Vericto cannot answer. */
  readonly failMode: FailMode;
  /** Called with every verdict (`options.onVerdict`). */
  readonly onVerdict: ((verdict: Verdict) => void) | undefined;
  readonly #logger: VerictoLogger;
  readonly #cache: VerdictCache | undefined;

  /** True when statements are checked by the local `vericto serve` process. */
  readonly offline: boolean;

  constructor(options: VerictoOptions = {}) {
    const env = defaultEnv(options.env);
    this.#logger = options.logger === false ? SILENT : (options.logger ?? DEFAULT_LOGGER);
    this.offline = offlineFlag(options.offline, env);
    if (this.offline) {
      const key = options.apiKey?.trim() ? 'apiKey' : readEnv(env, 'VERICTO_API_KEY') ? 'VERICTO_API_KEY' : undefined;
      const other = options.evaluator ? 'an evaluator' : key ? `an API key (${key})` : undefined;
      if (other) {
        throw new VerictoConfigError(
          `Offline mode and ${other} were both given: choose one. Offline checks use the engine's standard rules ` +
            'locally; the API key uses your workspace.',
          { code: 'OFFLINE_CONFLICT' },
        );
      }
      const logger = this.#logger;
      this.evaluator = new OfflineEvaluator({
        profile: options.offlineProfile,
        cliPath: options.offlineCliPath,
        timeoutMs: options.timeoutMs,
        env,
        logger: { debug: (m) => logger.debug?.(m), info: (m) => { logger.info(m); } },
      });
    } else {
      if (options.offlineProfile !== undefined || options.offlineCliPath !== undefined) {
        throw new VerictoConfigError('offlineProfile and offlineCliPath need offline: true (or VERICTO_OFFLINE=1).');
      }
      this.evaluator = options.evaluator ?? new RuntimeApiEvaluator(options);
    }
    // An empty or whitespace-only VERICTO_FAIL_MODE is unset: the default, closed.
    const fromEnv = readEnv(env, 'VERICTO_FAIL_MODE');
    const source = options.failMode === undefined && fromEnv !== undefined ? 'VERICTO_FAIL_MODE' : 'failMode';
    const mode = (options.failMode ?? fromEnv ?? 'closed').trim().toLowerCase();
    if (mode !== 'closed' && mode !== 'open') {
      throw new VerictoConfigError(`${source} must be 'closed' or 'open', got ${JSON.stringify(mode)}.`);
    }
    this.failMode = mode;
    const ttl = options.cacheTtlMs ?? 0;
    const size = options.cacheSize ?? 1024;
    if (ttl < 0 || size < 1) throw new VerictoConfigError('cacheTtlMs must be >= 0 and cacheSize >= 1.');
    this.#cache = ttl > 0 ? new VerdictCache(ttl, size) : undefined;
    this.onVerdict = options.onVerdict;
  }

  /**
   * Release what the evaluator holds: offline, stop the `vericto serve` process (the
   * checks already sent are answered first). A no-op online. Later offline checks
   * reject with `VerictoConfigError`.
   */
  async close(): Promise<void> {
    await this.evaluator.close?.();
  }

  /** `await using vericto = new Vericto({ offline: true })` closes it at the end of the scope. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Fail fast if the server reports that it does not evaluate `dialect`. Resolves the
   * normalized dialect id. When the server cannot be asked, nothing is thrown here.
   */
  async requireDialect(dialect: string): Promise<string> {
    const name = normalizeDialect(dialect);
    const supported = await this.evaluator.supportedDialects();
    if (supported && !supported.includes(name)) {
      throw new VerictoUnsupportedDialectError(name, supported, this.evaluator.apiUrl ?? 'the configured evaluator');
    }
    return name;
  }

  /**
   * Evaluate `sql` and resolve the verdict, whatever it is: use it to ask, and
   * `enforce` to guard. Does not reject on `BLOCKED` (the verdict says so).
   *
   * When Vericto cannot answer, the fail mode applies, as in `enforce`: `closed`
   * rejects with `VerictoUnavailableError`; `open` resolves an `UNEVALUATED` verdict
   * whose `message` is the reason, and logs a warning. `VerictoConfigError` rejects in
   * both modes.
   *
   * `options.context` (`{ ticket, tenant }`) and `options.endUser` (up to 16 attributes
   * of the end user your service acts for) are sent with the request, checked first
   * with the server's limits. They take effect when business policies are enabled in
   * your workspace.
   */
  async check(sql: string, dialect: string, options?: EvaluationOptions): Promise<Verdict> {
    if (typeof sql !== 'string') {
      throw new TypeError(`vericto: expected the SQL text as a string, got ${typeof sql}.`);
    }
    const fields = policyFields(options);
    try {
      return await this.#evaluate(sql, dialect, fields);
    } catch (err) {
      if (!(err instanceof VerictoUnavailableError) || this.failMode === 'closed') throw err;
      this.#logger.warn(`vericto: no verdict, check answered UNEVALUATED (failMode=open): ${err.message}`);
      return unevaluatedVerdict(sql, normalizeDialect(dialect), err.message, this.#mode());
    }
  }

  /**
   * Evaluate `sql` and apply the decision: reject with `VerictoBlockedError` on
   * `BLOCKED`; log `FLAGGED`/`MONITORED`/allowed `PARSE_ERROR`; apply the fail mode
   * when Vericto cannot answer. Run `sqlToExecute(verdict)` (the masked rewrite, if any).
   * `options` (`context`, `endUser`) are sent as in `check`.
   */
  async enforce(sql: string, dialect: string, options?: EvaluationOptions): Promise<Verdict> {
    if (typeof sql !== 'string') {
      throw new TypeError(`vericto: expected the SQL text as a string, got ${typeof sql}.`);
    }
    const fields = policyFields(options);
    let verdict: Verdict;
    try {
      verdict = await this.#evaluate(sql, dialect, fields);
    } catch (err) {
      if (!(err instanceof VerictoUnavailableError)) throw err;
      if (this.failMode === 'closed') {
        this.#logger.error(`vericto: no verdict, statement not executed (failMode=closed): ${err.message}`);
        throw err;
      }
      verdict = unevaluatedVerdict(sql, normalizeDialect(dialect), err.message, this.#mode());
      this.#logger.warn(`vericto: no verdict, statement executed unevaluated (failMode=open): ${err.message}`);
      emitFailOpenWarning(err.message);
      this.#notify(verdict);
      return verdict;
    }
    this.#notify(verdict);
    this.#log(verdict);
    if (verdict.decision === 'BLOCKED') throw new VerictoBlockedError(verdict, sql);
    return verdict;
  }

  /** `enforce`, resolving the SQL text to execute. */
  async prepare(sql: string, dialect: string, options?: EvaluationOptions): Promise<string> {
    return sqlToExecute(await this.enforce(sql, dialect, options));
  }

  /** Enforce a batch in order; a block anywhere rejects before the caller runs any of it. */
  async enforceAll(statements: readonly string[], dialect: string, options?: EvaluationOptions): Promise<Verdict[]> {
    const out: Verdict[] = [];
    for (const statement of statements) out.push(await this.enforce(statement, dialect, options));
    return out;
  }

  /** One evaluation through the cache; rejects with what the evaluator rejects with. */
  async #evaluate(sql: string, dialect: string, fields: PolicyFields): Promise<Verdict> {
    const name = await this.requireDialect(dialect);
    // A verdict depends on the declared context too: it is part of the cache key.
    const scope = fields.context || fields.end_user ? JSON.stringify([fields.context ?? null, sortKeys(fields.end_user)]) : '';
    const hit = this.#cache?.get(sql, name, scope);
    if (hit) return hit;
    const options: EvaluationOptions | undefined =
      fields.context || fields.end_user ? { context: fields.context, endUser: fields.end_user } : undefined;
    const verdict = options ? await this.evaluator.evaluate(sql, name, options) : await this.evaluator.evaluate(sql, name);
    this.#cache?.put(verdict, scope);
    return verdict;
  }

  #mode(): 'online' | 'offline' {
    return this.evaluator instanceof OfflineEvaluator ? 'offline' : 'online';
  }

  /** Drop every cached verdict (only relevant with `cacheTtlMs` > 0). */
  clearCache(): void {
    this.#cache?.clear();
  }

  #notify(verdict: Verdict): void {
    if (!this.onVerdict) return;
    try {
      this.onVerdict(verdict);
    } catch (err) {
      // A broken callback must not change the decision.
      this.#logger.error(`vericto: onVerdict callback threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #log(verdict: Verdict): void {
    // The SQL text is never logged: it can carry personal data in literals.
    const extra = `rule=${verdict.ruleCode ?? '-'} severity=${verdict.severity ?? '-'} event_id=${verdict.eventId ?? '-'}`;
    switch (verdict.decision) {
      case 'BLOCKED':
        this.#logger.warn(`vericto: statement BLOCKED ${extra}`);
        break;
      case 'FLAGGED':
        this.#logger.warn(`vericto: statement FLAGGED ${extra}`);
        break;
      case 'PARSE_ERROR':
        this.#logger.warn(`vericto: statement not parsed, allowed by workspace policy ${extra}`);
        break;
      case 'MONITORED':
        this.#logger.info(`vericto: statement MONITORED ${extra}`);
        break;
      default:
        break;
    }
    if (isMasked(verdict)) this.#logger.info(`vericto: running the masked rewrite ${extra}`);
  }
}

function offlineFlag(option: boolean | undefined, env: Record<string, string | undefined>): boolean {
  if (option !== undefined) {
    if (typeof option !== 'boolean') throw new VerictoConfigError(`offline must be true or false, got ${JSON.stringify(option)}.`);
    return option;
  }
  const raw = readEnv(env, 'VERICTO_OFFLINE')?.toLowerCase();
  if (raw === undefined || FALSE.has(raw)) return false;
  if (TRUE.has(raw)) return true;
  throw new VerictoConfigError(`VERICTO_OFFLINE must be 1/true or 0/false, got ${JSON.stringify(raw)}.`);
}

function sortKeys(attrs: Record<string, string> | undefined): [string, string][] | null {
  return attrs ? Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : null;
}

function emitFailOpenWarning(reason: string): void {
  if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
    process.emitWarning(`Vericto could not evaluate the statement and failMode is 'open', so it ran unchecked: ${reason}`, {
      type: 'VerictoFailOpenWarning',
      code: 'VERICTO_FAIL_OPEN',
    });
  }
}

/**
 * Small TTL + LRU cache of server verdicts, keyed by `(sql, dialect, scope)`, `scope`
 * being the declared `context` and `end_user`. Dropped whole when a response reports a
 * different `ruleset_version`.
 */
class VerdictCache {
  readonly #ttl: number;
  readonly #size: number;
  readonly #items = new Map<string, { at: number; verdict: Verdict }>();
  #ruleset: string | undefined;

  constructor(ttl: number, size: number) {
    this.#ttl = ttl;
    this.#size = size;
  }

  get(sql: string, dialect: string, scope: string): Verdict | undefined {
    const key = `${dialect}\u0000${scope}\u0000${sql}`;
    const item = this.#items.get(key);
    if (!item) return undefined;
    if (Date.now() - item.at > this.#ttl) {
      this.#items.delete(key);
      return undefined;
    }
    this.#items.delete(key);
    this.#items.set(key, item);
    return { ...item.verdict, cached: true };
  }

  put(verdict: Verdict, scope: string): void {
    if (verdict.decision === 'UNEVALUATED') return;
    if (verdict.rulesetVersion && verdict.rulesetVersion !== this.#ruleset) {
      if (this.#ruleset !== undefined) this.#items.clear();
      this.#ruleset = verdict.rulesetVersion;
    }
    const key = `${verdict.dialect}\u0000${scope}\u0000${verdict.sql}`;
    this.#items.delete(key);
    this.#items.set(key, { at: Date.now(), verdict });
    while (this.#items.size > this.#size) {
      const oldest = this.#items.keys().next().value;
      if (oldest === undefined) break;
      this.#items.delete(oldest);
    }
  }

  clear(): void {
    this.#items.clear();
  }
}
