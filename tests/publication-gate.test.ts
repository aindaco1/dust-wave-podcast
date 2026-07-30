import { describe, expect, it } from "vitest";

import {
  assessPublicationGate,
  assertPublicationOverrideConfirmation,
  publicationGateMode,
  readPublicationGateRequest
} from "../src/publication-gate";
import { RequestValidationError } from "../src/validation";

const DIGEST = "a".repeat(64);

describe("publication gate modes", () => {
  it("fails safely to legacy for missing or unknown configuration", () => {
    expect(publicationGateMode(undefined)).toBe("legacy");
    expect(publicationGateMode("unexpected")).toBe("legacy");
    expect(publicationGateMode(" SHADOW ")).toBe("shadow");
    expect(publicationGateMode("enforce")).toBe("enforce");
  });

  it("reports mismatch in shadow without blocking legacy publication", () => {
    expect(assessPublicationGate({
      mode: "shadow",
      requestedSnapshotDigest: null,
      requestedPublicationRevision: null,
      actualSnapshotDigest: DIGEST,
      actualPublicationRevision: 4,
      candidateReady: false,
      blockerCount: 3,
      warningCount: 1,
      overrideRequested: false,
      overrideAuthorized: false
    })).toEqual({
      mode: "shadow",
      snapshotMatched: false,
      candidateReady: false,
      overridden: false
    });
  });

  it("requires an exact snapshot when enforcement is enabled", () => {
    expectGateError(
      () => assessPublicationGate({
        mode: "enforce",
        requestedSnapshotDigest: null,
        requestedPublicationRevision: null,
        actualSnapshotDigest: DIGEST,
        actualPublicationRevision: 4,
        candidateReady: true,
        blockerCount: 0,
        warningCount: 0,
        overrideRequested: false,
        overrideAuthorized: false
      }),
      "publication_snapshot_required",
      409
    );
    expectGateError(
      () => assessPublicationGate({
        mode: "enforce",
        requestedSnapshotDigest: "b".repeat(64),
        requestedPublicationRevision: 4,
        actualSnapshotDigest: DIGEST,
        actualPublicationRevision: 4,
        candidateReady: true,
        blockerCount: 0,
        warningCount: 0,
        overrideRequested: false,
        overrideAuthorized: false
      }),
      "publication_snapshot_stale",
      409
    );
  });

  it("allows exact ready evidence without an override", () => {
    expect(assessPublicationGate({
      mode: "enforce",
      requestedSnapshotDigest: DIGEST,
      requestedPublicationRevision: 4,
      actualSnapshotDigest: DIGEST,
      actualPublicationRevision: 4,
      candidateReady: true,
      blockerCount: 0,
      warningCount: 1,
      overrideRequested: false,
      overrideAuthorized: false
    })).toMatchObject({
      snapshotMatched: true,
      candidateReady: true,
      overridden: false
    });
  });

  it("requires Admin authority for a blocker override", () => {
    const base = {
      mode: "enforce" as const,
      requestedSnapshotDigest: DIGEST,
      requestedPublicationRevision: 4,
      actualSnapshotDigest: DIGEST,
      actualPublicationRevision: 4,
      candidateReady: false,
      blockerCount: 2,
      warningCount: 1
    };
    expectGateError(
      () => assessPublicationGate({
        ...base,
        overrideRequested: false,
        overrideAuthorized: false
      }),
      "publication_not_ready",
      409
    );
    expectGateError(
      () => assessPublicationGate({
        ...base,
        overrideRequested: true,
        overrideAuthorized: false
      }),
      "publication_override_forbidden",
      403
    );
    expect(assessPublicationGate({
      ...base,
      overrideRequested: true,
      overrideAuthorized: true
    })).toMatchObject({
      snapshotMatched: true,
      candidateReady: false,
      overridden: true
    });
  });
});

describe("publication override input", () => {
  it("normalizes and bounds the private reason", () => {
    expect(readPublicationGateRequest({
      snapshotDigest: DIGEST.toUpperCase(),
      basePublicationRevision: 4,
      override: {
        id: "publication_override_1",
        reason: "  Review accepted the known exception.  ",
        confirmation: "PUBLISH_WITH_BLOCKERS"
      }
    })).toEqual({
      snapshotDigest: DIGEST,
      basePublicationRevision: 4,
      override: {
        id: "publication_override_1",
        reason: "Review accepted the known exception.",
        confirmation: "PUBLISH_WITH_BLOCKERS"
      }
    });
  });

  it("rejects control and bidirectional override text", () => {
    for (const reason of ["line one\nline two", "unsafe\u202etext"]) {
      expectGateError(
        () => readPublicationGateRequest({
          override: {
            id: "publication_override_1",
            reason,
            confirmation: "PUBLISH_WITH_BLOCKERS"
          }
        }),
        "invalid_request",
        400
      );
    }
  });

  it("rejects coerced snapshot and revision types", () => {
    for (const body of [
      { snapshotDigest: null },
      { snapshotDigest: { digest: DIGEST } },
      { basePublicationRevision: null },
      { basePublicationRevision: "4" },
      { basePublicationRevision: false }
    ]) {
      expectGateError(
        () => readPublicationGateRequest(body),
        "invalid_request",
        400
      );
    }
  });

  it("requires an explicit high-friction confirmation", () => {
    expectGateError(
      () => assertPublicationOverrideConfirmation("yes"),
      "publication_override_confirmation_required",
      400
    );
  });
});

function expectGateError(
  action: () => unknown,
  code: string,
  status: number
): void {
  try {
    action();
    throw new Error("Expected the publication gate to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(RequestValidationError);
    expect(error).toMatchObject({ code, status });
  }
}
