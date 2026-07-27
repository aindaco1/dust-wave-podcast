import { sha256Hex } from "@dustwave/worker-core/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import { handleRequest } from "../src/app";
import type { PodcastEnv } from "../src/env";
import {
  parsePodcastRssImportPreview,
  previewAdminRssImport,
  validatedImportFeedUrl
} from "../src/rss-import-preview";

describe("RSS migration preview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns sanitized, digest-bound metadata for a migratable podcast", async () => {
    const preview = await parsePodcastRssImportPreview(
      validPodcastFeed(),
      "https://podcast.example.org/feed.xml"
    );

    expect(preview).toMatchObject({
      schemaVersion: "dustwave-rss-import-preview-v1",
      requestedUrl: "https://podcast.example.org/feed.xml",
      resolvedUrl: "https://podcast.example.org/feed.xml",
      title: "Bosque & sonido",
      description: "Historias desde la selva.",
      language: "es-mx",
      ownerEmailPresent: true,
      itemCount: 1,
      audioItemCount: 1,
      migratableItemCount: 1,
      previewItemCount: 1,
      previewTruncated: false
    });
    expect(preview.feedSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(preview.episodes[0]).toMatchObject({
      title: "Episodio <uno>",
      summary: "Una introducción bilingüe.",
      publishedAt: "2026-07-26T12:00:00.000Z",
      durationSeconds: 754,
      explicit: false,
      canonicalUrl: "https://podcast.example.org/episodes/uno",
      enclosure: {
        url: "https://cdn.example.org/audio/uno.mp3",
        mimeType: "audio/mpeg",
        bytes: 1234567
      },
      migrationReady: true,
      blockers: [],
      warnings: []
    });
    expect(preview.episodes[0].sourceIdentitySha256).toMatch(
      /^[a-f0-9]{64}$/u
    );
    expect(JSON.stringify(preview)).not.toContain("owner@example.org");
    expect(JSON.stringify(preview)).not.toContain("<p>");
  });

  it("reports newsletter image items without treating them as episodes", async () => {
    const preview = await parsePodcastRssImportPreview(
      validPodcastFeed().replace(
        'url="https://cdn.example.org/audio/uno.mp3" '
          + 'length="1234567" type="audio/mpeg"',
        'url="https://cdn.example.org/images/uno.jpg" '
          + 'length="0" type="image/jpeg"'
      ),
      "https://newsletter.example.org/feed"
    );

    expect(preview).toMatchObject({
      itemCount: 1,
      audioItemCount: 0,
      migratableItemCount: 0
    });
    expect(preview.episodes[0]).toMatchObject({
      migrationReady: false,
      blockers: expect.arrayContaining([
        "unsupported_enclosure_type",
        "missing_or_invalid_enclosure_bytes"
      ])
    });
  });

  it("rejects unsafe targets and XML entity declarations", async () => {
    for (const value of [
      "http://podcast.example.org/feed",
      "https://127.0.0.1/feed",
      "https://localhost/feed",
      "https://podcast.internal/feed",
      "https://user:password@podcast.example.org/feed",
      "https://podcast.example.org/feed#private"
    ]) {
      expect(() => validatedImportFeedUrl(value)).toThrowError(
        expect.objectContaining({ code: "rss_import_feed_url_invalid" })
      );
    }
    await expect(
      parsePodcastRssImportPreview(
        '<?xml version="1.0"?><!DOCTYPE rss ['
          + '<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
          + '<rss><channel><title>&xxe;</title></channel></rss>',
        "https://podcast.example.org/feed"
      )
    ).rejects.toThrowError(expect.objectContaining({
      code: "rss_import_document_invalid"
    }));
  });

  it("requires recent super-admin ownership confirmation before fetching", async () => {
    const fixture = await routeFixture({ recent: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleRequest(
      fixture.request({ ownershipConfirmed: true }),
      fixture.env
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "recent_authentication_required"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows only validated manual redirects and performs no storage mutation", async () => {
    const fixture = await routeFixture();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 307,
        headers: {
          location: "https://feeds.example.org/opera.xml"
        }
      }))
      .mockResolvedValueOnce(new Response(validPodcastFeed(), {
        status: 200,
        headers: {
          "content-type": "application/rss+xml; charset=utf-8"
        }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await previewAdminRssImport(
      fixture.request({ ownershipConfirmed: true }),
      fixture.env,
      "show_opera"
    );
    const payload = await response.json() as {
      importMutationPerformed: boolean;
      preview: {
        redirectCount: number;
        resolvedUrl: string;
        migratableItemCount: number;
      };
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      importMutationPerformed: false,
      preview: {
        redirectCount: 1,
        resolvedUrl: "https://feeds.example.org/opera.xml",
        migratableItemCount: 1
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "GET",
      redirect: "manual"
    });
    expect(fixture.mutationQueries()).toEqual([
      expect.stringContaining("UPDATE admin_sessions")
    ]);
  });

  it("rejects preview requests without an explicit rights confirmation", async () => {
    const fixture = await routeFixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      previewAdminRssImport(
        fixture.request({ ownershipConfirmed: false }),
        fixture.env,
        "show_opera"
      )
    ).rejects.toThrowError(expect.objectContaining({
      code: "rss_import_ownership_confirmation_required"
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

async function routeFixture({
  recent = true
}: {
  recent?: boolean;
} = {}) {
  const sessionSecret = "session_fixture";
  const csrfToken = "csrf_fixture";
  const csrfTokenHash = await sha256Hex(`${sessionSecret}:${csrfToken}`);
  const mutationQueries: string[] = [];
  const db = {
    prepare(query: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (query.includes("SELECT s.admin_user_id")) {
            return {
              admin_user_id: "admin_actor",
              csrf_token_hash: csrfTokenHash
            };
          }
          if (query.includes("SELECT 1 AS recent")) {
            return recent ? { recent: 1 } : null;
          }
          if (
            query.includes("SELECT id, title")
            && query.includes("FROM shows")
          ) {
            return {
              id: "show_opera",
              title: "Ópera en la Selva"
            };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM admin_user_roles")) {
            return {
              results: [{ role: "super_admin", show_id: null }]
            };
          }
          return { results: [] };
        },
        async run() {
          mutationQueries.push(query);
          return { success: true };
        }
      };
    },
    async batch() {
      mutationQueries.push("batch");
      return [];
    }
  } as unknown as D1Database;
  return {
    env: {
      DB: db,
      SITE_ORIGIN: "https://dustwave.xyz",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      ADMIN_SESSION_SECRET: sessionSecret
    } as unknown as PodcastEnv,
    request(body: Record<string, unknown>) {
      return new Request(
        "https://dustwave.xyz/v1/admin/shows/show_opera/rss-import/preview",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `${ADMIN_SESSION_COOKIE}=session_fixture`,
            origin: "https://dustwave.xyz",
            "x-podcast-csrf": csrfToken
          },
          body: JSON.stringify({
            feedUrl: "https://podcast.example.org/feed.xml",
            ...body
          })
        }
      );
    },
    mutationQueries: () => mutationQueries
  };
}

function validPodcastFeed(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title><![CDATA[Bosque &amp; sonido]]></title>
    <description><![CDATA[<p>Historias desde la selva.</p>]]></description>
    <language>es-MX</language>
    <itunes:image href="https://cdn.example.org/artwork/opera.jpg"/>
    <itunes:owner>
      <itunes:name>Dust Wave</itunes:name>
      <itunes:email>owner@example.org</itunes:email>
    </itunes:owner>
    <item>
      <title>Episodio &lt;uno&gt;</title>
      <guid isPermaLink="false">opera-episode-one</guid>
      <description><![CDATA[<p>Una introducción bilingüe.</p>]]></description>
      <link>https://podcast.example.org/episodes/uno</link>
      <pubDate>Sun, 26 Jul 2026 12:00:00 GMT</pubDate>
      <itunes:duration>12:34</itunes:duration>
      <itunes:explicit>no</itunes:explicit>
      <enclosure url="https://cdn.example.org/audio/uno.mp3" length="1234567" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`;
}
