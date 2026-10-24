// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

import { defaultEnv, readEnv, type Env } from './env.js';
import {
  VerictoConfigError,
  VerictoQuotaExceededError,
  VerictoUnavailableError,
  VerictoUnsupportedDialectError,
} from './errors.js';
import type { Evaluator } from './evaluator.js';
import { verdictFromResponse, type Verdict } from './verdict.js';
import { VERSION } from './version.js';

/** The Vericto API used when neither `apiUrl` nor `VERICTO_API_URL` is set. */
export const DEFAULT_API_URL = 'https://api.vericto.com';
/** The Runtime API endpoint every evaluation is sent to. */
export const EVALUATE_PATH = '/api/v1/proxy/query';
/** Where the server lists the dialects it evaluates. */
export const CONFIG_PATH = '/api/v1/meta/config';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRYABLE = new Set([500, 502, 503, 504]);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MAX_BACKOFF_MS = 2000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RuntimeApiOptions {
  /** API key (`vtro_...`, scope `proxy:evaluate`). Default: `VERICTO_API_KEY`. */
  apiKey?: string;
  /** The registered database (UUID). Default: `VERICTO_DATABASE_ID`. */
  databaseId?: string;
  /** API base URL. Default: `VERICTO_API_URL`, then `https://api.vericto.com`. */
  apiUrl?: string;
  /** Per-attempt timeout in milliseconds. Default: `VERICTO_TIMEOUT` (seconds) or 5000. */
  timeoutMs?: number;
  /** Retries after the first attempt for network errors, timeouts, 5xx and 429 rate limits. Default 2. */
  maxRetries?: number;
  /** Base backoff in milliseconds (exponential, with jitter, capped at 2 s). Default 200. */
  backoffMs?: number;
  /** How long the server's dialect list is cached, in milliseconds. Default 10 minutes. */
  dialectsTtlMs?: number;
  /** A `fetch` implementation (tests, proxies). Default: the global `fetch`. */
  fetch?: FetchLike;
  /**
   * Environment to read the defaults from. Default: `process.env`. An empty or
   * whitespace-only variable counts as unset.
   */
  env?: Env;
}

/**
 * Evaluates statements with the Vericto Runtime API (`POST /api/v1/proxy/query`).
 *
 * The key is sent in the `X-API-Key` header, over HTTPS only (plain HTTP is accepted
 * for localhost alone), and never appears in messages or `toString()`. To trust an
 * extra CA, use Node's `NODE_EXTRA_CA_CERTS`.
 */
export class RuntimeApiEvaluator implements Evaluator {
  /** The API base URL, without a trailing slash. */
  readonly apiUrl: string;
  /** The registered database (lower-case UUID) every evaluation names. */
  readonly databaseId: string;
  /** Per-attempt timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Retries after the first attempt. */
  readonly maxRetries: number;
  readonly #apiKey: string;
  readonly #backoffMs: number;
  readonly #dialectsTtlMs: number;
  readonly #fetch: FetchLike;
  #dialects: readonly string[] | undefined;
  #dialectsAt = 0;
  #dialectsPending: Promise<readonly string[] | undefined> | undefined;

