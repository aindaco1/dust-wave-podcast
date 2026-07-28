import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "@dustwave/worker-core/crypto";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import { parsePodcastRssImportPreview } from "../src/rss-import-preview";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const siteOrigin = "https://dust-wave-website-staging.pages.dev";
const apiOrigin = "https://dust-wave-podcast-staging.jogo.workers.dev";
const sessionSecret = "rss_import_plan_session_secret";
const sessionToken = "rss_import_plan_session";
const analystSessionToken = "rss_import_plan_analyst_session";
const csrfToken = "rss_import_plan_csrf";
const signedFeedUrl =
  "https://podcast.example.org/feed.xml?token=source-feed-secret";
const cancellationReason = "Provider contract still needs review";

let harnesses = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const harness of harnesses) harness.database.close();
  harnesses = [];
});

describe("reviewed RSS import plans", () => {
  it("freezes, revalidates, reviews, lists, and cancels without copying media or creating episodes", async () => {
    const harness = await createHarness();
    const preview = await parsePodcastRssImportPreview(
      validPodcastFeed(),
      signedFeedUrl
    );
    const selected = [
      preview.episodes[0].sourceIdentitySha256,
      preview.episodes[1].sourceIdentitySha256
    ];
    const providerFetch = vi.fn(async () => feedResponse(validPodcastFeed()));
    vi.stubGlobal("fetch", providerFetch);

    const prepared = await handleRequest(
      adminRequest(
        "/v1/admin/shows/show_opera_en_la_selva/rss-import/plans",
        {
          planId: "opera_import_plan",
          feedUrl: signedFeedUrl,
          ownershipConfirmed: true,
          expectedFeedSha256: preview.feedSha256,
          selectedSourceIdentitySha256: selected
        }
      ),
      harness.env
    );
    expect(prepared.status).toBe(200);
    const preparedPayload = await prepared.json();
    expect(preparedPayload).toMatchObject({
      plan: {
        id: "opera_import_plan",
        showId: "show_opera_en_la_selva",
        status: "draft",
        requestedFeedUrl: "https://podcast.example.org/feed.xml",
        selectedItemCount: 2,
        items: [
          {
            sourceIdentitySha256: selected[0],
            title: "Episodio uno",
            enclosure: {
              url: "https://cdn.example.org/audio/uno.mp3",
              mimeType: "audio/mpeg",
              bytes: 1234567
            }
          },
          {
            sourceIdentitySha256: selected[1],
            title: "Episode two"
          }
        ]
      },
      idempotent: false,
      mediaCopyPerformed: false,
      episodeMutationPerformed: false
    });
    const selectionSha256 = preparedPayload.plan.selectionSha256;
    expect(selectionSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(harness.episodeCount()).toBe(0);
    expect(harness.persistedPlanText()).not.toContain("source-feed-secret");
    expect(harness.persistedPlanText()).not.toContain("audio-secret");
    expect(harness.auditActions()).toEqual([
      "rss_import.plan_created"
    ]);

    const idempotent = await handleRequest(
      adminRequest(
        "/v1/admin/shows/show_opera_en_la_selva/rss-import/plans",
        {
          planId: "opera_import_plan",
          feedUrl: signedFeedUrl,
          ownershipConfirmed: true,
          expectedFeedSha256: preview.feedSha256,
          selectedSourceIdentitySha256: [...selected].reverse()
        }
      ),
      harness.env
    );
    expect(idempotent.status).toBe(200);
    expect(await idempotent.json()).toMatchObject({ idempotent: true });
    expect(providerFetch).toHaveBeenCalledTimes(1);

    const reviewed = await handleRequest(
      adminRequest(
        "/v1/admin/rss-import/plans/opera_import_plan/review",
        {
          feedUrl: signedFeedUrl,
          ownershipConfirmed: true,
          expectedFeedSha256: preview.feedSha256,
          expectedSelectionSha256: selectionSha256,
          reviewConfirmed: true
        }
      ),
      harness.env
    );
    expect(reviewed.status).toBe(200);
    expect(await reviewed.json()).toMatchObject({
      plan: { status: "reviewed" },
      idempotent: false,
      mediaCopyPerformed: false,
      episodeMutationPerformed: false
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(harness.episodeCount()).toBe(0);

    const listed = await handleRequest(
      adminGet(
        "/v1/admin/shows/show_opera_en_la_selva/rss-import/plans"
      ),
      harness.env
    );
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toContain("no-store");
    expect(await listed.json()).toMatchObject({
      plans: [{
        id: "opera_import_plan",
        status: "reviewed",
        selectedItemCount: 2
      }],
      limit: 10,
      mediaCopyPerformed: false,
      episodeMutationPerformed: false
    });
    const analystList = await handleRequest(
      adminGet(
        "/v1/admin/shows/show_opera_en_la_selva/rss-import/plans",
        analystSessionToken
      ),
      harness.env
    );
    expect(analystList.status).toBe(200);
    expect(analystList.headers.get("cache-control")).toContain("no-store");
    const crossShow = await handleRequest(
      adminGet(
        "/v1/admin/shows/show_out_of_scope/rss-import/plans",
        analystSessionToken
      ),
      harness.env
    );
    expect(crossShow.status).toBe(403);

    const canceled = await handleRequest(
      adminRequest(
        "/v1/admin/rss-import/plans/opera_import_plan/cancel",
        {
          expectedSelectionSha256: selectionSha256,
          reason: cancellationReason
        }
      ),
      harness.env
    );
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toMatchObject({
      plan: { status: "canceled" },
      mediaCopyPerformed: false,
      episodeMutationPerformed: false
    });
    expect(harness.persistedPlanText()).not.toContain(cancellationReason);
    expect(harness.episodeCount()).toBe(0);
    expect(harness.auditActions()).toEqual([
      "rss_import.plan_created",
      "rss_import.plan_reviewed",
      "rss_import.plan_canceled"
    ]);
    expect(() => harness.database.prepare(
      `UPDATE rss_import_plan_items
       SET title = 'Changed'
       WHERE plan_id = 'opera_import_plan'`
    ).run()).toThrow(/rss_import_plan_items_immutable/u);
    expect(() => harness.database.prepare(
      "DELETE FROM rss_import_plans WHERE id = 'opera_import_plan'"
    ).run()).toThrow(/rss_import_plans_immutable/u);
    expect(() => harness.database.prepare(
      `UPDATE rss_import_plans
       SET source_podcast_guid = ?
       WHERE id = 'opera_import_plan'`
    ).run(
      "d21642df-1816-55c8-b308-6209066e9ef6"
    )).toThrow(/rss_import_plan_podcast_guid_immutable/u);
  });

  it("freezes a matching source GUID and rejects invalid or conflicting identity", async () => {
    const harness = await createHarness();
    const assignedGuid = "d21642df-1816-55c8-b308-6209066e9ef6";
    const matchingFeed = withPodcastGuid(validPodcastFeed(), assignedGuid);
    const preview = await parsePodcastRssImportPreview(
      matchingFeed,
      signedFeedUrl
    );
    vi.stubGlobal("fetch", vi.fn(async () => feedResponse(matchingFeed)));

    const prepared = await preparePlan(harness, preview);
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toMatchObject({
      plan: {
        sourcePodcastGuid: assignedGuid
      }
    });
    expect(
      harness.database.prepare(
        "SELECT source_podcast_guid FROM rss_import_plans"
      ).get()
    ).toEqual({ source_podcast_guid: assignedGuid });

    const conflictHarness = await createHarness();
    const conflictingFeed = withPodcastGuid(
      validPodcastFeed(),
      "917393e3-1b1e-5cef-ace4-edaa54e1f810"
    );
    const conflictingPreview = await parsePodcastRssImportPreview(
      conflictingFeed,
      signedFeedUrl
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => feedResponse(conflictingFeed))
    );
    const conflict = await preparePlan(
      conflictHarness,
      conflictingPreview
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: "rss_import_podcast_guid_mismatch"
    });
    expect(conflictHarness.planCount()).toBe(0);

    const invalidHarness = await createHarness();
    const invalidFeed = withPodcastGuid(
      validPodcastFeed(),
      "not-a-podcast-guid"
    );
    const invalidPreview = await parsePodcastRssImportPreview(
      invalidFeed,
      signedFeedUrl
    );
    vi.stubGlobal("fetch", vi.fn(async () => feedResponse(invalidFeed)));
    const invalid = await preparePlan(invalidHarness, invalidPreview);
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toMatchObject({
      error: "rss_import_podcast_guid_invalid"
    });
    expect(invalidHarness.planCount()).toBe(0);
  });

  it("requires one-time show identity assignment before freezing a source GUID", async () => {
    const harness = await createHarness();
    harness.database.prepare(
      `INSERT INTO shows (
         id, slug, title, canonical_url, rss_slug
       ) VALUES (
         'show_unassigned',
         'unassigned',
         'Unassigned',
         'https://dustwave.xyz/podcasts/unassigned/',
         'unassigned'
       )`
    ).run();
    const sourceGuid = "917393e3-1b1e-5cef-ace4-edaa54e1f810";
    const feed = withPodcastGuid(validPodcastFeed(), sourceGuid);
    const preview = await parsePodcastRssImportPreview(feed, signedFeedUrl);
    vi.stubGlobal("fetch", vi.fn(async () => feedResponse(feed)));

    const response = await handleRequest(
      adminRequest(
        "/v1/admin/shows/show_unassigned/rss-import/plans",
        {
          planId: "unassigned_import_plan",
          feedUrl: signedFeedUrl,
          ownershipConfirmed: true,
          expectedFeedSha256: preview.feedSha256,
          selectedSourceIdentitySha256: [
            preview.episodes[0].sourceIdentitySha256
          ]
        }
      ),
      harness.env
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "rss_import_show_podcast_guid_unassigned"
    });
    expect(harness.planCount()).toBe(0);
  });

  it("rejects a changed feed during review and preserves the draft", async () => {
    const harness = await createHarness();
    const feed = validPodcastFeed();
    const preview = await parsePodcastRssImportPreview(feed, signedFeedUrl);
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(feedResponse(feed))
      .mockResolvedValueOnce(feedResponse(
        feed.replace("Episodio uno", "Episodio cambiado")
      ));
    vi.stubGlobal("fetch", providerFetch);
    const prepared = await preparePlan(harness, preview);
    const preparedPayload = await prepared.json();

    const response = await handleRequest(
      adminRequest(
        "/v1/admin/rss-import/plans/opera_import_plan/review",
        {
          feedUrl: signedFeedUrl,
          ownershipConfirmed: true,
          expectedFeedSha256: preview.feedSha256,
          expectedSelectionSha256: preparedPayload.plan.selectionSha256,
          reviewConfirmed: true
        }
      ),
      harness.env
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "rss_import_feed_changed"
    });
    expect(harness.planStatus()).toBe("draft");
    expect(harness.episodeCount()).toBe(0);
    expect(harness.auditActions()).toEqual([
      "rss_import.plan_created"
    ]);
  });

  it("requires recent super-admin authentication before any source fetch", async () => {
    const harness = await createHarness({ recentAuthentication: false });
    const preview = await parsePodcastRssImportPreview(
      validPodcastFeed(),
      signedFeedUrl
    );
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    const response = await preparePlan(harness, preview);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "recent_authentication_required"
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(harness.planCount()).toBe(0);
  });
});

