// Guards against locking the office out of user management: no change may leave zero active users
// who hold manageUsers. Call with the change you're about to make; it answers whether at least one
// active manager would remain afterwards.
const { userCan } = require("./middleware/auth");

// overrides.users:  { [userId]: { role_id?, grants?, revokes?, active? } }  — fields to pretend changed
// overrides.roles:  { [roleId]: permissions[] }                             — role permission lists to pretend changed
// overrides.deleteRole: roleId that is about to be deleted (its users would have no permissions)
async function managersRemainAfter(client, overrides = {}) {
  const { rows: roles } = await client.query("SELECT id, permissions FROM roles");
  const rolePerms = new Map(roles.map((r) => [r.id, r.permissions]));
  Object.entries(overrides.roles || {}).forEach(([id, perms]) => rolePerms.set(id, perms));
  if (overrides.deleteRole) rolePerms.delete(overrides.deleteRole);

  const { rows: users } = await client.query("SELECT id, role_id, grants, revokes, active FROM users");
  return users.some((u) => {
    const changed = { ...u, ...((overrides.users || {})[u.id] || {}) };
    if (!changed.active) return false;
    const perms = rolePerms.get(changed.role_id) || [];
    return userCan({ grants: changed.grants, revokes: changed.revokes, role_permissions: perms }, "manageUsers");
  });
}

module.exports = { managersRemainAfter };
