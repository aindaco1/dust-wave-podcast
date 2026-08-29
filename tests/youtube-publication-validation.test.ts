import { describe, expect, it } from "vitest";

import { validYouTubePrivacyStatus } from
  "../src/youtube-publication-validation";

describe("YouTube publication validation", () => {
  it("shares the private and unlisted publication boundary", () => {
    expect(validYouTubePrivacyStatus("private")).toBe("private");
    expect(validYouTubePrivacyStatus("unlisted")).toBe("unlisted");
    expect(() => validYouTubePrivacyStatus("public")).toThrow(
      "privacyStatus must be private or unlisted"
    );
  });
});