async function preparePlan(harness, preview) {
  return handleRequest(
    adminRequest(
      "/v1/admin/shows/show_opera_en_la_selva/rss-import/plans",
      {
        planId: "opera_import_plan",
        feedUrl: signedFeedUrl,
        ownershipConfirmed: true,
        expectedFeedSha256: preview.feedSha256,
        selectedSourceIdentitySha256: [
          preview.episodes[0].sourceIdentitySha256
        ]
      }
    ),
    harness.env
  );
}

async function createHarness({
  recentAuthentication = true
} = {}) {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  const sessionTokenHash = await sha256Hex(
    `${sessionSecret}:${sessionToken}`
  );
  const csrfTokenHash = await sha256Hex(
    `${sessionSecret}:${csrfToken}`
  );
  const analystSessionTokenHash = await sha256Hex(
    `${sessionSecret}:${analystSessionToken}`
  );
  database.prepare(`
    INSERT INTO admin_users (
      id, email_lookup_hash, status, activated_at, last_authenticated_at
    ) VALUES (
      'admin_fixture',
      ?,
      'active',
      datetime('now'),
      ${recentAuthentication
        ? "datetime('now')"
        : "datetime('now', '-2 hours')"}
    )
  `).run("e".repeat(64));
  database.prepare(`
    INSERT INTO admin_user_roles (
      id, admin_user_id, role, show_id
    ) VALUES (
      'role_fixture',
      'admin_fixture',
      'super_admin',
      NULL
    )
  `).run();
  database.prepare(`
    INSERT INTO admin_sessions (
      token_hash, admin_user_id, csrf_token_hash, expires_at
    ) VALUES (?, 'admin_fixture', ?, datetime('now', '+1 hour'))
  `).run(sessionTokenHash, csrfTokenHash);
  database.prepare(`
    INSERT INTO admin_users (
      id, email_lookup_hash, status, activated_at, last_authenticated_at
    ) VALUES (
      'analyst_fixture',
      ?,
      'active',
      datetime('now'),
      datetime('now')
    )
  `).run("f".repeat(64));
  database.prepare(`
    INSERT INTO admin_user_roles (
      id, admin_user_id, role, show_id
    ) VALUES (
      'analyst_role_fixture',
      'analyst_fixture',
      'analyst',
      'show_opera_en_la_selva'
    )
  `).run();
  database.prepare(`
    INSERT INTO admin_sessions (
      token_hash, admin_user_id, csrf_token_hash, expires_at
    ) VALUES (?, 'analyst_fixture', ?, datetime('now', '+1 hour'))
  `).run(analystSessionTokenHash, "0".repeat(64));

  const harness = {
    database,
    env: {
      ENVIRONMENT: "staging",
      SITE_ORIGIN: siteOrigin,
      ALLOWED_ORIGINS: `${siteOrigin},http://localhost:8080`,
      ADMIN_SESSION_SECRET: sessionSecret,
      DB: d1Database(database)
    },
    episodeCount() {
      return Number(database.prepare(
        "SELECT COUNT(*) AS count FROM episodes"
      ).get().count);
    },
    planCount() {
      return Number(database.prepare(
        "SELECT COUNT(*) AS count FROM rss_import_plans"
      ).get().count);
    },
    planStatus() {
      return database.prepare(
        "SELECT status FROM rss_import_plans WHERE id = 'opera_import_plan'"
      ).get()?.status;
    },
    auditActions() {
      return database.prepare(
        `SELECT action
         FROM admin_audit_events
         ORDER BY occurred_at, rowid`
      ).all().map(({ action }) => action);
    },
    persistedPlanText() {
      const plans = database.prepare(
        "SELECT * FROM rss_import_plans"
      ).all();
      const items = database.prepare(
        "SELECT * FROM rss_import_plan_items"
      ).all();
      const audits = database.prepare(
        `SELECT action, target_type, target_id, metadata_json
         FROM admin_audit_events`
      ).all();
      return JSON.stringify({ plans, items, audits });
    }
  };
  harnesses.push(harness);
  return harness;
}

