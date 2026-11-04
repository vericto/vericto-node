// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline mode: SQL is checked by a local `vericto serve --stdio` process (Vericto CLI
 * 2.1.0 or later), with the engine's standard rules. No account, no network.
 *
 * License boundary: this package is Apache-2.0 and the CLI and its engine are
 * AGPL-3.0-only. The SDK never links, bundles or downloads the engine: it starts the
 * CLI binary the user installed as a separate process and talks to it with JSON Lines
 * over stdin/stdout (`docs/serve-protocol.md` in vericto-cli, protocol 1).
 *
 * Node built-ins only, loaded on first use: importing `@vericto/sdk` does not load
 * `node:child_process` unless offline mode is used.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { KNOWN_DIALECTS } from './dialects.js';
import { defaultEnv, readEnv, type Env } from './env.js';
import { VerictoConfigError, VerictoUnavailableError, VerictoUnsupportedDialectError } from './errors.js';
import type { Evaluator } from './evaluator.js';
import type { EvaluationOptions } from './policy-context.js';
import { verdictFromResponse, type Verdict } from './verdict.js';

/** The `vericto serve` protocol this SDK speaks. */
export const SERVE_PROTOCOL = 1;
/** The oldest Vericto CLI with `vericto serve --stdio`. */
export const MIN_CLI_VERSION = '2.1.0';
/** The npm package that ships the Vericto CLI. */
export const CLI_PACKAGE = '@vericto/vericto-cli';

/**
 * `runtime` (default): what the Runtime API answers for a workspace with no overrides
 * (a `DROP TABLE` is BLOCKED). `ci`: what `vericto check --offline` answers, with the
 * schema DDL rules (VERICTO-010 to 019) capped at FLAGGED.
 */
export type OfflineProfile = 'runtime' | 'ci';

const INSTALL_HINT =
  `Install the Vericto CLI ${MIN_CLI_VERSION} or later (a separate program, AGPL-3.0-only; the SDK only starts it): ` +
  `npm install --save-dev ${CLI_PACKAGE}@^${MIN_CLI_VERSION}, or brew install vericto/tap/vericto, ` +
  'or set VERICTO_CLI (offlineCliPath) to the vericto binary.';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const CLOSE_GRACE_MS = 2000;
/** Responses are small (the SQL comes back as a 100-character preview at most). */
const MAX_RESPONSE_LINE = 8 * 1024 * 1024;
const MAX_STDERR_LINE = 2000;

/** Where the offline evaluator logs. The SQL text is never passed to it. */
export interface OfflineLogger {
  debug?(message: string): void;
  info?(message: string): void;
}

export interface OfflineEvaluatorOptions {
  /** Default `runtime`; see {@link OfflineProfile}. */
  profile?: OfflineProfile;
  /** The `vericto` binary. Default: `VERICTO_CLI`, then `@vericto/vericto-cli` in node_modules, then `vericto` on PATH. */
  cliPath?: string;
  /**
   * Per-check timeout in milliseconds. Default 30000. `VERICTO_TIMEOUT` is the Runtime API's
   * network timeout and does not apply here.
   */
  timeoutMs?: number;
  /** How long the process may take to start and say hello, in milliseconds. Default 10000. */
  startTimeoutMs?: number;
  /** Environment to read `VERICTO_CLI` and `PATH` from. Default: `process.env`. */
  env?: Env;
  /** Where to look for `node_modules/@vericto/vericto-cli`. Default: `process.cwd()`, then the main script's directory. */
  searchFrom?: readonly string[];
  /** The child's stderr goes to `debug`. Default: silent. */
  logger?: OfflineLogger;
}

/** What `hello` said. */
export interface ServeInfo {
  readonly path: string;
  readonly cliVersion: string;
  readonly engineVersion: string;
  readonly profiles: readonly string[];
  readonly maxLineBytes: number;
}

