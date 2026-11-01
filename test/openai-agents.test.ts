// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI Agents SDK (`@openai/agents`) end to end: real `Agent` / `run` / `tool()` and
 * tool input guardrails, a scripted `Model` (no model calls, no OpenAI key), SQLite
 * through better-sqlite3 and the local Runtime API stand-in.
 */
import Database from 'better-sqlite3';
import {
  Agent,
  RunContext,
  Usage,
  run,
  setTracingDisabled,
  tool,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type RunToolCallOutputItem,
  type ToolInputGuardrailData,
} from '@openai/agents';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { VerictoBlockedError, VerictoConfigError, VerictoUnavailableError } from '../src/index.js';
import {
  sqlTool,
  verictoErrorOf,
  verictoToolInputGuardrail,
  type SqlToolResult,
  type VerictoRefusal,
} from '../src/openai-agents.js';
import { FakeVericto, blocked, flagged, masked } from './fake-vericto.js';

let fake: FakeVericto;
let db: Database.Database;

beforeAll(() => {
  setTracingDisabled(true);
});
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

const count = () => (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
const unavailable = () => {
  for (let i = 0; i < 3; i++) fake.queue.push({ status: 503, body: {} });
};

/** A scripted model: one tool call per entry, then "Done.". Records what it was sent. */
class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  readonly #calls: { name: string; args: Record<string, unknown> }[];
  constructor(calls: { name: string; args: Record<string, unknown> }[]) {
    this.#calls = [...calls];
  }
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const next = this.#calls.shift();
    return {
      usage: new Usage(),
      output: next
        ? [{ type: 'function_call', callId: `call-${String(this.requests.length)}`, name: next.name, arguments: JSON.stringify(next.args), status: 'completed' }]
        : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] }],
    };
  }
  // eslint-disable-next-line require-yield
  async *getStreamedResponse(): AsyncIterable<never> {
    throw new Error('not used');
  }
}