function adminRequest(path, body) {
  return new Request(`${apiOrigin}${path}`, {
    method: "POST",
    headers: {
      cookie: `${ADMIN_SESSION_COOKIE}=${sessionToken}`,
      "content-type": "application/json",
      origin: siteOrigin,
      "x-podcast-csrf": csrfToken
    },
    body: JSON.stringify(body)
  });
}

function adminGet(path, token = sessionToken) {
  return new Request(`${apiOrigin}${path}`, {
    headers: {
      cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
      origin: siteOrigin
    }
  });
}

function feedResponse(feed) {
  return new Response(feed, {
    status: 200,
    headers: { "content-type": "application/rss+xml; charset=utf-8" }
  });
}

function validPodcastFeed() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Ópera en la Selva</title>
    <description>Historias desde la selva.</description>
    <language>es-MX</language>
    <item>
      <title>Episodio uno</title>
      <guid isPermaLink="false">opera-episode-one</guid>
      <description>Una introducción bilingüe.</description>
      <link>https://podcast.example.org/episodes/uno?ref=private</link>
      <pubDate>Sun, 26 Jul 2026 12:00:00 GMT</pubDate>
      <itunes:duration>12:34</itunes:duration>
      <itunes:explicit>no</itunes:explicit>
      <enclosure url="https://cdn.example.org/audio/uno.mp3?token=audio-secret" length="1234567" type="audio/mpeg"/>
    </item>
    <item>
      <title>Episode two</title>
      <guid isPermaLink="false">opera-episode-two</guid>
      <description>A second episode.</description>
      <link>https://podcast.example.org/episodes/two</link>
      <pubDate>Mon, 27 Jul 2026 12:00:00 GMT</pubDate>
      <itunes:duration>09:10</itunes:duration>
      <itunes:explicit>yes</itunes:explicit>
      <enclosure url="https://cdn.example.org/audio/two.mp3" length="7654321" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`;
}

function withPodcastGuid(feed, guid) {
  return feed
    .replace(
      "<rss version=\"2.0\"",
      "<rss version=\"2.0\" "
        + "xmlns:podcast=\"https://podcastindex.org/namespace/1.0\""
    )
    .replace(
      "<channel>",
      `<channel><podcast:guid>${guid}</podcast:guid>`
    );
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
      async all() {
        return {
          success: true,
          results: database.prepare(query).all(...values),
          meta: {}
        };
      },
      async run() {
        return statement.executeRun();
      },
      executeRun() {
        const result = database.prepare(query).run(...values);
        return {
          success: true,
          results: [],
          meta: { changes: Number(result.changes) }
        };
      }
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements) {
      database.exec("BEGIN");
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

function applyMigrations(database) {
  for (const filename of readdirSync(migrationsDirectory)
    .filter((candidate) => candidate.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
  }
}
