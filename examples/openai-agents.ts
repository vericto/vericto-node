// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * An OpenAI Agents SDK agent whose SQL tool is checked by Vericto.
 *
 *   npm install @vericto/sdk @openai/agents zod pg
 *   VERICTO_API_KEY=vtro_... VERICTO_DATABASE_ID=... DATABASE_URL=postgres://... OPENAI_API_KEY=... \
 *     npx tsx examples/openai-agents.ts
 */
import { Agent, run } from '@openai/agents';
import pg from 'pg';
import { sqlTool, verictoErrorOf } from '@vericto/sdk/openai-agents';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Vericto checks each query the model writes; `execute` runs the SQL it approved. A
// blocked query never runs: the model gets the rule and the suggested fix. To guard a
// tool you already have, add verictoToolInputGuardrail({ dialect, sqlKey }) to its
// inputGuardrails instead.
const agent = new Agent({
  name: 'SQL agent',
  instructions: 'Answer questions about the database with SQL. If a query is blocked, follow the suggested fix.',
  tools: [sqlTool({ dialect: 'postgres', execute: async (sql) => (await pool.query(sql)).rows })],
});

try {
  const result = await run(agent, 'Delete the test customers, then tell me how many customers are left.');
  console.log(result.finalOutput);
} catch (err) {
  // Fail closed: Vericto unavailable or misconfigured rejects the run; nothing ran.
  const vericto = verictoErrorOf(err);
  console.error(vericto ? `Vericto: ${vericto.message}` : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
