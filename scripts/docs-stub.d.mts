// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/** Types of scripts/docs-stub.mjs, for the tests that start it. */

export interface StubRequest {
  query: string;
  dialect: string;
  context?: Record<string, unknown>;
  end_user?: Record<string, unknown>;
}

export interface Stub {
  url: string;
  evaluations(): number;
  requests: StubRequest[];
  close(): Promise<void>;
}

export function decide(query: string): { status: number; [field: string]: unknown };
export function policyContextErrors(body: Record<string, unknown>): { field: string; message: string }[];
export function startStub(options?: { port?: number }): Promise<Stub>;
