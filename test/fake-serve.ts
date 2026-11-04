// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * Executable stand-ins for `vericto serve --stdio` (scripts/serve-stub.mjs),
 * one small launcher per configuration in a temporary directory. POSIX only: the
 * launcher is a `#!/bin/sh` script.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Vericto, type VerictoOptions } from '../src/index.js';

const SCRIPT = fileURLToPath(new URL('../scripts/serve-stub.mjs', import.meta.url));

export class FakeServe {
  readonly dir = mkdtempSync(join(tmpdir(), 'vericto-node-fake-serve-'));
  #n = 0;

  /** A launcher for the fake with `flags`; `spawnLog` records one pid per start. */
  cli(flags: string[] = [], options: { name?: string; dir?: string } = {}): { path: string; spawnLog: string } {
    const n = ++this.#n;
    const spawnLog = join(this.dir, `spawns-${String(n)}.log`);
    const dir = options.dir ?? join(this.dir, `cli-${String(n)}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, options.name ?? 'vericto');
    const quoted = [process.execPath, SCRIPT, ...flags, '--spawn-log', spawnLog].map((a) => `'${a.replace(/'/g, `'\\''`)}'`);
    writeFileSync(path, `#!/bin/sh\nexec ${quoted.join(' ')} "$@"\n`);
    chmodSync(path, 0o755);
    return { path, spawnLog };
  }

  /** The pids the launcher at `spawnLog` started. */
  static pids(spawnLog: string): number[] {
    return existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** True while `pid` is running. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait until `predicate` holds (polling), or fail after `ms`. */
export async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Run `fn` with an offline guard on a fake `vericto serve` (DELETE is BLOCKED by
 * VERICTO-001, DROP by VERICTO-010, the rest ALLOWED), then close it.
 */
export async function withOfflineGuard<T>(fn: (vericto: Vericto) => Promise<T>, options: VerictoOptions = {}): Promise<T> {
  const serve = new FakeServe();
  const vericto = new Vericto({ offline: true, offlineCliPath: serve.cli().path, logger: false, env: {}, ...options });
  try {
    return await fn(vericto);
  } finally {
    await vericto.close();
    serve.cleanup();
  }
}
