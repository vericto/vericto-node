import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_API_URL,
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

  it('rejects a URL that does not parse or is not http(s)', () => {
    const withUrl = (apiUrl: string) => () => new RuntimeApiEvaluator({ ...base, apiKey: API_KEY, apiUrl });
    expect(withUrl('not a url')).toThrow(/Invalid Vericto API URL/);
    expect(withUrl('ftp://api.vericto.com')).toThrow(/Invalid Vericto API URL/);
  });

  it.each(['http://localhost:8080', 'http://127.0.0.1:1', 'http://[::1]:9000'])('allows plain HTTP to %s', (apiUrl) => {
    expect(new RuntimeApiEvaluator({ ...base, apiKey: API_KEY, apiUrl }).apiUrl).toBe(apiUrl);
  });

  it('rejects a non-positive timeout and negative retries, and floors fractional retries', () => {
    const make = (o: Partial<ConstructorParameters<typeof RuntimeApiEvaluator>[0]>) => () =>
      new RuntimeApiEvaluator({ ...base, apiKey: API_KEY, ...o });
    expect(make({ timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(make({ timeoutMs: -5 })).toThrow(/timeoutMs/);
    expect(make({ env: { VERICTO_TIMEOUT: '0' } })).toThrow(/timeoutMs/);
    expect(make({ maxRetries: -1 })).toThrow(/maxRetries/);
    expect(make({ maxRetries: 1.7 })().maxRetries).toBe(1);
    expect(make({ maxRetries: 0 })().maxRetries).toBe(0);
  });

  it('prefers options over the environment, trims values and falls back to the defaults', () => {
    const env = {
      VERICTO_API_KEY: 'vtro_from_env',
      VERICTO_DATABASE_ID: '00000000-0000-4000-8000-000000000000',
      VERICTO_API_URL: '  ',
      VERICTO_TIMEOUT: '',
    };
    const fromEnv = new RuntimeApiEvaluator({ env });
    expect(fromEnv.apiUrl).toBe('https://api.vericto.com');
    expect(fromEnv.timeoutMs).toBe(5000);
    expect(fromEnv.maxRetries).toBe(2);
    expect(fromEnv.databaseId).toBe('00000000-0000-4000-8000-000000000000');

    const fromOptions = new RuntimeApiEvaluator({
      env,
      apiKey: `  ${API_KEY}  `,
      databaseId: ` ${DATABASE_ID} `,
      apiUrl: 'https://eu.vericto.example///',
      timeoutMs: 250,
    });
    expect(fromOptions.databaseId).toBe(DATABASE_ID);
    expect(fromOptions.apiUrl).toBe('https://eu.vericto.example');
    expect(fromOptions.timeoutMs).toBe(250);
  });

  it('reads process.env when no env is passed', () => {
    vi.stubEnv('VERICTO_API_KEY', API_KEY);
    vi.stubEnv('VERICTO_DATABASE_ID', DATABASE_ID);
    vi.stubEnv('VERICTO_API_URL', 'https://process-env.vericto.example');
    try {
      expect(new RuntimeApiEvaluator().apiUrl).toBe('https://process-env.vericto.example');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe('an empty or whitespace-only variable is unset', () => {
    const blanks = ['', ' ', '\t', ' \n '];
    const valid = { VERICTO_API_KEY: API_KEY, VERICTO_DATABASE_ID: DATABASE_ID };

    it.each(blanks)('VERICTO_API_KEY=%j: no key', (value) => {
      expect(() => new RuntimeApiEvaluator({ env: { ...valid, VERICTO_API_KEY: value } })).toThrow(
        /^No Vericto API key: pass apiKey or set VERICTO_API_KEY/,
      );
    });

    it.each(blanks)('VERICTO_DATABASE_ID=%j: no database id', (value) => {
      expect(() => new RuntimeApiEvaluator({ env: { ...valid, VERICTO_DATABASE_ID: value } })).toThrow(
        /^No Vericto database id: pass databaseId or set VERICTO_DATABASE_ID/,
      );
    });

    it.each(blanks)('VERICTO_API_URL=%j: the default URL', (value) => {
      expect(new RuntimeApiEvaluator({ env: { ...valid, VERICTO_API_URL: value } }).apiUrl).toBe(DEFAULT_API_URL);
    });

    it.each(blanks)('VERICTO_TIMEOUT=%j: the default 5 s', (value) => {
      expect(new RuntimeApiEvaluator({ env: { ...valid, VERICTO_TIMEOUT: value } }).timeoutMs).toBe(5000);
    });

    it('a blank variable never hides the option', () => {
      const ev = new RuntimeApiEvaluator({
        env: { VERICTO_API_KEY: '', VERICTO_DATABASE_ID: ' ', VERICTO_API_URL: '', VERICTO_TIMEOUT: ' ' },
        apiKey: API_KEY,
        databaseId: DATABASE_ID,
        apiUrl: 'https://eu.vericto.example',
        timeoutMs: 250,
      });
      expect([ev.apiUrl, ev.databaseId, ev.timeoutMs]).toEqual(['https://eu.vericto.example', DATABASE_ID, 250]);
    });

    it('in process.env too', () => {
      vi.stubEnv('VERICTO_API_KEY', API_KEY);
      vi.stubEnv('VERICTO_DATABASE_ID', DATABASE_ID);
      vi.stubEnv('VERICTO_API_URL', '  ');
      vi.stubEnv('VERICTO_TIMEOUT', '');
      try {
        const ev = new RuntimeApiEvaluator();
        expect([ev.apiUrl, ev.timeoutMs]).toEqual([DEFAULT_API_URL, 5000]);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('an invalid non-empty variable still throws', () => {
    const valid = { VERICTO_API_KEY: API_KEY, VERICTO_DATABASE_ID: DATABASE_ID };
    const make = (env: Record<string, string>) => () => new RuntimeApiEvaluator({ env: { ...valid, ...env } });

    it('VERICTO_API_KEY without the vtro_ prefix', () => {
      expect(make({ VERICTO_API_KEY: ' sk-secret-value ' })).toThrow(/must start with 'vtro_'/);
    });

    it('VERICTO_DATABASE_ID that is not a UUID', () => {
      expect(make({ VERICTO_DATABASE_ID: 'prod' })).toThrow(/must be a UUID/);
    });

    it.each(['not a url', 'ftp://api.vericto.com'])('VERICTO_API_URL=%j', (value) => {
      expect(make({ VERICTO_API_URL: value })).toThrow(/Invalid Vericto API URL/);
    });

    it('VERICTO_API_URL over plain HTTP off localhost', () => {
      expect(make({ VERICTO_API_URL: 'http://api.example.com' })).toThrow(/plain HTTP/);
    });

    it.each(['soon', '5s', 'NaN'])('VERICTO_TIMEOUT=%j', (value) => {
      expect(make({ VERICTO_TIMEOUT: value })).toThrow(/^VERICTO_TIMEOUT must be a number of seconds/);
    });

    it.each(['0', '-1'])('VERICTO_TIMEOUT=%j (not positive)', (value) => {
      expect(make({ VERICTO_TIMEOUT: value })).toThrow(/timeoutMs must be greater than 0/);
    });
  });

  it('requires a fetch implementation', () => {
    vi.stubGlobal('fetch', undefined);
    try {
      expect(() => new RuntimeApiEvaluator({ ...base, apiKey: API_KEY })).toThrow(/No fetch implementation/);
      expect(new RuntimeApiEvaluator({ ...base, apiKey: API_KEY, fetch: scripted([]).fetch })).toBeInstanceOf(
        RuntimeApiEvaluator,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

type ScriptedReply = { status: number; body?: unknown; headers?: Record<string, string> } | Error | 'reject-non-error';

/** A deterministic `fetch`: answers in order, records every call. No socket involved. */
function scripted(replies: ScriptedReply[], dialects: ScriptedReply[] = []) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const reply = (url.endsWith('/meta/config') ? dialects : replies).shift();
    if (reply === undefined) throw new Error(`scripted fetch: no reply left for ${url}`);
    if (reply === 'reject-non-error') throw 'boom'; // eslint-disable-line @typescript-eslint/only-throw-error
    if (reply instanceof Error) throw reply;
    const text = typeof reply.body === 'string' ? reply.body : reply.body === undefined ? '' : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status, headers: reply.headers });
  };
  return { fetch, calls, evaluator: (o: Partial<ConstructorParameters<typeof RuntimeApiEvaluator>[0]> = {}) =>
    new RuntimeApiEvaluator({ apiKey: API_KEY, databaseId: DATABASE_ID, apiUrl: 'https://api.vericto.test', backoffMs: 0, env: {}, fetch, ...o }) };
}

const posts = (calls: { url: string }[]) => calls.filter((c) => c.url.endsWith('/proxy/query')).length;

describe('RuntimeApiEvaluator: HTTP errors', () => {
  it('a 401 names the key variable, is never retried and never shows the key', async () => {
    fake.queue.push({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } } });
    const err = (await fake.evaluator().evaluate('SELECT 1', 'postgres').catch((e: unknown) => e)) as VerictoConfigError;
    expect(err).toBeInstanceOf(VerictoConfigError);
    expect(err.message).toBe('Vericto rejected the API key (HTTP 401). Check VERICTO_API_KEY.');
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).not.toContain(API_KEY);
    expect(fake.requests).toHaveLength(1);
  });

  it('a 403 that is not a block explains the missing scope', async () => {
    fake.queue.push({ status: 403, body: {} });
    await expect(fake.evaluator().evaluate('SELECT 1', 'postgres')).rejects.toThrow(
      'Vericto refused the request (HTTP 403): the key lacks the proxy:evaluate scope or this database.',
    );
    fake.queue.push({ status: 403, body: { error: { code: 'PLAN_UPGRADE_REQUIRED', message: 'upgrade to Team' } } });
    await expect(fake.evaluator().evaluate('SELECT 1', 'postgres')).rejects.toThrow(
      'Vericto refused the request (HTTP 403, PLAN_UPGRADE_REQUIRED): upgrade to Team.',
    );
  });

  it('a 403 carrying a BLOCKED decision (any case) is a verdict, not an error', async () => {
    fake.queue.push({ status: 403, body: { decision: 'blocked', rule_code: 'VERICTO-001' } });
    const verdict = await fake.evaluator().evaluate('DROP TABLE t', 'postgres');
    expect(verdict).toMatchObject({ decision: 'BLOCKED', ruleCode: 'VERICTO-001' });
  });

  it('a 400 for a dialect the server supports is a plain config error with its message', async () => {
    fake.queue.push({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'query is required' } } });
    const err = await fake.evaluator().evaluate('', 'postgres').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoConfigError);
    expect(err).not.toBeInstanceOf(VerictoUnsupportedDialectError);
    expect((err as Error).message).toBe('Vericto rejected the request (HTTP 400, VALIDATION_ERROR): query is required');
  });

  it('a 400 when the dialect list cannot be read stays a plain config error', async () => {
    const s = scripted([{ status: 400, body: {} }], [new TypeError('fetch failed')]);
    const err = await s.evaluator().evaluate('SELECT 1', 'sqlite').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoConfigError);
    expect(err).not.toBeInstanceOf(VerictoUnsupportedDialectError);
    expect((err as Error).message).toBe('Vericto rejected the request (HTTP 400).');
  });

  it('an oversized statement is sent whole; a 413 is not retried', async () => {
    const big = `SELECT ${"'x', ".repeat(200_000)}1`; // about 1 MB
    expect((await fake.evaluator().evaluate(big, 'postgres')).decision).toBe('ALLOWED');
    expect(fake.requests[0]?.query).toBe(big);

    fake.queue.push({ status: 413, body: { error: { code: 'PAYLOAD_TOO_LARGE' } } });
    const err = await fake.evaluator().evaluate(big, 'postgres').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoConfigError);
    expect((err as VerictoConfigError).status).toBe(413);
    expect(fake.requests).toHaveLength(2);
  });

  it('does not follow a redirect (the key would go to another host)', async () => {
    fake.queue.push({ status: 302, headers: { location: 'https://elsewhere.example/steal' }, body: '' });
    const err = await fake.evaluator().evaluate('SELECT 1', 'postgres').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoConfigError);
    expect((err as VerictoConfigError).status).toBe(302);
    expect(fake.requests).toHaveLength(1);
  });

  it('a quota error without a reset date still reads well and carries the upgrade link', async () => {
    fake.queue.push({ status: 429, body: { error: { code: 'QUOTA_EXCEEDED', upgrade_url: 'https://vericto.com/pricing' } } });
    const err = (await fake.evaluator().evaluate('SELECT 1', 'postgres').catch((e: unknown) => e)) as VerictoQuotaExceededError;
    expect(err.message).toBe('The Vericto workspace has used its monthly query quota.');
    expect(err.upgradeUrl).toBe('https://vericto.com/pricing');
    expect(err.resetsAt).toBeUndefined();
  });

  it('retries a 429 without a code, and a 5xx with an HTML body', async () => {
    fake.queue.push({ status: 429, body: '' }, { status: 502, body: '<html>Bad Gateway</html>' });
    expect((await fake.evaluator().evaluate('SELECT 1', 'postgres')).decision).toBe('ALLOWED');
    expect(fake.requests).toHaveLength(3);
  });

  it('names the last failure when the retries run out', async () => {
    fake.queue.push({ status: 500, body: {} }, { status: 504, body: { error: { code: 'GATEWAY_TIMEOUT' } } });
    await expect(fake.evaluator({ maxRetries: 1 }).evaluate('SELECT 1', 'postgres')).rejects.toThrow(
      `Vericto did not return a verdict after 2 attempt(s): HTTP 504 GATEWAY_TIMEOUT from ${fake.url}.`,
    );
  });

  it('maxRetries 0 makes exactly one attempt', async () => {
    fake.queue.push({ status: 503, body: {} });
    await expect(fake.evaluator({ maxRetries: 0 }).evaluate('SELECT 1', 'postgres')).rejects.toThrow(/after 1 attempt/);
    expect(fake.requests).toHaveLength(1);
  });
});

describe('RuntimeApiEvaluator: malformed responses and the network', () => {
  it.each([
    ['truncated JSON', '{"decision":'],
    ['a JSON array', '[{"decision":"ALLOWED"}]'],
    ['JSON null', 'null'],
    ['an empty body', ''],
  ])('treats %s on HTTP 200 as no verdict, and retries it', async (_name, body) => {
    fake.queue.push({ status: 200, body }, { status: 200, body });
    const err = await fake.evaluator({ maxRetries: 1 }).evaluate('SELECT 1', 'postgres').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoUnavailableError);
    expect((err as Error).message).toContain('HTTP 200 without a decision');
    expect(fake.requests).toHaveLength(2);
  });

  it('recovers when a retry returns a verdict after a malformed one', async () => {
    fake.queue.push({ status: 200, body: 'not json' });
    expect((await fake.evaluator().evaluate('SELECT 1', 'postgres')).decision).toBe('ALLOWED');
  });

  it('retries after a timeout and succeeds', async () => {
    fake.queue.push({ status: 200, body: { decision: 'ALLOWED' }, delayMs: 400 });
    const verdict = await fake.evaluator({ timeoutMs: 100, maxRetries: 1 }).evaluate('SELECT 1', 'postgres');
    expect(verdict.decision).toBe('ALLOWED');
    expect(fake.requests).toHaveLength(2);
  });

  it('reports network errors by type, never with the key', async () => {
    const s = scripted([new TypeError('fetch failed'), 'reject-non-error']);
    const err = await s.evaluator({ maxRetries: 1 }).evaluate('SELECT 1', 'postgres').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerictoUnavailableError);
    expect((err as Error).message).toBe(
      'Vericto did not return a verdict after 2 attempt(s): Error while calling https://api.vericto.test.',
    );
    expect(s.calls).toHaveLength(2);
  });

  it('sends the key and payload, refuses redirects and passes an abort signal', async () => {
    const s = scripted([{ status: 200, body: { decision: 'ALLOWED' } }]);
    await s.evaluator().evaluate('SELECT ?', 'mysql');
    const { url, init } = s.calls[0]!;
    expect(url).toBe('https://api.vericto.test/api/v1/proxy/query');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({ query: 'SELECT ?', database_id: DATABASE_ID, dialect: 'mysql' });
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe(API_KEY);
  });
});

