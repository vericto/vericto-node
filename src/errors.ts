// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

import type { Finding, Verdict } from './verdict.js';

/** Base class of every error this package throws. */
export class VerictoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The client is misconfigured: missing or rejected API key, bad database id, a key
 * without the `proxy:evaluate` scope, or a malformed request. Thrown whatever the
 * fail mode is: failing open on a revoked key would switch the firewall off silently.
 */
export class VerictoConfigError extends VerictoError {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.status = options.status;
    this.code = options.code;
  }
}

/**
 * The Vericto server does not evaluate this dialect (it is missing from
 * `GET /api/v1/meta/config`, e.g. `sqlite` on a server older than vericto-engine
 * 4.1.0). No SQL was executed.
 */
export class VerictoUnsupportedDialectError extends VerictoConfigError {
  readonly dialect: string;
  readonly supported: readonly string[];

  constructor(dialect: string, supported: readonly string[], apiUrl: string) {
    const listed = supported.length ? supported.join(', ') : 'none reported';
    super(
      `The Vericto API at ${apiUrl} does not support the '${dialect}' dialect (supported: ${listed}). ` +
        'No SQL was executed. Upgrade the server, or use a supported dialect.',
      { code: 'UNSUPPORTED_DIALECT' },
    );
    this.dialect = dialect;
    this.supported = supported;
  }
}

/**
 * Vericto could not return a verdict after the configured retries. With
 * `failMode: 'closed'` (the default) the statement is not executed and this is thrown.
 */
export class VerictoUnavailableError extends VerictoError {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.status = options.status;
    this.code = options.code;
  }
}

/** The workspace used its monthly query quota (HTTP 429 `QUOTA_EXCEEDED`). Not retried. */
export class VerictoQuotaExceededError extends VerictoUnavailableError {
  readonly resetsAt: string | undefined;
  readonly upgradeUrl: string | undefined;

  constructor(message: string, options: { resetsAt?: string; upgradeUrl?: string } = {}) {
    super(message, { status: 429, code: 'QUOTA_EXCEEDED' });
    this.resetsAt = options.resetsAt;
    this.upgradeUrl = options.upgradeUrl;
  }
}

/** Vericto blocked the statement. It was not executed. */
export class VerictoBlockedError extends VerictoError {
  readonly verdict: Verdict;
  readonly sql: string;

  constructor(verdict: Verdict, sql: string) {
    let message = `Query blocked by ${verdict.ruleCode ?? 'a Vericto rule'}`;
    if (verdict.severity) message += ` (severity ${verdict.severity})`;
    if (verdict.message) message += `: ${verdict.message}`;
    if (verdict.suggestedFix) message += `. Suggested fix: ${verdict.suggestedFix}`;
    super(message);
    this.verdict = verdict;
    this.sql = sql;
  }

  get findings(): readonly Finding[] {
    return this.verdict.findings;
  }

  get suggestedFix(): string | undefined {
    return this.verdict.suggestedFix;
  }
}
