/**
 * What Vericto decided. `UNEVALUATED` is local: Vericto could not answer and the
 * guard runs with `failMode: 'open'`, so the statement ran without a verdict.
 */
export type Decision = 'ALLOWED' | 'FLAGGED' | 'MONITORED' | 'PARSE_ERROR' | 'BLOCKED' | 'UNEVALUATED';

const SERVER_DECISIONS: ReadonlySet<string> = new Set(['ALLOWED', 'FLAGGED', 'MONITORED', 'PARSE_ERROR', 'BLOCKED']);

/** A rule that matched the statement. */
export interface Finding {
  readonly ruleCode: string;
  readonly severity?: string;
  readonly ruleId?: string;
  readonly astNodePath?: string;
  readonly suggestedFix?: string;
}

/** Vericto's answer for one statement. */
export interface Verdict {
  readonly decision: Decision;
  /** The statement as submitted. */
  readonly sql: string;
  readonly dialect: string;
  readonly ruleCode?: string;
  readonly severity?: string;
  readonly message?: string;
  readonly suggestedFix?: string;
  /**
   * When set, the statement to run **instead of** `sql`: the sensitive columns it
   * reads come back masked (Sensitive Column Protection).
   */
  readonly rewrittenQuery?: string;
  readonly parseError?: string;
  readonly findings: readonly Finding[];
  readonly sensitiveColumns: readonly unknown[];
  readonly accessDenied: readonly unknown[];
  /** The audit-trail event id. */
  readonly eventId?: string;
  readonly rulesetVersion?: string;
  readonly cached: boolean;
  /** The response body, for fields this version does not model yet. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** The statement the driver must run: the masked rewrite when there is one. */
export function sqlToExecute(verdict: Verdict): string {
  return verdict.rewrittenQuery ?? verdict.sql;
}

export function isMasked(verdict: Verdict): boolean {
  return Boolean(verdict.rewrittenQuery);
}

/** Build a verdict from a `POST /api/v1/proxy/query` response body. */
export function verdictFromResponse(body: Record<string, unknown>, sql: string, dialect: string): Verdict {
  const raw = (typeof body.decision === 'string' ? body.decision : '').toUpperCase();
  // An unknown decision must never be read as "allowed".
  const decision: Decision = SERVER_DECISIONS.has(raw) ? (raw as Decision) : 'BLOCKED';
  const ruleCode = optStr(body.rule_code);
  const severity = optStr(body.severity);
  const suggestedFix = optStr(body.suggested_safe_query);
  let message = optStr(body.error);
  if (message && ruleCode && message === `Query blocked by rule ${ruleCode}`) message = undefined;
  return {
    decision,
    sql,
    dialect,
    ruleCode,
    severity,
    message,
    suggestedFix,
    // A blocked statement never runs, so it has nothing to rewrite.
    rewrittenQuery: decision === 'BLOCKED' ? undefined : optStr(body.rewritten_query),
    parseError: optStr(body.parse_error),
    findings: findingsOf(body, ruleCode, severity, suggestedFix),
    sensitiveColumns: Array.isArray(body.sensitive_columns) ? body.sensitive_columns : [],
    accessDenied: Array.isArray(body.access_denied) ? body.access_denied : [],
    eventId: optStr(body.event_id),
    rulesetVersion: optStr(body.ruleset_version),
    cached: false,
    raw: body,
  };
}

export function unevaluatedVerdict(sql: string, dialect: string, reason: string): Verdict {
  return {
    decision: 'UNEVALUATED',
    sql,
    dialect,
    message: reason,
    findings: [],
    sensitiveColumns: [],
    accessDenied: [],
    cached: false,
    raw: {},
  };
}

function optStr(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function findingsOf(
  body: Record<string, unknown>,
  ruleCode: string | undefined,
  severity: string | undefined,
  suggestedFix: string | undefined,
): Finding[] {
  // The Runtime API reports the deciding rule; a later version may send the full list.
  const listed = body.findings ?? body.violations;
  if (Array.isArray(listed)) {
    const out: Finding[] = [];
    for (const item of listed as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const f = item as Record<string, unknown>;
      const code = optStr(f.rule_code ?? f.code);
      if (!code) continue;
      out.push({
        ruleCode: code,
        severity: optStr(f.severity),
        ruleId: optStr(f.rule_id),
        astNodePath: optStr(f.ast_node_path),
        suggestedFix: optStr(f.suggested_safe_query ?? f.suggested_fix),
      });
    }
    if (out.length) return out;
  }
  if (!ruleCode) return [];
  return [
    {
      ruleCode,
      severity,
      ruleId: optStr(body.rule_id),
      astNodePath: optStr(body.ast_node_path),
      suggestedFix,
    },
  ];
}
