import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RuntimeApiEvaluator,
  VERSION,
  VerictoConfigError,
  VerictoQuotaExceededError,
  VerictoUnavailableError,
  VerictoUnsupportedDialectError,
} from '../src/index.js';
import { API_KEY, DATABASE_ID, FakeVericto, blocked } from './fake-vericto.js';

let fake: FakeVericto;
beforeEach(async () => {
  fake = await new FakeVericto().start();
});
afterEach(async () => {
  await fake.stop();
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => { resolve(port); });
    });
  });
}

describe('RuntimeApiEvaluator', () => {
  it('sends the documented request', async () => {
    const verdict = await fake.evaluator().evaluate('SELECT 1', 'snowflake');
    expect(verdict.decision).toBe('ALLOWED');
    expect(verdict.eventId).toBe('evt-allowed');
    const sent = fake.requests[0]!;
    expect(sent).toMatchObject({ query: 'SELECT 1', dialect: 'snowflake', database_id: DATABASE_ID });
    expect(sent.headers['x-api-key']).toBe(API_KEY);
    expect(sent.headers['user-agent']).toBe(`vericto-node/${VERSION}`);
    expect(sent.headers.authorization).toBeUndefined();
  });

  it('reads a block as a verdict', async () => {
    fake.on((sql) => sql.startsWith('DELETE'), blocked('VERICTO-010', 'DELETE FROM t WHERE id = 1'));
    const verdict = await fake.evaluator().evaluate('DELETE FROM t', 'postgres');
    expect(verdict.decision).toBe('BLOCKED');
    expect(verdict.ruleCode).toBe('VERICTO-010');
    expect(verdict.suggestedFix).toBe('DELETE FROM t WHERE id = 1');
    expect(verdict.findings).toEqual([
      expect.objectContaining({ ruleCode: 'VERICTO-010', astNodePath: 'Delete' }),
    ]);
    expect(verdict.rewrittenQuery).toBeUndefined();
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [403, 'PLAN_UPGRADE_REQUIRED'],
    [404, 'NOT_FOUND'],
    [400, 'VALIDATION_ERROR'],
  ])('HTTP %i %s is a config error, not retried', async (status, code) => {
    fake.queue.push({ status, body: { error: { code, message: 'nope' } } });
    const err = await fake.evaluator().evaluate('SELECT 1', 'postgres').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoConfigError);
    expect((err as VerictoConfigError).status).toBe(status);
    expect(String(err)).not.toContain(API_KEY);
    expect(fake.requests).toHaveLength(1);
  });

  it('does not retry the monthly quota', async () => {
    fake.queue.push({
      status: 429,
      headers: { 'retry-after': '86400' },
      body: { error: { code: 'QUOTA_EXCEEDED', resets_at: '2026-11-01T00:00:00.000Z' } },
    });
    const err = await fake.evaluator().evaluate('SELECT 1', 'postgres').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoQuotaExceededError);
    expect(err).toBeInstanceOf(VerictoUnavailableError);
    expect((err as VerictoQuotaExceededError).resetsAt).toBe('2026-11-01T00:00:00.000Z');
    expect(fake.requests).toHaveLength(1);
  });

  it('retries 5xx and 429 rate limits', async () => {
    fake.queue.push(
      { status: 503, body: {} },
      { status: 429, body: { error: { code: 'RATE_LIMIT_EXCEEDED', retry_after_seconds: 0 } } },
    );
    const verdict = await fake.evaluator().evaluate('SELECT 1', 'postgres');
    expect(verdict.decision).toBe('ALLOWED');
    expect(fake.requests).toHaveLength(3);
  });

  it('gives up after the retries', async () => {
    for (let i = 0; i < 3; i++) fake.queue.push({ status: 500, body: { error: { code: 'INTERNAL_SERVER_ERROR' } } });
    await expect(fake.evaluator().evaluate('SELECT 1', 'postgres')).rejects.toThrow(/3 attempt/);
  });

  it('treats a refused connection as unavailable', async () => {
    const ev = fake.evaluator({ apiUrl: `http://127.0.0.1:${await freePort()}`, maxRetries: 1 });
    await expect(ev.evaluate('SELECT 1', 'postgres')).rejects.toBeInstanceOf(VerictoUnavailableError);
  });

  it('times out', async () => {
    fake.queue.push({ status: 200, body: { decision: 'ALLOWED' }, delayMs: 600 });
    const started = Date.now();
    const ev = fake.evaluator({ timeoutMs: 150, maxRetries: 0 });
    await expect(ev.evaluate('SELECT 1', 'postgres')).rejects.toThrow(/Timeout/);
    expect(Date.now() - started).toBeLessThan(550);
  });

  it('treats a body without a decision as unavailable', async () => {
    fake.queue.push({ status: 200, body: '<html>captive portal</html>' });
    await expect(fake.evaluator({ maxRetries: 0 }).evaluate('SELECT 1', 'postgres')).rejects.toBeInstanceOf(
      VerictoUnavailableError,
    );
  });

  it('fails closed on an unknown decision', async () => {
    fake.queue.push({ status: 200, body: { decision: 'SOMETHING_NEW' } });
    expect((await fake.evaluator().evaluate('SELECT 1', 'postgres')).decision).toBe('BLOCKED');
  });

  it('names an unsupported dialect', async () => {
    fake.dialects = ['postgres', 'snowflake'];
    const err = await fake.evaluator().evaluate('SELECT 1', 'sqlite').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoUnsupportedDialectError);
    expect(String(err)).toContain('postgres, snowflake');
  });

  it('caches the dialect list and shares concurrent lookups', async () => {
    const ev = fake.evaluator();
    const [a, b] = await Promise.all([ev.supportedDialects(), ev.supportedDialects()]);
    expect(a).toEqual(fake.dialects);
    expect(b).toEqual(fake.dialects);
    await ev.supportedDialects();
    expect(fake.configCalls).toBe(1);
  });

  it('cannot tell the dialects when unreachable', async () => {
    const ev = fake.evaluator({ apiUrl: `http://127.0.0.1:${await freePort()}` });
    expect(await ev.supportedDialects()).toBeUndefined();
  });
});

