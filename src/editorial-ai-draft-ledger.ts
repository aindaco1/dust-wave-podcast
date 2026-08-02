import { prepareAdminAuditAfterSingleChange } from "./audit";

export type EditorialAiDraftKind = "chapters" | "clips" | "show_notes";

export type EditorialAiDraftClaim = {
  draftId: string;
  inputFingerprint: string;
  leaseId: string;
};

type EditorialAiDraftEvidence = {
  episodeId: string;
  workingMasterId: string;
  kind: EditorialAiDraftKind;
  sourceTranscriptId: string;
  sourceAlignmentRevisionId: string | null;
  sourceLanguage: "en" | "es";
  sourceTranscriptRevision: number;
  sourceTranscriptSha256: string;
  includedCueCount: number;
  totalCueCount: number;
  transcriptTruncated: boolean;
  episodeEvidenceSha256: string;
  outputLanguage: "en" | "es";
  model: string;
  promptVersion: string;
  inputFingerprint: string;
};

const MAXIMUM_AUTOMATED_ATTEMPTS = 3;

export async function claimEditorialAiDraft(
  db: D1Database,
  evidence: EditorialAiDraftEvidence
): Promise<EditorialAiDraftClaim | null> {
  const draftId = `editorial_draft_${evidence.inputFingerprint.slice(0, 40)}`;
  const leaseId = `editorial_draft_lease_${crypto.randomUUID()}`;
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO editorial_ai_drafts (
       id, episode_id, working_master_id, kind, source_transcript_id,
       source_alignment_revision_id, source_language,
       source_transcript_revision, source_transcript_sha256,
       included_cue_count, total_cue_count, transcript_truncated,
       episode_evidence_sha256, output_language, model, prompt_version,
       input_fingerprint, status, attempt_count, lease_id, lease_expires_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       'generating', 1, ?, datetime('now', '+4 minutes')
     )`
  ).bind(
    draftId,
    evidence.episodeId,
    evidence.workingMasterId,
    evidence.kind,
    evidence.sourceTranscriptId,
    evidence.sourceAlignmentRevisionId,
    evidence.sourceLanguage,
    evidence.sourceTranscriptRevision,
    evidence.sourceTranscriptSha256,
    evidence.includedCueCount,
    evidence.totalCueCount,
    evidence.transcriptTruncated ? 1 : 0,
    evidence.episodeEvidenceSha256,
    evidence.outputLanguage,
    evidence.model,
    evidence.promptVersion,
    evidence.inputFingerprint,
    leaseId
  ).run();
  let claimed = Number(inserted.meta?.changes ?? 0) === 1;
  if (!claimed) {
    const recovered = await db.prepare(
      `UPDATE editorial_ai_drafts
       SET
         status = 'generating',
         attempt_count = attempt_count + 1,
         lease_id = ?,
         lease_expires_at = datetime('now', '+4 minutes'),
         draft_json = NULL,
         draft_sha256 = NULL,
         failure_code = NULL,
         completed_at = NULL,
         updated_at = datetime('now')
       WHERE input_fingerprint = ?
         AND attempt_count < ?
         AND (
           status = 'failed'
           OR (status = 'generating' AND lease_expires_at <= datetime('now'))
         )`
    ).bind(
      leaseId,
      evidence.inputFingerprint,
      MAXIMUM_AUTOMATED_ATTEMPTS
    ).run();
    claimed = Number(recovered.meta?.changes ?? 0) === 1;
  }
  return claimed ? { draftId, inputFingerprint: evidence.inputFingerprint, leaseId } : null;
}

export async function completeEditorialAiDraft(
  db: D1Database,
  claim: EditorialAiDraftClaim,
  {
    draftJson,
    draftSha256,
    auditAction,
    auditMetadata
  }: {
    draftJson: string;
    draftSha256: string;
    auditAction: string;
    auditMetadata: Record<string, unknown>;
  }
): Promise<boolean> {
  const [completion] = await db.batch([
    db.prepare(
      `UPDATE editorial_ai_drafts
       SET
         status = 'ready',
         lease_id = NULL,
         lease_expires_at = NULL,
         draft_json = ?,
         draft_sha256 = ?,
         failure_code = NULL,
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?
         AND input_fingerprint = ?
         AND status = 'generating'
         AND lease_id = ?`
    ).bind(
      draftJson,
      draftSha256,
      claim.draftId,
      claim.inputFingerprint,
      claim.leaseId
    ),
    prepareAdminAuditAfterSingleChange(db, {
      adminUserId: null,
      action: auditAction,
      targetType: "editorial_ai_draft",
      targetId: claim.draftId,
      metadata: auditMetadata
    })
  ]);
  return Number(completion.meta?.changes ?? 0) === 1;
}

export async function failEditorialAiDraft(
  db: D1Database,
  claim: EditorialAiDraftClaim,
  {
    auditAction,
    auditMetadata,
    failureCode = "provider_or_validation_failed"
  }: {
    auditAction: string;
    auditMetadata: Record<string, unknown>;
    failureCode?: string;
  }
): Promise<boolean> {
  const [failure] = await db.batch([
    db.prepare(
      `UPDATE editorial_ai_drafts
       SET
         status = 'failed',
         lease_id = NULL,
         lease_expires_at = NULL,
         failure_code = ?,
         updated_at = datetime('now')
       WHERE id = ?
         AND input_fingerprint = ?
         AND status = 'generating'
         AND lease_id = ?`
    ).bind(
      failureCode,
      claim.draftId,
      claim.inputFingerprint,
      claim.leaseId
    ),
    prepareAdminAuditAfterSingleChange(db, {
      adminUserId: null,
      action: auditAction,
      targetType: "editorial_ai_draft",
      targetId: claim.draftId,
      metadata: auditMetadata
    })
  ]);
  return Number(failure.meta?.changes ?? 0) === 1;
}
