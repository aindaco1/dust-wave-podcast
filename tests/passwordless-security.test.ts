import { describe, expect, it } from "vitest";

import { passwordlessSessionCookie } from "../src/passwordless-security";

describe("passwordless session cookie policy", () => {
  it("uses a partitioned cross-site cookie for the isolated staging site", () => {
    const cookie = passwordlessSessionCookie({
      cookieName: "podcast_session",
      environment: "staging",
      maximumAge: 3_600,
      path: "/v1/admin",
      token: "token fixture"
    });

    expect(cookie).toBe(
      "podcast_session=token%20fixture; Path=/v1/admin; Max-Age=3600; "
      + "HttpOnly; Secure; SameSite=None; Partitioned"
    );
  });

  it("keeps production sessions first-party and same-site", () => {
    const cookie = passwordlessSessionCookie({
      cookieName: "podcast_session",
      environment: "production",
      maximumAge: 3_600,
      path: "/v1/member",
      token: "token_fixture"
    });

    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Partitioned");
  });

  it("clears a cookie with the same scoped attributes", () => {
    const cookie = passwordlessSessionCookie({
      cookieName: "podcast_session",
      environment: "staging",
      maximumAge: 0,
      path: "/v1/admin",
      token: ""
    });

    expect(cookie).toContain("podcast_session=;");
    expect(cookie).toContain("Path=/v1/admin");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("SameSite=None; Partitioned");
  });
});
