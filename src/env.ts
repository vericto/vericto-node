// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/** The environment the SDK reads its `VERICTO_*` defaults from. */
export type Env = Record<string, string | undefined>;

/** `options.env` when given, else `process.env` (an empty object where there is no `process`). */
export function defaultEnv(env: Env | undefined): Env {
  return env ?? (typeof process !== 'undefined' ? process.env : {});
}

/**
 * The trimmed value of `name`, or `undefined` when it is unset, empty or whitespace
 * only. Every `VERICTO_*` variable is read through this, so `VERICTO_FAIL_MODE=` or a
 * CI variable that expands to nothing means "use the documented default".
 */
export function readEnv(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}
