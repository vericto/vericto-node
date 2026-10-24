// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * A local stand-in for the Vericto Runtime API, for the documentation examples
 * (scripts/check-docs-examples.mjs). It answers with the documented response shapes of
 * `POST /api/v1/proxy/query` and `GET /api/v1/meta/config`; it is not the engine:
 * the decision comes from a few fixed patterns.
 *
 *   DELETE / UPDATE without WHERE   403 BLOCKED, VERICTO-001 (critical), suggested_safe_query
 *     (or with WHERE 1=1 / true)
 *   DROP TABLE                      403 BLOCKED, VERICTO-010 (critical)
 *   ATTACH DATABASE                 403 BLOCKED, VERICTO-098 (high)
 *   a SELECT that reads `email`     200 FLAGGED, VERICTO-085: rewritten_query masks the column
 *   SELECT * without LIMIT          200 FLAGGED, VERICTO-030 (medium)
 *   SELECT ... WITH ROLLUP (MySQL)  200 MONITORED, VERICTO-040 (low)
 *   `SELEC ...` (a typo)            403 BLOCKED, VERICTO-PARSE-ERROR (the fail-closed policy)
 *   anything else                   200 ALLOWED
 *
 * The first path segment of the base URL picks a failure, so an example only changes
 * VERICTO_API_URL: `/slow` answers after 10 s (a timeout), `/stall` sends headers and
 * never the body, `/500`, `/401`, `/403`, `/400`, `/rate-limit` (429
 * RATE_LIMIT_EXCEEDED), `/quota` (429 QUOTA_EXCEEDED). Nothing is persisted, no key is
 * checked beyond its `vtro_` prefix.
 *
 * `context` (ticket, tenant) and `end_user` are validated with the service's limits
 * (as with business policies enabled: 400 VALIDATION_ERROR for an invalid value) and
 * recorded in `requests`; they do not change the decision.
 *
 *   node scripts/docs-stub.mjs            # prints the base URL, serves until killed
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const DIALECTS = [
  ['postgres', 'PostgreSQL'],
  ['mysql', 'MySQL'],
  ['oracle', 'Oracle'],
  ['mssql', 'SQL Server'],
  ['snowflake', 'Snowflake'],
  ['sqlite', 'SQLite'],
];

