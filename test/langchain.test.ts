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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VerictoBlockedError, VerictoConfigError, VerictoUnavailableError } from '../src/index.js';
import {
  VerictoCheckSqlTool,
  VerictoQuerySqlTool,
  VerictoSqlDatabase,
  VerictoSqlToolkit,
  blockedMessage,
  dialectFromDataSource,
} from '../src/langchain.js';
import { FakeVericto, DIALECTS_WITHOUT_SQLITE, blocked, flagged, masked } from './fake-vericto.js';

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