/** The tool outputs of a run, parsed when they are JSON. */
function outputs(items: readonly { type: string }[]): unknown[] {
  return items
    .filter((i): i is RunToolCallOutputItem => i.type === 'tool_call_output_item')
    .map((i) => (typeof i.output === 'string' && /^[[{]/.test(i.output) ? (JSON.parse(i.output) as unknown) : i.output));
}

const rows = (sql: string) => db.prepare(sql).all();

/** What a run rejected with, unwrapped by verictoErrorOf. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return verictoErrorOf(err) ?? err;
  }
  throw new Error('the run did not reject');
}

describe('sqlTool', () => {
  it('is a strict run_sql function tool with the Vericto contract in its description', () => {
    const t = sqlTool({ dialect: 'pg', vericto: fake.guard(), execute: rows });
    expect(t.type).toBe('function');
    expect(t.name).toBe('run_sql');
    expect(t.strict).toBe(true);
    expect(t.parameters).toMatchObject({ required: ['sql'], additionalProperties: false });
    expect(t.description).toContain('(postgres)');
    const named = sqlTool({ dialect: 'sqlite', vericto: fake.guard(), execute: rows, name: 'query_db', description: 'Mine.' });
    expect([named.name, named.description]).toEqual(['query_db', 'Mine.']);
  });

  it('runs allowed queries and blocks the rest in a real run; the DELETE never runs', async () => {
    fake.on((sql) => sql === 'DELETE FROM users', blocked('VERICTO-001', 'DELETE FROM users WHERE <condition>'));
    const model = new ScriptedModel([
      { name: 'run_sql', args: { sql: 'SELECT id FROM users ORDER BY id' } },
      { name: 'run_sql', args: { sql: 'DELETE FROM users' } },
    ]);
    const agent = new Agent({ name: 'sql', model, tools: [sqlTool({ dialect: 'sqlite', vericto: fake.guard(), execute: rows })] });
    const result = await run(agent, 'Clean up the users table');
    expect(result.finalOutput).toBe('Done.');
    const [first, second] = outputs(result.newItems);
    expect(first).toEqual({
      result: [{ id: 1 }, { id: 2 }],
      vericto: { decision: 'ALLOWED', rule_code: null, severity: null, approved_query: null, note: null },
    });
    expect(second).toMatchObject({
      decision: 'BLOCKED',
      executed: false,
      rule_code: 'VERICTO-001',
      suggested_fix: 'DELETE FROM users WHERE <condition>',
    });
    expect((second as VerictoRefusal).message).toContain('NOT executed');
    expect(count()).toBe(2);
  });

  it('runs a flagged query, and the approved query instead of the original', async () => {
    fake.on((sql) => sql.startsWith('SELECT email'), masked("SELECT '***' AS email FROM users WHERE id = 1"));
    fake.on(() => true, flagged());
    const ran: string[] = [];
    const t = sqlTool({
      dialect: 'sqlite',
      vericto: fake.guard(),
      execute: (sql) => {
        ran.push(sql);
        return rows(sql);
      },
    });
    const ctx = new RunContext();
    const masked1 = (await t.invoke(ctx, JSON.stringify({ sql: 'SELECT email FROM users WHERE id = 1' }))) as SqlToolResult<unknown[]>;
    expect(masked1.result).toEqual([{ email: '***' }]);
    expect(masked1.vericto.approved_query).toBe("SELECT '***' AS email FROM users WHERE id = 1");
    const flagged1 = (await t.invoke(ctx, JSON.stringify({ sql: 'SELECT * FROM users' }))) as SqlToolResult<unknown[]>;
    expect(flagged1.vericto).toMatchObject({ decision: 'FLAGGED', rule_code: 'VERICTO-030' });
    expect(ran).toEqual(["SELECT '***' AS email FROM users WHERE id = 1", 'SELECT * FROM users']);
  });

  it('fails closed: the run rejects with VerictoUnavailableError, never as text for the model', async () => {
    unavailable();
    const execute = vi.fn(rows);
    const model = new ScriptedModel([{ name: 'run_sql', args: { sql: 'SELECT 1' } }]);
    const agent = new Agent({ name: 'sql', model, tools: [sqlTool({ dialect: 'sqlite', vericto: fake.guard(), execute })] });
    expect(await rejection(run(agent, 'q'))).toBeInstanceOf(VerictoUnavailableError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails open when the guard does', async () => {
    unavailable();
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const t = sqlTool({ dialect: 'sqlite', vericto: fake.guard({ failMode: 'open' }), execute: rows });
    const out = (await t.invoke(new RunContext(), JSON.stringify({ sql: 'SELECT id FROM users WHERE id = 2' }))) as SqlToolResult<unknown[]>;
    expect(out.result).toEqual([{ id: 2 }]);
    expect(out.vericto.decision).toBe('UNEVALUATED');
    warn.mockRestore();
  });

  it("onBlock: 'raise' and configuration errors reject; other errors go to errorFunction", async () => {
    fake.on((sql) => sql.startsWith('DELETE'), blocked());
    const raising = sqlTool({ dialect: 'sqlite', vericto: fake.guard(), onBlock: 'raise', execute: rows });
    await expect(raising.invoke(new RunContext(), JSON.stringify({ sql: 'DELETE FROM users' }))).rejects.toBeInstanceOf(VerictoBlockedError);

    fake.queue.push({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } } });
    const open = sqlTool({ dialect: 'sqlite', vericto: fake.guard({ failMode: 'open' }), execute: rows });
    await expect(open.invoke(new RunContext(), JSON.stringify({ sql: 'SELECT 1' }))).rejects.toBeInstanceOf(VerictoConfigError);

    const failing = sqlTool({ dialect: 'sqlite', vericto: fake.guard(), execute: () => { throw new Error('no such table: nope'); } });
    expect(await failing.invoke(new RunContext(), JSON.stringify({ sql: 'SELECT 1' }))).toBe(
      'An error occurred while running the tool. Please try again.',
    );
    const mine = sqlTool({
      dialect: 'sqlite',
      vericto: fake.guard(),
      execute: () => { throw new Error('no such table: nope'); },
      errorFunction: (_ctx, err) => `SQL error: ${(err as Error).message}`,
    });
    expect(await mine.invoke(new RunContext(), JSON.stringify({ sql: 'SELECT 1' }))).toBe('SQL error: no such table: nope');
  });

  it('sends context and endUser read from the run context', async () => {
    const t = sqlTool<unknown, { tenant: string }>({
      dialect: 'sqlite',
      vericto: fake.guard(),
      context: (_input, runContext) => ({ tenant: runContext?.context.tenant }),
      endUser: { id: 'u-1' },
      execute: rows,
    });
    await t.invoke(new RunContext({ tenant: 'acme' }), JSON.stringify({ sql: 'SELECT 1' }));
    expect(fake.requests[0]).toMatchObject({ context: { tenant: 'acme' }, end_user: { id: 'u-1' } });
  });

  it('validates its options when it is built', () => {
    const vericto = fake.guard();
    expect(() => sqlTool({ vericto, execute: rows } as never)).toThrow(VerictoConfigError);
    expect(() => sqlTool({ dialect: 'sqlite', vericto } as never)).toThrow(/execute/);
    expect(() => sqlTool({ dialect: 'sqlite', vericto, execute: rows, endUser: { 'bad key': 'x' } })).toThrow(VerictoConfigError);
  });
});

describe('verictoErrorOf', () => {
  it('finds a Vericto error through error / cause, and nothing else', () => {
    const vericto = new VerictoUnavailableError('down');
    expect(verictoErrorOf(vericto)).toBe(vericto);
    expect(verictoErrorOf({ error: { cause: vericto } })).toBe(vericto);
    expect(verictoErrorOf(new Error('x'))).toBeUndefined();
    expect(verictoErrorOf('text')).toBeUndefined();
    expect(verictoErrorOf(undefined)).toBeUndefined();
    const loop: { error?: unknown } = {};
    loop.error = loop;
    expect(verictoErrorOf(loop)).toBeUndefined();
  });
});

describe('verictoToolInputGuardrail', () => {
  /** The user's own tool, with bind parameters, guarded by the input guardrail. */
  function guardedTool(options: Partial<Parameters<typeof verictoToolInputGuardrail>[0]> = {}) {
    const execute = vi.fn(({ query, params }: { query: string; params: (string | number)[] }) => JSON.stringify(db.prepare(query).all(...params)));
    const t = tool({
      name: 'query_db',
      description: 'Run SQL with bind parameters.',
      parameters: z.object({ query: z.string(), params: z.array(z.union([z.string(), z.number()])) }),
      execute,
      inputGuardrails: [verictoToolInputGuardrail({ dialect: 'sqlite', vericto: fake.guard(), sqlKey: 'query', ...options })],
    });
    return { t, execute };
  }

  it('allows an allowed query and rejects a blocked one with the refusal; the tool never runs it', async () => {
    fake.on((sql) => sql.startsWith('DROP'), blocked('VERICTO-010'));
    const { t, execute } = guardedTool();
    const model = new ScriptedModel([
      { name: 'query_db', args: { query: 'SELECT id FROM users WHERE id = ?', params: [1] } },
      { name: 'query_db', args: { query: 'DROP TABLE users', params: [] } },
    ]);
    const result = await run(new Agent({ name: 'sql', model, tools: [t] }), 'q');
    const [first, second] = outputs(result.newItems);
    expect(first).toEqual([{ id: 1 }]);
    expect(second).toMatchObject({ decision: 'BLOCKED', executed: false, rule_code: 'VERICTO-010', suggested_fix: null });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(count()).toBe(2);
    expect(result.toolInputGuardrailResults.map((r) => [r.guardrail.name, r.output.behavior.type])).toEqual([
      ['vericto', 'allow'],
      ['vericto', 'rejectContent'],
    ]);
  });

  it('rejects a query that has an approved query with that query, then lets the approved query run', async () => {
    const approved = "SELECT '***' AS email FROM users WHERE id = ?";
    fake.on((sql) => sql.startsWith('SELECT email') || sql === approved, masked(approved));
    const { t, execute } = guardedTool();
    const model = new ScriptedModel([
      { name: 'query_db', args: { query: 'SELECT email FROM users WHERE id = ?', params: [1] } },
      { name: 'query_db', args: { query: approved, params: [1] } },
    ]);
    const result = await run(new Agent({ name: 'sql', model, tools: [t] }), 'q');
    const [first, second] = outputs(result.newItems);
    expect(first).toMatchObject({ decision: 'FLAGGED', executed: false, approved_query: approved });
    expect((first as { message: string }).message).toContain(`Run only this approved query instead: ${approved}`);
    expect(second).toEqual([{ email: '***' }]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ query: approved, params: [1] });
  });

  it('fails closed: the run rejects and the tool does not run', async () => {
    unavailable();
    const { t, execute } = guardedTool();
    const model = new ScriptedModel([{ name: 'query_db', args: { query: 'SELECT 1', params: [] } }]);
    expect(await rejection(run(new Agent({ name: 'sql', model, tools: [t] }), 'q'))).toBeInstanceOf(VerictoUnavailableError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("onBlock: 'raise' rejects the run with VerictoBlockedError", async () => {
    fake.on(() => true, blocked());
    const { t, execute } = guardedTool({ onBlock: 'raise' });
    const model = new ScriptedModel([{ name: 'query_db', args: { query: 'DELETE FROM users', params: [] } }]);
    expect(await rejection(run(new Agent({ name: 'sql', model, tools: [t] }), 'q'))).toBeInstanceOf(VerictoBlockedError);
    expect(execute).not.toHaveBeenCalled();
  });

  /** A guardrail call as the runner makes it. */
  const data = (args: string): ToolInputGuardrailData =>
    ({
      context: new RunContext(),
      agent: new Agent({ name: 'a' }),
      toolCall: { type: 'function_call', callId: 'c', name: 'query_db', arguments: args },
    });

  it('allows arguments that are not JSON (the tool cannot parse them either), and needs the SQL field', async () => {
    const guardrail = verictoToolInputGuardrail({ dialect: 'sqlite', vericto: fake.guard(), name: 'db-guardrails' });
    expect(guardrail).toMatchObject({ type: 'tool_input', name: 'db-guardrails' });
    expect((await guardrail.run(data('{not json'))).behavior).toEqual({ type: 'allow' });
    await expect(guardrail.run(data('{"query":"SELECT 1"}'))).rejects.toThrow(/no SQL text at 'sql'/);
    expect(fake.requests).toEqual([]);
  });

  it('reports the verdict as outputInfo, and passes context functions the parsed arguments', async () => {
    fake.on(() => true, flagged());
    const context = vi.fn((args: Record<string, unknown>) => ({ ticket: String(args.ticket) }));
    const guardrail = verictoToolInputGuardrail({ dialect: 'sqlite', vericto: fake.guard(), context });
    const out = await guardrail.run(data('{"sql":"SELECT * FROM users","ticket":"CHG-9"}'));
    expect(out).toMatchObject({ behavior: { type: 'allow' }, outputInfo: { decision: 'FLAGGED', rule_code: 'VERICTO-030' } });
    expect(fake.requests[0]?.context).toEqual({ ticket: 'CHG-9' });
  });
});
