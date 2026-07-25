import { describe, expect, it } from "vitest";

import { normalizeReviewComment } from "../src/production-reviews";

describe("production review comment contract", () => {
  it("normalizes a bounded timestamp range and plain bilingual review text", () => {
    expect(normalizeReviewComment({
      startsAtMs: 12_500,
      endsAtMs: 19_250,
      bodyText: "  Baja la música.  \r\nLower the music.  ",
      blocker: true,
      assignedToAdminUserId: "admin_fixture"
    }, 30)).toEqual({
      startsAtMs: 12_500,
      endsAtMs: 19_250,
      bodyText: "Baja la música.\nLower the music.",
      blocker: true,
      assignedToAdminUserId: "admin_fixture"
    });
  });

  it("supports an untimed note without inventing a timestamp", () => {
    expect(normalizeReviewComment({
      bodyText: "Confirm the guest credit.",
      blocker: false
    }, null)).toEqual({
      startsAtMs: null,
      endsAtMs: null,
      bodyText: "Confirm the guest credit.",
      blocker: false,
      assignedToAdminUserId: null
    });
  });

  it("rejects invalid ranges, unsafe text, and ambiguous booleans", () => {
    expect(() => normalizeReviewComment({
      endsAtMs: 1_000,
      bodyText: "Missing start"
    }, 10)).toThrow(/requires a startsAtMs/);
    expect(() => normalizeReviewComment({
      startsAtMs: 2_000,
      endsAtMs: 2_000,
      bodyText: "Empty range"
    }, 10)).toThrow(/after startsAtMs/);
    expect(() => normalizeReviewComment({
      startsAtMs: 9_500,
      endsAtMs: 10_001,
      bodyText: "Past duration"
    }, 10)).toThrow(/episode duration/);
    expect(() => normalizeReviewComment({
      bodyText: "Safe prefix\u202espoofed direction"
    }, 10)).toThrow(/unsafe control/);
    expect(() => normalizeReviewComment({
      bodyText: "Review",
      blocker: "true"
    }, 10)).toThrow(/blocker must be a boolean/);
  });
});