interface Pending {
  resolve(result: Record<string, unknown>): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface Session {
  /** Unset until the binary is resolved and spawned. */
  child: ChildProcessWithoutNullStreams | undefined;
  /** Settles with the hello (or the startup error). */
  ready: Promise<ServeInfo>;
  info: ServeInfo | undefined;
  /** The checks of this process that have not settled. */
  pending: Map<string, Pending>;
  /** Ids written and not answered yet, in write order (the server answers in order). */
  inFlight: string[];
  writeChain: Promise<void>;
  exited: boolean;
  /** Set by this side when it ends the process on purpose. */
  ending: boolean;
  /** The hello was read, or the startup failure was reported. */
  startHandled: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  /** Resolves when the process has exited. */
  done: Promise<void>;
}

type ChildProcessModule = typeof import('node:child_process');

/** Live children, killed when the parent process exits (one listener for all clients). */
const LIVE = new Set<ChildProcessWithoutNullStreams>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled || typeof process === 'undefined' || typeof process.on !== 'function') return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const child of LIVE) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
  });
}

/**
 * Evaluates statements with a local `vericto serve --stdio` process: the engine's
 * standard rules, no account, no network. One child process per evaluator, started
 * on the first check; restarted once if it exits unexpectedly.
 *
 * Usually built by `new Vericto({ offline: true })`; build it yourself to pass as
 * `evaluator`.
 */
export class OfflineEvaluator implements Evaluator {
  readonly mode = 'offline';
  readonly profile: OfflineProfile;
  readonly timeoutMs: number;
  readonly #cliPath: string | undefined;
  readonly #cliPathSource: string;
  readonly #startTimeoutMs: number;
  readonly #env: Env;
  readonly #searchFrom: readonly string[] | undefined;
  readonly #logger: OfflineLogger;
  #session: Session | undefined;
  /** A configuration error found at startup: every later check rejects with it. */
  #fatal: VerictoConfigError | undefined;
  /** The process failed and was not answered since: the next failure stops the restarts. */
  #failedSinceSuccess = false;
  #broken: VerictoUnavailableError | undefined;
  #closed = false;
  #nextId = 0;
  #notedPolicyFields = false;

  constructor(options: OfflineEvaluatorOptions = {}) {
    const profile: string = options.profile ?? 'runtime';
    if (profile !== 'runtime' && profile !== 'ci') {
      throw new VerictoConfigError(`offlineProfile must be 'runtime' or 'ci', got ${JSON.stringify(profile)}.`);
    }
    this.profile = profile;
    this.#env = defaultEnv(options.env);
    const fromEnv = readEnv(this.#env, 'VERICTO_CLI');
    const cli = options.cliPath?.trim() || undefined;
    this.#cliPath = cli ?? fromEnv;
    this.#cliPathSource = cli ? 'offlineCliPath' : 'VERICTO_CLI';

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!(timeoutMs > 0)) throw new VerictoConfigError('timeoutMs must be greater than 0.');
    this.timeoutMs = timeoutMs;
    const start = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    if (!(start > 0)) throw new VerictoConfigError('startTimeoutMs must be greater than 0.');
    this.#startTimeoutMs = start;
    this.#searchFrom = options.searchFrom;
    this.#logger = options.logger ?? {};
  }

  /** A description (the profile and, once started, the CLI version). */
  toString(): string {
    const info = this.#session?.info;
    return `OfflineEvaluator(profile=${this.profile}${info ? `, cli=${info.cliVersion}, engine=${info.engineVersion}` : ''})`;
  }

  toJSON(): Record<string, unknown> {
    return { mode: 'offline', profile: this.profile };
  }

  /** The process id of the running `vericto serve`, if one is running. */
  get pid(): number | undefined {
    const session = this.#session;
    return session && !session.exited ? session.child?.pid : undefined;
  }

  /** The dialects are the engine's to decide: an unknown one is rejected by the server. */
  supportedDialects(): Promise<readonly string[] | undefined> {
    return Promise.resolve(undefined);
  }

  /**
   * Start the process now (it is otherwise started on the first check) and resolve
   * what it reported. Rejects with `VerictoConfigError` (`CLI_NOT_FOUND`,
   * `CLI_TOO_OLD`, `CLI_PROTOCOL_MISMATCH`) or `VerictoUnavailableError`.
   */
  async start(): Promise<ServeInfo> {
    return this.#ready().ready;
  }

