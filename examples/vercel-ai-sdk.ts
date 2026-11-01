// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * A Vercel AI SDK agent whose SQL tool is checked by Vericto.
 *
 *   npm install @vericto/sdk ai @ai-sdk/openai pg
 *   VERICTO_API_KEY=vtro_... VERICTO_DATABASE_ID=... DATABASE_URL=postgres://... OPENAI_API_KEY=... \
 *     npx tsx examples/vercel-ai-sdk.ts
 */
import { openai } from '@ai-sdk/openai';
import { generateText, isStepCount } from 'ai';
import pg from 'pg';
import { sqlTool, throwOnVerictoError } from '@vericto/sdk/ai';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Vericto checks each query the model writes; `execute` runs the SQL it approved (the
// approved query when columns are masked or a LIMIT is bound). A blocked query never
// runs: the model gets the rule and the suggested fix, and rewrites it.
const runSql = sqlTool({
  dialect: 'postgres',
  execute: async (sql) => (await pool.query(sql)).rows,
});

const result = await generateText({
  model: openai('gpt-5-mini'),
  tools: { runSql },
  stopWhen: isStepCount(8),
  system: 'Answer questions about the database with SQL. If a query is blocked, follow the suggested fix.',
  prompt: 'Delete the test customers, then tell me how many customers are left.',
});
throwOnVerictoError(result); // Vericto unavailable or misconfigured: nothing ran
console.log(result.text);
await pool.end();
