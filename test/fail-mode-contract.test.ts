// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * The fail-mode contract over HTTP, shared with vericto-python 0.5.0. When Vericto
 * cannot answer (network error, timeout, 5xx, a body that is not JSON):
 *
 * - `failMode: 'open'`: `check()` resolves an `UNEVALUATED` verdict with the reason,
 *   `enforce()` resolves one too (the statement may run, with a process warning);
 *   neither rejects.
 * - `failMode: 'closed'` (default): both reject with `VerictoUnavailableError`.
 */
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeApiEvaluator, Vericto, VerictoUnavailableError, type FailMode, type Verdict } from '../src/index.js';
import { API_KEY, DATABASE_ID, FakeVericto } from './fake-vericto.js';

let fake: FakeVericto;
beforeEach(async () => {
  fake = await new FakeVericto().start();
});
afterEach(async () => {
  await fake.stop();
});

/** A port nothing listens on. */
async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  return `http://127.0.0.1:${port}`;
}

const CASES: Record<string, { setup: () => Promise<string>; reason: RegExp }> = {
  'network error': { setup: closedPort, reason: /while calling/ },
  timeout: {
    setup: async () => {
      fake.queue.push({ status: 200, body: { decision: 'ALLOWED' }, delayMs: 400 });
      return fake.url;
    },
    reason: /Timeout while calling/,
  },
  '5xx': {
    setup: async () => {
      fake.queue.push({ status: 503, body: { error: { code: 'INTERNAL_ERROR', message: 'boom' } } });
      return fake.url;
    },
    reason: /HTTP 503/,
  },
  'invalid JSON': {
    setup: async () => {
      fake.queue.push({ status: 200, body: '<html>bad gateway</html>' });
      return fake.url;
    },
    reason: /without a decision/,
  },
};

function guard(apiUrl: string, failMode: FailMode, onVerdict?: (v: Verdict) => void): Vericto {
  const evaluator = new RuntimeApiEvaluator({
    apiKey: API_KEY,
    databaseId: DATABASE_ID,
    apiUrl,
    timeoutMs: 150,
    maxRetries: 0,
    backoffMs: 0,
    env: {},
  });
  return new Vericto({ evaluator, failMode, logger: false, env: {}, onVerdict });
}

describe.each(Object.keys(CASES))('when Vericto cannot answer: %s', (name) => {
  const { setup, reason } = CASES[name]!;

  it("failMode 'open': check() resolves UNEVALUATED with the reason and never rejects", async () => {
    const verdict = await guard(await setup(), 'open').check('DELETE FROM t', 'postgres');
    expect(verdict.decision).toBe('UNEVALUATED');
    expect(verdict.message).toMatch(reason);
    expect(verdict.message).not.toContain(API_KEY);
    expect([verdict.sql, verdict.dialect]).toEqual(['DELETE FROM t', 'postgres']);
  });

  it("failMode 'open': enforce() resolves UNEVALUATED, warns and notifies", async () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const seen: Verdict[] = [];
      const verdict = await guard(await setup(), 'open', (v) => seen.push(v)).enforce('SELECT 1', 'postgres');
      expect(verdict.decision).toBe('UNEVALUATED');
      expect(verdict.message).toMatch(reason);
      expect(seen).toEqual([verdict]);
      expect(emit).toHaveBeenCalledWith(expect.stringMatching(reason), expect.objectContaining({ type: 'VerictoFailOpenWarning' }));
    } finally {
      emit.mockRestore();
    }
  });

  it.each(['check', 'enforce'] as const)("failMode 'closed': %s() rejects with VerictoUnavailableError", async (method) => {
    const g = guard(await setup(), 'closed');
    const err = await g[method]('SELECT 1', 'postgres').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VerictoUnavailableError);
    expect((err as Error).message).toMatch(reason);
    expect((err as Error).message).not.toContain(API_KEY);
  });
});
