// Guard a snowflake-sdk connection.
//   VERICTO_API_KEY=vtro_... VERICTO_DATABASE_ID=<uuid> node --experimental-strip-types examples/snowflake.ts
import snowflake from 'snowflake-sdk';

import { VerictoBlockedError } from '@vericto/vericto';
import { guardConnection } from '@vericto/vericto/snowflake';

const raw = snowflake.createConnection({
  account: process.env.SNOWFLAKE_ACCOUNT ?? '',
  username: process.env.SNOWFLAKE_USER ?? '',
  authenticator: 'SNOWFLAKE_JWT',
  privateKeyPath: process.env.SNOWFLAKE_PRIVATE_KEY_FILE ?? '',
});
await raw.connectAsync();
const conn = await guardConnection(raw);

const rows = await conn.query('SELECT CURRENT_ACCOUNT() AS account, ? AS one', [1]);
console.log(rows);

try {
  await conn.query('DELETE FROM analytics.public.orders'); // never reaches Snowflake
} catch (err) {
  if (err instanceof VerictoBlockedError) console.log('blocked:', err.verdict.ruleCode, err.suggestedFix);
  else throw err;
}
