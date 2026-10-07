// One row in audit_log per thing a person did. The ticket page's timeline is just these rows for
// entity = 'ticket', so every action that changes a ticket's story (create, close, pay, unpay,
// void) must log against the ticket — even when it happened through a remittance.
async function logAudit(client, { userId, action, entity, entityId, details }) {
  await client.query(
    "INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)",
    [userId || null, action, entity, entityId || null, details ? JSON.stringify(details) : null]
  );
}

module.exports = { logAudit };
