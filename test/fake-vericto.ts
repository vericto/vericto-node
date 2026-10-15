/** A local stand-in for the Vericto Runtime API (a real HTTP server on 127.0.0.1). */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { RuntimeApiEvaluator, Vericto, type VerictoOptions } from '../src/index.js';

export const API_KEY = 'vtro_test_0123456789abcdef';
export const DATABASE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const ALL_DIALECTS = ['postgres', 'mysql', 'oracle', 'mssql', 'snowflake', 'sqlite'];
export const TODAY_DIALECTS = ['postgres', 'mysql', 'oracle', 'mssql', 'snowflake'];

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface Recorded {
  query: string;
  dialect: string;
  database_id: string;
  headers: IncomingHttpHeaders;
}

type Rule = (sql: string) => Reply | undefined;

export const allowed = (): Reply => ({ status: 200, body: { decision: 'ALLOWED', event_id: 'evt-allowed' } });
export const blocked = (rule = 'VERICTO-010', fix: string | null = null): Reply => ({
  status: 403,
  body: {
    error: `Query blocked by rule ${rule}`,
    decision: 'BLOCKED',
    rule_code: rule,
    severity: 'critical',
    ast_node_path: 'Delete',
    suggested_safe_query: fix,
    rewritten_query: null,
    event_id: 'evt-blocked',
  },
});
export const flagged = (rule = 'VERICTO-030'): Reply => ({
  status: 200,
  body: { decision: 'FLAGGED', rule_code: rule, severity: 'medium' },
});
export const masked = (rewritten: string): Reply => ({
  status: 200,
  body: {
    decision: 'FLAGGED',
    rule_code: 'VERICTO-085',
    severity: 'low',
    rewritten_query: rewritten,
    sensitive_columns: [{ table: 'users', column: 'email', action: 'mask' }],
  },
});

export class FakeVericto {
  dialects = [...ALL_DIALECTS];
  readonly requests: Recorded[] = [];
  /** Replies served in order before the rules apply (retry tests). */
  readonly queue: Reply[] = [];
  configCalls = 0;
  readonly #rules: Rule[] = [];
  #server: Server | undefined;
  url = '';

  on(predicate: (sql: string) => boolean, reply: Reply): void {
    this.#rules.push((sql) => (predicate(sql) ? reply : undefined));
  }

  queries(): string[] {
    return this.requests.map((r) => r.query);
  }

  async start(): Promise<this> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const send = (reply: Reply) => {
          const write = () => {
            res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
            res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
          };
          if (reply.delayMs) setTimeout(write, reply.delayMs);
          else write();
        };
        if (req.method === 'GET' && req.url === '/api/v1/meta/config') {
          this.configCalls++;
          send({ status: 200, body: { dialects: this.dialects.map((id) => ({ id, label: id })) } });
          return;
        }
        if (req.method === 'POST' && req.url === '/api/v1/proxy/query') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Omit<Recorded, 'headers'>;
          this.requests.push({ ...body, headers: req.headers });
          const queued = this.queue.shift();
          if (queued) { send(queued); return; }
          if (!this.dialects.includes(body.dialect)) {
            send({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Validation failed' } } }); return;
          }
          for (const rule of this.#rules) {
            const hit = rule(body.query);
            if (hit) { send(hit); return; }
          }
          send(allowed()); return;
        }
        send({ status: 404, body: { error: { code: 'NOT_FOUND' } } });
      });
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server?.closeAllConnections();
      this.#server?.close(() => { resolve(); });
    });
  }

  evaluator(options: Partial<ConstructorParameters<typeof RuntimeApiEvaluator>[0]> = {}): RuntimeApiEvaluator {
    return new RuntimeApiEvaluator({
      apiKey: API_KEY,
      databaseId: DATABASE_ID,
      apiUrl: this.url,
      backoffMs: 0,
      env: {},
      ...options,
    });
  }

  guard(options: VerictoOptions = {}): Vericto {
    return new Vericto({ evaluator: this.evaluator(), logger: false, env: {}, ...options });
  }
}
