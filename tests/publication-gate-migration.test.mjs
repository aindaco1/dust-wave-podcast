import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);

describe("publication gate migration", () => {
  it("replays from zero and atomically versions episode, show, and global evidence", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }
      db.exec(`
        INSERT INTO episodes (
          id, show_id, slug, title, summary, content_html, canonical_url
        ) VALUES (
          'episode_gate_fixture',
          'show_opera_en_la_selva',
          'gate-fixture',
          'Gate fixture',
          'Summary',
          '<p>Notes</p>',
          'https://dustwave.xyz/news/podcasts/opera/gate-fixture/'
        );
        UPDATE episodes
        SET title = 'Gate fixture updated'
        WHERE id = 'episode_gate_fixture';
        UPDATE shows
        SET language = 'en'
        WHERE id = 'show_opera_en_la_selva';
        UPDATE distribution_destinations
        SET updated_at = datetime('now')
        WHERE id = 'spotify';
        INSERT INTO transcripts (id, episode_id, language)
        VALUES ('transcript_gate_fixture', 'episode_gate_fixture', 'en');
      `);

      expect(db.prepare(`
        SELECT
          episode.publication_evidence_version AS episode_version,
          show_evidence.version AS show_version,
          global_evidence.version AS global_version
        FROM episodes episode
        JOIN publication_show_evidence_versions show_evidence
          ON show_evidence.show_id = episode.show_id
        CROSS JOIN publication_global_evidence_versions global_evidence
        WHERE episode.id = 'episode_gate_fixture'
      `).get()).toMatchObject({
        episode_version: 2,
        show_version: 1,
        global_version: 1
      });

      expect(() => db.exec(`
        BEGIN;
        UPDATE episodes
        SET title = title
        WHERE id = 'episode_missing';
        INSERT INTO publication_batch_guards (id, update_succeeded)
        VALUES ('guard_should_fail', changes());
        COMMIT;
      `)).toThrow(/update_succeeded/);
      if (db.isTransaction) db.exec("ROLLBACK");
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM publication_batch_guards"
      ).get()).toMatchObject({ count: 0 });

      db.exec(`
        BEGIN;
        UPDATE episodes
        SET
          status = 'published',
          public_at = '2026-07-25T12:00:00.000Z',
          publication_revision = 1,
          publication_fingerprint = 'fixture'
        WHERE id = 'episode_gate_fixture'
          AND publication_revision = 0
          AND publication_evidence_version = 2
          AND (
            SELECT version
            FROM publication_show_evidence_versions
            WHERE show_id = episodes.show_id
          ) = 1
          AND (
            SELECT version
            FROM publication_global_evidence_versions
            WHERE id = 'distribution'
          ) = 1;
        INSERT INTO publication_batch_guards (id, update_succeeded)
        VALUES ('guard_success', changes());
        DELETE FROM publication_batch_guards WHERE id = 'guard_success';
        COMMIT;
      `);
      expect(db.prepare(`
        SELECT publication_revision, publication_evidence_version
        FROM episodes
        WHERE id = 'episode_gate_fixture'
      `).get()).toMatchObject({
        publication_revision: 1,
        publication_evidence_version: 3
      });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
