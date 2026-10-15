// Guard a better-sqlite3 database. SQLite is evaluated once the Vericto server lists
// the `sqlite` dialect; until then guardDatabase rejects and no SQL runs.
import Database from 'better-sqlite3';

import { VerictoBlockedError, VerictoUnsupportedDialectError } from '@vericto/sdk';
import { guardDatabase } from '@vericto/sdk/better-sqlite3';

const raw = new Database('app.db');
try {
  const db = await guardDatabase(raw);
  const expire = await db.prepare('DELETE FROM sessions WHERE expires_at < ?'); // checked once
  expire.run(Date.now()); // synchronous, as usual
  await db.run('DELETE FROM sessions'); // no WHERE: blocked by the workspace rules
} catch (err) {
  if (err instanceof VerictoBlockedError || err instanceof VerictoUnsupportedDialectError) console.log(err.message);
  else throw err;
} finally {
  raw.close();
}
