// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

// Ask Vericto yourself, around any driver: run the SQL it returns (the masked
// rewrite when a sensitive column is read), or handle the block.
import { Vericto, sqlToExecute } from '@vericto/sdk';

const vericto = new Vericto({ failMode: 'closed', onVerdict: (v) => console.log(v.decision, v.ruleCode ?? '') });

export async function guardedQuery<T>(run: (sql: string) => Promise<T>, sql: string): Promise<T> {
  const verdict = await vericto.enforce(sql, 'postgres'); // rejects with VerictoBlockedError
  return run(sqlToExecute(verdict));
}
