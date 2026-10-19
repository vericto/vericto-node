// SPDX-FileCopyrightText: 2026 Vericto S.A.S.
// SPDX-License-Identifier: Apache-2.0

/**
 * A LangChain.js SQL agent whose queries are checked by Vericto.
 *
 *   npm install @vericto/sdk @langchain/classic @langchain/core @langchain/openai typeorm pg
 *   VERICTO_API_KEY=vtro_... VERICTO_DATABASE_ID=... DATABASE_URL=postgres://... npx tsx examples/langchain.ts
 */
import { ChatOpenAI } from '@langchain/openai';
import { createSqlAgent } from '@langchain/classic/agents/toolkits/sql';
import { DataSource } from 'typeorm';
import { VerictoSqlDatabase, VerictoSqlToolkit } from '@vericto/sdk/langchain';

const db = await VerictoSqlDatabase.fromDataSourceParams({
  appDataSource: new DataSource({ type: 'postgres', url: process.env.DATABASE_URL }),
});
const llm = new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 });
const agent = createSqlAgent(llm, new VerictoSqlToolkit(db, llm));

// A blocked query comes back to the agent as a message with the rule and the
// suggested fix; the agent rewrites it instead of crashing.
const result = await agent.invoke({ input: 'Delete the test customers' });
console.log(result.output);
await db.appDataSource.destroy();
