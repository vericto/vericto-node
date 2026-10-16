/**
 * Dialects the Vericto engine evaluates (`sqlite` since vericto-engine 4.1.0). The
 * wrappers still ask the server (`GET /api/v1/meta/config`) and refuse a dialect it
 * does not list.
 */
export const KNOWN_DIALECTS = ['postgres', 'mysql', 'oracle', 'mssql', 'snowflake', 'sqlite'] as const;

const ALIASES: Readonly<Record<string, string>> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  pg: 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mysql',
  oracle: 'oracle',
  oracledb: 'oracle',
  mssql: 'mssql',
  sqlserver: 'mssql',
  tedious: 'mssql',
  snowflake: 'snowflake',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  'better-sqlite3': 'sqlite',
};

/**
 * Map a driver name to the Vericto dialect id. Unknown names pass through
 * lower-cased: the server decides, and answers with a clear error.
 */
export function normalizeDialect(name: string): string {
  const key = name.trim().toLowerCase();
  return ALIASES[key] ?? key;
}
