// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * A Mastra agent whose SQL tool is checked by Vericto.
 *
 *   npm install @vericto/sdk @mastra/core zod pg
 *   VERICTO_API_KEY=vtro_... VERICTO_DATABASE_ID=... DATABASE_URL=postgres://... OPENAI_API_KEY=... \
 *     npx tsx examples/mastra.ts
 */
import { Agent } from '@mastra/core/agent';
import pg from 'pg';
import type { VerictoError } from '@vericto/sdk';
import { sqlTool, verictoErrorOf } from '@vericto/sdk/mastra';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Vericto checks each query the model writes; `execute` runs the SQL it approved. A
// blocked query never runs: the model gets the rule and the suggested fix. To guard a
// tool you already have, wrap it: guardSqlTool(tool, { dialect, sqlKey }).
const agent = new Agent({
  id: 'sql-agent',
  name: 'SQL agent',
  instructions: 'Answer questions about the database with SQL. If a query is blocked, follow the suggested fix.',
  model: 'openai/gpt-5-mini',
  tools: { runSql: sqlTool({ dialect: 'postgres', execute: async (sql) => (await pool.query(sql)).rows }) },
});

let failure: VerictoError | undefined;
const result = await agent.generate('Delete the test customers, then tell me how many customers are left.', {
  maxSteps: 8,
  onChunk: (chunk) => {
    if (chunk.type === 'tool-error') failure ??= verictoErrorOf(chunk.payload.error);
  },
});
await pool.end();
if (failure) throw failure; // Vericto unavailable or misconfigured: nothing ran
console.log(result.text);
