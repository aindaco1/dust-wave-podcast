import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../src/show-premium-prices.ts", import.meta.url)),
  "utf8"
);
const updateSql = source.match(
  /export const PREMIUM_PRICE_UPDATE_SQL = `([\s\S]+?)`;/u
)?.[1];

describe("premium price atomic SQL", () => {
  it("updates both expected rows or neither", () => {
    expect(updateSql).toBeTruthy();
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        `CREATE TABLE show_prices (
           id TEXT PRIMARY KEY,
           show_id TEXT NOT NULL,
           billing_period TEXT NOT NULL,
           amount_cents INTEGER NOT NULL,
           currency TEXT NOT NULL,
           stripe_price_id TEXT,
           provider_mode TEXT NOT NULL,
           active INTEGER NOT NULL
         );
         INSERT INTO show_prices VALUES
           (
             'price_month', 'show_fixture', 'month', 500, 'USD',
             'price_provider_month', 'test', 1
           ),
           (
             'price_year', 'show_fixture', 'year', 5000, 'USD',
             'price_provider_year', 'test', 1
           );`
      );
      const update = database.prepare(updateSql);
      const stale = update.run(
        600,
        6_000,
        600,
        6_000,
        "show_fixture",
        "show_fixture",
        "price_month",
        400,
        "price_year",
        5_000
      );
      expect(stale.changes).toBe(0);
      expect(readPrices(database)).toEqual([
        { billing_period: "month", amount_cents: 500, linked: 1 },
        { billing_period: "year", amount_cents: 5_000, linked: 1 }
      ]);

      const changed = update.run(
        600,
        5_000,
        600,
        5_000,
        "show_fixture",
        "show_fixture",
        "price_month",
        500,
        "price_year",
        5_000
      );
      expect(changed.changes).toBe(2);
      expect(readPrices(database)).toEqual([
        { billing_period: "month", amount_cents: 600, linked: 0 },
        { billing_period: "year", amount_cents: 5_000, linked: 1 }
      ]);
    } finally {
      database.close();
    }
  });
});

function readPrices(database) {
  return database.prepare(
    `SELECT
       billing_period,
       amount_cents,
       stripe_price_id IS NOT NULL AS linked
     FROM show_prices
     ORDER BY billing_period`
  ).all();
}