  /**
   * Evaluate one SQL text (one or more statements: one verdict, the strongest finding
   * across them, as online). `options.context` / `options.endUser` have no effect
   * offline: there are no business policies.
   */
  async evaluate(sql: string, dialect: string, options?: EvaluationOptions): Promise<Verdict> {
    if ((options?.context || options?.endUser) && !this.#notedPolicyFields) {
      this.#notedPolicyFields = true;
      this.#logger.info?.('vericto: context and endUser have no effect offline (no business policies).');
    }
    const result = await this.#request({ op: 'check', sql, dialect, profile: this.profile }, dialect);
    return verdictFromResponse(bodyOf(result, this.profile), sql, dialect);
  }

  /** Round trip with the process (`ping`). */
  async ping(): Promise<void> {
    await this.#request({ op: 'ping' }, undefined);
  }

  /**
   * Stop the process: the checks already sent are answered, then it exits. Later
   * checks reject with `VerictoConfigError`. Safe to call more than once.
   */
  async close(): Promise<void> {
    this.#closed = true;
    const session = this.#session;
    if (!session) return;
    this.#end(session);
    await session.done;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // ---- internals ----------------------------------------------------------------

  #ready(): Session {
    if (this.#closed) throw new VerictoConfigError('This Vericto client is closed.', { code: 'CLOSED' });
    if (this.#fatal) throw this.#fatal;
    if (this.#broken) throw this.#broken;
    this.#session ??= this.#spawn();
    return this.#session;
  }

  async #request(message: Record<string, unknown>, dialect: string | undefined): Promise<Record<string, unknown>> {
    const session = this.#ready();
    const id = String(++this.#nextId);
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      session.pending.set(id, { resolve, reject, timer: undefined });
      this.#refresh(session);
    });
    // Written after the hello; a request is never sent to a process that has not said it.
    // Until then the start timeout applies; from then on, the check's own timeout.
    session.ready.then(
      (info) => {
        const pending = session.pending.get(id);
        if (!pending) return;
        const line = JSON.stringify({ id, ...message }) + '\n';
        const bytes = Buffer.byteLength(line, 'utf8') - 1;
        if (bytes > info.maxLineBytes) {
          this.#settle(session, id, undefined, tooLarge(bytes, info.maxLineBytes));
          return;
        }
        pending.timer = setTimeout(() => {
          const err = new VerictoUnavailableError(`vericto serve did not answer within ${String(this.timeoutMs)} ms.`, {
            code: 'TIMEOUT',
          });
          if (!this.#settle(session, id, undefined, err)) return;
          // A process that stopped answering is ended; the next check starts a new one.
          this.#fail(session, 'it stopped answering');
        }, this.timeoutMs);
        this.#write(session, line, id);
      },
      () => {
        // The startup error was already given to every pending request.
      },
    );
    const raw = await response;
    if (raw.ok === true) return raw;
    throw errorOf(raw.error, dialect);
  }

  #write(session: Session, line: string, id: string): void {
    session.writeChain = session.writeChain.then(async () => {
      const child = session.child;
      if (!child || session.exited) {
        this.#settle(session, id, undefined, new VerictoUnavailableError('vericto serve exited before the check was sent.', { code: 'CLI_EXITED' }));
        return;
      }
      if (!session.pending.has(id)) return; // timed out while queued
      session.inFlight.push(id);
      if (!child.stdin.write(line)) await drained(child);
    });
  }

  /** Resolve or reject one pending request; `false` when it is no longer pending. */
  #settle(session: Session, id: string, value: Record<string, unknown> | undefined, err?: Error): boolean {
    const pending = session.pending.get(id);
    if (!pending) return false;
    session.pending.delete(id);
    clearTimeout(pending.timer);
    if (err) pending.reject(err);
    else pending.resolve(value ?? {});
    this.#refresh(session);
    return true;
  }

