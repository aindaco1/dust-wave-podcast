import { sha256Hex } from "@dustwave/worker-core/crypto";
import { afterEach, describe, expect, it } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import type { PodcastEnv } from "../src/env";
import { migratedSqlite, sqliteD1 } from "./sqlite-d1-fixture.mjs";

const siteOrigin = "https://dustwave.xyz";
const sessionSecret = "show_creation_session_secret";
const sessionToken = "show_creation_session_token";
const csrfToken = "show_creation_csrf_token";
const requestId = "show_create_1234567890abcdef";
const deletionRequestId = "show_delete_1234567890abcdef";

describe("admin show creation", () => {
  let fixture: Awaited<ReturnType<typeof showCreationFixture>> | undefined;

  afterEach(() => {
    fixture?.sqlite.close();
    fixture = undefined;
  });

  it("creates a private show with permanent identity and initialized policies", async () => {
    fixture = await showCreationFixture();
    const response = await handleRequest(showRequest(showBody()), fixture.env);
    const payload = await response.json() as {
      created: boolean;
      idempotent: boolean;
      show: Record<string, unknown>;
      provisioning: Record<string, unknown>;
    };

    expect(response.status).toBe(201);
    expect(payload).toMatchObject({
      created: true,
      idempotent: false,
      show: {
        slug: "field-notes",
        title: "Field Notes",
        language: "en",
        status: "coming_soon",
        canonicalUrl: "https://dustwave.xyz/podcasts/field-notes/",
        feedUrl: "https://feeds.dustwave.xyz/field-notes/rss.xml",
        podcastGuid: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        ),
        premiumEnabled: false,
        freeMiniEpisodeEnabled: false,
        testFixture: false,
        episodeCount: 0
      },
      provisioning: {
        publicSiteReady: false,
        blockers: [
          "site_catalog_entry_required",
          "site_artwork_assets_required"
        ]
      }
    });

    const showId = String(payload.show.id);
    expect(fixture.sqlite.prepare(
      `SELECT
         status, premium_enabled, free_mini_episode_enabled, test_fixture,
         creation_request_id, length(creation_request_sha256) AS digest_length
       FROM shows
       WHERE id = ?`
    ).get(showId)).toEqual({
      status: "coming_soon",
      premium_enabled: 0,
      free_mini_episode_enabled: 0,
      test_fixture: 0,
      creation_request_id: requestId,
      digest_length: 64
    });
    const destinationCount = fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM distribution_destinations"
    ).get() as { count: number };
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM show_distribution_destinations
       WHERE show_id = ?`
    ).get(showId)).toEqual(destinationCount);
    expect(singleShowCount(fixture.sqlite, "show_audio_qc_policies", showId))
      .toBe(1);
    expect(singleShowCount(
      fixture.sqlite,
      "show_transcription_settings",
      showId
    )).toBe(1);
    expect(singleShowCount(
      fixture.sqlite,
      "publication_show_evidence_versions",
      showId
    )).toBe(1);
    expect(fixture.sqlite.prepare(
      `SELECT action, target_id
       FROM admin_audit_events
       WHERE action = 'show.created'`
    ).get()).toEqual({ action: "show.created", target_id: showId });
    expect(fixture.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("replays an identical request without duplicating the show or audit", async () => {
    fixture = await showCreationFixture();
    const first = await handleRequest(showRequest(showBody()), fixture.env);
    expect(first.status).toBe(201);

    const replay = await handleRequest(showRequest(showBody()), fixture.env);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      created: true,
      idempotent: true,
      show: { slug: "field-notes" }
    });
    expect(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM shows WHERE slug = 'field-notes'"
    ).get()).toEqual({ count: 1 });
    expect(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM admin_audit_events WHERE action = 'show.created'"
    ).get()).toEqual({ count: 1 });
  });

  it("fails closed for changed retries, reused slugs, and stale authentication", async () => {
    fixture = await showCreationFixture();
    expect((await handleRequest(showRequest(showBody()), fixture.env)).status)
      .toBe(201);

    const changed = await handleRequest(showRequest(showBody({
      title: "Changed Field Notes"
    })), fixture.env);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({
      error: "show_creation_request_conflict"
    });

    const reusedSlug = await handleRequest(showRequest(showBody({
      requestId: "show_create_fedcba0987654321"
    })), fixture.env);
    expect(reusedSlug.status).toBe(409);
    expect(await reusedSlug.json()).toEqual({ error: "show_slug_conflict" });

    fixture.sqlite.prepare(
      "UPDATE admin_users SET last_authenticated_at = datetime('now', '-16 minutes')"
    ).run();
    const stale = await handleRequest(showRequest(showBody({
      requestId: "show_create_stale123456789"
    })), fixture.env);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({
      error: "recent_authentication_required"
    });
  });

  it("allows only Super-admins to establish a show identity", async () => {
    fixture = await showCreationFixture({ role: "admin" });
    const response = await handleRequest(showRequest(showBody()), fixture.env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM shows WHERE slug = 'field-notes'"
    ).get()).toEqual({ count: 0 });
  });

  it("requires the exact permanent-identity confirmation before writing", async () => {
    fixture = await showCreationFixture();
    const response = await handleRequest(showRequest(showBody({
      confirmation: "CREATE SHOW field-notes"
    })), fixture.env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      message: "confirmation must exactly match CREATE_SHOW field-notes"
    });
    expect(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM shows WHERE slug = 'field-notes'"
    ).get()).toEqual({ count: 0 });
  });

  it("deletes only an unused show shell, retires its identity, and replays safely", async () => {
    fixture = await showCreationFixture();
    const created = await handleRequest(showRequest(showBody()), fixture.env);
    const createdPayload = await created.json() as {
      show: { id: string; slug: string };
    };
    const showId = createdPayload.show.id;

    const deleted = await handleRequest(
      deleteShowRequest(showId, deletionRequestId),
      fixture.env
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      deleted: true,
      idempotent: false,
      show: { id: showId, slug: "field-notes" },
      identityRetired: true
    });
    expect(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM shows WHERE id = ?"
    ).get(showId)).toEqual({ count: 0 });
    for (const table of [
      "show_audio_qc_policies",
      "show_distribution_destinations",
      "show_transcription_settings",
      "publication_show_evidence_versions"
    ]) {
      expect(singleShowCount(fixture.sqlite, table, showId)).toBe(0);
    }
    expect(fixture.sqlite.prepare(
      `SELECT show_id, slug, creation_request_id, deletion_request_id
       FROM deleted_show_identities
       WHERE show_id = ?`
    ).get(showId)).toEqual({
      show_id: showId,
      slug: "field-notes",
      creation_request_id: requestId,
      deletion_request_id: deletionRequestId
    });
    expect(fixture.sqlite.prepare(
      `SELECT action, target_id
       FROM admin_audit_events
       WHERE target_id = ?
       ORDER BY occurred_at, action`
    ).all(showId)).toEqual([
      { action: "show.created", target_id: showId },
      { action: "show.deleted", target_id: showId }
    ]);

    const replay = await handleRequest(
      deleteShowRequest(showId, deletionRequestId),
      fixture.env
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      deleted: true,
      idempotent: true,
      identityRetired: true
    });
    expect(fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count
       FROM admin_audit_events
       WHERE action = 'show.deleted' AND target_id = ?`
    ).get(showId)).toEqual({ count: 1 });

    const recreateOriginalRequest = await handleRequest(
      showRequest(showBody()),
      fixture.env
    );
    expect(recreateOriginalRequest.status).toBe(409);
    expect(await recreateOriginalRequest.json()).toEqual({
      error: "show_identity_retired"
    });

    const recreate = await handleRequest(showRequest(showBody({
      requestId: "show_create_replacement123456",
      confirmation: "CREATE_SHOW field-notes"
    })), fixture.env);
    expect(recreate.status).toBe(409);
    expect(await recreate.json()).toEqual({ error: "show_identity_retired" });
    expect(fixture.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("blocks deletion once a show has content or operational history", async () => {
    fixture = await showCreationFixture();
    const created = await handleRequest(showRequest(showBody()), fixture.env);
    const { show } = await created.json() as { show: { id: string } };
    fixture.sqlite.prepare(
      `INSERT INTO episodes (id, show_id, slug, title, canonical_url)
       VALUES ('episode_field_notes', ?, 'pilot', 'Pilot',
               'https://dustwave.xyz/podcasts/field-notes/pilot/')`
    ).run(show.id);
    fixture.sqlite.prepare(
      `INSERT INTO queue_dead_letter_incidents (
         id, payload_sha256, source_queue, dead_letter_queue,
         classification, show_id, failure_code, last_dlq_delivery_attempt
       ) VALUES (
         'dlq_field_notes', ?, 'podcast', 'podcast-dlq',
         'malformed', ?, 'malformed_queue_job', 3
       )`
    ).run("b".repeat(64), show.id);
    fixture.sqlite.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id
       ) VALUES (
         'audit_site_projection_fixture', 'admin_show_creator',
         'show.site_projection_published', 'show', ?
       )`
    ).run(show.id);

    const response = await handleRequest(
      deleteShowRequest(show.id, deletionRequestId),
      fixture.env
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "show_delete_blocked",
      blockers: [
        "episodes",
        "analytics_or_operations",
        "website_publication"
      ]
    });
    expect(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM shows WHERE id = ?"
    ).get(show.id)).toEqual({ count: 1 });
    expect(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM deleted_show_identities WHERE show_id = ?"
    ).get(show.id)).toEqual({ count: 0 });
  });

  it("requires a Super-admin, recent authentication, and exact delete confirmation", async () => {
    fixture = await showCreationFixture();
    const created = await handleRequest(showRequest(showBody()), fixture.env);
    const { show } = await created.json() as { show: { id: string } };

    const incorrect = await handleRequest(deleteShowRequest(
      show.id,
      deletionRequestId,
      "DELETE SHOW field-notes"
    ), fixture.env);
    expect(incorrect.status).toBe(400);
    expect(await incorrect.json()).toMatchObject({
      error: "invalid_request",
      message: "confirmation must exactly match DELETE_SHOW field-notes"
    });

    fixture.sqlite.prepare(
      "UPDATE admin_user_roles SET role = 'admin' WHERE id = 'role_show_creator'"
    ).run();
    const forbidden = await handleRequest(deleteShowRequest(
      show.id,
      "show_delete_forbidden123456"
    ), fixture.env);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });

    fixture.sqlite.prepare(
      "UPDATE admin_user_roles SET role = 'super_admin' WHERE id = 'role_show_creator'"
    ).run();
    fixture.sqlite.prepare(
      "UPDATE admin_users SET last_authenticated_at = datetime('now', '-16 minutes')"
    ).run();
    const stale = await handleRequest(deleteShowRequest(
      show.id,
      "show_delete_stale123456789"
    ), fixture.env);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({
      error: "recent_authentication_required"
    });
    expect(fixture.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM shows WHERE id = ?"
    ).get(show.id)).toEqual({ count: 1 });
  });
});

async function showCreationFixture({
  role = "super_admin"
}: { role?: "super_admin" | "admin" } = {}) {
  const sqlite = migratedSqlite();
  const db = sqliteD1(sqlite);
  sqlite.prepare(
    `INSERT INTO admin_users (
       id, email_lookup_hash, status, activated_at, last_authenticated_at
     ) VALUES (
       'admin_show_creator', ?, 'active', datetime('now'), datetime('now')
     )`
  ).run("a".repeat(64));
  sqlite.prepare(
    `INSERT INTO admin_user_roles (
       id, admin_user_id, role, show_id
     ) VALUES ('role_show_creator', 'admin_show_creator', ?, NULL)`
  ).run(role);
  sqlite.prepare(
    `INSERT INTO admin_sessions (
       token_hash, admin_user_id, csrf_token_hash, expires_at
     ) VALUES (?, 'admin_show_creator', ?, datetime('now', '+1 hour'))`
  ).run(
    await sha256Hex(`${sessionSecret}:${sessionToken}`),
    await sha256Hex(`${sessionSecret}:${csrfToken}`)
  );
  return {
    sqlite,
    env: {
      DB: db,
      SITE_ORIGIN: siteOrigin,
      ALLOWED_ORIGINS: siteOrigin,
      ADMIN_SESSION_SECRET: sessionSecret
    } as unknown as PodcastEnv
  };
}

function showRequest(body: Record<string, unknown>): Request {
  return new Request("https://feeds.dustwave.xyz/v1/admin/shows", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${ADMIN_SESSION_COOKIE}=${sessionToken}`,
      origin: siteOrigin,
      "x-podcast-csrf": csrfToken
    },
    body: JSON.stringify(body)
  });
}

function deleteShowRequest(
  showId: string,
  deletionId: string,
  confirmation = "DELETE_SHOW field-notes"
): Request {
  return new Request(
    `https://feeds.dustwave.xyz/v1/admin/shows/${showId}`,
    {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        cookie: `${ADMIN_SESSION_COOKIE}=${sessionToken}`,
        origin: siteOrigin,
        "x-podcast-csrf": csrfToken
      },
      body: JSON.stringify({ requestId: deletionId, confirmation })
    }
  );
}

function showBody(overrides: Record<string, unknown> = {}) {
  return {
    requestId,
    title: "Field Notes",
    slug: "field-notes",
    language: "en",
    authorName: "Dust Wave",
    category: "Arts",
    description: "Notas de campo.",
    descriptionEn: "Field notes.",
    artworkUrl: "",
    earlyAccessDays: null,
    youtubeChannelUrl: "",
    explicit: false,
    confirmation: "CREATE_SHOW field-notes",
    ...overrides
  };
}

function singleShowCount(
  sqlite: ReturnType<typeof migratedSqlite>,
  table: string,
  showId: string
): number {
  return Number((sqlite.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE show_id = ?`
  ).get(showId) as { count: number }).count);
}
