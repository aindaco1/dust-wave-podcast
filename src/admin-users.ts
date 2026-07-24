import { hmacSha256, normalizeEmail } from "@dustwave/worker-core/crypto";

import { type AdminRole, requireAdmin } from "./admin-auth";
import { prepareAdminAudit, recordAdminAudit } from "./audit";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import {
  optionalText,
  readJsonObject,
  RequestValidationError,
  requiredText,
  validIdentifier
} from "./validation";

const ADMIN_ROLES = new Set<AdminRole>([
  "super_admin",
  "admin",
  "producer",
  "analyst"
]);
const EDITABLE_STATUSES = new Set(["invited", "suspended", "revoked"]);

type AdminUserRow = {
  id: string;
  status: "invited" | "active" | "suspended" | "revoked";
  invited_at: string;
  activated_at: string | null;
  last_authenticated_at: string | null;
  created_at: string;
  updated_at: string;
};

type AdminRoleRow = {
  admin_user_id: string;
  role: AdminRole;
  show_id: string | null;
  granted_at: string;
};

export async function listAdminUsers(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"]
  });
  if (!auth.ok) return auth.response;
  const [users, roles] = await Promise.all([
    env.DB.prepare(
      `SELECT
         id, status, invited_at, activated_at, last_authenticated_at,
         created_at, updated_at
       FROM admin_users
       ORDER BY
         CASE status
           WHEN 'active' THEN 0
           WHEN 'invited' THEN 1
           WHEN 'suspended' THEN 2
           ELSE 3
         END,
         created_at
       LIMIT 100`
    ).all<AdminUserRow>(),
    env.DB.prepare(
      `SELECT r.admin_user_id, r.role, r.show_id, r.granted_at
       FROM admin_user_roles r
       JOIN admin_users u ON u.id = r.admin_user_id
       ORDER BY r.admin_user_id, r.role, r.show_id
       LIMIT 400`
    ).all<AdminRoleRow>()
  ]);
  const rolesByUser = new Map<string, AdminRoleRow[]>();
  for (const role of roles.results) {
    const existing = rolesByUser.get(role.admin_user_id) ?? [];
    existing.push(role);
    rolesByUser.set(role.admin_user_id, existing);
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    users: users.results.map((user) => ({
      id: user.id,
      status: user.status,
      invitedAt: user.invited_at,
      activatedAt: user.activated_at,
      lastAuthenticatedAt: user.last_authenticated_at,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      roles: (rolesByUser.get(user.id) ?? []).map((role) => ({
        role: role.role,
        showId: role.show_id,
        grantedAt: role.granted_at
      }))
    }))
  });
}

export async function inviteAdminUser(
  request: Request,
  env: PodcastEnv
): Promise<Response> {
  const auth = await requireLifecycleAdmin(request, env);
  if (!auth.ok) return auth.response;
  if (!env.ADMIN_EMAIL_LOOKUP_PEPPER) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "admin_auth_not_configured" },
      { status: 503 }
    );
  }
  const body = await readJsonObject(request);
  const email = validEmail(body.email);
  const role = validRole(body.role);
  const showId = await validRoleScope(env.DB, role, body.showId);
  const lookupHash = await hmacSha256(
    email,
    env.ADMIN_EMAIL_LOOKUP_PEPPER,
    "hex"
  );
  const existing = await env.DB
    .prepare(
      `SELECT id
       FROM admin_users
       WHERE email_lookup_hash = ?`
    )
    .bind(lookupHash)
    .first<{ id: string }>();
  if (existing) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "admin_user_exists", adminUserId: existing.id },
      { status: 409 }
    );
  }
  const adminUserId = `admin_${crypto.randomUUID().replace(/-/g, "")}`;
  const roleId = `role_${crypto.randomUUID().replace(/-/g, "")}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO admin_users (id, email_lookup_hash)
       VALUES (?, ?)`
    ).bind(adminUserId, lookupHash),
    env.DB.prepare(
      `INSERT INTO admin_user_roles (
         id, admin_user_id, role, show_id, granted_by_admin_user_id
       ) VALUES (?, ?, ?, ?, ?)`
    ).bind(
      roleId,
      adminUserId,
      role,
      showId,
      auth.authorization.identity.id
    ),
    prepareAdminAudit(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "admin_user.invited",
      targetType: "admin_user",
      targetId: adminUserId,
      metadata: { role, showId }
    })
  ]);
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    {
      adminUserId,
      status: "invited",
      role: { role, showId },
      delivery: "standard_magic_link_login"
    },
    { status: 201 }
  );
}

