// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/** `context` and `endUser`: the request body, the client-side limits, the cache. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Vericto, VerictoConfigError, type Evaluator, type Verdict } from '../src/index.js';
import { policyFields } from '../src/policy-context.js';
import { verdictFromResponse } from '../src/verdict.js';
import { policyContextErrors, startStub } from '../scripts/docs-stub.mjs';
import { API_KEY, DATABASE_ID, FakeVericto } from './fake-vericto.js';

const TICKET = 'CHG-1042';
const END_USER = { id: 'u_829', role: 'support', region: 'eu' };
const long = (n: number) => 'x'.repeat(n);

let fake: FakeVericto;
beforeEach(async () => {
  fake = await new FakeVericto().start();
});
afterEach(async () => {
  await fake.stop();
});

describe('the request body', () => {
  it('check() sends context and end_user', async () => {
    await fake.guard().check('SELECT 1', 'postgres', { context: { ticket: TICKET, tenant: 'acme' }, endUser: END_USER });
    const sent = fake.requests.at(-1)!;
    expect(sent.context).toEqual({ ticket: TICKET, tenant: 'acme' });
    expect(sent.end_user).toEqual(END_USER);
    expect([sent.query, sent.database_id, sent.dialect]).toEqual(['SELECT 1', DATABASE_ID, 'postgres']);
  });

  it('enforce(), prepare() and enforceAll() send them', async () => {
    const g = fake.guard();
    await g.enforce('SELECT 1', 'postgres', { context: { tenant: 'acme' } });
    expect(fake.requests.at(-1)?.context).toEqual({ tenant: 'acme' });
    expect(fake.requests.at(-1)).not.toHaveProperty('end_user');
    await g.prepare('SELECT 2', 'postgres', { endUser: { id: 'u_1' } });
    expect(fake.requests.at(-1)?.end_user).toEqual({ id: 'u_1' });
    expect(fake.requests.at(-1)).not.toHaveProperty('context');
    await g.enforceAll(['SELECT 3', 'SELECT 4'], 'postgres', { context: { ticket: TICKET } });
    expect(fake.requests.slice(-2).map((r) => r.context)).toEqual([{ ticket: TICKET }, { ticket: TICKET }]);
  });

  it('without them the body is unchanged', async () => {
    const g = fake.guard();
    await g.check('SELECT 1', 'postgres');
    await g.check('SELECT 1', 'postgres', {});
    await g.check('SELECT 1', 'postgres', { context: {}, endUser: {} });
    await g.check('SELECT 1', 'postgres', { context: { ticket: undefined } });
    for (const sent of fake.requests) {
      expect(Object.keys(sent).filter((k) => k !== 'headers').sort()).toEqual(['database_id', 'dialect', 'query']);
    }
  });

  it('the evaluator takes them directly', async () => {
    await fake.evaluator().evaluate('SELECT 1', 'postgres', { context: { ticket: TICKET }, endUser: { id: 'u_1' } });
    expect(fake.requests.at(-1)?.context).toEqual({ ticket: TICKET });
    expect(fake.requests.at(-1)?.end_user).toEqual({ id: 'u_1' });
  });

  it('the guard passes them to a custom evaluator only when given', async () => {
    const calls: unknown[][] = [];
    const evaluator: Evaluator = {
      async evaluate(sql: string, dialect: string, ...rest: unknown[]): Promise<Verdict> {
        calls.push(rest);
        return verdictFromResponse({ decision: 'ALLOWED' }, sql, dialect);
      },
      async supportedDialects() {
        return undefined;
      },
    };
    const g = new Vericto({ evaluator, logger: false, env: {} });
    await g.check('SELECT 1', 'postgres');
    await g.check('SELECT 1', 'postgres', { endUser: { id: 'u_1' } });
    expect(calls).toEqual([[], [{ context: undefined, endUser: { id: 'u_1' } }]]);
  });
});