describe('RuntimeApiEvaluator: backoff', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits Retry-After, capped at 2 s', async () => {
    vi.useFakeTimers();
    const s = scripted([
      { status: 503, headers: { 'retry-after': '86400' }, body: {} },
      { status: 200, body: { decision: 'ALLOWED' } },
    ]);
    const pending = s.evaluator({ maxRetries: 1 }).evaluate('SELECT 1', 'postgres');
    await vi.advanceTimersByTimeAsync(1999);
    expect(posts(s.calls)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).decision).toBe('ALLOWED');
    expect(posts(s.calls)).toBe(2);
  });

  it('falls back to retry_after_seconds when the header is not a number', async () => {
    vi.useFakeTimers();
    const s = scripted([
      { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }, body: { error: { retry_after_seconds: 1 } } },
      { status: 200, body: { decision: 'ALLOWED' } },
    ]);
    const pending = s.evaluator({ maxRetries: 1 }).evaluate('SELECT 1', 'postgres');
    await vi.advanceTimersByTimeAsync(999);
    expect(posts(s.calls)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(posts(s.calls)).toBe(2);
  });

  it('backs off exponentially without Retry-After', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // lowest jitter: half the base delay
    const s = scripted([{ status: 500 }, { status: 500 }, { status: 200, body: { decision: 'ALLOWED' } }]);
    const pending = s.evaluator({ maxRetries: 2, backoffMs: 1000 }).evaluate('SELECT 1', 'postgres');
    await vi.advanceTimersByTimeAsync(499);
    expect(posts(s.calls)).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // first retry after 500 ms
    expect(posts(s.calls)).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(posts(s.calls)).toBe(2);
    await vi.advanceTimersByTimeAsync(1); // second retry after 1000 ms
    expect((await pending).decision).toBe('ALLOWED');
  });
});

