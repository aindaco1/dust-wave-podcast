import { describe, expect, it } from "vitest";

import { failEditorialAiDraft } from "../src/editorial-ai-draft-ledger";

describe("editorial AI draft ledger", () => {
  it("persists the caller's content-free failure code", async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare(query: string) {
        const statement = {
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            statements.push({ query, values });
            return statement;
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          }
        };
        return statement;
      },
      async batch(batch: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(batch.map((statement) => statement.run()));
      }
    } as unknown as D1Database;

    expect(await failEditorialAiDraft(db, {
      draftId: "editorial_draft_fixture",
      inputFingerprint: "a".repeat(64),
      leaseId: "editorial_draft_lease_fixture"
    }, {
      auditAction: "show_notes.automatic_draft_failed",
      auditMetadata: {
        failureCode: "show_notes_attribution_invalid"
      },
      failureCode: "show_notes_attribution_invalid"
    })).toBe(true);

    const failure = statements.find(({ query }) =>
      query.includes("SET\n         status = 'failed'")
    );
    expect(failure?.values[0]).toBe("show_notes_attribution_invalid");
  });
});
