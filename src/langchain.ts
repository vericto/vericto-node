// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vericto for LangChain.js SQL agents and chains (`@langchain/classic`).
 *
 * ```ts
 * import { DataSource } from 'typeorm';
 * import { VerictoSqlDatabase, VerictoSqlToolkit } from '@vericto/sdk/langchain';
 * import { createSqlAgent } from '@langchain/classic/agents/toolkits/sql';
 *
 * const db = await VerictoSqlDatabase.fromDataSourceParams({
 *   appDataSource: new DataSource({ type: 'postgres', url: process.env.DATABASE_URL }),
 * });
 * const agent = createSqlAgent(llm, new VerictoSqlToolkit(db, llm));
 * ```
 *
 * Every statement LangChain sends through the database's TypeORM `DataSource` is
 * checked: the agent's queries (`run`, `QuerySqlTool`), the sample rows of
 * `getTableInfo`, and `SqlDatabaseChain`'s generated SQL. A blocked query is
 * answered with a message the model can act on (rule, reason, suggested fix)
 * instead of an exception, unless `onBlock: 'raise'`. Masked queries run as the
 * rewrite. Vericto being unavailable or misconfigured is never turned into a message
 * for the model: it propagates, so the fail mode stays in charge.
 *
 * Requires the optional peers `@langchain/classic`, `@langchain/core` and `typeorm`.
 */
import { SqlToolkit } from '@langchain/classic/agents/toolkits/sql';
import { SqlDatabase, type SqlDatabaseDataSourceParams } from '@langchain/classic/sql_db';
import { QuerySqlTool } from '@langchain/classic/tools/sql';
import type { BaseLanguageModelInterface } from '@langchain/core/language_models/base';
import { Tool } from '@langchain/core/tools';
import type { DataSource } from 'typeorm';

import { normalizeDialect } from './dialects.js';
import { VerictoBlockedError, VerictoConfigError, VerictoError } from './errors.js';
import { Vericto } from './guard.js';
import { isMasked, sqlToExecute, type Verdict } from './verdict.js';

/** What a blocked query does: `return` a message for the model (default), or `raise`. */
export type OnBlock = 'return' | 'raise';

export interface VerictoLangChainOptions {
  /** The guard. Default: one built from the `VERICTO_*` environment variables. */
  vericto?: Vericto;
  /** The Vericto dialect. Default: read from the TypeORM `DataSource` type. */
  dialect?: string;
  /** Default `return`. */
  onBlock?: OnBlock;
}

export type VerictoSqlDatabaseParams = SqlDatabaseDataSourceParams & VerictoLangChainOptions;

const TYPEORM_DIALECTS: Readonly<Record<string, string>> = {
  postgres: 'postgres',
  'aurora-postgres': 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  'aurora-mysql': 'mysql',
  mssql: 'mssql',
  oracle: 'oracle',
  sqlite: 'sqlite',
  'better-sqlite3': 'sqlite',
  sqljs: 'sqlite',
};

/**
 * The Vericto dialect of a TypeORM `DataSource` type. Types Vericto does not
 * evaluate (cockroachdb, sap, spanner, mongodb...) throw `VerictoConfigError`: pass
 * `dialect` explicitly if you know what you are doing.
 */
export function dialectFromDataSource(dataSource: Pick<DataSource, 'options'>): string {
  const type: string = dataSource.options.type;
  const dialect = TYPEORM_DIALECTS[type];
  if (!dialect) {
    throw new VerictoConfigError(
      `vericto: no Vericto dialect for the TypeORM type '${type}'. ` +
        `Supported: ${Object.keys(TYPEORM_DIALECTS).join(', ')}; or pass { dialect }.`,
    );
  }
  return dialect;
}

/**
 * A `DataSource` whose `query()` is checked by Vericto first (and runs the masked
 * rewrite). Everything else is the original data source's.
 */
