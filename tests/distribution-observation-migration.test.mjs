import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  recordDistributionObservation
} from "../src/distribution-observation-store";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("distribution observation persistence", () => {
  it("records and verifies one exact event with real schema", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database);
      database.exec(`
        INSERT INTO episodes (
          id, show_id, slug, title, canonical_url, publication_revision
        ) VALUES (
          'episode_directory_probe',
          'show_opera_en_la_selva',
          'directory-probe',
          'Directory probe',
          'https://dustwave.xyz/news/directory-probe/',
          3
        );
        INSERT INTO episode_publications (
          id, episode_id, destination_id, publication_revision,
          status, idempotency_key
        ) VALUES (
          'publication_directory_probe',
          'episode_directory_probe',
          'spotify',
          3,
          'waiting_for_feed',
          'directory-probe-idempotency'
        );
      `);
      const result = await recordDistributionObservation(
        d1Database(database),
        {
          publication: {
            id: "publication_directory_probe",
            showId: "show_opera_en_la_selva",
            episodeId: "episode_directory_probe",
            destinationId: "spotify",
            publicationRevision: 3,
            priorStatus: "waiting_for_feed",
            priorEvidenceUrl: null,
            priorError: null,
            priorEvidenceSource: null
          },
          status: "observed",
          evidenceUrl: "https://open.spotify.com/show/directory-probe",
          error: null,
          evidenceSource: "automated_probe",
          adminUserId: null
        }
      );

      expect(result.status).toBe("recorded");
      expect(database.prepare(`
        SELECT status, evidence_url, evidence_source,
          evidence_admin_user_id, last_error
        FROM episode_publications
        WHERE id = 'publication_directory_probe'
      `).get()).toEqual({
        status: "observed",
        evidence_url: "https://open.spotify.com/show/directory-probe",
        evidence_source: "automated_probe",
        evidence_admin_user_id: null,
        last_error: null
      });
      expect(database.prepare(`
        SELECT status, evidence_source, evidence_admin_user_id
        FROM distribution_observation_events
        WHERE episode_id = 'episode_directory_probe'
      `).get()).toEqual({
        status: "observed",
        evidence_source: "automated_probe",
        evidence_admin_user_id: null
      });
      const audit = database.prepare(`
        SELECT admin_user_id, action, metadata_json
        FROM admin_audit_events
        WHERE target_id = 'publication_directory_probe'
      `).get();
      expect(audit).toMatchObject({
        admin_user_id: null,
        action: "distribution.directory_observed"
      });
      expect(audit.metadata_json).not.toContain("Directory probe");
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});

function applyMigrations(database) {
  for (const filename of readdirSync(migrationsDirectory)
    .filter((candidate) => candidate.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
  }
}

function d1Database(database) {
  const prepare = (query) => {
    let values = [];
    const statement = {
      bind(...bound) {
        values = bound;
        return statement;
      },
      async first() {
        return database.prepare(query).get(...values) ?? null;
      },
      async run() {
        database.prepare(query).run(...values);
        return { success: true };
      },
      executeRun() {
        database.prepare(query).run(...values);
        return { success: true };
      }
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) =>
          statement.executeRun()
        );
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
}