/** The decision for one statement, as the fields of a 200 or 403 body. */
export function decide(query) {
  const sql = query.replace(/\s+/g, ' ').trim();
  if (process.env.STUB_LOG) console.error('[stub]', sql);
  const upper = sql.toUpperCase();
  const blocked = (rule, severity, fix = null) => ({ status: 403, rule, severity, fix });
  // No WHERE, or one that is always true (`WHERE 1=1`, as Prisma's deleteMany sends): VERICTO-001.
  if (/^(DELETE FROM|UPDATE) /.test(upper) && (!/ WHERE /.test(upper) || / WHERE (1 ?= ?1|TRUE)\s*;?$/.test(upper))) {
    const fix = upper.startsWith('DELETE') ? `${sql.replace(/;$/, '')} WHERE <condition>` : null;
    return blocked('VERICTO-001', 'critical', fix);
  }
  if (/^DROP TABLE /.test(upper)) return blocked('VERICTO-010', 'critical');
  if (/^ATTACH /.test(upper)) return blocked('VERICTO-098', 'high');
  if (/^SELEC /.test(upper)) return { status: 403, parseError: 'syntax error at or near "SELEC"' };
  if (/^SELECT /.test(upper) && /\bEMAIL\b/.test(upper.slice(0, upper.indexOf(' FROM ') >>> 0))) {
    // Mask the column in the select list only (`t."email"` -> `'***' AS "email"`).
    const from = upper.indexOf(' FROM ');
    const list = from === -1 ? sql : sql.slice(0, from);
    const rewritten =
      list.replace(/(?:["`]?\w+["`]?\.)*(["`]?)\bemail\b\1(?!\s*\()/gi, (m, q) => `'***' AS ${q}email${q}`) + (from === -1 ? '' : sql.slice(from));
    return {
      status: 200,
      decision: 'FLAGGED',
      rule: 'VERICTO-085',
      severity: 'low',
      rewritten,
      sensitive: [{ table: 'users', column: 'email', action: 'mask' }],
    };
  }
  if (/^SELECT \* /.test(upper) && !/ LIMIT /.test(upper)) {
    return { status: 200, decision: 'FLAGGED', rule: 'VERICTO-030', severity: 'medium' };
  }
  if (/ WITH ROLLUP/.test(upper)) return { status: 200, decision: 'MONITORED', rule: 'VERICTO-040', severity: 'low' };
  return { status: 200, decision: 'ALLOWED' };
}

function evaluation(query) {
  const d = decide(query);
  const eventId = randomUUID();
  if (d.status === 403 && d.parseError) {
    return [403, {
      error: `Query blocked: VERICTO-PARSE-ERROR: ${d.parseError}`,
      decision: 'BLOCKED',
      rule_code: 'VERICTO-PARSE-ERROR',
      ast_node_path: null,
      severity: 'medium',
      suggested_safe_query: null,
      parse_error: d.parseError,
      event_id: eventId,
    }];
  }
  if (d.status === 403) {
    return [403, {
      error: `Query blocked by rule ${d.rule}`,
      decision: 'BLOCKED',
      rule_code: d.rule,
      ast_node_path: 'Stmt',
      severity: d.severity,
      suggested_safe_query: d.fix,
      rewritten_query: null,
      sensitive_columns: [],
      access_denied: [],
      event_id: eventId,
    }];
  }
  return [200, {
    decision: d.decision,
    rule_id: d.rule ? randomUUID() : null,
    rule_code: d.rule ?? null,
    severity: d.severity ?? null,
    ast_node_path: null,
    estimated_rows_affected: null,
    suggested_safe_query: null,
    parse_error: null,
    parse_error_kind: null,
    rewritten_query: d.rewritten ?? null,
    sensitive_columns: d.sensitive ?? [],
    access_denied: [],
    latency_ms: 0.4,
    event_id: eventId,
  }];
}

const FAILURES = {
  '500': [500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }],
  '401': [401, { error: { code: 'UNAUTHORIZED', message: 'Invalid or revoked API key' } }],
  '403': [403, { error: { code: 'FORBIDDEN', message: 'This API key is not authorized for that workspace or database' } }],
  '400': [400, { error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: [{ field: 'dialect', message: 'Must be one of: postgres, mysql, oracle, mssql, snowflake, sqlite' }] } }],
  'rate-limit': [429, { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many evaluations per minute for this API key. Retry shortly.', retry_after_seconds: 60 } }],
  quota: [429, {
    error: {
      code: 'QUOTA_EXCEEDED',
      message: 'Monthly query quota exceeded. Upgrade your plan to continue.',
      used: 10000,
      limit: 10000,
      remaining: 0,
      upgrade_url: 'https://app.vericto.com/dashboard/billing',
      resets_at: '2026-11-01T00:00:00.000Z',
      retry_after_seconds: 3600,
    },
  }, { 'Retry-After': '3600' }],
};

const ATTR_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const printable = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value);
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The validation errors of `context` / `end_user` (vericto-fmw policyContextSchema). */
export function policyContextErrors(body) {
  const details = [];
  if (body.context !== undefined) {
    if (!isObject(body.context)) details.push({ field: 'context', message: 'Expected object' });
    else {
      for (const [key, value] of Object.entries(body.context)) {
        if (key !== 'ticket' && key !== 'tenant') details.push({ field: 'context', message: `Unrecognized key: ${key}` });
        else if (!printable(value, 128)) details.push({ field: `context.${key}`, message: '1 to 128 characters, no control characters' });
      }
    }
  }
  if (body.end_user !== undefined) {
    if (!isObject(body.end_user)) details.push({ field: 'end_user', message: 'Expected object' });
    else {
      const entries = Object.entries(body.end_user);
      if (entries.length > 16) details.push({ field: 'end_user', message: 'end_user: at most 16 keys' });
      for (const [key, value] of entries) {
        if (!ATTR_KEY.test(key)) details.push({ field: 'end_user', message: 'keys are identifiers, at most 63 characters' });
        else if (!printable(value, 256)) details.push({ field: `end_user.${key}`, message: '1 to 256 characters, no control characters' });
      }
    }
  }
  return details;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Start the stub on 127.0.0.1 (a free port unless one is given). Resolves
 * `{ url, evaluations, requests, close }`; `requests` records what was evaluated
 * (query, dialect, context, end_user), never the key.
 */
export function startStub({ port = 0 } = {}) {
  let evaluations = 0;
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const [mode, ...rest] = url.pathname.split('/').filter(Boolean);
    const path = '/' + (mode && !['api'].includes(mode) ? rest : [mode, ...rest]).join('/');
    const failure = mode && mode !== 'api' ? mode : undefined;

    if (req.method === 'GET' && path === '/api/v1/meta/config') {
      send(res, 200, { dialects: DIALECTS.map(([id, label]) => ({ id, label })) });
      return;
    }
    if (req.method !== 'POST' || path !== '/api/v1/proxy/query') {
      send(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (failure === 'slow') { setTimeout(() => { send(res, 200, { decision: 'ALLOWED' }); }, 10_000).unref(); return; }
      if (failure === 'stall') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"decision":'); return; }
      if (failure && FAILURES[failure]) { const [s, b, h] = FAILURES[failure]; send(res, s, b, h); return; }
      const key = req.headers['x-api-key'] ?? (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (typeof key !== 'string' || !key.startsWith('vtro_')) { const [s, b] = FAILURES['401']; send(res, s, b); return; }
      let body;
      try { body = JSON.parse(raw); } catch { send(res, 400, { error: { code: 'INVALID_JSON_BODY', message: 'The request body is not valid JSON.' } }); return; }
      if (typeof body.query !== 'string' || !body.query || typeof body.database_id !== 'string' || !DIALECTS.some(([id]) => id === body.dialect)) {
        const [s, b] = FAILURES['400']; send(res, s, b); return;
      }
      const details = policyContextErrors(body);
      if (details.length) { send(res, 400, { error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details } }); return; }
      evaluations++;
      requests.push({
        query: body.query,
        dialect: body.dialect,
        ...(body.context !== undefined ? { context: body.context } : {}),
        ...(body.end_user !== undefined ? { end_user: body.end_user } : {}),
      });
      const [status, out] = evaluation(body.query);
      send(res, status, out, { 'X-Quota-Limit': 'unlimited', 'X-Quota-Remaining': 'unlimited' });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://127.0.0.1:${actual}`,
        evaluations: () => evaluations,
        requests,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => { done(); }); }),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stub = await startStub({ port: Number(process.env.PORT ?? 0) });
  console.log(stub.url);
}
