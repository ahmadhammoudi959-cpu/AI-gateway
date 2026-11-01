// Activity feed shown in the dashboard (who changed what, renewals, alerts…).
export async function logEvent(db, { system_id = null, actor = 'system', type, message = '', data = null }) {
  try {
    await db.query(`INSERT INTO events (system_id, actor, type, message, data) VALUES ($1, $2, $3, $4, $5)`, [
      system_id,
      actor,
      type,
      message,
      data == null ? null : JSON.stringify(data),
    ]);
  } catch (e) {
    console.error('[events] failed to log event:', e.message);
  }
}
