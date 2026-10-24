// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * The declared context of an evaluation: `context` and `endUser` (`end_user` on the
 * wire).
 *
 * The Runtime API (`POST /api/v1/proxy/query`) accepts two optional fields that
 * business policies can read:
 *
 * - `context`: `{ ticket, tenant }`, the change ticket the statement belongs to and
 *   the tenant it runs for. Each value is 1 to 128 characters, with no control
 *   characters. No other key is accepted.
 * - `endUser`: the end user your service acts for, as up to 16 `key: value`
 *   attributes. Keys are identifiers (a letter or `_`, then letters, digits or `_`;
 *   at most 63 characters); values are 1 to 256 characters, with no control
 *   characters.
 *
 * They take effect when business policies are enabled in your workspace; otherwise
 * the server ignores them. The values are asserted by your service: they carry the
 * trust of the API key that sends them, never more.
 *
 * The limits are checked before anything is sent, with the server's own rules, so an
 * invalid value throws `VerictoConfigError` whatever the fail mode is.
 */
import { VerictoConfigError } from './errors.js';

/** `context` of an evaluation: the change ticket and the tenant. */
export interface PolicyContext {
  readonly ticket?: string;
  readonly tenant?: string;
}

/** `end_user` of an evaluation: up to 16 identifier keys with string values. */
export type EndUser = Readonly<Record<string, string>>;

/** The optional, per-call part of an evaluation request. */
export interface EvaluationOptions {
  /** The change ticket and tenant (`context`). */
  readonly context?: PolicyContext;
  /** The end user's attributes (`end_user`). */
  readonly endUser?: EndUser;
}

/** The request-body fields `context` and `end_user`, as sent. */
export interface PolicyFields {
  context?: { ticket?: string; tenant?: string };
  end_user?: Record<string, string>;
}

export const CONTEXT_KEYS = ['ticket', 'tenant'] as const;
export const MAX_CONTEXT_VALUE = 128;
export const MAX_END_USER_KEYS = 16;
export const MAX_END_USER_VALUE = 256;

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function printable(field: string, value: unknown, max: number): string {
  if (typeof value !== 'string') throw new VerictoConfigError(`${field} must be a string, got ${typeof value}.`);
  if (!value) throw new VerictoConfigError(`${field} must not be empty.`);
  // String length is in UTF-16 code units, as the server (zod) counts it.
  if (value.length > max) throw new VerictoConfigError(`${field}: at most ${max} characters.`);
  if (CONTROL_RE.test(value)) throw new VerictoConfigError(`${field}: no control characters.`);
  return value;
}

/**
 * Validate `context` and `endUser` and return the request-body fields. An omitted,
 * `undefined` or empty value adds nothing. Throws `VerictoConfigError` for a value the
 * server would reject; the message names the field, never its value.
 */
export function policyFields(options: EvaluationOptions | undefined): PolicyFields {
  const out: PolicyFields = {};
  if (!options) return out;
  const { context, endUser } = options as { context?: unknown; endUser?: unknown };
  if (context !== undefined && context !== null) {
    if (!isPlainObject(context)) {
      throw new VerictoConfigError(`context must be an object (ticket, tenant), got ${Array.isArray(context) ? 'array' : typeof context}.`);
    }
    const unknownKeys = Object.keys(context).filter((k) => !(CONTEXT_KEYS as readonly string[]).includes(k));
    if (unknownKeys.length) {
      throw new VerictoConfigError(`context: unknown key(s) ${unknownKeys.sort().join(', ')}; only ticket and tenant.`);
    }
    const declared: { ticket?: string; tenant?: string } = {};
    for (const key of CONTEXT_KEYS) {
      const value = context[key];
      if (value !== undefined && value !== null) declared[key] = printable(`context.${key}`, value, MAX_CONTEXT_VALUE);
    }
    if (Object.keys(declared).length) out.context = declared;
  }
  if (endUser !== undefined && endUser !== null) {
    if (!isPlainObject(endUser)) {
      throw new VerictoConfigError(`endUser must be an object of attributes, got ${Array.isArray(endUser) ? 'array' : typeof endUser}.`);
    }
    const entries = Object.entries(endUser);
    if (entries.length > MAX_END_USER_KEYS) throw new VerictoConfigError(`endUser: at most ${MAX_END_USER_KEYS} keys.`);
    const attrs: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (!KEY_RE.test(key)) {
        throw new VerictoConfigError('endUser: keys are identifiers (letters, digits, _), at most 63 characters.');
      }
      attrs[key] = printable(`endUser.${key}`, value, MAX_END_USER_VALUE);
    }
    if (entries.length) out.end_user = attrs;
  }
  return out;
}

/** A wrapper option: a fixed value, or a function read for every statement. */
export type Source<T> = T | (() => T | undefined);

/** The value of a wrapper's `context` / `endUser` option (calls it when it is a function). */
export function resolveSource<T>(source: Source<T> | undefined): T | undefined {
  return typeof source === 'function' ? (source as () => T | undefined)() : source;
}