  /** The child keeps the event loop alive only while it starts, a check is pending, or it is being stopped. */
  #refresh(session: Session): void {
    const child = session.child;
    if (session.exited || !child) return;
    const busy = !session.startHandled || session.pending.size > 0 || session.ending;
    for (const handle of [child, child.stdin, child.stdout, child.stderr] as RefHandle[]) {
      if (busy) handle.ref?.();
      else handle.unref?.();
    }
  }

  #spawn(): Session {
    let resolveReady!: (info: ServeInfo) => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<ServeInfo>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    // Handled through the pending requests; a bare `start()` caller gets it too.
    ready.catch(() => {});
    let resolveDone!: () => void;
    const done = new Promise<void>((res) => {
      resolveDone = res;
    });
    const session: Session = {
      child: undefined,
      pending: new Map(),
      ready,
      info: undefined,
      inFlight: [],
      writeChain: Promise.resolve(),
      exited: false,
      ending: false,
      startHandled: false,
      done,
    };
    const startFailed = (err: Error): void => {
      if (session.startHandled) return;
      session.startHandled = true;
      if (this.#session === session) this.#session = undefined;
      rejectReady(err);
      if (err instanceof VerictoConfigError && err.code !== 'CLOSED') this.#fatal = err;
      else if (err instanceof VerictoUnavailableError) this.#crashed(err);
      this.#rejectAll(session, err);
    };
    const finish = (): void => {
      session.exited = true;
      if (session.child) LIVE.delete(session.child);
      if (session.killTimer) clearTimeout(session.killTimer);
      if (this.#session === session) this.#session = undefined;
      resolveDone();
    };

    void (async () => {
      let path: string;
      let childProcess: ChildProcessModule;
      try {
        childProcess = await import('node:child_process');
        path = await resolveCliPath(this.#cliPath, this.#cliPathSource, this.#env, this.#searchFrom);
      } catch (err) {
        startFailed(err as Error);
        finish();
        return;
      }
      if (session.ending) {
        // Closed, or timed out, before the process was started.
        startFailed(
          this.#closed
            ? new VerictoConfigError('This Vericto client is closed.', { code: 'CLOSED' })
            : new VerictoUnavailableError('vericto serve was stopped before it started.', { code: 'CLI_EXITED' }),
        );
        finish();
        return;
      }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = childProcess.spawn(path, ['serve', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        startFailed(spawnError(err, path));
        finish();
        return;
      }
      session.child = child;
      LIVE.add(child);
      installExitHook();
      this.#refresh(session);

      let helloSeen = false;
      let spawnFailure: Error | undefined;
      let stderrTail = '';
      const startTimer = setTimeout(() => {
        if (helloSeen) return;
        startFailed(
          new VerictoUnavailableError(`vericto serve (${path}) did not start within ${String(this.#startTimeoutMs)} ms.`, {
            code: 'CLI_START_TIMEOUT',
          }),
        );
        this.#end(session, true);
      }, this.#startTimeoutMs);
      startTimer.unref();

      child.stdin.on('error', () => {
        // EPIPE when the process is gone: reported by 'close'.
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      let buffer = '';
      child.stdout.on('data', (chunk: string) => {
        if (session.startHandled && !helloSeen) return;
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          if (!helloSeen) {
            helloSeen = true;
            clearTimeout(startTimer);
            const parsed = parseHello(line, path);
            if (parsed instanceof Error) {
              startFailed(parsed);
              this.#end(session, true);
              return;
            }
            session.info = parsed;
            session.startHandled = true;
            this.#refresh(session);
            this.#logger.debug?.(`vericto: offline mode, vericto serve ${parsed.cliVersion} (engine ${parsed.engineVersion}) at ${path}`);
            resolveReady(parsed);
            continue;
          }
          if (!this.#onLine(session, line)) return;
        }
        if (buffer.length > MAX_RESPONSE_LINE) this.#protocolError(session, 'a response line is too long');
      });
      let errBuffer = '';
      child.stderr.on('data', (chunk: string) => {
        errBuffer += chunk;
        let nl: number;
        while ((nl = errBuffer.indexOf('\n')) >= 0) {
          const line = errBuffer.slice(0, nl).replace(/\r$/, '');
          errBuffer = errBuffer.slice(nl + 1);
          if (!line.trim()) continue;
          // The protocol keeps SQL out of stderr; the line is still bounded.
          const text = line.length > MAX_STDERR_LINE ? `${line.slice(0, MAX_STDERR_LINE)}...` : line;
          stderrTail = text;
          this.#logger.debug?.(`vericto serve: ${text}`);
        }
        if (errBuffer.length > MAX_STDERR_LINE * 4) errBuffer = errBuffer.slice(-MAX_STDERR_LINE);
      });
      child.on('error', (err) => {
        // A spawn failure (ENOENT, EACCES); 'close' follows.
        spawnFailure ??= spawnError(err, path);
      });
      // 'close', not 'exit': every line the process wrote has been read by then.
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(startTimer);
        const how = signal ? `signal ${signal}` : `code ${String(code)}`;
        if (!helloSeen) {
          if (session.startHandled || session.ending) {
            startFailed(new VerictoUnavailableError('vericto serve was stopped before it started.', { code: 'CLI_EXITED' }));
            finish();
            return;
          }
          if (spawnFailure) {
            startFailed(spawnFailure);
            finish();
            return;
          }
          // No hello: a `vericto` without `serve` (older than 2.1.0), or a crash at startup.
          void tooOldOrUnavailable(childProcess, path, how, stderrTail).then((err) => {
            startFailed(err);
            finish();
          });
          return;
        }
        const expected = session.ending;
        finish();
        const err = new VerictoUnavailableError(
          expected ? 'vericto serve was stopped before it answered.' : `vericto serve exited unexpectedly (${how}).`,
          { code: 'CLI_EXITED' },
        );
        this.#rejectAll(session, err);
        if (!expected) this.#crashed(err);
      });
    })();
    return session;
  }

  /** One response line; `false` when it ended the session. */
  #onLine(session: Session, line: string): boolean {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.#protocolError(session, 'a response line is not JSON');
      return false;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.#protocolError(session, 'a response line is not a JSON object');
      return false;
    }
    const response = msg as Record<string, unknown>;
    let id: string | undefined;
    if (typeof response.id === 'string') {
      const at = session.inFlight.indexOf(response.id);
      if (at < 0) {
        this.#protocolError(session, 'a response has an id that was not sent');
        return false;
      }
      session.inFlight.splice(at, 1);
      id = response.id;
    } else if (response.id === null || response.id === undefined) {
      // A line the server could not read (TOO_LARGE, malformed): answered in order,
      // so it is the oldest request in flight.
      id = session.inFlight.shift();
      if (id === undefined) {
        this.#protocolError(session, 'a response arrived with nothing in flight');
        return false;
      }
    } else {
      this.#protocolError(session, 'a response id is not a string');
      return false;
    }
    if (response.ok !== true && response.ok !== false) {
      this.#settle(session, id, undefined, new VerictoUnavailableError('vericto serve sent a response without ok.', { code: 'MALFORMED_RESPONSE' }));
      return true;
    }
    if (response.ok) this.#failedSinceSuccess = false;
    this.#settle(session, id, response);
    return true;
  }

  #protocolError(session: Session, what: string): void {
    this.#rejectAll(session, new VerictoUnavailableError(`vericto serve broke the protocol: ${what}.`, { code: 'MALFORMED_RESPONSE' }));
    this.#fail(session, what);
  }

  /** End a misbehaving session; counts as a crash. */
  #fail(session: Session, why: string): void {
    if (this.#session === session) this.#session = undefined;
    this.#crashed(new VerictoUnavailableError(`vericto serve failed: ${why}.`, { code: 'CLI_EXITED' }));
    this.#end(session, true);
  }

  /** Restart once: a second failure with no answer in between stops the restarts. */
  #crashed(err: VerictoUnavailableError): void {
    if (this.#failedSinceSuccess) {
      this.#broken = new VerictoUnavailableError(
        `${err.message} It failed again after a restart, so it is not restarted any more: create a new client.`,
        { code: 'CLI_CRASHED' },
      );
      this.#logger.debug?.('vericto: vericto serve failed twice in a row; not restarting it.');
    } else {
      this.#failedSinceSuccess = true;
      this.#logger.debug?.('vericto: vericto serve failed; the next check starts a new one.');
    }
  }

  #rejectAll(session: Session, err: Error): void {
    for (const id of [...session.pending.keys()]) this.#settle(session, id, undefined, err);
  }

  /** Ask the process to exit (`shutdown`, then EOF); kill it if it does not. */
  #end(session: Session, now = false): void {
    if (session.ending) {
      if (now && !session.exited) killQuietly(session.child);
      return;
    }
    session.ending = true;
    if (this.#session === session) this.#session = undefined;
    const child = session.child;
    if (session.exited || !child) return;
    this.#refresh(session);
    if (now) {
      killQuietly(child);
      return;
    }
    // After every check already queued: their writes are chained once the hello is in.
    session.ready.then(
      () => {
        session.writeChain = session.writeChain.then(() => {
          if (session.exited) return;
          try {
            child.stdin.end('{"op":"shutdown"}\n');
          } catch {
            // gone already
          }
        });
      },
      () => {
        killQuietly(child);
      },
    );
    session.killTimer = setTimeout(() => {
      killQuietly(child);
    }, CLOSE_GRACE_MS);
    session.killTimer.unref();
  }
}

