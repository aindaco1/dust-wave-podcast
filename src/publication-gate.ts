import { RequestValidationError, requiredText, validIdentifier } from "./validation";

export type PublicationGateMode = "legacy" | "shadow" | "enforce";

export type PublicationGateAssessment = {
  mode: PublicationGateMode;
  snapshotMatched: boolean | null;
  candidateReady: boolean;
  overridden: boolean;
};

export type PublicationGateRequest = {
  snapshotDigest: string | null;
  basePublicationRevision: number | null;
  override: {
    id: string;
    reason: string;
    confirmation: string;
  } | null;
};

type AssessPublicationGateInput = {
  mode: PublicationGateMode;
  requestedSnapshotDigest: string | null;
  requestedPublicationRevision: number | null;
  actualSnapshotDigest: string;
  actualPublicationRevision: number;
  candidateReady: boolean;
  blockerCount: number;
  warningCount: number;
  overrideRequested: boolean;
  overrideAuthorized: boolean;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UNSAFE_OVERRIDE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export function publicationGateMode(
  value: unknown
): PublicationGateMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "shadow" || normalized === "enforce"
    ? normalized
    : "legacy";
}

export function readPublicationGateRequest(
  body: Record<string, unknown>
): PublicationGateRequest {
  if (
    body.snapshotDigest !== undefined
    && typeof body.snapshotDigest !== "string"
  ) {
    throw new RequestValidationError("snapshotDigest must be a string");
  }
  const snapshotDigest = body.snapshotDigest === undefined
    ? null
    : body.snapshotDigest.trim().toLowerCase();
  if (
    body.basePublicationRevision !== undefined
    && typeof body.basePublicationRevision !== "number"
  ) {
    throw new RequestValidationError(
      "basePublicationRevision must be a number"
    );
  }
  const basePublicationRevision = body.basePublicationRevision === undefined
    ? null
    : body.basePublicationRevision;
  if (
    basePublicationRevision !== null
    && (
      !Number.isSafeInteger(basePublicationRevision)
      || basePublicationRevision < 0
    )
  ) {
    throw new RequestValidationError(
      "basePublicationRevision must be a non-negative integer"
    );
  }
  if (
    snapshotDigest !== null
    && !SHA256_HEX.test(snapshotDigest)
  ) {
    throw new RequestValidationError(
      "snapshotDigest must be a lowercase SHA-256 digest"
    );
  }

  if (body.override === undefined || body.override === null) {
    return { snapshotDigest, basePublicationRevision, override: null };
  }
  if (
    typeof body.override !== "object"
    || Array.isArray(body.override)
  ) {
    throw new RequestValidationError("override must be an object");
  }
  const candidate = body.override as Record<string, unknown>;
  const reason = requiredText(candidate.reason, "override.reason", 500)
    .normalize("NFKC")
    .trim();
  if (reason.length > 500) {
    throw new RequestValidationError("override.reason is too long");
  }
  if (UNSAFE_OVERRIDE_TEXT.test(reason)) {
    throw new RequestValidationError(
      "override.reason contains unsupported control characters"
    );
  }
  return {
    snapshotDigest,
    basePublicationRevision,
    override: {
      id: validIdentifier(candidate.id, "override.id"),
      reason,
      confirmation: requiredText(
        candidate.confirmation,
        "override.confirmation",
        40
      )
    }
  };
}

export function assessPublicationGate(
  input: AssessPublicationGateInput
): PublicationGateAssessment {
  const snapshotMatched = (
    input.requestedSnapshotDigest !== null
    && input.requestedPublicationRevision !== null
  )
    ? input.requestedSnapshotDigest === input.actualSnapshotDigest
      && input.requestedPublicationRevision === input.actualPublicationRevision
    : false;

  if (input.mode === "legacy") {
    return {
      mode: input.mode,
      snapshotMatched: null,
      candidateReady: input.candidateReady,
      overridden: false
    };
  }
  if (input.mode === "shadow") {
    return {
      mode: input.mode,
      snapshotMatched,
      candidateReady: input.candidateReady,
      overridden: false
    };
  }
  if (
    input.requestedSnapshotDigest === null
    || input.requestedPublicationRevision === null
  ) {
    throw new RequestValidationError(
      "A fresh publication readiness snapshot is required",
      "publication_snapshot_required",
      409
    );
  }
  if (!snapshotMatched) {
    throw new RequestValidationError(
      "Publication evidence changed. Refresh readiness and retry.",
      "publication_snapshot_stale",
      409
    );
  }
  if (input.candidateReady) {
    if (input.overrideRequested) {
      throw new RequestValidationError(
        "An override is not needed for a ready publication",
        "publication_override_not_needed",
        400
      );
    }
    return {
      mode: input.mode,
      snapshotMatched: true,
      candidateReady: true,
      overridden: false
    };
  }
  if (!input.overrideRequested) {
    throw new RequestValidationError(
      `${input.blockerCount} publication readiness blocker${
        input.blockerCount === 1 ? "" : "s"
      } must be resolved or explicitly overridden; ${
        input.warningCount
      } warning${input.warningCount === 1 ? "" : "s"} reported`,
      "publication_not_ready",
      409
    );
  }
  if (!input.overrideAuthorized) {
    throw new RequestValidationError(
      "Only an Admin or Super-admin may override publication blockers",
      "publication_override_forbidden",
      403
    );
  }
  return {
    mode: input.mode,
    snapshotMatched: true,
    candidateReady: false,
    overridden: true
  };
}

export function assertPublicationOverrideConfirmation(
  confirmation: string
): void {
  if (confirmation !== "PUBLISH_WITH_BLOCKERS") {
    throw new RequestValidationError(
      "Type PUBLISH_WITH_BLOCKERS to confirm the override",
      "publication_override_confirmation_required",
      400
    );
  }
}
