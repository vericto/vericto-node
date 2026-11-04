// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

// A stand-in for `vericto serve --stdio` (protocol 1), for the offline unit tests, the
// smoke test and the documentation examples (as scripts/docs-stub.mjs stands in for the
// Runtime API): Node built-ins only, no engine. Its behavior is chosen with flags
// before `serve`:
//
//   node serve-stub.mjs [--version-of X] [--protocol N] [--no-serve] [--garbage-hello]
//                       [--max-line-bytes N] [--reverse] [--spawn-log FILE] serve --stdio
//
// Verdicts by SQL text: DROP -> VERICTO-010 (BLOCKED under runtime, FLAGGED under ci),
// DELETE -> BLOCKED VERICTO-001, SELEC (typo) -> PARSE_ERROR, anything else ALLOWED.
// Special SQL texts drive the failure tests: CRASH, HANG, INTERNAL, MALFORMED,
// NOSTATUS, WRONGID, NULLID, NOOK, STDERR.
import { Buffer } from 'node:buffer';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const version = flag('--version-of') ?? '2.1.0';
if (args.includes('--version')) {
  process.stdout.write(`vericto ${version}\n`);
  process.exit(0);
}
const spawnLog = flag('--spawn-log');
if (spawnLog) appendFileSync(spawnLog, `${process.pid}\n`);
if (args.includes('--no-serve')) {
  process.stderr.write("error: unrecognized subcommand 'serve'\n");
  process.exit(2);
}

const ENGINE = '5.0.0';
const maxLine = Number(flag('--max-line-bytes') ?? 1048576);
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

if (args.includes('--garbage-hello')) {
  process.stdout.write('Welcome to some other vericto\n');
} else {
  out({
    type: 'hello',
    protocol: Number(flag('--protocol') ?? 1),
    cli_version: version,
    engine_version: ENGINE,
    profiles: ['runtime', 'ci'],
    max_line_bytes: maxLine,
    extra_field_ignored: true,
  });
}
process.stderr.write('serve-stub: ready\n');

function doc(sql, profile) {
  let q = { status: 'ALLOWED', action: null, rule_code: null, severity: null, ast_node_path: null, suggested_fix: null };
  if (/^\s*DROP/i.test(sql)) {
    q = profile === 'ci'
      ? { status: 'FLAGGED', action: 'flag', rule_code: 'VERICTO-010', severity: 'critical', ast_node_path: 'DropStmt', suggested_fix: 'Use a versioned migration tool (Flyway, Prisma Migrate, Alembic, Rails migrations)' }
      : { status: 'BLOCKED', action: 'block', rule_code: 'VERICTO-010', severity: 'critical', ast_node_path: 'DropStmt', suggested_fix: 'Use a versioned migration tool (Flyway, Prisma Migrate, Alembic, Rails migrations)' };
  } else if (/^\s*DELETE/i.test(sql)) {
    q = { status: 'BLOCKED', action: 'block', rule_code: 'VERICTO-001', severity: 'critical', ast_node_path: 'DeleteStmt > WhereClause = NULL', suggested_fix: 'DELETE FROM users WHERE id = $1' };
  } else if (/^\s*SELEC\s/i.test(sql)) {
    q = { status: 'PARSE_ERROR', action: null, rule_code: null, severity: null, ast_node_path: 'PARSE_ERROR', suggested_fix: null };
  }
  const blocked = q.status === 'BLOCKED' ? 1 : 0;
  return {
    engine_version: ENGINE,
    exit_code: blocked,
    mode: 'offline',
    queries: [{ ...q, file_index: null, line: 1, sql_preview: sql.slice(0, 100) }],
    summary: {
      total: 1,
      blocked,
      allowed: q.status === 'ALLOWED' ? 1 : 0,
      flagged: q.status === 'FLAGGED' ? 1 : 0,
      monitored: 0,
      parse_errors: q.status === 'PARSE_ERROR' ? 1 : 0,
      ruleset_version: `standard@engine-${ENGINE}`,
    },
  };
}

const held = [];
function answer(response) {
  if (!args.includes('--reverse')) return out(response);
  // Answers pairs in reverse order: the client must match by id.
  held.push(response);
  if (held.length === 2) {
    out(held[1]);
    out(held[0]);
    held.length = 0;
  }
}

function handle(line) {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > maxLine) {
    out({ id: null, ok: false, error: { code: 'TOO_LARGE', message: 'line too long' } });
    return;
  }
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    out({ id: null, ok: false, error: { code: 'INVALID_REQUEST', message: 'malformed JSON' } });
    return;
  }
  if (req.op === 'shutdown') {
    if (typeof req.id === 'string') out({ id: req.id, ok: true });
    process.exit(0);
  }
  if (req.op === 'ping') return answer({ id: req.id, ok: true });
  const sql = req.sql;
  if (typeof sql !== 'string' || !sql.trim()) {
    return answer({ id: req.id, ok: false, error: { code: 'INVALID_REQUEST', message: '`sql` is empty' } });
  }
  if (req.dialect === 'db2') {
    return answer({ id: req.id, ok: false, error: { code: 'UNSUPPORTED_DIALECT', message: "unsupported dialect 'db2'" } });
  }
  switch (sql) {
    case 'CRASH':
      process.exit(3);
      break;
    case 'HANG':
      return;
    case 'INTERNAL':
      return answer({ id: req.id, ok: false, error: { code: 'INTERNAL', message: 'engine failure' } });
    case 'MALFORMED':
      process.stdout.write('this is not json\n');
      return;
    case 'NOSTATUS':
      return answer({ id: req.id, ok: true, result: { queries: [] } });
    case 'WRONGID':
      return answer({ id: 'not-sent', ok: true });
    case 'NULLID':
      return answer({ id: null, ok: false, error: { code: 'TOO_LARGE', message: 'line too long' } });
    case 'NOOK':
      return answer({ id: req.id });
    case 'STDERR':
      process.stderr.write('serve-stub: a diagnostic line\n');
      break;
    default:
      break;
  }
  answer({ id: req.id, ok: true, result: doc(sql, req.profile ?? 'runtime') });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).replace(/\r$/, '');
    buffer = buffer.slice(nl + 1);
    handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