interface RefHandle {
  ref?(): void;
  unref?(): void;
}

function killQuietly(child: ChildProcessWithoutNullStreams | undefined): void {
  try {
    child?.kill('SIGKILL');
  } catch {
    // already gone
  }
}

function drained(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    const stdin = child.stdin;
    const done = (): void => {
      stdin.off('drain', done);
      stdin.off('close', done);
      stdin.off('error', done);
      resolve();
    };
    stdin.on('drain', done);
    stdin.on('close', done);
    stdin.on('error', done);
  });
}

function tooLarge(bytes: number, max: number): VerictoConfigError {
  return new VerictoConfigError(
    `The SQL text is too large for offline checks: the request is ${String(bytes)} bytes, ` +
      `vericto serve accepts ${String(max)}. Nothing was executed.`,
    { code: 'TOO_LARGE' },
  );
}

/** The error of an `ok: false` response. */
function errorOf(value: unknown, dialect: string | undefined): Error {
  const e = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const code = typeof e.code === 'string' ? e.code : undefined;
  const message = typeof e.message === 'string' && e.message ? e.message : 'no message';
  switch (code) {
    case 'UNSUPPORTED_DIALECT':
      return new VerictoUnsupportedDialectError(
        dialect ?? 'unknown',
        KNOWN_DIALECTS,
        'vericto serve',
        `The local Vericto engine (vericto serve) does not support the '${dialect ?? 'unknown'}' dialect ` +
          `(supported: ${KNOWN_DIALECTS.join(', ')}). No SQL was executed.`,
      );
    case 'INVALID_REQUEST':
      return new VerictoConfigError(`vericto serve rejected the request (INVALID_REQUEST): ${message}`, { code });
    case 'TOO_LARGE':
      return new VerictoConfigError(`The SQL text is too large for offline checks (TOO_LARGE): ${message}. Nothing was executed.`, {
        code,
      });
    default:
      return new VerictoUnavailableError(`vericto serve could not check the statement (${code ?? 'no code'}): ${message}`, {
        code: code ?? 'INTERNAL',
      });
  }
}

