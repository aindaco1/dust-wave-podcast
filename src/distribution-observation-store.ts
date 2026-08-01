export type DistributionObservationStatus = "observed" | "failed";
export type DistributionObservationSource =
  | "manual_review"
  | "provider_dashboard"
  | "automated_probe";

export type DistributionObservationPublication = {
  id: string;
  showId: string;
  episodeId: string;
  destinationId: string;
  publicationRevision: number;
  priorStatus: string;
  priorEvidenceUrl: string | null;
  priorError: string | null;
  priorEvidenceSource: string | null;
};

export type RecordDistributionObservationInput = {
  publication: DistributionObservationPublication;
  status: DistributionObservationStatus;
  evidenceUrl: string | null;
  error: string | null;
  evidenceSource: DistributionObservationSource;
  adminUserId: string | null;
};

export type RecordDistributionObservationResult =
  | { status: "recorded"; eventId: string }
  | { status: "idempotent"; eventId: null }
  | { status: "conflict"; eventId: string };

export async function recordDistributionObservation(
  db: D1Database,
  input: RecordDistributionObservationInput
): Promise<RecordDistributionObservationResult> {
  const {
    publication,
    status,
    evidenceUrl,
    error,
    evidenceSource,
    adminUserId
  } = input;
  if (
    publication.priorStatus === status
    && publication.priorEvidenceUrl === evidenceUrl
    && publication.priorError === error
    && publication.priorEvidenceSource === evidenceSource
  ) {
    return { status: "idempotent", eventId: null };
  }

  const eventId =
    `distribution_observation_${crypto.randomUUID().replace(/-/g, "")}`;
  const auditId = `audit_${crypto.randomUUID().replace(/-/g, "")}`;
  const auditAction = status === "observed"
    ? "distribution.directory_observed"
    : "distribution.directory_failed";
  const auditMetadata = JSON.stringify({
    episodeId: publication.episodeId,
    destinationId: publication.destinationId,
    publicationRevision: publication.publicationRevision,
    priorStatus: publication.priorStatus,
    status,
    evidenceSource,
    hasEvidenceUrl: Boolean(evidenceUrl),
    hasError: Boolean(error)
  });

  await db.batch([
    db.prepare(
      `INSERT INTO distribution_observation_events (
         id, show_id, episode_id, destination_id, publication_revision,
         status, evidence_url, failure_detail, evidence_source,
         evidence_admin_user_id
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM episode_publications
       WHERE id = ?
         AND publication_revision = ?
         AND status = ?`
    ).bind(
      eventId,
      publication.showId,
      publication.episodeId,
      publication.destinationId,
      publication.publicationRevision,
      status,
      evidenceUrl,
      error,
      evidenceSource,
      adminUserId,
      publication.id,
      publication.publicationRevision,
      publication.priorStatus
    ),
    db.prepare(
      `UPDATE episode_publications
       SET
         status = ?,
         evidence_url = ?,
         evidence_source = ?,
         evidence_admin_user_id = ?,
         last_observed_at = CASE
           WHEN ? = 'observed' THEN datetime('now')
           ELSE last_observed_at
         END,
         last_error = ?,
         updated_at = datetime('now')
       WHERE id = ?
         AND publication_revision = ?
         AND status = ?
         AND EXISTS (
           SELECT 1
           FROM distribution_observation_events event
           WHERE event.id = ?
             AND event.episode_id = episode_publications.episode_id
             AND event.destination_id =
               episode_publications.destination_id
             AND event.publication_revision =
               episode_publications.publication_revision
         )`
    ).bind(
      status,
      evidenceUrl,
      evidenceSource,
      adminUserId,
      status,
      error,
      publication.id,
      publication.publicationRevision,
      publication.priorStatus,
      eventId
    ),
    db.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, ?, 'episode_publication', publication.id, ?
       FROM episode_publications publication
       JOIN distribution_observation_events event
         ON event.id = ?
        AND event.episode_id = publication.episode_id
        AND event.destination_id = publication.destination_id
        AND event.publication_revision = publication.publication_revision
       WHERE publication.id = ?
         AND publication.status = ?
         AND publication.evidence_source = ?`
    ).bind(
      auditId,
      adminUserId,
      auditAction,
      auditMetadata,
      eventId,
      publication.id,
      status,
      evidenceSource
    )
  ]);

  const committed = await db.prepare(
    `SELECT
       publication.status,
       publication.evidence_url,
       publication.evidence_source,
       publication.last_error,
       event.id AS event_id,
       audit.id AS audit_id
     FROM episode_publications publication
     LEFT JOIN distribution_observation_events event
       ON event.id = ?
      AND event.episode_id = publication.episode_id
      AND event.destination_id = publication.destination_id
      AND event.publication_revision = publication.publication_revision
     LEFT JOIN admin_audit_events audit
       ON audit.id = ?
      AND audit.target_id = publication.id
     WHERE publication.id = ?
       AND publication.publication_revision = ?`
  ).bind(
    eventId,
    auditId,
    publication.id,
    publication.publicationRevision
  ).first<{
    status: string;
    evidence_url: string | null;
    evidence_source: string | null;
    last_error: string | null;
    event_id: string | null;
    audit_id: string | null;
  }>();
  if (
    committed?.status !== status
    || committed.evidence_url !== evidenceUrl
    || committed.evidence_source !== evidenceSource
    || committed.last_error !== error
    || committed.event_id !== eventId
    || committed.audit_id !== auditId
  ) {
    return { status: "conflict", eventId };
  }
  return { status: "recorded", eventId };
}
