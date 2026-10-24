// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * LangChain.js (@langchain/classic) end to end: a real TypeORM DataSource on
 * better-sqlite3, the real SqlDatabase / QuerySqlTool / SqlToolkit / createSqlAgent /
 * SqlDatabaseChain, a fake LLM (no model calls) and the local Runtime API stand-in.
 */
import { createSqlAgent } from '@langchain/classic/agents/toolkits/sql';
import { SqlDatabaseChain } from '@langchain/classic/chains/sql_db';
import { QuerySqlTool } from '@langchain/classic/tools/sql';
import { LLM } from '@langchain/core/language_models/llms';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VerictoBlockedError, VerictoConfigError, VerictoUnavailableError, verdictFromResponse } from '../src/index.js';
import {
  VerictoCheckSqlTool,
  VerictoQuerySqlTool,
  VerictoSqlDatabase,
  VerictoSqlToolkit,
  blockedMessage,
  describeVerdict,
  dialectFromDataSource,
  guardDataSource,
} from '../src/langchain.js';
import { API_KEY, DATABASE_ID, FakeVericto, DIALECTS_WITHOUT_SQLITE, blocked, flagged, masked } from './fake-vericto.js';

/** A scripted LLM: answers in order and ignores stop sequences (the testing fakes echo them). */
class ScriptedLLM extends LLM {
  readonly #responses: string[];
  constructor(responses: string[]) {
    super({});
    this.#responses = [...responses];
  }
  _llmType(): string {
    return 'scripted';
  }
  async _call(): Promise<string> {
    const next = this.#responses.shift();
    if (next === undefined) throw new Error('ScriptedLLM: no more responses');
    return next;
  }
}

let fake: FakeVericto;
let ds: DataSource;