/**
 * A `POST /api/v1/proxy/query`-shaped body from a `check` result (the
 * `vericto check --offline --format json` document), so the online mapping applies.
 */
function bodyOf(response: Record<string, unknown>, profile: OfflineProfile): Record<string, unknown> {
  const result = response.result;
  const doc = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined;
  const queries = doc && Array.isArray(doc.queries) ? (doc.queries as unknown[]) : undefined;
  const query = queries?.length === 1 && queries[0] && typeof queries[0] === 'object' ? (queries[0] as Record<string, unknown>) : undefined;
  if (!doc || !query || typeof query.status !== 'string') {
    throw new VerictoUnavailableError('vericto serve sent a check result without a status.', { code: 'MALFORMED_RESPONSE' });
  }
  const summary = doc.summary && typeof doc.summary === 'object' ? (doc.summary as Record<string, unknown>) : {};
  const engineVersion = typeof doc.engine_version === 'string' ? doc.engine_version : undefined;
  return {
    decision: query.status,
    action: query.action ?? null,
    rule_code: query.rule_code ?? null,
    severity: query.severity ?? null,
    ast_node_path: query.status === 'PARSE_ERROR' ? null : (query.ast_node_path ?? null),
    suggested_safe_query: query.suggested_fix ?? null,
    ruleset_version: summary.ruleset_version ?? (engineVersion ? `standard@engine-${engineVersion}` : null),
    mode: 'offline',
    engine_version: engineVersion ?? null,
    profile,
    // The whole document, as `vericto check --offline --format json` prints it.
    result: doc,
  };
}

