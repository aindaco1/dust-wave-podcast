export async function recordAdminAudit(
  db: D1Database,
  input: AdminAuditInput
): Promise<void> {
  await prepareAdminAudit(db, input).run();
}

export type AdminAuditInput = {
  adminUserId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
};

export function prepareAdminAudit(
  db: D1Database,
  {
    adminUserId,
    action,
    targetType,
    targetId = null,
    metadata = {}
  }: AdminAuditInput
): D1PreparedStatement {
  return db.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      `audit_${crypto.randomUUID().replace(/-/g, "")}`,
      adminUserId,
      action,
      targetType,
      targetId,
      JSON.stringify(metadata)
    );
}

export function prepareAdminAuditAfterSingleChange(
  db: D1Database,
  input: AdminAuditInput
): D1PreparedStatement {
  return prepareAdminAuditAfterChanges(db, input, 1);
}

export function prepareAdminAuditAfterChanges(
  db: D1Database,
  {
    adminUserId,
    action,
    targetType,
    targetId = null,
    metadata = {}
  }: AdminAuditInput,
  expectedChanges: number
): D1PreparedStatement {
  if (
    !Number.isSafeInteger(expectedChanges)
    || expectedChanges < 1
    || expectedChanges > 1_000
  ) {
    throw new RangeError("expectedChanges must be between 1 and 1000");
  }
  return db.prepare(
      `INSERT INTO admin_audit_events (
         id, admin_user_id, action, target_type, target_id, metadata_json
       )
       SELECT ?, ?, ?, ?, ?, ?
       WHERE changes() = ?`
    )
    .bind(
      `audit_${crypto.randomUUID().replace(/-/g, "")}`,
      adminUserId,
      action,
      targetType,
      targetId,
      JSON.stringify(metadata),
      expectedChanges
    );
}
