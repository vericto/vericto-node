// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mastra (`@mastra/core`) end to end: real `createTool` tools and an `Agent` run with
 * the AI SDK's scripted test model (no model calls), SQLite through better-sqlite3 and
 * the local Runtime API stand-in.
 */
import Database from 'better-sqlite3';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { VerictoBlockedError, VerictoConfigError, VerictoUnavailableError } from '../src/index.js';
import {
  guardSqlTool,
  sqlTool,
  verictoErrorOf,
  type MastraToolContext,
  type SqlToolResult,
  type VerictoRefusal,
} from '../src/mastra.js';
import type { VerictoError } from '../src/index.js';
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

const CTX = {} as MastraToolContext;
const count = () => (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
const rows = (sql: string) => db.prepare(sql).all();
const unavailable = () => {
  for (let i = 0; i < 3; i++) fake.queue.push({ status: 503, body: {} });
};

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** A scripted model: one tool call per entry, then "Done." (`agent.generate` calls `doGenerate`). */
function scriptedModel(tool: string, inputs: Record<string, unknown>[]): MockLanguageModelV4 {
  const calls = [...inputs];
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const input = calls.shift();
      return {
        content: input
          ? [{ type: 'tool-call', toolCallId: `call-${String(calls.length)}`, toolName: tool, input: JSON.stringify(input) }]
          : [{ type: 'text', text: 'Done.' }],
        finishReason: { unified: input ? 'tool-calls' : 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

describe('sqlTool', () => {
  it('is a Mastra tool with the Vericto contract in its description', () => {
    const t = sqlTool({ dialect: 'postgresql', vericto: fake.guard(), execute: rows });
    expect(t.id).toBe('run-sql');
    expect(t.description).toContain('(postgres)');
    const mine = sqlTool({ dialect: 'sqlite', vericto: fake.guard(), execute: rows, id: 'query-db', description: 'Mine.' });
    expect([mine.id, mine.description]).toEqual(['query-db', 'Mine.']);
  });

  it('runs allowed, flagged and approved queries; blocks the rest without running them', async () => {
    fake.on((sql) => sql === 'DELETE FROM users', blocked('VERICTO-001', 'DELETE FROM users WHERE <condition>'));
    fake.on((sql) => sql.startsWith('SELECT email'), masked("SELECT '***' AS email FROM users WHERE id = 1"));
    fake.on((sql) => sql.startsWith('SELECT *'), flagged());
    const ran: string[] = [];
    const t = sqlTool({
      dialect: 'sqlite',
      vericto: fake.guard(),
      execute: (sql) => {
        ran.push(sql);
        return rows(sql);
      },
    });
    expect(await t.execute({ sql: 'SELECT id FROM users WHERE id = 2' }, CTX)).toEqual({
      result: [{ id: 2 }],
      vericto: { decision: 'ALLOWED', rule_code: null, severity: null, approved_query: null, note: null },
    });
    expect(((await t.execute({ sql: 'SELECT * FROM users' }, CTX)) as SqlToolResult<unknown[]>).vericto.decision).toBe('FLAGGED');
    const approved = (await t.execute({ sql: 'SELECT email FROM users WHERE id = 1' }, CTX)) as SqlToolResult<unknown[]>;
    expect(approved.result).toEqual([{ email: '***' }]);
    expect(approved.vericto.approved_query).toBe("SELECT '***' AS email FROM users WHERE id = 1");
    const refusal = (await t.execute({ sql: 'DELETE FROM users' }, CTX)) as VerictoRefusal;
    expect(refusal).toMatchObject({ decision: 'BLOCKED', executed: false, rule_code: 'VERICTO-001' });
    expect(ran).toEqual(['SELECT id FROM users WHERE id = 2', 'SELECT * FROM users', "SELECT '***' AS email FROM users WHERE id = 1"]);
    expect(count()).toBe(2);
  });

  it('fails closed, fails open when the guard does, raises on block when asked', async () => {
    unavailable();
    const execute = vi.fn(rows);
    await expect(sqlTool({ dialect: 'sqlite', vericto: fake.guard(), execute }).execute({ sql: 'SELECT 1' }, CTX)).rejects.toBeInstanceOf(
      VerictoUnavailableError,
    );
    expect(execute).not.toHaveBeenCalled();

    unavailable();
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const open = sqlTool({ dialect: 'sqlite', vericto: fake.guard({ failMode: 'open' }), execute: rows });
    expect(((await open.execute({ sql: 'SELECT 1 AS one' }, CTX)) as SqlToolResult<unknown[]>).vericto.decision).toBe('UNEVALUATED');
    warn.mockRestore();

    fake.on(() => true, blocked());
    const raising = sqlTool({ dialect: 'sqlite', vericto: fake.guard(), onBlock: 'raise', execute: rows });
    await expect(raising.execute({ sql: 'DELETE FROM users' }, CTX)).rejects.toBeInstanceOf(VerictoBlockedError);
  });

  it('sends context and endUser read from the request context', async () => {
    const t = sqlTool({
      dialect: 'sqlite',
      vericto: fake.guard(),
      endUser: (_input, context) => ({ id: String((context as { requestContext?: Map<string, unknown> }).requestContext?.get('userId')) }),
      execute: rows,
    });
    await t.execute({ sql: 'SELECT 1' }, { requestContext: new Map([['userId', 'u-3']]) } as unknown as MastraToolContext);
    expect(fake.requests[0]?.end_user).toEqual({ id: 'u-3' });
  });

  it('validates its options when it is built', () => {
    expect(() => sqlTool({ vericto: fake.guard(), execute: rows } as never)).toThrow(VerictoConfigError);
    expect(() => sqlTool({ dialect: 'sqlite', vericto: fake.guard() } as never)).toThrow(/execute/);
  });

  it('in an Agent run: the model gets the rows, then the refusal, and the DELETE never runs', async () => {
    fake.on((sql) => sql === 'DELETE FROM users', blocked('VERICTO-001'));
    const agent = new Agent({
      id: 'sql-agent',
      name: 'SQL agent',
      instructions: 'Answer with SQL.',
      model: scriptedModel('runSql', [{ sql: 'SELECT id FROM users ORDER BY id' }, { sql: 'DELETE FROM users' }]),
      tools: { runSql: sqlTool({ dialect: 'sqlite', vericto: fake.guard(), execute: rows }) },
    });
    const result = await agent.generate('Clean up the users table', { maxSteps: 5 });
    const results = result.steps.flatMap((s) => s.toolResults).map((r) => (r as { payload?: { result: unknown } }).payload?.result ?? (r as { output?: unknown }).output);
    expect(results[0]).toMatchObject({ result: [{ id: 1 }, { id: 2 }], vericto: { decision: 'ALLOWED' } });
    expect(results[1]).toMatchObject({ decision: 'BLOCKED', executed: false, rule_code: 'VERICTO-001' });
    expect(result.text).toBe('Done.');
    expect(count()).toBe(2);
  });
});

describe('sqlTool, fail closed in an Agent run', () => {
  it('nothing runs, and the tool-error chunk carries the VerictoUnavailableError', async () => {
    unavailable();
    const execute = vi.fn(rows);
    const agent = new Agent({
      id: 'sql-agent',
      name: 'SQL agent',
      instructions: 'Answer with SQL.',
      model: scriptedModel('runSql', [{ sql: 'SELECT 1' }]),
      tools: { runSql: sqlTool({ dialect: 'sqlite', vericto: fake.guard(), execute }) },
    });
    let failure: VerictoError | undefined;
    await agent.generate('q', {
      maxSteps: 3,
      onChunk: (chunk) => {
        if (chunk.type === 'tool-error') failure ??= verictoErrorOf(chunk.payload.error);
      },
    });
    expect(failure).toBeInstanceOf(VerictoUnavailableError);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('guardSqlTool', () => {
  function myTool() {
    const execute = vi.fn(async ({ query, params }: { query: string; params: (string | number)[] }) => ({ rows: db.prepare(query).all(...params) }));
    const t = createTool({
      id: 'query-db',
      description: 'Run SQL with bind parameters.',
      inputSchema: z.object({ query: z.string(), params: z.array(z.union([z.string(), z.number()])) }),
      execute,
    });
    return { t, execute };
  }

  it('guards an existing tool: same class and fields, a blocked query never reaches execute', async () => {
    fake.on((sql) => sql.startsWith('DROP'), blocked('VERICTO-010'));
    const { t, execute } = myTool();
    const guarded = guardSqlTool(t, { dialect: 'sqlite', vericto: fake.guard(), sqlKey: 'query' });
    expect(guarded).toBeInstanceOf(t.constructor);
    expect([guarded.id, guarded.description, guarded.inputSchema]).toEqual([t.id, t.description, t.inputSchema]);
    expect(guarded.execute).not.toBe(t.execute);

    expect(await guarded.execute({ query: 'SELECT id FROM users WHERE id = ?', params: [1] }, CTX)).toEqual({ rows: [{ id: 1 }] });
    expect(await guarded.execute({ query: 'DROP TABLE users', params: [] }, CTX)).toMatchObject({ decision: 'BLOCKED', rule_code: 'VERICTO-010' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(count()).toBe(2);
  });

  it('passes the approved query and keeps the other input fields', async () => {
    fake.on((sql) => sql.startsWith('SELECT email'), masked("SELECT '***' AS email FROM users WHERE id = ?"));
    const { t, execute } = myTool();
    const guarded = guardSqlTool(t, { dialect: 'sqlite', vericto: fake.guard(), sqlKey: 'query' });
    expect(await guarded.execute({ query: 'SELECT email FROM users WHERE id = ?', params: [2] }, CTX)).toEqual({ rows: [{ email: '***' }] });
    expect(execute.mock.calls[0]?.[0]).toEqual({ query: "SELECT '***' AS email FROM users WHERE id = ?", params: [2] });
  });

  it('fails closed, and a missing SQL field never runs', async () => {
    unavailable();
    const { t, execute } = myTool();
    const guarded = guardSqlTool(t, { dialect: 'sqlite', vericto: fake.guard(), sqlKey: 'query' });
    await expect(guarded.execute({ query: 'SELECT 1', params: [] }, CTX)).rejects.toBeInstanceOf(VerictoUnavailableError);
    await expect(guardSqlTool(t, { dialect: 'sqlite', vericto: fake.guard() }).execute({ query: 'SELECT 1', params: [] }, CTX)).rejects.toThrow(
      /no SQL text at 'sql'/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a tool without execute', () => {
    const noExecute = createTool({ id: 'x', description: 'x' });
    expect(() => guardSqlTool(noExecute, { dialect: 'sqlite', vericto: fake.guard() })).toThrow(/execute function/);
  });

  it('works in an Agent run', async () => {
    fake.on((sql) => sql.startsWith('DROP'), blocked('VERICTO-010'));
    const { t, execute } = myTool();
    const agent = new Agent({
      id: 'sql-agent',
      name: 'SQL agent',
      instructions: 'Answer with SQL.',
      model: scriptedModel('queryDb', [{ query: 'DROP TABLE users', params: [] }]),
      tools: { queryDb: guardSqlTool(t, { dialect: 'sqlite', vericto: fake.guard(), sqlKey: 'query' }) },
    });
    const result = await agent.generate('q', { maxSteps: 3 });
    const results = result.steps.flatMap((s) => s.toolResults).map((r) => (r as { payload?: { result: unknown } }).payload?.result ?? (r as { output?: unknown }).output);
    expect(results[0]).toMatchObject({ decision: 'BLOCKED', rule_code: 'VERICTO-010' });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('offline (a local vericto serve)', () => {
  it('sqlTool works unchanged with an offline client: allowed runs, blocked is refused', async () => {
    await withOfflineGuard(async (vericto) => {
      const ran: string[] = [];
      const t = sqlTool({
        dialect: 'sqlite',
        vericto,
        execute: (sql) => {
          ran.push(sql);
          return rows(sql);
        },
      });
      expect(await t.execute({ sql: 'SELECT id FROM users WHERE id = 2' }, CTX)).toMatchObject({
        result: [{ id: 2 }],
        vericto: { decision: 'ALLOWED' },
      });
      expect(await t.execute({ sql: 'DELETE FROM users' }, CTX)).toMatchObject({
        decision: 'BLOCKED',
        executed: false,
        rule_code: 'VERICTO-001',
      });
      expect(ran).toEqual(['SELECT id FROM users WHERE id = 2']);
      expect(count()).toBe(2);
    });
  }, 30_000);
});