describe('client-side limits (the server rules)', () => {
  const cases: [string, unknown, unknown, RegExp][] = [
    ['empty ticket', { ticket: '' }, undefined, /context\.ticket must not be empty/],
    ['ticket over 128', { ticket: long(129) }, undefined, /context\.ticket: at most 128/],
    ['control character', { tenant: 'a\nb' }, undefined, /context\.tenant: no control characters/],
    ['DEL', { tenant: 'a\u007fb' }, undefined, /no control characters/],
    ['non-string', { tenant: 7 }, undefined, /context\.tenant must be a string/],
    ['unknown key', { ticket: TICKET, user: 'x' }, undefined, /unknown key/],
    ['not an object', 'CHG-1', undefined, /context must be an object/],
    ['array', ['CHG-1'], undefined, /context must be an object/],
    ['empty value', undefined, { id: '' }, /endUser\.id must not be empty/],
    ['value over 256', undefined, { id: long(257) }, /endUser\.id: at most 256/],
    ['tab', undefined, { id: 'a\tb' }, /no control characters/],
    ['key starts with a digit', undefined, { '1st': 'x' }, /keys are identifiers/],
    ['dash in the key', undefined, { 'a-b': 'x' }, /keys are identifiers/],
    ['key over 63', undefined, { ['k'.repeat(64)]: 'x' }, /keys are identifiers/],
    ['newline in the key', undefined, { 'id\n': 'x' }, /keys are identifiers/],
    ['17 keys', undefined, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])), /at most 16 keys/],
    ['number value', undefined, { id: 1 }, /endUser\.id must be a string/],
    ['endUser array', undefined, ['id'], /endUser must be an object/],
  ];

  it.each(cases)('%s is refused before anything is sent, in both fail modes', async (_name, context, endUser, message) => {
    for (const failMode of ['open', 'closed'] as const) {
      const g = fake.guard({ failMode });
      const options = { context, endUser } as never;
      await expect(g.check('SELECT 1', 'postgres', options)).rejects.toThrow(message);
      await expect(g.enforce('SELECT 1', 'postgres', options)).rejects.toBeInstanceOf(VerictoConfigError);
    }
    expect(fake.requests).toEqual([]);
  });

  it('messages name the field, never the value', () => {
    const secret = `tenant-secret-${'z'.repeat(120)}`;
    expect(() => policyFields({ context: { tenant: secret } })).toThrow(/context\.tenant/);
    try {
      policyFields({ context: { tenant: secret } });
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('the limits are inclusive and count UTF-16 code units, as the server does', () => {
    const endUser = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, long(256)]));
    expect(Object.keys(policyFields({ context: { ticket: long(128), tenant: 'é'.repeat(128) }, endUser }).end_user!)).toHaveLength(16);
    expect(policyFields({ endUser: { _: 'x', [`A${'b'.repeat(62)}`]: 'y' } }).end_user).toEqual({ _: 'x', [`A${'b'.repeat(62)}`]: 'y' });
    expect(policyFields({ context: { ticket: '\u{1F600}'.repeat(64) } }).context).toBeDefined();
    expect(() => policyFields({ context: { ticket: `${'\u{1F600}'.repeat(64)}x` } })).toThrow(/at most 128/);
  });
});

describe('the verdict cache', () => {
  it('keys on the declared context', async () => {
    const g = fake.guard({ cacheTtlMs: 60_000 });
    await g.check('SELECT 1', 'postgres', { context: { tenant: 'a' } });
    expect((await g.check('SELECT 1', 'postgres', { context: { tenant: 'a' } })).cached).toBe(true);
    expect((await g.check('SELECT 1', 'postgres', { context: { tenant: 'b' } })).cached).toBe(false);
    expect((await g.check('SELECT 1', 'postgres')).cached).toBe(false);
    expect((await g.check('SELECT 1', 'postgres', { endUser: { id: 'u_1', role: 'x' } })).cached).toBe(false);
    // Attribute order does not matter.
    expect((await g.check('SELECT 1', 'postgres', { endUser: { role: 'x', id: 'u_1' } })).cached).toBe(true);
    expect(fake.requests).toHaveLength(4);
  });
});

describe('against scripts/docs-stub.mjs (the service validation rules)', () => {
  it('receives the body', async () => {
    const stub = await startStub();
    try {
      const g = new Vericto({ apiKey: API_KEY, databaseId: DATABASE_ID, apiUrl: stub.url, logger: false, env: {} });
      const verdict = await g.check('SELECT 1', 'postgres', { context: { ticket: TICKET, tenant: 'acme' }, endUser: END_USER });
      expect(verdict.decision).toBe('ALLOWED');
      expect(stub.requests).toEqual([
        { query: 'SELECT 1', dialect: 'postgres', context: { ticket: TICKET, tenant: 'acme' }, end_user: END_USER },
      ]);
    } finally {
      await stub.close();
    }
  });

  it('the client limits match the stub', () => {
    const errors = policyContextErrors;
    const ok = {
      context: { ticket: long(128), tenant: 'acme' },
      end_user: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, long(256)])),
    };
    expect(errors(ok)).toEqual([]);
    expect(policyFields({ context: ok.context, endUser: ok.end_user })).toEqual(ok);
    for (const bad of [
      { context: { ticket: long(129) } },
      { context: { ticket: '' } },
      { context: { other: 'x' } },
      { end_user: { '1x': 'y' } },
      { end_user: { id: 'a\u0000b' } },
      { end_user: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) },
    ]) {
      expect(errors(bad)).not.toEqual([]);
      expect(() => policyFields({ context: bad.context, endUser: bad.end_user })).toThrow(VerictoConfigError);
    }
  });
});