beforeEach(async () => {
  fake = await new FakeVericto().start();
  ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
  await ds.initialize();
  await ds.query('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
  await ds.query("INSERT INTO users VALUES (1, 'ana@example.com'), (2, 'bo@example.com')");
});
afterEach(async () => {
  if (ds.isInitialized) await ds.destroy();
  await fake.stop();
});

const count = async () => (await ds.query<{ n: number }[]>('SELECT count(*) AS n FROM users'))[0]!.n;
const open = (options: { onBlock?: 'return' | 'raise'; sampleRowsInTableInfo?: number } = {}) =>
  VerictoSqlDatabase.fromDataSourceParams({ appDataSource: ds, vericto: fake.guard(), ...options });

describe('VerictoSqlDatabase', () => {
  it('runs allowed queries, checked with the dialect of the data source', async () => {
    const db = await open();
    expect(db.dialect).toBe('sqlite');
    expect(db.allTables.map((t) => t.tableName)).toEqual(['users']);
    expect(fake.requests).toEqual([]); // LangChain's catalogue read is not an agent query
    expect(JSON.parse(await db.run('SELECT email FROM users WHERE id = 1'))).toEqual([{ email: 'ana@example.com' }]);
    expect(fake.queries()).toEqual(['SELECT email FROM users WHERE id = 1']);
    expect(fake.requests[0]?.dialect).toBe('sqlite');
  });

  it('returns a message for the model when blocked, and nothing runs', async () => {
    fake.on((sql) => sql === 'DELETE FROM users', blocked('VERICTO-010', 'DELETE FROM users WHERE id = 1'));
    const db = await open();
    const out = await db.run('DELETE FROM users');
    expect(out).toContain('NOT executed');
    expect(out).toContain('Rule: VERICTO-010 (severity critical)');
    expect(out).toContain('Suggested fix: DELETE FROM users WHERE id = 1');
    expect(await count()).toBe(2);
  });

  it("raises with onBlock: 'raise'", async () => {
    fake.on((sql) => sql.startsWith('DELETE'), blocked());
    const db = await open({ onBlock: 'raise' });
    await expect(db.run('DELETE FROM users')).rejects.toBeInstanceOf(VerictoBlockedError);
    expect(await count()).toBe(2);
  });

  it('runs the masked rewrite, never the original', async () => {
    fake.on((sql) => sql.startsWith('SELECT email'), masked("SELECT '***' AS email FROM users WHERE id = 1"));
    const db = await open();
    expect(JSON.parse(await db.run('SELECT email FROM users WHERE id = 1', 'one'))).toEqual({ email: '***' });
  });

  it('runs flagged queries', async () => {
    fake.on(() => true, flagged());
    const db = await open();
    expect(JSON.parse(await db.run('SELECT id FROM users'))).toHaveLength(2);
  });

  it('lets "Vericto unavailable" through (fail closed), never as text for the model', async () => {
    const db = await open();
    for (let i = 0; i < 3; i++) fake.queue.push({ status: 503, body: {} });
    await expect(db.run('SELECT 1')).rejects.toBeInstanceOf(VerictoUnavailableError);
  });

  it('checks the sample rows of getTableInfo: masked, or withheld when blocked', async () => {
    fake.on((sql) => sql.includes('LIMIT 3'), masked('SELECT id, \'***\' AS email FROM "users" LIMIT 3'));
    const db = await open();
    const info = await db.getTableInfo();
    expect(info).toContain('***');
    expect(info).not.toContain('ana@example.com');

    fake.on(() => true, blocked()); // first match wins: LIMIT 2 below falls through to this one
    const blockedDb = await VerictoSqlDatabase.fromDataSourceParams({
      appDataSource: ds,
      vericto: fake.guard(),
      sampleRowsInTableInfo: 2,
    });
    const log = console.log;
    console.log = () => {}; // LangChain logs the sample-rows error itself
    let withheld: string;
    try {
      withheld = await blockedDb.getTableInfo();
    } finally {
      console.log = log;
    }
    expect(withheld).toContain('CREATE TABLE');
    expect(withheld).not.toContain('ana@example.com');
  });

  it('fails fast on a dialect the server does not evaluate', async () => {
    fake.dialects = [...DIALECTS_WITHOUT_SQLITE];
    await expect(open()).rejects.toThrow(/does not support the 'sqlite' dialect/);
  });

  it('maps TypeORM types and refuses unknown ones', () => {
    expect(dialectFromDataSource({ options: { type: 'postgres' } })).toBe('postgres');
    expect(dialectFromDataSource({ options: { type: 'mariadb' } })).toBe('mysql');
    expect(dialectFromDataSource({ options: { type: 'mssql' } })).toBe('mssql');
    expect(dialectFromDataSource({ options: { type: 'oracle' } })).toBe('oracle');
    expect(() => dialectFromDataSource({ options: { type: 'spanner' } })).toThrow(VerictoConfigError);
  });

  it('rejects a bad onBlock', async () => {
    await expect(open({ onBlock: 'ignore' as 'raise' })).rejects.toThrow(/onBlock/);
  });
});

describe('tools, toolkit, agent and chain', () => {
  it('stock QuerySqlTool gets the block message', async () => {
    fake.on((sql) => sql.startsWith('DROP'), blocked('VERICTO-001'));
    const tool = new QuerySqlTool(await open());
    expect(await tool.invoke('DROP TABLE users')).toContain('Rule: VERICTO-001');
    expect(await count()).toBe(2);
  });

  it('VerictoQuerySqlTool lets Vericto errors through and still returns SQL errors as text', async () => {
    const tool = new VerictoQuerySqlTool(await open({ onBlock: 'raise' }));
    fake.on((sql) => sql.startsWith('DROP'), blocked('VERICTO-001'));
    await expect(tool.invoke('DROP TABLE users')).rejects.toBeInstanceOf(VerictoBlockedError);
    expect(await tool.invoke('SELECT nope FROM users')).toMatch(/no such column/);
  });

  it('createSqlAgent with VerictoSqlToolkit: the model sees the block and corrects itself', async () => {
    fake.on((sql) => sql === 'DELETE FROM users', blocked('VERICTO-010', 'DELETE FROM users WHERE id = 2'));
    const db = await open();
    const llm = new ScriptedLLM([
      'Thought: delete the user\nAction: query-sql\nAction Input: DELETE FROM users',
      'Thought: use the fix\nAction: query-sql\nAction Input: DELETE FROM users WHERE id = 2',
      'Final Answer: deleted user 2',
    ]);
    const toolkit = new VerictoSqlToolkit(db, llm);
    expect(toolkit.dialect).toBe('sqlite');
    expect(toolkit.tools.some((t) => t instanceof VerictoQuerySqlTool)).toBe(true);
    const result = (await createSqlAgent(llm, toolkit).invoke({ input: 'delete user 2' })) as {
      output: string;
      intermediateSteps: { observation: string }[];
    };
    expect(result.output).toBe('deleted user 2');
    expect(result.intermediateSteps[0]?.observation).toContain('Suggested fix: DELETE FROM users WHERE id = 2');
    expect(await count()).toBe(1);
    expect(fake.queries()).toEqual(['DELETE FROM users', 'DELETE FROM users WHERE id = 2']);
  });

  it('SqlDatabaseChain: the generated SQL goes through Vericto too', async () => {
    fake.on((sql) => sql.startsWith('DELETE'), blocked());
    const db = await open();
    db.sampleRowsInTableInfo = 0;
    const llm = new ScriptedLLM(['DELETE FROM users', 'I could not do that.']);
    const chain = new SqlDatabaseChain({ llm, database: db });
    const err = console.error;
    console.error = () => {}; // the chain logs the query error itself
    try {
      await chain.invoke({ query: 'delete everyone' });
    } finally {
      console.error = err;
    }
    expect(fake.queries()).toEqual(['DELETE FROM users']);
    expect(await count()).toBe(2);
  });

  it('VerictoCheckSqlTool reports verdicts without running anything', async () => {
    fake.on((sql) => sql.startsWith('DELETE'), blocked('VERICTO-010', 'DELETE FROM users WHERE id = 1'));
    fake.on((sql) => sql.startsWith('SELECT email'), masked("SELECT '***' AS email FROM users"));
    fake.on((sql) => sql.startsWith('UPDATE'), flagged('VERICTO-030'));
    const tool = new VerictoCheckSqlTool({ vericto: fake.guard(), dialect: 'sqlite' });
    expect(await tool.invoke('SELECT 1')).toBe('Vericto: ALLOWED. The query can run.');
    const b = (await tool.invoke('DELETE FROM users')) as string;
    expect(b).toContain('Vericto blocked this SQL query.');
    expect(b).toContain('Suggested fix: DELETE FROM users WHERE id = 1');
    expect(await tool.invoke('SELECT email FROM users')).toContain("run masked, as: SELECT '***' AS email FROM users");
    expect(await tool.invoke("UPDATE users SET email = 'x' WHERE id = 1")).toContain('FLAGGED by VERICTO-030');
    expect(await count()).toBe(2);

    const raising = new VerictoCheckSqlTool({ db: await open({ onBlock: 'raise' }) });
    expect(raising.dialect).toBe('sqlite');
    await expect(raising.invoke('DELETE FROM users')).rejects.toBeInstanceOf(VerictoBlockedError);
    expect(() => new VerictoCheckSqlTool({ vericto: fake.guard() })).toThrow(/dialect/);
  });

  it('VerictoQuerySqlTool lets "Vericto unavailable" through instead of answering the model', async () => {
    const tool = new VerictoQuerySqlTool(await open());
    for (let i = 0; i < 3; i++) fake.queue.push({ status: 503, body: {} });
    await expect(tool.invoke('SELECT 1')).rejects.toBeInstanceOf(VerictoUnavailableError);
    expect(VerictoQuerySqlTool.lc_name()).toBe('VerictoQuerySqlTool');
  });

  it('VerictoCheckSqlTool describes MONITORED and PARSE_ERROR verdicts', async () => {
    fake.on((sql) => sql.startsWith('SELECT big'), { status: 200, body: { decision: 'MONITORED', rule_code: 'VERICTO-050' } });
    fake.on((sql) => sql.startsWith('SELEC '), { status: 200, body: { decision: 'PARSE_ERROR', parse_error: 'unexpected SELEC' } });
    fake.on((sql) => sql.startsWith('???'), { status: 200, body: { decision: 'PARSE_ERROR' } });
    const tool = new VerictoCheckSqlTool({ vericto: fake.guard(), dialect: 'better-sqlite3' });
    expect(tool.dialect).toBe('sqlite');
    expect(await tool.invoke('SELECT big FROM t')).toBe('Vericto: MONITORED by VERICTO-050. The query is allowed to run.');
    expect(await tool.invoke('SELEC 1')).toBe(
      'Vericto could not parse the query (unexpected SELEC); the workspace policy allows it to run.',
    );
    expect(await tool.invoke('???')).toBe('Vericto could not parse the query; the workspace policy allows it to run.');
    expect(VerictoCheckSqlTool.lc_name()).toBe('VerictoCheckSqlTool');
  });

  it('VerictoCheckSqlTool validates onBlock and builds its guard from the environment', async () => {
    expect(() => new VerictoCheckSqlTool({ vericto: fake.guard(), dialect: 'sqlite', onBlock: 'skip' as 'raise' })).toThrow(
      /onBlock/,
    );
    vi.stubEnv('VERICTO_API_KEY', API_KEY);
    vi.stubEnv('VERICTO_DATABASE_ID', DATABASE_ID);
    vi.stubEnv('VERICTO_API_URL', fake.url);
    vi.stubEnv('VERICTO_FAIL_MODE', undefined);
    try {
      const tool = new VerictoCheckSqlTool({ dialect: 'postgres' });
      expect(tool.onBlock).toBe('return');
      expect(await tool.invoke('SELECT 1')).toBe('Vericto: ALLOWED. The query can run.');
      expect(fake.requests[0]?.dialect).toBe('postgres');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('blockedMessage without a fix tells the model not to retry as is', () => {
    const text = blockedMessage({
      decision: 'BLOCKED',
      sql: 'x',
      dialect: 'postgres',
      ruleCode: 'VERICTO-010',
      findings: [],
      sensitiveColumns: [],
      accessDenied: [],
      cached: false,
      raw: {},
    });
    expect(text).toContain('Do not retry the same query.');
  });
});

const verdictOf = (body: Record<string, unknown>, sql = 'SELECT 1') => verdictFromResponse(body, sql, 'postgres');

describe('messages for the model', () => {
  it('blockedMessage includes the reason and the denied access', () => {
    const text = blockedMessage(
      verdictOf({
        decision: 'BLOCKED',
        rule_code: 'VERICTO-070',
        error: 'agent may not read salaries',
        access_denied: [{ table: 'salaries' }],
      }),
    );
    expect(text.split('\n')).toEqual([
      'Vericto blocked this SQL query; it was NOT executed.',
      'Rule: VERICTO-070',
      'Reason: agent may not read salaries',
      'Access denied: [{"table":"salaries"}]',
      'Rewrite the query so that it complies with the rule, and try again. Do not retry the same query.',
    ]);
    expect(blockedMessage(verdictOf({ decision: 'BLOCKED' }))).toContain('Rule: a Vericto rule');
  });

  it('describeVerdict covers every decision', () => {
    expect(describeVerdict(verdictOf({ decision: 'ALLOWED' }))).toBe('Vericto: ALLOWED. The query can run.');
    expect(describeVerdict(verdictOf({ decision: 'FLAGGED' }))).toBe(
      'Vericto: FLAGGED. The query is allowed to run, but it was reported.',
    );
    expect(describeVerdict(verdictOf({ decision: 'FLAGGED', rule_code: 'VERICTO-030', severity: 'medium' }))).toBe(
      'Vericto: FLAGGED by VERICTO-030 (severity medium). The query is allowed to run, but it was reported.',
    );
    expect(describeVerdict(verdictOf({ decision: 'MONITORED' }))).toBe('Vericto: MONITORED. The query is allowed to run.');
    const blockedText = describeVerdict(verdictOf({ decision: 'BLOCKED', rule_code: 'VERICTO-001' }));
    expect(blockedText.startsWith('Vericto blocked this SQL query.\nRule: VERICTO-001')).toBe(true);
    expect(blockedText).not.toContain('NOT executed');
  });

  it('describeVerdict shows the masked rewrite that will run', () => {
    const text = describeVerdict(verdictOf({ decision: 'ALLOWED', rewritten_query: "SELECT '***' AS ssn FROM p" }, 'SELECT ssn FROM p'));
    expect(text).toBe(
      "Vericto: ALLOWED. The query can run.\nIt reads sensitive columns, so it will run masked, as: SELECT '***' AS ssn FROM p",
    );
  });
});

describe('guardDataSource and construction options', () => {
  it('checks query(), passes parameters through, and leaves everything else to the data source', async () => {
    const guarded = guardDataSource(ds, fake.guard(), 'better-sqlite3');
    expect(await guarded.query('SELECT email FROM users WHERE id = ?', [2])).toEqual([{ email: 'bo@example.com' }]);
    expect(fake.requests[0]).toMatchObject({ query: 'SELECT email FROM users WHERE id = ?', dialect: 'sqlite' });
    expect(JSON.stringify(fake.requests)).not.toContain('bo@example.com');
    expect(guarded.isInitialized).toBe(true);
    expect(guarded.options.type).toBe('better-sqlite3');
    expect(guarded.driver).toBe(ds.driver);
    // Methods other than query() are bound to the original and are not checked.
    expect(await guarded.createQueryRunner().query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    expect(fake.requests).toHaveLength(1);
  });

  it('a blocked query() rejects and nothing runs', async () => {
    fake.on((sql) => sql.startsWith('DELETE'), blocked());
    const guarded = guardDataSource(ds, fake.guard(), 'sqlite');
    await expect(guarded.query('DELETE FROM users')).rejects.toBeInstanceOf(VerictoBlockedError);
    expect(await count()).toBe(2);
  });

  it('an explicit dialect wins over the data source type and is normalized', async () => {
    const db = await VerictoSqlDatabase.fromDataSourceParams({ appDataSource: ds, vericto: fake.guard(), dialect: 'SQLite3' });
    expect(db.dialect).toBe('sqlite');
    expect(db.onBlock).toBe('return');
    expect(db.rawDataSource).toBe(ds);
  });

  it('fromOptionsParams builds and guards its own data source', async () => {
    const db = await VerictoSqlDatabase.fromOptionsParams({
      appDataSourceOptions: { type: 'better-sqlite3', database: ':memory:' },
      vericto: fake.guard(),
    });
    try {
      expect(db).toBeInstanceOf(VerictoSqlDatabase);
      expect(db.dialect).toBe('sqlite');
      expect(await db.run('SELECT 41 + 1 AS answer')).toBe('[{"answer":42}]');
      expect(fake.queries()).toEqual(['SELECT 41 + 1 AS answer']);
    } finally {
      await db.rawDataSource.destroy();
    }
  });

  it('builds its guard from the VERICTO_* environment by default', async () => {
    vi.stubEnv('VERICTO_API_KEY', API_KEY);
    vi.stubEnv('VERICTO_DATABASE_ID', DATABASE_ID);
    vi.stubEnv('VERICTO_API_URL', fake.url);
    vi.stubEnv('VERICTO_FAIL_MODE', undefined);
    try {
      const db = await VerictoSqlDatabase.fromDataSourceParams({ appDataSource: ds });
      expect(JSON.parse(await db.run('SELECT id FROM users WHERE id = 1'))).toEqual([{ id: 1 }]);
      expect(fake.requests[0]?.headers['x-api-key']).toBe(API_KEY);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['aurora-postgres', 'postgres'],
    ['aurora-mysql', 'mysql'],
    ['mysql', 'mysql'],
    ['sqlite', 'sqlite'],
    ['better-sqlite3', 'sqlite'],
    ['sqljs', 'sqlite'],
  ])('maps the TypeORM type %s to %s', (type, dialect) => {
    expect(dialectFromDataSource({ options: { type } } as Parameters<typeof dialectFromDataSource>[0])).toBe(dialect);
  });

  it('names the unsupported TypeORM type and the way out', () => {
    const cockroach = { options: { type: 'cockroachdb' } } as Parameters<typeof dialectFromDataSource>[0];
    expect(() => dialectFromDataSource(cockroach)).toThrow(
      /no Vericto dialect for the TypeORM type 'cockroachdb'.*or pass \{ dialect \}/,
    );
  });
});

describe('0.4.0: the fail-mode contract and the declared context', () => {
  const down = () => {
    for (let i = 0; i < 3; i++) fake.queue.push({ status: 503, body: { error: { code: 'INTERNAL_ERROR' } } });
  };

  it("VerictoCheckSqlTool under failMode 'open' answers UNEVALUATED with the reason", async () => {
    down();
    const tool = new VerictoCheckSqlTool({ vericto: fake.guard({ failMode: 'open' }), dialect: 'sqlite' });
    const answer = (await tool.invoke('DELETE FROM users')) as string;
    expect(answer).toMatch(/^Vericto: UNEVALUATED\. Vericto could not evaluate the query \(.*HTTP 503.*\)\.$/);
    expect(answer).not.toContain('ALLOWED');
  });

  it("VerictoCheckSqlTool under failMode 'closed' rejects, never answers the model", async () => {
    down();
    const tool = new VerictoCheckSqlTool({ vericto: fake.guard(), dialect: 'sqlite' });
    await expect(tool.invoke('SELECT 1')).rejects.toBeInstanceOf(VerictoUnavailableError);
  });

  it("the query tools run the query unevaluated under failMode 'open'", async () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const db = await VerictoSqlDatabase.fromDataSourceParams({ appDataSource: ds, vericto: fake.guard({ failMode: 'open' }) });
      down();
      expect(JSON.parse(await new VerictoQuerySqlTool(db).invoke('SELECT id FROM users ORDER BY id') as string)).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
      expect(emit).toHaveBeenCalledOnce();
    } finally {
      emit.mockRestore();
    }
  });

  it('describeVerdict never calls an UNEVALUATED verdict allowed', () => {
    const text = describeVerdict({ ...verdictFromResponse({ decision: 'ALLOWED' }, 'SELECT 1', 'sqlite'), decision: 'UNEVALUATED', message: 'down' });
    expect(text).toBe('Vericto: UNEVALUATED. Vericto could not evaluate the query (down).');
  });

  it('context and endUser go with every statement of the database and the check tool', async () => {
    const db = await VerictoSqlDatabase.fromDataSourceParams({
      appDataSource: ds,
      vericto: fake.guard(),
      context: { ticket: 'CHG-1' },
      endUser: { id: 'u_1' },
    });
    await db.run('SELECT id FROM users WHERE id = 1');
    expect(fake.requests.at(-1)).toMatchObject({ context: { ticket: 'CHG-1' }, end_user: { id: 'u_1' } });
    await new VerictoCheckSqlTool({ db }).invoke('SELECT 2');
    expect(fake.requests.at(-1)).toMatchObject({ context: { ticket: 'CHG-1' }, end_user: { id: 'u_1' } });
    await new VerictoCheckSqlTool({ db, context: { tenant: 'acme' } }).invoke('SELECT 3');
    expect(fake.requests.at(-1)?.context).toEqual({ tenant: 'acme' });
  });

  it('a function is read for every statement', async () => {
    const state: { endUser?: { id: string } } = {};
    const db = await VerictoSqlDatabase.fromDataSourceParams({ appDataSource: ds, vericto: fake.guard(), endUser: () => state.endUser });
    await db.run('SELECT 1');
    expect(fake.requests.at(-1)).not.toHaveProperty('end_user');
    state.endUser = { id: 'u_2' };
    await db.run('SELECT 1');
    expect(fake.requests.at(-1)?.end_user).toEqual({ id: 'u_2' });
    const guarded = guardDataSource(ds, fake.guard(), 'sqlite', { context: () => ({ tenant: 't1' }) });
    await guarded.query('SELECT 1');
    expect(fake.requests.at(-1)?.context).toEqual({ tenant: 't1' });
  });

  it('invalid fixed values are refused at construction', async () => {
    await expect(
      VerictoSqlDatabase.fromDataSourceParams({ appDataSource: ds, vericto: fake.guard(), context: { ticket: '' } }),
    ).rejects.toThrow(/context\.ticket/);
    expect(() => new VerictoCheckSqlTool({ vericto: fake.guard(), dialect: 'sqlite', endUser: { 'bad key': 'x' } })).toThrow(
      VerictoConfigError,
    );
    expect(() => guardDataSource(ds, fake.guard(), 'sqlite', { context: { other: 'x' } as never })).toThrow(/unknown key/);
  });
});