  constructor(options: RuntimeApiOptions = {}) {
    const env = defaultEnv(options.env);
    const key = (options.apiKey ?? readEnv(env, 'VERICTO_API_KEY') ?? '').trim();
    if (!key) {
      throw new VerictoConfigError(
        'No Vericto API key: pass apiKey or set VERICTO_API_KEY (a vtro_... key with the proxy:evaluate scope).',
      );
    }
    if (!key.startsWith('vtro_')) {
      throw new VerictoConfigError("The Vericto API key must start with 'vtro_' (the value itself is not shown).");
    }
    this.#apiKey = key;

    const db = (options.databaseId ?? readEnv(env, 'VERICTO_DATABASE_ID') ?? '').trim();
    if (!db) {
      throw new VerictoConfigError(
        'No Vericto database id: pass databaseId or set VERICTO_DATABASE_ID ' +
          '(the id of the database registered in your Vericto workspace).',
      );
    }
    if (!UUID_RE.test(db)) {
      throw new VerictoConfigError(`The Vericto database id must be a UUID, got ${JSON.stringify(db.slice(0, 64))}.`);
    }
    this.databaseId = db.toLowerCase();

    const rawUrl = options.apiUrl ?? readEnv(env, 'VERICTO_API_URL') ?? '';
    const url = (rawUrl.trim() || DEFAULT_API_URL).replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new VerictoConfigError(`Invalid Vericto API URL ${JSON.stringify(url)}: expected https://host.`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new VerictoConfigError(`Invalid Vericto API URL ${JSON.stringify(url)}: expected https://host.`);
    }
    if (parsed.protocol === 'http:' && !LOCAL_HOSTS.has(parsed.hostname)) {
      throw new VerictoConfigError(`Refusing to send the API key over plain HTTP to ${parsed.hostname}: use https://.`);
    }
    this.apiUrl = url;

    let timeoutMs = options.timeoutMs;
    if (timeoutMs === undefined) {
      const fromEnv = readEnv(env, 'VERICTO_TIMEOUT');
      timeoutMs = fromEnv !== undefined ? Number(fromEnv) * 1000 : 5000;
      if (!Number.isFinite(timeoutMs)) {
        throw new VerictoConfigError(`VERICTO_TIMEOUT must be a number of seconds, got ${JSON.stringify(fromEnv)}.`);
      }
    }
    if (!(timeoutMs > 0)) throw new VerictoConfigError('timeoutMs must be greater than 0.');
    const maxRetries = options.maxRetries ?? 2;
    if (!(maxRetries >= 0)) throw new VerictoConfigError('maxRetries cannot be negative.');
    this.timeoutMs = timeoutMs;
    this.maxRetries = Math.floor(maxRetries);
    this.#backoffMs = Math.max(0, options.backoffMs ?? 200);
    this.#dialectsTtlMs = options.dialectsTtlMs ?? 600_000;
    // Typed as optional: Node < 18 has no global fetch.
    const f = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) throw new VerictoConfigError('No fetch implementation: Node 18+ is required, or pass options.fetch.');
    this.#fetch = f;
  }

  /** A description without the key. */
  toString(): string {
    return `RuntimeApiEvaluator(apiUrl=${this.apiUrl}, databaseId=${this.databaseId})`;
  }

  /** `JSON.stringify` shows the URL and database id, never the key. */
  toJSON(): Record<string, unknown> {
    return { apiUrl: this.apiUrl, databaseId: this.databaseId };
  }

  /**
   * Evaluate one statement. Resolves the verdict (`BLOCKED` included). Rejects with
   * `VerictoUnavailableError` when no verdict came back after the retries (network
   * error, timeout, 5xx, 429 rate limit; `VerictoQuotaExceededError` at once for the
   * monthly quota) and with `VerictoConfigError` for 400, 401, 403 and other 4xx.
   * Each attempt, response body included, is bounded by `timeoutMs`.
   */
  async evaluate(sql: string, dialect: string): Promise<Verdict> {
    const payload = JSON.stringify({ query: sql, database_id: this.databaseId, dialect });
    let lastError = 'no attempt made';
    let retryAfterMs: number | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(this.#delay(attempt, retryAfterMs));
      retryAfterMs = undefined;

      let response: ApiResponse;
      try {
        response = await this.#request(EVALUATE_PATH, {
          method: 'POST',
          headers: { ...this.#headers(), 'Content-Type': 'application/json', 'X-API-Key': this.#apiKey },
          body: payload,
        });
      } catch (err) {
        lastError = `${errorName(err)} while calling ${this.apiUrl}`;
        continue;
      }

      const { status, body } = response;
      if (status === 200 || (status === 403 && (typeof body.decision === 'string' ? body.decision : '').toUpperCase() === 'BLOCKED')) {
        if (!('decision' in body)) {
          lastError = `HTTP ${status} without a decision from ${this.apiUrl}`;
          continue;
        }
        return verdictFromResponse(body, sql, dialect);
      }

      const error = body.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>) : {};
      const code = typeof error.code === 'string' && error.code ? error.code : undefined;
      const message = typeof error.message === 'string' && error.message ? error.message : undefined;

      if (status === 429 && code === 'QUOTA_EXCEEDED') {
        const resetsAt = typeof error.resets_at === 'string' ? error.resets_at : undefined;
        throw new VerictoQuotaExceededError(
          `The Vericto workspace has used its monthly query quota${resetsAt ? `; it resets at ${resetsAt}` : ''}.`,
          { resetsAt, upgradeUrl: typeof error.upgrade_url === 'string' ? error.upgrade_url : undefined },
        );
      }
      if (status === 429 || RETRYABLE.has(status)) {
        lastError = `HTTP ${status}${code ? ` ${code}` : ''} from ${this.apiUrl}`;
        retryAfterMs = retryAfter(response.headers.get('retry-after'), error.retry_after_seconds);
        continue;
      }
      throw await this.#configError(status, code, message, dialect);
    }
    throw new VerictoUnavailableError(
      `Vericto did not return a verdict after ${this.maxRetries + 1} attempt(s): ${lastError}.`,
    );
  }

  /**
   * The dialects the server evaluates (`GET /api/v1/meta/config`), cached. `undefined`
   * when the server cannot be asked; the evaluation request then decides.
   */
  async supportedDialects(): Promise<readonly string[] | undefined> {
    if (this.#dialects && Date.now() - this.#dialectsAt < this.#dialectsTtlMs) return this.#dialects;
    this.#dialectsPending ??= this.#fetchDialects().finally(() => {
      this.#dialectsPending = undefined;
    });
    return this.#dialectsPending;
  }

  async #fetchDialects(): Promise<readonly string[] | undefined> {
    try {
      const response = await this.#request(CONFIG_PATH, { method: 'GET', headers: this.#headers() });
      if (response.status !== 200) return this.#dialects;
      const listed = response.body.dialects;
      if (!Array.isArray(listed)) return this.#dialects;
      const ids = listed
        .map((d: unknown) => (d && typeof d === 'object' ? (d as Record<string, unknown>).id : undefined))
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      this.#dialects = ids;
      this.#dialectsAt = Date.now();
      return ids;
    } catch {
      return this.#dialects;
    }
  }

  #headers(): Record<string, string> {
    return { Accept: 'application/json', 'User-Agent': `vericto-node/${VERSION}` };
  }

  /**
   * One HTTP attempt, response body included. The timeout covers the whole exchange:
   * a server that sends its headers and then stalls the body is a timeout too, not a
   * request that never settles.
   */
  async #request(path: string, init: RequestInit): Promise<ApiResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.timeoutMs);
    try {
      const response = await this.#fetch(this.apiUrl + path, { ...init, redirect: 'manual', signal: controller.signal });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: parseJsonObject(text) };
    } finally {
      clearTimeout(timer);
    }
  }

  #delay(attempt: number, retryAfterMs: number | undefined): number {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, MAX_BACKOFF_MS);
    const base = this.#backoffMs * 2 ** (attempt - 1);
    return Math.min(MAX_BACKOFF_MS, base * (0.5 + Math.random() / 2));
  }

  async #configError(
    status: number,
    code: string | undefined,
    message: string | undefined,
    dialect: string,
  ): Promise<VerictoConfigError> {
    if (status === 401) {
      return new VerictoConfigError('Vericto rejected the API key (HTTP 401). Check VERICTO_API_KEY.', {
        status,
        code,
      });
    }
    if (status === 403) {
      return new VerictoConfigError(
        `Vericto refused the request (HTTP 403${code ? `, ${code}` : ''}): ` +
          `${message ?? 'the key lacks the proxy:evaluate scope or this database'}.`,
        { status, code },
      );
    }
    if (status === 400) {
      const supported = await this.supportedDialects();
      if (supported && !supported.includes(dialect)) {
        return new VerictoUnsupportedDialectError(dialect, supported, this.apiUrl);
      }
    }
    return new VerictoConfigError(
      `Vericto rejected the request (HTTP ${status}${code ? `, ${code}` : ''})${message ? `: ${message}` : '.'}`,
      { status, code },
    );
  }
}

interface ApiResponse {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function retryAfter(header: string | null, bodyValue: unknown): number | undefined {
  for (const value of [header, bodyValue]) {
    if (value === null || value === undefined || value === '') continue;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  }
  return undefined;
}

function errorName(err: unknown): string {
  if (err instanceof Error) return err.name === 'AbortError' ? 'Timeout' : err.name;
  return 'Error';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
