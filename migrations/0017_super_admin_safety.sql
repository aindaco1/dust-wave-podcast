PRAGMA foreign_keys = ON;

CREATE TRIGGER protect_minimum_active_super_admin_status
BEFORE UPDATE OF status ON admin_users
WHEN OLD.status = 'active'
  AND NEW.status != 'active'
  AND (
    SELECT COUNT(DISTINCT u.id)
    FROM admin_users u
    JOIN admin_user_roles r ON r.admin_user_id = u.id
    WHERE u.status = 'active' AND r.role = 'super_admin'
  ) >= 2
  AND (
    SELECT COUNT(DISTINCT u.id)
    FROM admin_users u
    JOIN admin_user_roles r ON r.admin_user_id = u.id
    WHERE
      u.status = 'active'
      AND r.role = 'super_admin'
      AND u.id != OLD.id
  ) < 2
BEGIN
  SELECT RAISE(ABORT, 'minimum_two_active_super_admins');
END;

CREATE TRIGGER protect_minimum_active_super_admin_delete
BEFORE DELETE ON admin_users
WHEN OLD.status = 'active'
  AND (
    SELECT COUNT(DISTINCT u.id)
    FROM admin_users u
    JOIN admin_user_roles r ON r.admin_user_id = u.id
    WHERE u.status = 'active' AND r.role = 'super_admin'
  ) >= 2
  AND (
    SELECT COUNT(DISTINCT u.id)
    FROM admin_users u
    JOIN admin_user_roles r ON r.admin_user_id = u.id
    WHERE
      u.status = 'active'
      AND r.role = 'super_admin'
      AND u.id != OLD.id
  ) < 2
BEGIN
  SELECT RAISE(ABORT, 'minimum_two_active_super_admins');
END;

CREATE TRIGGER protect_minimum_active_super_admin_role
BEFORE DELETE ON admin_user_roles
WHEN OLD.role = 'super_admin'
  AND (
    SELECT status FROM admin_users WHERE id = OLD.admin_user_id
  ) = 'active'
  AND (
    SELECT COUNT(DISTINCT u.id)
    FROM admin_users u
    JOIN admin_user_roles r ON r.admin_user_id = u.id
    WHERE u.status = 'active' AND r.role = 'super_admin'
  ) >= 2
  AND (
    SELECT COUNT(DISTINCT u.id)
    FROM admin_users u
    JOIN admin_user_roles r ON r.admin_user_id = u.id
    WHERE
      u.status = 'active'
      AND r.role = 'super_admin'
      AND u.id != OLD.admin_user_id
  ) < 2
BEGIN
  SELECT RAISE(ABORT, 'minimum_two_active_super_admins');
END;

CREATE TRIGGER protect_minimum_active_super_admin_role_update
BEFORE UPDATE OF admin_user_id, role, show_id ON admin_user_roles
WHEN OLD.role = 'super_admin'
  AND (
    NEW.role != 'super_admin'
    OR NEW.admin_user_id != OLD.admin_user_id
    OR NEW.show_id IS NOT NULL
  )
  AND (
    SELECT status FROM admin_users WHERE id = OLD.admin_user_id
  ) = 'active'
  AND (
    SELECT COUNT(DISTINCT u.id)
    FROM admin_users u
    JOIN admin_user_roles r ON r.admin_user_id = u.id
    WHERE u.status = 'active' AND r.role = 'super_admin'
  ) >= 2
  AND (
    SELECT COUNT(DISTINCT u.id)
    FROM admin_users u
    JOIN admin_user_roles r ON r.admin_user_id = u.id
    WHERE
      u.status = 'active'
      AND r.role = 'super_admin'
      AND u.id != OLD.admin_user_id
  ) < 2
BEGIN
  SELECT RAISE(ABORT, 'minimum_two_active_super_admins');
END;
