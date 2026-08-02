import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

export function migratedSqlite() {
  const sqlite = new DatabaseSync(":memory:");
  for (const filename of readdirSync(migrationsDirectory)
    .filter((candidate) => candidate.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
  }
  return sqlite;
}

export function sqliteD1(sqlite) {
  return {
    prepare(query) {
      let values = [];
      return {
        bind(...bound) {
          values = bound;
          return this;
        },
        async run() {
          const result = sqlite.prepare(query).run(...values);
          return {
            success: true,
            meta: { changes: Number(result.changes) }
          };
        },
        async first() {
          return sqlite.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(query).all(...values) };
        }
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  };
}
