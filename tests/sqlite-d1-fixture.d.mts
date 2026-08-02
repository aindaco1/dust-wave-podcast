type SqliteStatement = {
  run(...values: unknown[]): unknown;
  get(...values: unknown[]): Record<string, unknown> | undefined;
  all(...values: unknown[]): Array<Record<string, unknown>>;
};

type SqliteDatabase = {
  prepare(query: string): SqliteStatement;
  close(): void;
};

export function migratedSqlite(): SqliteDatabase;
export function sqliteD1(sqlite: SqliteDatabase): D1Database;