export function guardDataSource(dataSource: DataSource, vericto: Vericto, dialect: string): DataSource {
  const name = normalizeDialect(dialect);
  const query = async (sql: string, parameters?: unknown[], ...rest: unknown[]): Promise<unknown> => {
    const final = await vericto.prepare(sql, name);
    return (dataSource.query as (...args: unknown[]) => Promise<unknown>).call(dataSource, final, parameters, ...rest);
  };
  return new Proxy(dataSource, {
    get(target, prop) {
      if (prop === 'query') return query;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The message a model gets for a blocked query: what was blocked, why, and the fix. */
export function blockedMessage(verdict: Verdict): string {
  const lines = ['Vericto blocked this SQL query; it was NOT executed.'];
  const rule = verdict.ruleCode ?? 'a Vericto rule';
  lines.push(`Rule: ${rule}${verdict.severity ? ` (severity ${verdict.severity})` : ''}`);
  if (verdict.message) lines.push(`Reason: ${verdict.message}`);
  const denied = verdict.accessDenied.length ? JSON.stringify(verdict.accessDenied) : undefined;
  if (denied) lines.push(`Access denied: ${denied}`);
  if (verdict.suggestedFix) {
    lines.push(`Suggested fix: ${verdict.suggestedFix}`);
    lines.push('Use the suggested fix, or rewrite the query so that it complies with the rule, and try again.');
  } else {
    lines.push('Rewrite the query so that it complies with the rule, and try again. Do not retry the same query.');
  }
  return lines.join('\n');
}

/** A readable verdict for the check tool. */
export function describeVerdict(verdict: Verdict): string {
  if (verdict.decision === 'BLOCKED') return blockedMessage(verdict).replace('; it was NOT executed.', '.');
  const rule = verdict.ruleCode ? ` by ${verdict.ruleCode}${verdict.severity ? ` (severity ${verdict.severity})` : ''}` : '';
  let text: string;
  switch (verdict.decision) {
    case 'FLAGGED':
      text = `Vericto: FLAGGED${rule}. The query is allowed to run, but it was reported.`;
      break;
    case 'MONITORED':
      text = `Vericto: MONITORED${rule}. The query is allowed to run.`;
      break;
    case 'PARSE_ERROR':
      text = `Vericto could not parse the query${verdict.parseError ? ` (${verdict.parseError})` : ''}; the workspace policy allows it to run.`;
      break;
    default:
      text = 'Vericto: ALLOWED. The query can run.';
  }
  if (isMasked(verdict)) {
    text += `\nIt reads sensitive columns, so it will run masked, as: ${sqlToExecute(verdict)}`;
  }
  return text;
}

function checkOnBlock(onBlock: OnBlock | undefined): OnBlock {
  // Checked at run time too: plain-JS callers get no type error.
  const value: string = onBlock ?? 'return';
  if (value !== 'return' && value !== 'raise') {
    throw new VerictoConfigError(`onBlock must be 'return' or 'raise', got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * A LangChain `SqlDatabase` whose statements are checked by Vericto. Accepted
 * wherever a `SqlDatabase` is: `QuerySqlTool`, `SqlToolkit`/`createSqlAgent`,
 * `SqlDatabaseChain`.
 */
export class VerictoSqlDatabase extends SqlDatabase {
  readonly vericto: Vericto;
  readonly dialect: string;
  readonly onBlock: OnBlock;
  /** The unguarded data source: SQL run through it directly is not checked. */
  readonly rawDataSource: DataSource;

  protected constructor(fields: VerictoSqlDatabaseParams & { vericto: Vericto; dialect: string }) {
    super(fields);
    this.vericto = fields.vericto;
    this.dialect = fields.dialect;
    this.onBlock = checkOnBlock(fields.onBlock);
    this.rawDataSource = fields.appDataSource;
    this.appDataSource = guardDataSource(fields.appDataSource, this.vericto, this.dialect);
  }

  /**
   * Same as `SqlDatabase.fromDataSourceParams`, plus the Vericto options. Fails fast
   * when the server does not evaluate the dialect. LangChain's own schema
   * introspection (the column catalogue read here) runs on the raw data source.
   */
  static override async fromDataSourceParams(fields: VerictoSqlDatabaseParams): Promise<VerictoSqlDatabase> {
    const vericto = fields.vericto ?? new Vericto();
    const dialect = await vericto.requireDialect(fields.dialect ?? dialectFromDataSource(fields.appDataSource));
    checkOnBlock(fields.onBlock);
    const base = await SqlDatabase.fromDataSourceParams(fields);
    const db = new VerictoSqlDatabase({ ...fields, vericto, dialect });
    db.allTables = base.allTables;
    db.customDescription = base.customDescription;
    return db;
  }

  /** Same as `SqlDatabase.fromOptionsParams`, plus the Vericto options. */
  static override async fromOptionsParams(
    fields: Parameters<typeof SqlDatabase.fromOptionsParams>[0] & VerictoLangChainOptions,
  ): Promise<VerictoSqlDatabase> {
    const { DataSource } = await SqlDatabase.imports();
    const { appDataSourceOptions, ...rest } = fields;
    return VerictoSqlDatabase.fromDataSourceParams({ ...rest, appDataSource: new DataSource(appDataSourceOptions) });
  }

  /**
   * Run `command` after Vericto checks it. Blocked: returns {@link blockedMessage}
   * (or throws `VerictoBlockedError` with `onBlock: 'raise'`). Masked: runs the
   * rewrite. Vericto unavailable or misconfigured: throws.
   */
  override async run(command: string, fetch: 'all' | 'one' = 'all'): Promise<string> {
    try {
      return await super.run(command, fetch);
    } catch (err) {
      if (err instanceof VerictoBlockedError && this.onBlock === 'return') return blockedMessage(err.verdict);
      throw err;
    }
  }
}

/**
 * `QuerySqlTool` that lets Vericto errors through. The stock tool turns every error
 * into text for the model, which would also hide "Vericto unavailable" (and, with
 * `onBlock: 'raise'`, the block) from your code.
 */
export class VerictoQuerySqlTool extends QuerySqlTool {
  static override lc_name(): string {
    return 'VerictoQuerySqlTool';
  }

  /** @ignore */
  override async _call(input: string): Promise<string> {
    try {
      return await this.db.run(input);
    } catch (err) {
      if (err instanceof VerictoError) throw err;
      return String(err);
    }
  }
}

/** `SqlToolkit` with {@link VerictoQuerySqlTool} and the Vericto dialect in the prompt. */
export class VerictoSqlToolkit extends SqlToolkit {
  constructor(db: VerictoSqlDatabase, llm: BaseLanguageModelInterface) {
    super(db, llm);
    this.tools = this.tools.map((tool) => (tool instanceof QuerySqlTool ? new VerictoQuerySqlTool(db) : tool));
    this.dialect = db.dialect;
  }
}

export interface VerictoCheckSqlToolOptions extends VerictoLangChainOptions {
  /** Take the guard, dialect and onBlock from this database. */
  db?: VerictoSqlDatabase;
}

/**
 * A tool that only checks a query (nothing is executed) and answers with Vericto's
 * verdict, so an agent can validate SQL before it proposes or runs it. Each check is
 * a Runtime API evaluation (it counts against the runtime quota and is audited).
 */
export class VerictoCheckSqlTool extends Tool {
  static override lc_name(): string {
    return 'VerictoCheckSqlTool';
  }

  name = 'vericto-check-sql';
  description =
    'Input is one SQL query. Checks it with the Vericto SQL firewall without running it and returns the ' +
    'verdict: ALLOWED, FLAGGED, MONITORED, or BLOCKED with the rule and a suggested fix. ' +
    'Use it before running a query; if it is blocked, fix the query and check again.';

  readonly vericto: Vericto;
  readonly dialect: string;
  readonly onBlock: OnBlock;

  constructor(options: VerictoCheckSqlToolOptions = {}) {
    super();
    const vericto = options.vericto ?? options.db?.vericto;
    const dialect = options.dialect ?? options.db?.dialect;
    if (!dialect) throw new VerictoConfigError('VerictoCheckSqlTool needs { dialect } or { db }.');
    this.vericto = vericto ?? new Vericto();
    this.dialect = normalizeDialect(dialect);
    this.onBlock = checkOnBlock(options.onBlock ?? options.db?.onBlock);
  }

  /** @ignore */
  async _call(input: string): Promise<string> {
    const verdict = await this.vericto.check(input, this.dialect);
    if (verdict.decision === 'BLOCKED' && this.onBlock === 'raise') throw new VerictoBlockedError(verdict, input);
    return describeVerdict(verdict);
  }
}
