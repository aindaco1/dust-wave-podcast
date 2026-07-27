import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256Hex } from "@dustwave/worker-core/crypto";

import { ADMIN_SESSION_COOKIE } from "../src/admin-auth";
import {
  deleteAdminMarketingLink,
  listAdminMarketingLinks,
  normalizeMarketingLinkInput,
  saveAdminMarketingLink
} from "../src/marketing-links";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const sessionSecret = "marketing-link-session-secret";
const sessionToken = "marketing-link-session-token";
const csrfToken = "marketing-link-csrf-token";

describe("saved podcast marketing links", () => {
  let sqlite;
  let db;
  let env;

  beforeEach(async () => {
    sqlite = new DatabaseSync(":memory:");
    for (const filename of readdirSync(migrationsDirectory)
      .filter((candidate) => candidate.endsWith(".sql"))
      .sort()) {
      sqlite.exec(readFileSync(join(migrationsDirectory, filename), "utf8"));
    }
    sqlite.exec(`
      INSERT INTO shows (
        id, slug, title, canonical_url, rss_slug
      ) VALUES (
        'show_fixture',
        'show-fixture',
        'Show Fixture',
        'https://dustwave.xyz/podcasts/show-fixture/',
        'show-fixture'
      );
      INSERT INTO admin_users (
        id, email_lookup_hash, status
      ) VALUES (
        'admin_fixture',
        '${"a".repeat(64)}',
        'active'
      );
      INSERT INTO admin_user_roles (
        id, admin_user_id, role, show_id
      ) VALUES (
        'role_fixture',
        'admin_fixture',
        'producer',
        'show_fixture'
      );
    `);
    sqlite.prepare(`
      INSERT INTO admin_sessions (
        token_hash,
        admin_user_id,
        csrf_token_hash,
        expires_at
      ) VALUES (?, 'admin_fixture', ?, datetime('now', '+1 hour'))
    `).run(
      await sha256Hex(`${sessionSecret}:${sessionToken}`),
      await sha256Hex(`${sessionSecret}:${csrfToken}`)
    );
    db = sqliteD1(sqlite);
    env = {
      DB: db,
      SITE_ORIGIN: "https://dustwave.xyz",
      ALLOWED_ORIGINS: "https://dustwave.xyz",
      ADMIN_SESSION_SECRET: sessionSecret
    };
  });

  afterEach(() => {
    sqlite.close();
  });

  it("uses the exact shared Pool/Store URL policy", () => {
    expect(normalizeMarketingLinkInput(
      {
        label: "Launch newsletter",
        utmSource: "newsletter",
        utmMedium: "email",
        utmCampaign: "Ópera Launch",
        utmContent: "Hero",
        referralCode: "Jay Renteria"
      },
      "https://dustwave.xyz/podcasts/opera-en-la-selva/"
    )).toMatchObject({
      code: "jay-renteria",
      referralCode: "jay-renteria",
      taggedUrl:
        "https://dustwave.xyz/podcasts/opera-en-la-selva/?utm_source=newsletter&utm_medium=email&utm_campaign=%C3%93pera+Launch&utm_content=Hero&ref=jay-renteria"
    });
    expect(() => normalizeMarketingLinkInput(
      { label: "Unsafe" },
      "http://dustwave.xyz/podcasts/show/"
    )).toThrow(/canonical URL is invalid/);
  });

  it("creates, lists, updates, and deletes one audited show-scoped link", async () => {
    const createResponse = await saveAdminMarketingLink(
      request("/v1/admin/shows/show_fixture/marketing/links", {
        method: "POST",
        body: {
          label: "Launch newsletter",
          utmSource: "newsletter",
          utmMedium: "email",
          utmCampaign: "show-launch",
          utmContent: "hero",
          referralCode: "Jay Renteria"
        }
      }),
      env,
      "show_fixture"
    );
    const created = await createResponse.json();
    expect(createResponse.status).toBe(201);
    expect(created.link).toMatchObject({
      code: "jay-renteria",
      label: "Launch newsletter",
      revision: 1,
      taggedUrl:
        "https://dustwave.xyz/podcasts/show-fixture/?utm_source=newsletter&utm_medium=email&utm_campaign=show-launch&utm_content=hero&ref=jay-renteria"
    });
    expect(JSON.stringify(created)).not.toContain("admin_fixture");

    const listResponse = await listAdminMarketingLinks(
      request("/v1/admin/shows/show_fixture/marketing/links?limit=20"),
      env,
      "show_fixture"
    );
    const list = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(list.links).toHaveLength(1);
    expect(list.pagination).toEqual({ limit: 20, nextCursor: null });

    const updateResponse = await saveAdminMarketingLink(
      request("/v1/admin/shows/show_fixture/marketing/links", {
        method: "POST",
        body: {
          id: created.link.id,
          expectedUpdatedAt: created.link.updatedAt,
          code: created.link.code,
          label: "Newsletter — updated",
          utmSource: "newsletter",
          utmMedium: "email",
          utmCampaign: "show-launch",
          utmContent: "footer",
          referralCode: "Jay Renteria"
        }
      }),
      env,
      "show_fixture"
    );
    const updated = await updateResponse.json();
    expect(updateResponse.status).toBe(200);
    expect(updated.link).toMatchObject({
      label: "Newsletter — updated",
      revision: 2,
      utmContent: "footer"
    });

    const staleResponse = await saveAdminMarketingLink(
      request("/v1/admin/shows/show_fixture/marketing/links", {
        method: "POST",
        body: {
          id: created.link.id,
          expectedUpdatedAt: created.link.updatedAt,
          code: created.link.code,
          label: "Stale overwrite",
          utmSource: "newsletter"
        }
      }),
      env,
      "show_fixture"
    );
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      error: "marketing_link_changed"
    });

    const deleteResponse = await deleteAdminMarketingLink(
      request(
        `/v1/admin/shows/show_fixture/marketing/links/${created.link.id}`,
        { method: "DELETE" }
      ),
      env,
      "show_fixture",
      created.link.id
    );
    expect(deleteResponse.status).toBe(200);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM podcast_marketing_links
    `).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(`
      SELECT action
      FROM admin_audit_events
      ORDER BY occurred_at, rowid
    `).all().map(({ action }) => action)).toEqual([
      "marketing_link.created",
      "marketing_link.updated",
      "marketing_link.deleted"
    ]);
  });

  it("lets an analyst list but never mutate links", async () => {
    sqlite.exec(`
      UPDATE admin_user_roles
      SET role = 'analyst'
      WHERE id = 'role_fixture'
    `);
    const listResponse = await listAdminMarketingLinks(
      request("/v1/admin/shows/show_fixture/marketing/links"),
      env,
      "show_fixture"
    );
    const saveResponse = await saveAdminMarketingLink(
      request("/v1/admin/shows/show_fixture/marketing/links", {
        method: "POST",
        body: { label: "Forbidden" }
      }),
      env,
      "show_fixture"
    );
    expect(listResponse.status).toBe(200);
    expect(saveResponse.status).toBe(403);
  });
});

function request(path, { method = "GET", body } = {}) {
  return new Request(`https://feeds.dustwave.xyz${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      cookie: `${ADMIN_SESSION_COOKIE}=${sessionToken}`,
      origin: "https://dustwave.xyz",
      "x-podcast-csrf": csrfToken
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

function sqliteD1(sqlite) {
  return {
    prepare(query) {
      let values = [];
      const statement = {
        bind(...bound) {
          values = bound;
          return statement;
        },
        async first() {
          return sqlite.prepare(query).get(...values) ?? null;
        },
        async all() {
          return {
            success: true,
            results: sqlite.prepare(query).all(...values),
            meta: {}
          };
        },
        async run() {
          const result = sqlite.prepare(query).run(...values);
          return {
            success: true,
            results: [],
            meta: { changes: Number(result.changes) }
          };
        }
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

