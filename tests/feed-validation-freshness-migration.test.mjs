import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const showId = "show_opera_en_la_selva";
const episodeId = "episode_feed_freshness";
const feedSha256 = "f".repeat(64);

describe("feed-validation freshness migration", () => {
  it("expires exact-feed evidence only after feed-affecting mutations", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const filename of readdirSync(migrationsDirectory)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        db.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
      }
      db.prepare(
        `INSERT INTO episodes (
           id, show_id, slug, title, summary, content_html, canonical_url
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        episodeId,
        showId,
        "feed-freshness",
        "Feed freshness",
        "Summary",
        "<p>Private notes.</p>",
        "https://dustwave.xyz/news/podcasts/opera/feed-freshness/"
      );

      recordValidFeed(db);
      db.prepare(
        "UPDATE episodes SET content_html = ? WHERE id = ?"
      ).run("<p>Changed private notes.</p>", episodeId);
      expect(validationCount(db)).toBe(1);

      db.prepare(
        "UPDATE episodes SET title = ? WHERE id = ?"
      ).run("Changed feed title", episodeId);
      expect(validationCount(db)).toBe(0);

      recordValidFeed(db);
      db.prepare(
        `INSERT INTO transcripts (
           id, episode_id, language, status, revision,
           speaker_labels_confirmed
         ) VALUES (
           'transcript_feed_freshness', ?, 'es', 'needs_review', 1, 1
         )`
      ).run(episodeId);
      expect(validationCount(db)).toBe(1);
      db.prepare(
        `INSERT INTO transcript_approvals (
           id, transcript_id, revision
         ) VALUES (
           'transcript_approval_feed_freshness',
           'transcript_feed_freshness',
           1
         )`
      ).run();
      expect(validationCount(db)).toBe(0);

      recordValidFeed(db);
      db.prepare(
        `INSERT INTO episode_chapter_approvals (
           id, episode_id, revision
         ) VALUES ('chapter_approval_feed_freshness', ?, 1)`
      ).run(episodeId);
      expect(validationCount(db)).toBe(0);

      recordValidFeed(db);
      db.prepare(
        "UPDATE shows SET title = ? WHERE id = ?"
      ).run("Ópera en la Selva — updated", showId);
      expect(validationCount(db)).toBe(0);

      recordValidFeed(db);
      db.prepare(
        `INSERT INTO episodes (
           id, show_id, slug, title, summary, content_html,
           status, access, public_at, canonical_url,
           audio_key, guid, media_status
         ) VALUES (
           'episode_feed_due_insert',
           ?,
           'feed-due-insert',
           'Due insert',
           'Summary',
           '<p>Notes.</p>',
           'published',
           'public',
           '2026-07-20T12:00:00.000Z',
           'https://dustwave.xyz/news/podcasts/opera/feed-due-insert/',
           'podcasts/opera/feed-due-insert.mp3',
           'urn:dustwave:episode:feed-due-insert',
           'ready'
         )`
      ).run(showId);
      expect(validationCount(db)).toBe(0);

      recordValidFeed(db);
      db.prepare(
        "DELETE FROM episodes WHERE id = 'episode_feed_due_insert'"
      ).run();
      expect(validationCount(db)).toBe(0);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      db.close();
    }
  });
});

function recordValidFeed(db) {
  db.prepare(
    `INSERT INTO show_feed_validations (
       show_id, status, feed_url, validator_version,
       feed_sha256, item_count, checked_at, validated_at
     ) VALUES (
       ?, 'valid',
       'https://feeds.dustwave.xyz/opera-en-la-selva/rss.xml',
       'dustwave-rss-launch-v3',
       ?, 1,
       '2026-07-28T12:00:00.000Z',
       '2026-07-28T12:00:00.000Z'
     )`
  ).run(showId, feedSha256);
}

function validationCount(db) {
  return db.prepare(
    "SELECT COUNT(*) AS count FROM show_feed_validations WHERE show_id = ?"
  ).get(showId).count;
}