describe('RuntimeApiEvaluator: dialect list', () => {
  it('refreshes after the TTL', async () => {
    const ev = fake.evaluator({ dialectsTtlMs: 0 });
    await ev.supportedDialects();
    fake.dialects = ['postgres'];
    expect(await ev.supportedDialects()).toEqual(['postgres']);
    expect(fake.configCalls).toBe(2);
  });

  it('keeps the last good list when the server errors or answers garbage', async () => {
    const s = scripted([], [
      { status: 200, body: { dialects: [{ id: 'postgres' }, { id: '' }, { label: 'no id' }, null, 'sqlite', { id: 7 }] } },
      { status: 500, body: {} },
      { status: 200, body: { dialects: 'postgres' } },
      new TypeError('fetch failed'),
    ]);
    const ev = s.evaluator({ dialectsTtlMs: 0 });
    expect(await ev.supportedDialects()).toEqual(['postgres']); // malformed entries dropped
    expect(await ev.supportedDialects()).toEqual(['postgres']);
    expect(await ev.supportedDialects()).toEqual(['postgres']);
    expect(await ev.supportedDialects()).toEqual(['postgres']);
    expect(s.calls).toHaveLength(4);
  });

  it('cannot tell before any good answer', async () => {
    const s = scripted([], [{ status: 404, body: {} }, { status: 200, body: '<html>' }]);
    const ev = s.evaluator({ dialectsTtlMs: 0 });
    expect(await ev.supportedDialects()).toBeUndefined();
    expect(await ev.supportedDialects()).toBeUndefined();
  });

  it('asks without the API key', async () => {
    const s = scripted([], [{ status: 200, body: { dialects: [] } }]);
    expect(await s.evaluator().supportedDialects()).toEqual([]);
    const headers = s.calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBeUndefined();
    expect(s.calls[0]!.init.method).toBe('GET');
  });
});
