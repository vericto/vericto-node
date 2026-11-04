// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vercel AI SDK (`ai` 7) end to end: the real `tool()` / `generateText`, the AI SDK's
 * scripted test model (no model calls), SQLite through better-sqlite3 and the local
 * Runtime API stand-in.
 */
import Database from 'better-sqlite3';
import { generateText, isStepCount, jsonSchema, tool, type ToolExecutionOptions } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VerictoBlockedError, VerictoConfigError, VerictoUnavailableError, type Verdict } from '../src/index.js';
import {
  guardSqlTool,
  isVerictoRefusal,
  sqlTool,
  throwOnVerictoError,
  type SqlToolResult,
  type VerictoRefusal,
} from '../src/ai.js';
import { withOfflineGuard } from './fake-serve.js';
import { FakeVericto, blocked, flagged, masked } from './fake-vericto.js';

let fake: FakeVericto;
let db: Database.Database;

beforeEach(async () => {
  fake = await new FakeVericto().start();
  db = new Database(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
  db.exec("INSERT INTO users VALUES (1, 'ana@example.com'), (2, 'bo@example.com')");
});
afterEach(async () => {
  db.close();
  await fake.stop();
});

const CALL: ToolExecutionOptions<Record<string, unknown>> = { toolCallId: 'call-1', messages: [], context: {} };
const count = () => (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
const unavailable = () => {
  for (let i = 0; i < 3; i++) fake.queue.push({ status: 503, body: {} });
};

/** The scripted model: one tool call per SQL, then a final answer. */
function scriptedModel(tool: string, statements: string[]): MockLanguageModelV4 {
  const calls = [...statements];
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const sql = calls.shift();
      return {
        content: sql
          ? [{ type: 'tool-call', toolCallId: `call-${String(calls.length)}`, toolName: tool, input: JSON.stringify({ sql }) }]
          : [{ type: 'text', text: 'Done.' }],
        finishReason: { unified: sql ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

function rowsTool(guard: { vericto?: ReturnType<FakeVericto['guard']> } = {}) {
  return sqlTool({
    dialect: 'better-sqlite3',
    vericto: guard.vericto ?? fake.guard(),
    execute: (sql) => db.prepare(sql).all(),
  });
}

describe('sqlTool', () => {
  it('runs an allowed query, checked as the dialect given, and reports the verdict', async () => {
    const runSql = rowsTool();
    const out = await runSql.execute({ sql: 'SELECT id FROM users ORDER BY id' }, CALL);
    expect(out).toEqual({
      result: [{ id: 1 }, { id: 2 }],
      vericto: { decision: 'ALLOWED', rule_code: null, severity: null, approved_query: null, note: null },
    });
    expect(fake.requests.map((r) => [r.query, r.dialect])).toEqual([['SELECT id FROM users ORDER BY id', 'sqlite']]);
    expect(runSql.description).toContain('(sqlite)');
  });

  it('returns a structured refusal when blocked, and the SQL never runs', async () => {
    fake.on((sql) => sql === 'DELETE FROM users', blocked('VERICTO-001', 'DELETE FROM users WHERE id = 1'));
    const execute = vi.fn((sql: string) => db.prepare(sql).run());
    const runSql = sqlTool({ dialect: 'sqlite', vericto: fake.guard(), execute });
    const out = await runSql.execute({ sql: 'DELETE FROM users' }, CALL);
    expect(execute).not.toHaveBeenCalled();
    expect(count()).toBe(2);
    expect(isVerictoRefusal(out)).toBe(true);
    const refusal = out as VerictoRefusal;
    expect(refusal).toMatchObject({
      decision: 'BLOCKED',
      executed: false,
      rule_code: 'VERICTO-001',
      severity: 'critical',
      reason: null,
      suggested_fix: 'DELETE FROM users WHERE id = 1',
      access_denied: [],
      event_id: 'evt-blocked',
    });
    expect(refusal.message).toContain('NOT executed');
    expect(refusal.message).toContain('Suggested fix: DELETE FROM users WHERE id = 1');
  });

  it("throws VerictoBlockedError with onBlock: 'raise'", async () => {
    fake.on((sql) => sql.startsWith('DELETE'), blocked());
    const runSql = sqlTool({ dialect: 'sqlite', vericto: fake.guard(), onBlock: 'raise', execute: (sql) => db.prepare(sql).run() });
    await expect(runSql.execute({ sql: 'DELETE FROM users' }, CALL)).rejects.toBeInstanceOf(VerictoBlockedError);
    expect(count()).toBe(2);
  });

  it('runs a flagged query and reports it (to the model and to onVerdict)', async () => {
    fake.on(() => true, flagged('VERICTO-030'));
    const seen: Verdict[] = [];
    const runSql = rowsTool({ vericto: fake.guard({ onVerdict: (v) => seen.push(v) }) });
    const out = (await runSql.execute({ sql: 'SELECT * FROM users' }, CALL)) as SqlToolResult<unknown[]>;
    expect(out.result).toHaveLength(2);
    expect(out.vericto).toMatchObject({ decision: 'FLAGGED', rule_code: 'VERICTO-030', severity: 'medium' });
    expect(seen.map((v) => v.decision)).toEqual(['FLAGGED']);
  });

  it('runs the approved query instead of the original (mask, LIMIT bound)', async () => {
    fake.on((sql) => sql.startsWith('SELECT email'), masked("SELECT '***' AS email FROM users LIMIT 1"));
    const ran: string[] = [];
    const runSql = sqlTool({
      dialect: 'sqlite',
      vericto: fake.guard(),
      execute: (sql) => {
        ran.push(sql);
        return db.prepare(sql).all();
      },
    });
    const out = (await runSql.execute({ sql: 'SELECT email FROM users' }, CALL)) as SqlToolResult<unknown[]>;
    expect(ran).toEqual(["SELECT '***' AS email FROM users LIMIT 1"]);
    expect(out.result).toEqual([{ email: '***' }]);
    expect(out.vericto.approved_query).toBe("SELECT '***' AS email FROM users LIMIT 1");
  });

  it('fails closed: no verdict throws VerictoUnavailableError and nothing runs', async () => {
    unavailable();
    const execute = vi.fn();
    const runSql = sqlTool({ dialect: 'sqlite', vericto: fake.guard(), execute });
    await expect(runSql.execute({ sql: 'SELECT 1' }, CALL)).rejects.toBeInstanceOf(VerictoUnavailableError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails open when the guard does: runs unevaluated and says so', async () => {
    unavailable();
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const runSql = rowsTool({ vericto: fake.guard({ failMode: 'open' }) });
    const out = (await runSql.execute({ sql: 'SELECT id FROM users WHERE id = 1' }, CALL)) as SqlToolResult<unknown[]>;
    expect(out.result).toEqual([{ id: 1 }]);
    expect(out.vericto.decision).toBe('UNEVALUATED');
    expect(out.vericto.note).toMatch(/HTTP 503/);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('a configuration error throws in both fail modes', async () => {
    for (const failMode of ['closed', 'open'] as const) {
      fake.queue.push({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } } });
      const runSql = rowsTool({ vericto: fake.guard({ failMode }) });
      await expect(runSql.execute({ sql: 'SELECT 1' }, CALL)).rejects.toBeInstanceOf(VerictoConfigError);
    }
  });

  it('reuses the guard cache: an unchanged query is not evaluated again', async () => {
    const runSql = rowsTool({ vericto: fake.guard({ cacheTtlMs: 60_000 }) });
    await runSql.execute({ sql: 'SELECT id FROM users' }, CALL);
    await runSql.execute({ sql: 'SELECT id FROM users' }, CALL);
    expect(fake.requests).toHaveLength(1);
  });

  it('sends context and endUser, fixed or read per call from the input and the call options', async () => {
    const endUser = vi.fn((_input: { sql: string }, options: ToolExecutionOptions<{ userId: string }>) => ({
      id: options.context.userId,
    }));
    const runSql = sqlTool<unknown, { userId: string }>({
      dialect: 'sqlite',
      vericto: fake.guard(),
      context: { ticket: 'CHG-1', tenant: 'acme' },
      endUser,
      execute: (sql) => db.prepare(sql).all(),
    });
    await runSql.execute({ sql: 'SELECT 1' }, { toolCallId: 'c', messages: [], context: { userId: 'u-7' } });
    expect(fake.requests[0]).toMatchObject({ context: { ticket: 'CHG-1', tenant: 'acme' }, end_user: { id: 'u-7' } });
    expect(endUser).toHaveBeenCalledWith({ sql: 'SELECT 1' }, expect.objectContaining({ toolCallId: 'c' }));
  });

  it('validates its options when it is built', () => {
    const vericto = fake.guard();
    const execute = () => [];
    expect(() => sqlTool({ dialect: '', vericto, execute })).toThrow(VerictoConfigError);
    expect(() => sqlTool({ vericto, execute } as never)).toThrow(/needs \{ dialect \}/);
    expect(() => sqlTool(undefined as never)).toThrow(VerictoConfigError);
    expect(() => sqlTool({ dialect: 'sqlite', vericto, execute, onBlock: 'ignore' as never })).toThrow(/onBlock/);
    expect(() => sqlTool({ dialect: 'sqlite', vericto, execute, context: { ticket: '' } })).toThrow(VerictoConfigError);
    expect(() => sqlTool({ dialect: 'sqlite', vericto } as never)).toThrow(/execute/);
    expect(sqlTool({ dialect: 'sqlite', vericto, execute, description: 'Mine.' }).description).toBe('Mine.');
  });

  it('builds its guard from the VERICTO_* environment by default', () => {
    vi.stubEnv('VERICTO_API_KEY', '');
    expect(() => sqlTool({ dialect: 'sqlite', execute: () => [] })).toThrow(VerictoConfigError);
    vi.unstubAllEnvs();
  });

  it('a non-string sql never runs', async () => {
    const execute = vi.fn();
    const runSql = sqlTool({ dialect: 'sqlite', vericto: fake.guard(), execute });
    await expect(runSql.execute({ sql: 42 } as never, CALL)).rejects.toThrow(/no SQL text at 'sql' \(got number\)/);
    await expect(runSql.execute(null as never, CALL)).rejects.toThrow(/got undefined/);
    expect(execute).not.toHaveBeenCalled();
    expect(fake.requests).toEqual([]);
  });
});

describe('sqlTool with generateText', () => {
  it('the model gets the rows, then the refusal; the DELETE never runs', async () => {
    fake.on((sql) => sql === 'DELETE FROM users', blocked('VERICTO-001', 'DELETE FROM users WHERE <condition>'));
    const result = await generateText({
      model: scriptedModel('runSql', ['SELECT id FROM users ORDER BY id', 'DELETE FROM users']),
      tools: { runSql: rowsTool() },
      stopWhen: isStepCount(5),
      prompt: 'Clean up the users table',
    });
    throwOnVerictoError(result);
    const outputs = result.steps.flatMap((s) => s.toolResults.map((r) => r.output));
    expect(outputs[0]).toMatchObject({ result: [{ id: 1 }, { id: 2 }], vericto: { decision: 'ALLOWED' } });
    expect(outputs[1]).toMatchObject({ decision: 'BLOCKED', executed: false, rule_code: 'VERICTO-001' });
    expect(result.text).toBe('Done.');
    expect(count()).toBe(2);
  });

  it('fail closed: the AI SDK reports a tool-error, and throwOnVerictoError surfaces it', async () => {
    unavailable();
    const result = await generateText({
      model: scriptedModel('runSql', ['SELECT 1']),
      tools: { runSql: rowsTool() },
      stopWhen: isStepCount(3),
      prompt: 'q',
    });
    expect(() => {
      throwOnVerictoError(result);
    }).toThrow(VerictoUnavailableError);
  });
});

describe('guardSqlTool', () => {
  it('guards an existing tool: allowed runs, blocked returns the refusal without calling execute', async () => {
    fake.on((sql) => sql.startsWith('DROP'), blocked('VERICTO-010'));
    const execute = vi.fn(({ query, params }: { query: string; params: unknown[] }) => db.prepare(query).all(...params));
    const mine = tool({
      description: 'Run SQL with bind parameters.',
      inputSchema: jsonSchema<{ query: string; params: unknown[] }>({
        type: 'object',
        properties: { query: { type: 'string' }, params: { type: 'array' } },
        required: ['query', 'params'],
      }),
      execute,
    });
    const guarded = guardSqlTool(mine, { dialect: 'sqlite', vericto: fake.guard(), sqlKey: 'query' });
    expect(guarded.description).toBe('Run SQL with bind parameters.');
    expect(guarded).not.toBe(mine);

    expect(await guarded.execute({ query: 'SELECT id FROM users WHERE id = ?', params: [2] }, CALL)).toEqual([{ id: 2 }]);
    expect(execute).toHaveBeenLastCalledWith({ query: 'SELECT id FROM users WHERE id = ?', params: [2] }, CALL);

    const out = await guarded.execute({ query: 'DROP TABLE users', params: [] }, CALL);
    expect(out).toMatchObject({ decision: 'BLOCKED', rule_code: 'VERICTO-010', suggested_fix: null });
    expect((out as VerictoRefusal).message).toContain('Do not retry the same query.');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(count()).toBe(2);
  });

  it('passes the approved query, keeping the other input fields (bind parameters)', async () => {
    fake.on((sql) => sql.startsWith('SELECT email'), masked("SELECT '***' AS email FROM users WHERE id = ?"));
    const execute = vi.fn(({ sql, params }: { sql: string; params: unknown[] }) => db.prepare(sql).all(...params));
    const guarded = guardSqlTool(
      tool({ inputSchema: jsonSchema<{ sql: string; params: unknown[] }>({ type: 'object' }), execute }),
      { dialect: 'sqlite', vericto: fake.guard() },
    );
    expect(await guarded.execute({ sql: 'SELECT email FROM users WHERE id = ?', params: [1] }, CALL)).toEqual([
      { email: '***' },
    ]);
    expect(execute.mock.calls[0]?.[0]).toEqual({ sql: "SELECT '***' AS email FROM users WHERE id = ?", params: [1] });
  });

  it('keeps toModelOutput for results and sends a refusal as JSON', async () => {
    fake.on((sql) => sql.startsWith('DELETE'), blocked());
    const toModelOutput = vi.fn(({ output }: { output: unknown }) => ({ type: 'text' as const, value: JSON.stringify(output) }));
    const guarded = guardSqlTool(
      tool({
        inputSchema: jsonSchema<{ sql: string }>({ type: 'object' }),
        execute: ({ sql }: { sql: string }) => db.prepare(sql).all(),
        toModelOutput,
      }),
      { dialect: 'sqlite', vericto: fake.guard() },
    );
    const convert = guarded.toModelOutput!;
    const refusal = await guarded.execute({ sql: 'DELETE FROM users' }, CALL);
    expect(await convert({ toolCallId: 'c', input: { sql: 'DELETE FROM users' }, output: refusal })).toMatchObject({
      type: 'json',
      value: { decision: 'BLOCKED' },
    });
    expect(toModelOutput).not.toHaveBeenCalled();
    expect(await convert({ toolCallId: 'c', input: { sql: 'x' }, output: [{ id: 1 }] })).toEqual({ type: 'text', value: '[{"id":1}]' });
    expect(guardSqlTool(tool({ inputSchema: jsonSchema<{ sql: string }>({}), execute: () => 1 }), { dialect: 'sqlite', vericto: fake.guard() }).toModelOutput).toBeUndefined();
  });

  it('collects a streaming tool to its final output', async () => {
    const guarded = guardSqlTool(
      tool({
        inputSchema: jsonSchema<{ sql: string }>({ type: 'object' }),
        async *execute({ sql }: { sql: string }) {
          yield { status: 'running' as const, rows: [] as unknown[] };
          yield { status: 'done' as const, rows: db.prepare(sql).all() };
        },
      }),
      { dialect: 'sqlite', vericto: fake.guard() },
    );
    expect(await guarded.execute({ sql: 'SELECT id FROM users WHERE id = 1' }, CALL)).toEqual({ status: 'done', rows: [{ id: 1 }] });
  });

  it('works inside generateText, and fail closed reaches your code', async () => {
    fake.on((sql) => sql === 'DELETE FROM users', blocked());
    const guarded = guardSqlTool(
      tool({
        inputSchema: jsonSchema<{ sql: string }>({ type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] }),
        execute: ({ sql }: { sql: string }) => db.prepare(sql).all(),
      }),
      { dialect: 'sqlite', vericto: fake.guard() },
    );
    const result = await generateText({
      model: scriptedModel('runSql', ['DELETE FROM users']),
      tools: { runSql: guarded },
      stopWhen: isStepCount(3),
      prompt: 'q',
    });
    expect(result.steps[0]?.toolResults[0]?.output).toMatchObject({ decision: 'BLOCKED' });
    expect(count()).toBe(2);
  });

  it('refuses a tool without execute', () => {
    const noExecute = { inputSchema: jsonSchema<{ sql: string }>({}), outputSchema: jsonSchema({}) };
    expect(() => guardSqlTool(noExecute as never, { dialect: 'sqlite', vericto: fake.guard() })).toThrow(/execute function/);
  });
});

describe('throwOnVerictoError', () => {
  it('ignores other errors and results', () => {
    expect(() => {
      throwOnVerictoError({ steps: [{ content: [{ type: 'text' }, { type: 'tool-error', error: new Error('x') }] }] });
    }).not.toThrow();
  });
});

describe('offline (a local vericto serve)', () => {
  it('sqlTool works unchanged with an offline client: allowed runs, blocked is refused', async () => {
    await withOfflineGuard(async (vericto) => {
      const execute = vi.fn((sql: string) => db.prepare(sql).all());
      const runSql = sqlTool({ dialect: 'better-sqlite3', vericto, execute });
      expect(await runSql.execute({ sql: 'SELECT id FROM users ORDER BY id' }, CALL)).toEqual({
        result: [{ id: 1 }, { id: 2 }],
        vericto: { decision: 'ALLOWED', rule_code: null, severity: null, approved_query: null, note: null },
      });
      const out = await runSql.execute({ sql: 'DELETE FROM users' }, CALL);
      expect(isVerictoRefusal(out)).toBe(true);
      expect(out).toMatchObject({ decision: 'BLOCKED', executed: false, rule_code: 'VERICTO-001', event_id: null });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(count()).toBe(2);
    });
  }, 30_000);
});