function parseHello(line: string, path: string): ServeInfo | VerictoConfigError {
  let hello: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) hello = parsed as Record<string, unknown>;
  } catch {
    // below
  }
  if (!hello || hello.type !== 'hello') {
    return new VerictoConfigError(`${path} did not start the vericto serve protocol (no hello line). ${INSTALL_HINT}`, {
      code: 'CLI_PROTOCOL_MISMATCH',
    });
  }
  const cliVersion = typeof hello.cli_version === 'string' ? hello.cli_version : '';
  if (!versionAtLeast(cliVersion, MIN_CLI_VERSION)) {
    return new VerictoConfigError(
      `The Vericto CLI at ${path} is ${cliVersion || 'of an unknown version'}; offline mode needs ${MIN_CLI_VERSION} or later. ${INSTALL_HINT}`,
      { code: 'CLI_TOO_OLD' },
    );
  }
  if (hello.protocol !== SERVE_PROTOCOL) {
    return new VerictoConfigError(
      `The Vericto CLI at ${path} (${cliVersion}) speaks serve protocol ${JSON.stringify(hello.protocol)}; this SDK speaks ` +
        `${String(SERVE_PROTOCOL)}. Upgrade @vericto/sdk, or install a CLI that speaks protocol ${String(SERVE_PROTOCOL)}.`,
      { code: 'CLI_PROTOCOL_MISMATCH' },
    );
  }
  const max = typeof hello.max_line_bytes === 'number' && hello.max_line_bytes > 0 ? hello.max_line_bytes : 1024 * 1024;
  return {
    path,
    cliVersion,
    engineVersion: typeof hello.engine_version === 'string' ? hello.engine_version : '',
    profiles: Array.isArray(hello.profiles) ? hello.profiles.filter((p): p is string => typeof p === 'string') : [],
    maxLineBytes: max,
  };
}

function spawnError(err: unknown, path: string): Error {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === 'ENOENT') {
    return new VerictoConfigError(`The Vericto CLI was not found at ${path}. ${INSTALL_HINT}`, { code: 'CLI_NOT_FOUND' });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new VerictoConfigError(`The Vericto CLI at ${path} cannot be run (${code}): check its permissions. ${INSTALL_HINT}`, {
      code: 'CLI_NOT_FOUND',
    });
  }
  return new VerictoUnavailableError(`vericto serve could not be started (${code ?? (err instanceof Error ? err.name : 'error')}).`, {
    code: 'CLI_START_FAILED',
  });
}

/** The process exited before its hello: a CLI without `serve`, or a crash at startup. */
async function tooOldOrUnavailable(cp: ChildProcessModule, path: string, how: string, stderrTail: string): Promise<Error> {
  const version = await new Promise<string | undefined>((resolve) => {
    try {
      cp.execFile(path, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        const match = /(\d+\.\d+\.\d+[\w.+-]*)/.exec(stdout);
        resolve(err && !match ? undefined : match?.[1]);
      });
    } catch {
      resolve(undefined);
    }
  });
  if (version && !versionAtLeast(version, MIN_CLI_VERSION)) {
    return new VerictoConfigError(
      `The Vericto CLI at ${path} is ${version}; offline mode needs ${MIN_CLI_VERSION} or later (vericto serve). ${INSTALL_HINT}`,
      { code: 'CLI_TOO_OLD' },
    );
  }
  return new VerictoUnavailableError(
    `vericto serve (${path}) exited before it started (${how})${stderrTail ? `: ${stderrTail}` : ''}.`,
    { code: 'CLI_START_FAILED' },
  );
}

/** `a >= b` for `X.Y.Z` versions; a pre-release (`2.1.0-rc.1`) is below its release. */
export function versionAtLeast(a: string, b: string): boolean {
  const parse = (v: string): [number[], boolean] | undefined => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
    return m ? [[Number(m[1]), Number(m[2]), Number(m[3])], Boolean(m[4])] : undefined;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    const p = x[0][i] ?? 0;
    const q = y[0][i] ?? 0;
    if (p !== q) return p > q;
  }
  return !x[1] || y[1];
}

