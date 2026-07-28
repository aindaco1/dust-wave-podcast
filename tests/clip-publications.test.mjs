import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "@dustwave/worker-core/crypto";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const siteOrigin = "https://dust-wave-website-staging.pages.dev";
const feedOrigin = "https://dust-wave-podcast-staging.jogo.workers.dev";
const sessionSecret = "clip_publication_session_secret";
const sessionToken = "clip_publication_session";
const csrfToken = "clip_publication_csrf";
const outputSha256 = "a".repeat(64);
const recipeSha256 = "b".repeat(64);
const manifestSha256 = "c".repeat(64);
const objectKey = "podcasts/show/episode/clips/render_fixture.mp4";
const objectEtag = '"clip-etag"';

let harnesses = [];

afterEach(() => {
  for (const harness of harnesses) harness.database.close();
  harnesses = [];
});

describe("public clip publication", () => {
  it("prepares exact evidence, requires recent super-admin approval, and exposes safe public metadata", async () => {
    const harness = await createHarness();
    const draft = await handleRequest(
      adminRequest(
        "/v1/admin/clip-renders/render_fixture/publication",
        {
          publicationId: "clip_publication_fixture",
          expectedClipRevision: 1,
          publicSlug: "launch-moment",
          title: "A launch moment",
          description: "Captioned excerpt"
        }
      ),
      harness.env
    );

    expect(draft.status).toBe(200);
    expect(await draft.json()).toMatchObject({
      publication: {
        id: "clip_publication_fixture",
        renderId: "render_fixture",
        publicSlug: "launch-moment",
        status: "draft",
        evidenceCurrent: true,
        publicPath:
          "/v1/shows/show-fixture/episodes/episode-fixture"
          + "/clips/launch-moment.mp4"
      },
      idempotent: false
    });
    expect(harness.r2Heads).toBe(1);
    expect(harness.auditActions()).toEqual([
      "clip.publication_draft_created"
    ]);

    const approval = await handleRequest(
      adminRequest(
        "/v1/admin/clip-publications/clip_publication_fixture/approve",
        {}
      ),
      harness.env
    );

    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({
      publication: {
        status: "approved",
        evidenceCurrent: true
      },
      idempotent: false
    });
    expect(harness.r2Heads).toBe(2);
    expect(harness.auditActions()).toEqual([
      "clip.publication_draft_created",
      "clip.publication_approved"
    ]);

    const stillScheduled = await handleRequest(
      publicRequest(
        "/v1/shows/show-fixture/episodes/episode-fixture/clips"
      ),
      harness.env
    );
    expect(stillScheduled.status).toBe(404);
    expect(stillScheduled.headers.get("cache-control")).toBe("no-store");

    harness.database.prepare(
      "UPDATE episodes SET status = 'published' WHERE id = 'episode_fixture'"
    ).run();
    const listed = await handleRequest(
      publicRequest(
        "/v1/shows/show-fixture/episodes/episode-fixture/clips"
      ),
      harness.env
    );
    expect(listed.status).toBe(200);
    expect(listed.headers.get("access-control-allow-origin")).toBe("*");
    expect(listed.headers.get("cache-control"))
      .toBe("public, max-age=60, must-revalidate");
    expect(listed.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/);
    const payload = await listed.json();
    expect(payload).toEqual({
      schemaVersion: 1,
      episode: {
        showSlug: "show-fixture",
        slug: "episode-fixture",
        canonicalUrl:
          "https://dustwave.xyz/news/episode-fixture/"
      },
      clips: [{
        slug: "launch-moment",
        title: "A launch moment",
        description: "Captioned excerpt",
        aspectRatio: "9:16",
        width: 1080,
        height: 1920,
        durationMs: 2_000,
        captionLanguage: "es",
        mediaUrl:
          `${feedOrigin}/v1/shows/show-fixture/episodes/episode-fixture`
          + "/clips/launch-moment.mp4",
        downloadUrl:
          `${feedOrigin}/v1/shows/show-fixture/episodes/episode-fixture`
          + "/clips/launch-moment.mp4?download=1",
        canonicalUrl:
          "https://dustwave.xyz/news/episode-fixture/"
      }],
      truncated: false
    });
    expect(JSON.stringify(payload)).not.toContain(objectKey);
    expect(JSON.stringify(payload)).not.toContain(outputSha256);
  });

  it("serves one verified public range and conceals a withdrawn selection", async () => {
    const harness = await createHarness({ episodeStatus: "published" });
    await prepareAndApprove(harness.env);
    const mediaPath =
      "/v1/shows/show-fixture/episodes/episode-fixture"
      + "/clips/launch-moment.mp4";
    const media = await handleRequest(
      publicRequest(mediaPath, {
        headers: { range: "bytes=2-5" }
      }),
      harness.env
    );

    expect(media.status).toBe(206);
    expect(media.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(media.headers.get("content-length")).toBe("4");
    expect(media.headers.get("content-type")).toBe("video/mp4");
    expect(media.headers.get("cache-control"))
      .toBe("public, max-age=60, must-revalidate");
    expect(media.headers.get("cross-origin-resource-policy"))
      .toBe("cross-origin");
    expect(media.headers.get("access-control-allow-origin")).toBe("*");
    expect(media.headers.get("link")).toBe(
      "<https://dustwave.xyz/news/episode-fixture/>; rel=\"canonical\""
    );
    expect(media.headers.get("x-robots-tag")).toContain("noindex");
    expect(await media.text()).toBe("2345");
    expect(harness.r2Gets).toBe(1);

    const withdrawn = await handleRequest(
      adminRequest(
        "/v1/admin/clip-publications/clip_publication_fixture/withdraw",
        {}
      ),
      harness.env
    );
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toMatchObject({
      publication: { status: "withdrawn" }
    });
    const afterWithdrawal = await handleRequest(
      publicRequest(mediaPath),
      harness.env
    );
    expect(afterWithdrawal.status).toBe(404);
    expect(afterWithdrawal.headers.get("cache-control")).toBe("no-store");
    expect(harness.r2Gets).toBe(1);
    expect(harness.auditActions()).toContain(
      "clip.publication_withdrawn"
    );
  });

  it("rejects stale clip evidence before a second R2 read", async () => {
    const harness = await createHarness();
    await prepareDraft(harness.env);
    harness.database.prepare(
      `UPDATE clips
       SET revision = 2, recipe_sha256 = ?
       WHERE id = 'clip_fixture'`
    ).run("d".repeat(64));
    const response = await handleRequest(
      adminRequest(
        "/v1/admin/clip-publications/clip_publication_fixture/approve",
        {}
      ),
      harness.env
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "clip_publication_not_ready"
    });
    expect(harness.r2Heads).toBe(1);
    expect(harness.auditActions()).toEqual([
      "clip.publication_draft_created"
    ]);
  });

  it("conceals a byte-identical object replacement with a different ETag", async () => {
    const harness = await createHarness({ episodeStatus: "published" });
    await prepareAndApprove(harness.env);
    harness.replaceObjectEtag('"replacement-etag"');
    const response = await handleRequest(
      publicRequest(
        "/v1/shows/show-fixture/episodes/episode-fixture"
        + "/clips/launch-moment.mp4"
      ),
      harness.env
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(harness.r2Gets).toBe(0);
  });

  it("keeps production and malformed slugs closed before D1 or R2", async () => {
    let queries = 0;
    const closedEnv = {
      ENVIRONMENT: "production",
      CLIP_PUBLICATION_MODE: "disabled",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      DB: {
        prepare() {
          queries += 1;
          throw new Error("D1 must stay closed");
        }
      },
      MEDIA_BUCKET: {
        async head() {
          throw new Error("R2 must stay closed");
        }
      }
    };
    const closed = await handleRequest(
      publicRequest(
        "/v1/shows/show-fixture/episodes/episode-fixture/clips"
      ),
      closedEnv
    );
    expect(closed.status).toBe(404);
    expect(queries).toBe(0);

    const harness = await createHarness();
    const malformed = await handleRequest(
      adminRequest(
        "/v1/admin/clip-renders/render_fixture/publication",
        {
          publicationId: "clip_publication_fixture",
          expectedClipRevision: 1,
          publicSlug: "../launch",
          title: "A launch moment"
        }
      ),
      harness.env
    );
    expect(malformed.status).toBe(400);
    expect(harness.r2Heads).toBe(0);
  });
});

async function createHarness({
  episodeStatus = "scheduled"
} = {}) {
  const database = new DatabaseSync(":memory:");
  harnesses.push({ database });
  applyMigrations(database);
  const sessionTokenHash = await sha256Hex(
    `${sessionSecret}:${sessionToken}`
  );
  const csrfTokenHash = await sha256Hex(
    `${sessionSecret}:${csrfToken}`
  );
  database.prepare(`
    INSERT INTO shows (
      id, slug, title, status, canonical_url, rss_slug
    ) VALUES (
      'show_fixture',
      'show-fixture',
      'Show fixture',
      'active',
      'https://dustwave.xyz/podcasts/show-fixture/',
      'show-fixture'
    )
  `).run();
  database.prepare(`
    INSERT INTO admin_users (
      id, email_lookup_hash, status, activated_at, last_authenticated_at
    ) VALUES (
      'admin_fixture',
      ?,
      'active',
      datetime('now'),
      datetime('now')
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
    INSERT INTO episodes (
      id, show_id, slug, title, status, access, public_at, canonical_url,
      audio_key, audio_bytes, audio_mime_type, audio_etag, media_status,
      duration_seconds
    ) VALUES (
      'episode_fixture',
      'show_fixture',
      'episode-fixture',
      'Episode fixture',
      ?,
      'public',
      datetime('now', '-1 minute'),
      'https://dustwave.xyz/news/episode-fixture/',
      'podcasts/show/episode.mp3',
      100,
      'audio/mpeg',
      '"audio-etag"',
      'ready',
      60
    )
  `).run(episodeStatus);
  database.prepare(`
    INSERT INTO clips (
      id, episode_id, title, starts_at_ms, ends_at_ms, aspect_ratio,
      status, revision, caption_language, recipe_json, recipe_sha256
    ) VALUES (
      'clip_fixture',
      'episode_fixture',
      'Clip fixture',
      1000,
      3000,
      '9:16',
      'ready',
      1,
      'es',
      '{}',
      ?
    )
  `).run(recipeSha256);
  database.prepare(`
    INSERT INTO clip_renders (
      id, clip_id, clip_revision, recipe_sha256,
      processor_manifest_sha256, output_object_key, status,
      output_object_bytes, output_sha256, output_mime_type,
      output_width, output_height, output_duration_ms, processor_version,
      completed_at
    ) VALUES (
      'render_fixture',
      'clip_fixture',
      1,
      ?,
      ?,
      ?,
      'ready',
      10,
      ?,
      'video/mp4',
      1080,
      1920,
      2000,
      'captioned-waveform-v1',
      datetime('now')
    )
  `).run(
    recipeSha256,
    manifestSha256,
    objectKey,
    outputSha256
  );

  let r2Heads = 0;
  let r2Gets = 0;
  const object = clipObject();
  const bucket = {
    async head(key) {
      r2Heads += 1;
      expect(key).toBe(objectKey);
      return object;
    },
    async get(key, options) {
      r2Gets += 1;
      expect(key).toBe(objectKey);
      expect(new Headers(options.onlyIf).get("if-match")).toBe(objectEtag);
      const range = options.range;
      const body = range
        ? "0123456789".slice(
            range.offset,
            range.offset + range.length
          )
        : "0123456789";
      return {
        ...object,
        body: new Response(body).body,
        ...(range ? { range } : {})
      };
    }
  };
  const harness = {
    database,
    get r2Heads() {
      return r2Heads;
    },
    get r2Gets() {
      return r2Gets;
    },
    replaceObjectEtag(etag) {
      object.httpEtag = etag;
    },
    auditActions() {
      return database.prepare(
        `SELECT action
         FROM admin_audit_events
         ORDER BY occurred_at, rowid`
      ).all().map(({ action }) => action);
    },
    env: {
      ENVIRONMENT: "staging",
      SITE_ORIGIN: siteOrigin,
      FEED_ORIGIN: feedOrigin,
      MEDIA_ORIGIN: feedOrigin,
      ALLOWED_ORIGINS: `${siteOrigin},http://localhost:8080`,
      MEDIA_KEY_PREFIX: "podcasts/",
      MEDIA_BUCKET_NAME: "dustwave-media-staging",
      CLIP_PUBLICATION_MODE: "staging_preview",
      ADMIN_SESSION_SECRET: sessionSecret,
      DB: d1Database(database),
      MEDIA_BUCKET: bucket
    }
  };
  harnesses[harnesses.length - 1] = harness;
  return harness;
}

async function prepareDraft(env) {
  return handleRequest(
    adminRequest(
      "/v1/admin/clip-renders/render_fixture/publication",
      {
        publicationId: "clip_publication_fixture",
        expectedClipRevision: 1,
        publicSlug: "launch-moment",
        title: "A launch moment",
        description: "Captioned excerpt"
      }
    ),
    env
  );
}

async function prepareAndApprove(env) {
  const draft = await prepareDraft(env);
  expect(draft.status).toBe(200);
  const approved = await handleRequest(
    adminRequest(
      "/v1/admin/clip-publications/clip_publication_fixture/approve",
      {}
    ),
    env
  );
  expect(approved.status).toBe(200);
}

function adminRequest(path, body) {
  return new Request(`${feedOrigin}${path}`, {
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

function publicRequest(path, { method = "GET", headers = {} } = {}) {
  return new Request(`${feedOrigin}${path}`, { method, headers });
}

function clipObject() {
  return {
    key: objectKey,
    version: "fixture",
    size: 10,
    etag: "clip-etag",
    httpEtag: objectEtag,
    uploaded: new Date("2026-07-28T00:00:00Z"),
    httpMetadata: { contentType: "video/mp4" },
    customMetadata: {
      sha256: outputSha256,
      "render-manifest-sha256": manifestSha256
    },
    range: undefined,
    checksums: {
      toJSON() {
        return { sha256: outputSha256 };
      }
    },
    writeHttpMetadata() {}
  };
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
