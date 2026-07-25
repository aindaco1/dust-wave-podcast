import { describe, expect, it } from "vitest";

import {
  buildPodcastAnnouncementDryRun,
  normalizePodcastAnnouncement
} from "../src/marketing";

describe("podcast marketing announcement review", () => {
  it("normalizes a bilingual same-site announcement without raw recipients", () => {
    expect(
      normalizePodcastAnnouncement(
        {
          language: "es",
          subject: "Nuevo episodio",
          heading: "Ópera en la Selva",
          bodyMarkdown: "Escucha **ahora**.",
          ctaLabel: "Escuchar",
          ctaUrl:
            "https://dustwave.xyz/podcasts/opera-en-la-selva/"
        },
        "https://dustwave.xyz"
      )
    ).toEqual({
      language: "es",
      subject: "Nuevo episodio",
      heading: "Ópera en la Selva",
      bodyMarkdown: "Escucha **ahora**.",
      ctaLabel: "Escuchar",
      ctaUrl:
        "https://dustwave.xyz/podcasts/opera-en-la-selva/"
    });
  });

  it("rejects off-site CTAs and incomplete CTA pairs", () => {
    expect(() => normalizePodcastAnnouncement(
      {
        subject: "Episode",
        bodyMarkdown: "Listen",
        ctaLabel: "Listen",
        ctaUrl: "https://attacker.example/"
      },
      "https://dustwave.xyz"
    )).toThrow(/same-site URL/);
    expect(() => normalizePodcastAnnouncement(
      {
        subject: "Episode",
        bodyMarkdown: "Listen",
        ctaLabel: "Listen"
      },
      "https://dustwave.xyz"
    )).toThrow(/must be provided together/);
  });

  it("hashes only eligible explicit opt-ins and remains review-only", async () => {
    const queries: string[] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);
        return {
          bind() {
            return this;
          },
          async first() {
            return {
              id: "show_opera_en_la_selva",
              slug: "opera-en-la-selva",
              title: "Ópera en la Selva",
              canonical_url:
                "https://dustwave.xyz/podcasts/opera-en-la-selva/"
            };
          },
          async all() {
            return {
              results: [{
                listener_id: "listener_pseudonymous_fixture",
                updated_at: "2026-07-25 00:00:00",
                entitlement_updated_at: "2026-07-25 00:00:00"
              }]
            };
          }
        };
      }
    } as unknown as D1Database;
    const result = await buildPodcastAnnouncementDryRun(
      db,
      "show_opera_en_la_selva",
      {
        language: "es",
        subject: "Nuevo episodio",
        heading: "",
        bodyMarkdown: "Escucha ahora.",
        ctaLabel: "",
        ctaUrl: ""
      },
      "marketing_revision_secret_fixture"
    );
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      dryRun: true,
      reviewOnly: true,
      sendEnabled: false,
      sendBlockedReason: "announcement_delivery_not_implemented",
      consentPolicy: "explicit_show_opt_in",
      eligibleRecipientCount: 1
    });
    expect(result?.audienceRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.announcementRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.reviewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).not.toContain("email");
    expect(queries[1]).toContain("p.announcements_enabled = 1");
    expect(queries[1]).toContain("s.status = 'active'");
  });
});