/**
 * The `vericto` binary to start, in this order:
 * 1. `offlineCliPath` / `VERICTO_CLI` (a path, or a command name looked up on PATH);
 * 2. the `@vericto/vericto-cli` package in the app's `node_modules` (a devDependency or
 *    an optional peer): its installed native binary, found from its `bin` metadata;
 * 3. `vericto` on PATH.
 * Nothing is ever downloaded.
 */
export async function resolveCliPath(
  explicit: string | undefined,
  source: string,
  env: Env,
  searchFrom?: readonly string[],
): Promise<string> {
  const [fs, pathMod, mod] = await Promise.all([import('node:fs'), import('node:path'), import('node:module')]);
  const isFile = (p: string): boolean => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const win = process.platform === 'win32';
  const onPath = (name: string): string | undefined => {
    const dirs = (env.PATH ?? env.Path ?? '').split(pathMod.delimiter).filter(Boolean);
    const names = win && !/\.[a-z0-9]+$/i.test(name) ? [`${name}.exe`, name] : [name];
    for (const dir of dirs) {
      for (const n of names) {
        const p = pathMod.join(dir, n);
        if (isFile(p)) return p;
      }
    }
    return undefined;
  };

  if (explicit) {
    const looksLikePath = explicit.includes('/') || explicit.includes('\\');
    const found = looksLikePath ? (isFile(explicit) ? explicit : undefined) : onPath(explicit);
    if (!found) {
      throw new VerictoConfigError(`${source} points to ${JSON.stringify(explicit)}, which is not a file. ${INSTALL_HINT}`, {
        code: 'CLI_NOT_FOUND',
      });
    }
    return found;
  }

  let packageWithoutBinary: string | undefined;
  const bases = searchFrom ?? [process.cwd(), ...(process.argv[1] ? [pathMod.dirname(pathMod.resolve(process.argv[1]))] : [])];
  for (const base of bases) {
    let dirs: string[] | null;
    try {
      dirs = mod.createRequire(pathMod.join(base, 'noop.js')).resolve.paths(CLI_PACKAGE);
    } catch {
      dirs = null;
    }
    for (const dir of dirs ?? []) {
      const pkgDir = pathMod.join(dir, ...CLI_PACKAGE.split('/'));
      const manifest = pathMod.join(pkgDir, 'package.json');
      if (!isFile(manifest)) continue;
      const found = binaryOfPackage(fs, pathMod, pkgDir, manifest, isFile, win);
      if (found) return found;
      packageWithoutBinary ??= pkgDir;
    }
  }

  const found = onPath('vericto');
  if (found) return found;
  const extra = packageWithoutBinary
    ? ` ${CLI_PACKAGE} is installed at ${packageWithoutBinary}, but its binary is not (did its install script run? Try npm rebuild ${CLI_PACKAGE}).`
    : '';
  throw new VerictoConfigError(`Offline mode could not find the Vericto CLI.${extra} ${INSTALL_HINT}`, { code: 'CLI_NOT_FOUND' });
}

/**
 * The native binary of an installed `@vericto/vericto-cli`: the package's `bin` is a
 * Node launcher (which downloads the binary when it is missing, so it is never run
 * here); its install script puts the binary in `node_modules/.bin_real/`.
 */
function binaryOfPackage(
  fs: typeof import('node:fs'),
  pathMod: typeof import('node:path'),
  pkgDir: string,
  manifest: string,
  isFile: (p: string) => boolean,
  win: boolean,
): string | undefined {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const bin = meta.bin;
  const target = typeof bin === 'string' ? bin : bin && typeof bin === 'object' ? (bin as Record<string, unknown>).vericto : undefined;
  if (typeof target !== 'string') return undefined;
  const names = win ? ['vericto.exe', 'vericto'] : ['vericto'];
  for (const name of names) {
    const p = pathMod.join(pkgDir, 'node_modules', '.bin_real', name);
    if (isFile(p)) return p;
  }
  // A package whose bin is the binary itself.
  const direct = pathMod.join(pkgDir, target);
  if (!/\.(c|m)?js$/i.test(target) && isFile(direct)) return direct;
  return undefined;
}