export async function updateAdminUserStatus(
  request: Request,
  env: PodcastEnv,
  adminUserIdValue: string
): Promise<Response> {
  const adminUserId = validIdentifier(adminUserIdValue, "adminUserId");
  const auth = await requireLifecycleAdmin(request, env);
  if (!auth.ok) return auth.response;
  const body = await readJsonObject(request);
  const status = requiredText(body.status, "status", 20);
  if (!EDITABLE_STATUSES.has(status)) {
    throw new RequestValidationError(
      "status must be invited, suspended, or revoked"
    );
  }
  const target = await env.DB
    .prepare(
      `SELECT
         u.status,
         EXISTS (
           SELECT 1 FROM admin_user_roles r
           WHERE r.admin_user_id = u.id AND r.role = 'super_admin'
         ) AS is_super_admin
       FROM admin_users u
       WHERE u.id = ?`
    )
    .bind(adminUserId)
    .first<{ status: AdminUserRow["status"]; is_super_admin: number }>();
  if (!target) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "admin_user_not_found" },
      { status: 404 }
    );
  }
  if (
    target.status === "active"
    && target.is_super_admin === 1
    && await activeSuperAdminCount(env.DB) <= 2
  ) {
    return minimumSuperAdminsResponse(request, env);
  }
  try {
    await env.DB
      .prepare(
        `UPDATE admin_users
         SET status = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(status, adminUserId)
      .run();
  } catch (error) {
    if (isMinimumSuperAdminError(error)) {
      return minimumSuperAdminsResponse(request, env);
    }
    throw error;
  }
  await recordAdminAudit(env.DB, {
    adminUserId: auth.authorization.identity.id,
    action: "admin_user.status_changed",
    targetType: "admin_user",
    targetId: adminUserId,
    metadata: { from: target.status, to: status }
  });
  return privateJson(request, env.ALLOWED_ORIGINS, {
    adminUserId,
    status
  });
}

export async function grantAdminUserRole(
  request: Request,
  env: PodcastEnv,
  adminUserIdValue: string
): Promise<Response> {
  const adminUserId = validIdentifier(adminUserIdValue, "adminUserId");
  const auth = await requireLifecycleAdmin(request, env);
  if (!auth.ok) return auth.response;
  const body = await readJsonObject(request);
  const role = validRole(body.role);
  const showId = await validRoleScope(env.DB, role, body.showId);
  const target = await env.DB
    .prepare(`SELECT id FROM admin_users WHERE id = ? AND status != 'revoked'`)
    .bind(adminUserId)
    .first<{ id: string }>();
  if (!target) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "admin_user_not_found" },
      { status: 404 }
    );
  }
  const inserted = await env.DB
    .prepare(
      `INSERT INTO admin_user_roles (
         id, admin_user_id, role, show_id, granted_by_admin_user_id
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING id`
    )
    .bind(
      `role_${crypto.randomUUID().replace(/-/g, "")}`,
      adminUserId,
      role,
      showId,
      auth.authorization.identity.id
    )
    .first<{ id: string }>();
  if (inserted) {
    await recordAdminAudit(env.DB, {
      adminUserId: auth.authorization.identity.id,
      action: "admin_user.role_granted",
      targetType: "admin_user",
      targetId: adminUserId,
      metadata: { role, showId }
    });
  }
  return privateJson(request, env.ALLOWED_ORIGINS, {
    adminUserId,
    role: { role, showId },
    idempotent: !inserted
  });
}

export async function revokeAdminUserRole(
  request: Request,
  env: PodcastEnv,
  adminUserIdValue: string,
  roleValue: string
): Promise<Response> {
  const adminUserId = validIdentifier(adminUserIdValue, "adminUserId");
  const role = validRole(roleValue);
  const auth = await requireLifecycleAdmin(request, env);
  if (!auth.ok) return auth.response;
  const showId = await validRoleScope(
    env.DB,
    role,
    new URL(request.url).searchParams.get("showId")
  );
  if (
    role === "super_admin"
    && await isActiveAdmin(env.DB, adminUserId)
    && await activeSuperAdminCount(env.DB) <= 2
  ) {
    return minimumSuperAdminsResponse(request, env);
  }
  try {
    const deleted = await env.DB
      .prepare(
        `DELETE FROM admin_user_roles
         WHERE admin_user_id = ?
           AND role = ?
           AND (
             (? IS NULL AND show_id IS NULL)
             OR show_id = ?
           )
         RETURNING id`
      )
      .bind(adminUserId, role, showId, showId)
      .first<{ id: string }>();
    if (deleted) {
      await recordAdminAudit(env.DB, {
        adminUserId: auth.authorization.identity.id,
        action: "admin_user.role_revoked",
        targetType: "admin_user",
        targetId: adminUserId,
        metadata: { role, showId }
      });
    }
    return privateJson(request, env.ALLOWED_ORIGINS, {
      adminUserId,
      role: { role, showId },
      idempotent: !deleted
    });
  } catch (error) {
    if (isMinimumSuperAdminError(error)) {
      return minimumSuperAdminsResponse(request, env);
    }
    throw error;
  }
}

async function requireLifecycleAdmin(
  request: Request,
  env: PodcastEnv
) {
  const auth = await requireAdmin(request, env, {
    allowedRoles: ["super_admin"],
    requireCsrf: true
  });
  if (!auth.ok) return auth;
  const recent = await env.DB
    .prepare(
      `SELECT 1 AS recent
       FROM admin_users
       WHERE id = ?
         AND status = 'active'
         AND last_authenticated_at >= datetime('now', '-15 minutes')`
    )
    .bind(auth.authorization.identity.id)
    .first<{ recent: number }>();
  if (!recent) {
    return {
      ok: false as const,
      response: privateJson(
        request,
        env.ALLOWED_ORIGINS,
        { error: "recent_authentication_required" },
        { status: 403 }
      )
    };
  }
  return auth;
}

function validEmail(value: unknown): string {
  const email = normalizeEmail(value);
  if (
    email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new RequestValidationError("email is invalid");
  }
  return email;
}

function validRole(value: unknown): AdminRole {
  const role = requiredText(value, "role", 20) as AdminRole;
  if (!ADMIN_ROLES.has(role)) {
    throw new RequestValidationError("role is invalid");
  }
  return role;
}

async function validRoleScope(
  db: D1Database,
  role: AdminRole,
  showIdValue: unknown
): Promise<string | null> {
  const rawShowId = optionalText(showIdValue, "showId", 128);
  if (role === "super_admin") {
    if (rawShowId) {
      throw new RequestValidationError("super_admin cannot have a show scope");
    }
    return null;
  }
  if (!rawShowId) return null;
  const showId = validIdentifier(rawShowId, "showId");
  const show = await db
    .prepare(`SELECT id FROM shows WHERE id = ? AND status != 'archived'`)
    .bind(showId)
    .first<{ id: string }>();
  if (!show) {
    throw new RequestValidationError(
      "showId does not reference an active show"
    );
  }
  return showId;
}

async function activeSuperAdminCount(db: D1Database): Promise<number> {
  const count = await db
    .prepare(
      `SELECT COUNT(DISTINCT u.id) AS count
       FROM admin_users u
       JOIN admin_user_roles r ON r.admin_user_id = u.id
       WHERE u.status = 'active' AND r.role = 'super_admin'`
    )
    .first<{ count: number }>();
  return Number(count?.count ?? 0);
}

async function isActiveAdmin(
  db: D1Database,
  adminUserId: string
): Promise<boolean> {
  return Boolean(
    await db
      .prepare(`SELECT 1 FROM admin_users WHERE id = ? AND status = 'active'`)
      .bind(adminUserId)
      .first()
  );
}

function minimumSuperAdminsResponse(
  request: Request,
  env: PodcastEnv
): Response {
  return privateJson(
    request,
    env.ALLOWED_ORIGINS,
    { error: "minimum_two_active_super_admins" },
    { status: 409 }
  );
}

function isMinimumSuperAdminError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("minimum_two_active_super_admins");
}
