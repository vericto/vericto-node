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
import { RuntimeApiEvaluator, type RuntimeApiOptions } from './runtime-api.js';
import { isMasked, sqlToExecute, unevaluatedVerdict, type Verdict } from './verdict.js';

export type FailMode = 'closed' | 'open';

/** Where the guard reports. The SQL text is never passed to it. */
export interface VerictoLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface VerictoOptions extends RuntimeApiOptions {
  /** What evaluates statements. Default: a `RuntimeApiEvaluator` from the options above. */
  evaluator?: Evaluator;
  /**
   * `closed` (default, or `VERICTO_FAIL_MODE`): when Vericto cannot answer, reject with
   * `VerictoUnavailableError` and do not run the statement. `open`: run it unevaluated,
   * emit a process warning (`VerictoFailOpenWarning`) and log it.
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
  info: () => {},
  warn: (m) => { console.warn(m); },
  error: (m) => { console.error(m); },
};
const SILENT: VerictoLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Checks SQL with Vericto before it runs. Share one instance per process; the
 * wrappers call `enforce` for every statement, and you can call it yourself around
 * any other driver.
 */
export class Vericto {
  readonly evaluator: Evaluator;
  readonly failMode: FailMode;
  readonly onVerdict: ((verdict: Verdict) => void) | undefined;
  readonly #logger: VerictoLogger;
  readonly #cache: VerdictCache | undefined;

  constructor(options: VerictoOptions = {}) {
    this.evaluator = options.evaluator ?? new RuntimeApiEvaluator(options);
    // An empty or whitespace-only VERICTO_FAIL_MODE is unset: the default, closed.
    const fromEnv = readEnv(defaultEnv(options.env), 'VERICTO_FAIL_MODE');
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
    this.#logger = options.logger === false ? SILENT : (options.logger ?? DEFAULT_LOGGER);
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
   * Evaluate `sql` and resolve the verdict, whatever it is. Does not apply the fail
   * mode and does not reject on `BLOCKED`: use it to ask, and `enforce` to guard.
   */
  async check(sql: string, dialect: string): Promise<Verdict> {
    if (typeof sql !== 'string') {
      throw new TypeError(`vericto: expected the SQL text as a string, got ${typeof sql}.`);
    }
    const name = await this.requireDialect(dialect);
    const hit = this.#cache?.get(sql, name);
    if (hit) return hit;
    const verdict = await this.evaluator.evaluate(sql, name);
    this.#cache?.put(verdict);
    return verdict;
  }

  /**
   * Evaluate `sql` and apply the decision: reject with `VerictoBlockedError` on
   * `BLOCKED`; log `FLAGGED`/`MONITORED`/allowed `PARSE_ERROR`; apply the fail mode
   * when Vericto cannot answer. Run `sqlToExecute(verdict)` (the masked rewrite, if any).
   */
  async enforce(sql: string, dialect: string): Promise<Verdict> {
    let verdict: Verdict;
    try {
      verdict = await this.check(sql, dialect);
    } catch (err) {
      if (!(err instanceof VerictoUnavailableError)) throw err;
      if (this.failMode === 'closed') {
        this.#logger.error(`vericto: no verdict, statement not executed (failMode=closed): ${err.message}`);
        throw err;
      }
      verdict = unevaluatedVerdict(sql, normalizeDialect(dialect), err.message);
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
  async prepare(sql: string, dialect: string): Promise<string> {
    return sqlToExecute(await this.enforce(sql, dialect));
  }

  /** Enforce a batch in order; a block anywhere rejects before the caller runs any of it. */
  async enforceAll(statements: readonly string[], dialect: string): Promise<Verdict[]> {
    const out: Verdict[] = [];
    for (const statement of statements) out.push(await this.enforce(statement, dialect));
    return out;
  }

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

function emitFailOpenWarning(reason: string): void {
  if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
    process.emitWarning(`Vericto could not evaluate the statement and failMode is 'open', so it ran unchecked: ${reason}`, {
      type: 'VerictoFailOpenWarning',
      code: 'VERICTO_FAIL_OPEN',
    });
  }
}

/**
 * Small TTL + LRU cache of server verdicts, keyed by `(sql, dialect)`. Dropped whole
 * when a response reports a different `ruleset_version`.
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

  get(sql: string, dialect: string): Verdict | undefined {
    const key = `${dialect}\u0000${sql}`;
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

  put(verdict: Verdict): void {
    if (verdict.decision === 'UNEVALUATED') return;
    if (verdict.rulesetVersion && verdict.rulesetVersion !== this.#ruleset) {
      if (this.#ruleset !== undefined) this.#items.clear();
      this.#ruleset = verdict.rulesetVersion;
    }
    const key = `${verdict.dialect}\u0000${verdict.sql}`;
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
