export const LAUNCH_CLAIM_REQUIRED_DESTINATIONS = 10;

type ShowFeedValidationRow = {
  status: "valid" | "failed";
  feed_url: string;
  validator_version: string;
  feed_sha256: string | null;
  item_count: number | null;
  failure_code: string | null;
  checked_at: string;
  validated_at: string | null;
};

type DestinationCertificationRow = {
  destination_id: string;
  enabled: number;
  owner_setup_status: string;
  ingestion_observed: number;
  failure_recovery_verified: number;
};

export type DistributionFeedValidationEvidence = {
  status: "valid" | "failed" | "not_checked";
  feedUrl: string | null;
  validatorVersion: string | null;
  feedSha256: string | null;
  itemCount: number | null;
  failureCode: string | null;
  checkedAt: string | null;
  validatedAt: string | null;
};

export type DestinationLaunchCertification = {
  ownerVerified: boolean;
  feedValidated: boolean;
  ingestionObserved: boolean;
  failureRecoveryVerified: boolean;
  certified: boolean;
};

export type DistributionCertificationSummary = {
  total: number;
  enabled: number;
  setupComplete: number;
  setupRequired: number;
  feedValidated: boolean;
  ingestionObserved: number;
  failureRecoveryVerified: number;
  certified: number;
};

export type DistributionLaunchCertification = {
  feedValidation: DistributionFeedValidationEvidence;
  byDestinationId: Map<string, DestinationLaunchCertification>;
  summary: DistributionCertificationSummary;
  launchClaim: {
    ready: boolean;
    requiredDestinations: number;
    certifiedDestinations: number;
    remainingDestinations: number;
  };
};

export async function loadDistributionLaunchCertification(
  db: D1Database,
  showId: string
): Promise<DistributionLaunchCertification> {
  const [feedRow, destinationResult] = await Promise.all([
    db.prepare(
      `SELECT
         status, feed_url, validator_version, feed_sha256, item_count,
         failure_code, checked_at, validated_at
       FROM show_feed_validations
       WHERE show_id = ?`
    ).bind(showId).first<ShowFeedValidationRow>(),
    db.prepare(
      `WITH scoped_destinations AS (
         SELECT
           destination.id AS destination_id,
           COALESCE(setup.enabled, destination.enabled) AS enabled,
           COALESCE(
             setup.owner_setup_status,
             destination.owner_setup_status
           ) AS owner_setup_status
         FROM distribution_destinations destination
         LEFT JOIN show_distribution_destinations setup
           ON setup.destination_id = destination.id
          AND setup.show_id = ?
       )
       SELECT
         scoped.destination_id,
         scoped.enabled,
         scoped.owner_setup_status,
         EXISTS (
           SELECT 1
           FROM distribution_observation_events observed
           WHERE observed.show_id = ?
             AND observed.destination_id = scoped.destination_id
             AND observed.status = 'observed'
         ) AS ingestion_observed,
         EXISTS (
           SELECT 1
           FROM distribution_observation_events failed
           WHERE failed.show_id = ?
             AND failed.destination_id = scoped.destination_id
             AND failed.status = 'failed'
             AND EXISTS (
               SELECT 1
               FROM distribution_observation_events recovered
               WHERE recovered.show_id = failed.show_id
                 AND recovered.destination_id = failed.destination_id
                 AND recovered.status = 'observed'
                 AND recovered.sequence > failed.sequence
             )
         ) AS failure_recovery_verified
       FROM scoped_destinations scoped
       ORDER BY scoped.destination_id`
    ).bind(showId, showId, showId).all<DestinationCertificationRow>()
  ]);

  const feedValidation = presentFeedValidation(feedRow);
  const feedValidated = feedValidation.status === "valid";
  const byDestinationId = new Map<string, DestinationLaunchCertification>();
  let enabled = 0;
  let setupComplete = 0;
  let ingestionObserved = 0;
  let failureRecoveryVerified = 0;
  let certified = 0;

  for (const row of destinationResult.results) {
    const destinationEnabled = row.enabled === 1;
    const ownerVerified = ["verified", "not_required"].includes(
      row.owner_setup_status
    );
    const destinationIngestionObserved = row.ingestion_observed === 1;
    const destinationFailureRecoveryVerified =
      row.failure_recovery_verified === 1;
    const destinationCertified = destinationEnabled
      && ownerVerified
      && feedValidated
      && destinationIngestionObserved
      && destinationFailureRecoveryVerified;
    byDestinationId.set(row.destination_id, {
      ownerVerified,
      feedValidated,
      ingestionObserved: destinationIngestionObserved,
      failureRecoveryVerified: destinationFailureRecoveryVerified,
      certified: destinationCertified
    });
    if (!destinationEnabled) continue;
    enabled += 1;
    if (ownerVerified) setupComplete += 1;
    if (destinationIngestionObserved) ingestionObserved += 1;
    if (destinationFailureRecoveryVerified) {
      failureRecoveryVerified += 1;
    }
    if (destinationCertified) certified += 1;
  }

  const total = destinationResult.results.length;
  const summary: DistributionCertificationSummary = {
    total,
    enabled,
    setupComplete,
    setupRequired: Math.max(0, enabled - setupComplete),
    feedValidated,
    ingestionObserved,
    failureRecoveryVerified,
    certified
  };
  return {
    feedValidation,
    byDestinationId,
    summary,
    launchClaim: {
      ready: certified >= LAUNCH_CLAIM_REQUIRED_DESTINATIONS,
      requiredDestinations: LAUNCH_CLAIM_REQUIRED_DESTINATIONS,
      certifiedDestinations: certified,
      remainingDestinations: Math.max(
        0,
        LAUNCH_CLAIM_REQUIRED_DESTINATIONS - certified
      )
    }
  };
}

function presentFeedValidation(
  row: ShowFeedValidationRow | null
): DistributionFeedValidationEvidence {
  return row
    ? {
        status: row.status,
        feedUrl: boundedEvidence(row.feed_url, 2_048),
        validatorVersion: boundedEvidence(row.validator_version, 64),
        feedSha256: boundedEvidence(row.feed_sha256, 64),
        itemCount: row.item_count === null
          ? null
          : Math.max(0, Number(row.item_count) || 0),
        failureCode: boundedEvidence(row.failure_code, 160),
        checkedAt: row.checked_at,
        validatedAt: row.validated_at
      }
    : {
        status: "not_checked",
        feedUrl: null,
        validatorVersion: null,
        feedSha256: null,
        itemCount: null,
        failureCode: null,
        checkedAt: null,
        validatedAt: null
      };
}

function boundedEvidence(value: unknown, maximum: number): string | null {
  const text = String(value ?? "").trim();
  return text ? Array.from(text).slice(0, maximum).join("") : null;
}