describe('configuration', () => {
  const base = { databaseId: DATABASE_ID, env: {} };

  it('requires a key and never echoes a wrong one', () => {
    expect(() => new RuntimeApiEvaluator(base)).toThrow(/VERICTO_API_KEY/);
    expect(() => new RuntimeApiEvaluator({ ...base, apiKey: 'sk-secret-value' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('sk-secret-value') as unknown }) as Error,
    );
  });

  it('requires a UUID database id', () => {
    expect(() => new RuntimeApiEvaluator({ apiKey: API_KEY, env: {} })).toThrow(/VERICTO_DATABASE_ID/);
    expect(() => new RuntimeApiEvaluator({ apiKey: API_KEY, databaseId: 'prod', env: {} })).toThrow(/UUID/);
  });

  it('refuses plain HTTP off localhost', () => {
    expect(() => new RuntimeApiEvaluator({ ...base, apiKey: API_KEY, apiUrl: 'http://api.example.com' })).toThrow(
      /plain HTTP/,
    );
  });

  it('reads the environment', () => {
    const ev = new RuntimeApiEvaluator({
      env: {
        VERICTO_API_KEY: API_KEY,
        VERICTO_DATABASE_ID: DATABASE_ID.toUpperCase(),
        VERICTO_API_URL: 'https://vericto.internal.example/',
        VERICTO_TIMEOUT: '1.5',
      },
    });
    expect(ev.apiUrl).toBe('https://vericto.internal.example');
    expect(ev.databaseId).toBe(DATABASE_ID);
    expect(ev.timeoutMs).toBe(1500);
  });

  it('rejects a bad timeout', () => {
    expect(
      () => new RuntimeApiEvaluator({ ...base, apiKey: API_KEY, env: { VERICTO_TIMEOUT: 'soon' } }),
    ).toThrow(/VERICTO_TIMEOUT/);
  });

  it('keeps the key out of toString and JSON', () => {
    const ev = new RuntimeApiEvaluator({ ...base, apiKey: API_KEY });
    expect(String(ev)).not.toContain(API_KEY);
    expect(JSON.stringify(ev)).not.toContain(API_KEY);
    expect(String(ev)).toContain('api.vericto.com');
  });

  it('keeps VERSION in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
