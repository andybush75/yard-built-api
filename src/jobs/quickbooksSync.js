// Job: QuickBooks Online transfer — the skeleton.
//
// This is the Yard-Built counterpart of ScrapDragon's QuickBooksOnlineTransfer Hangfire job, built
// so the plumbing (schedule, run log, retry, the "what is waiting" count) exists before the posting
// code does. It never writes to QuickBooks today:
//   - not connected (no QBO_* variables)  → run is marked "skipped" with the pending counts
//   - connected                            → still skipped, with a note that posting isn't implemented
// When the real transfer is written, it goes in postToQuickBooks() below; each ticket/remittance
// that posts cleanly gets synced = true so a re-run never double-posts, and one bad record fails
// that record with its reason instead of aborting the whole batch — the exact behavior the Hangfire
// failures in ScrapDragon make hard to get right after the fact.
const { query } = require("../db");

function qboConfig() {
  const { QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REALM_ID, QBO_REFRESH_TOKEN } = process.env;
  if (!QBO_CLIENT_ID || !QBO_CLIENT_SECRET || !QBO_REALM_ID || !QBO_REFRESH_TOKEN) return null;
  return { clientId: QBO_CLIENT_ID, realmId: QBO_REALM_ID };
}

async function pendingWork() {
  const { rows: [t] } = await query(
    `SELECT count(*)::int AS n, coalesce(sum(total),0)::numeric(14,2) AS total,
            count(*) FILTER (WHERE kind = 'transfer')::int AS transfers
     FROM tickets WHERE NOT synced AND status = 'Closed'`
  );
  const { rows: [r] } = await query(
    `SELECT count(*)::int AS n, coalesce(sum(total),0)::numeric(14,2) AS total
     FROM remittances WHERE NOT voided AND created_at > now() - interval '90 days'`
  );
  const { rows: byYard } = await query(
    `SELECT yard, count(*)::int AS n FROM tickets WHERE NOT synced AND status = 'Closed' GROUP BY yard ORDER BY yard`
  );
  return {
    tickets: { count: t.n, total: Number(t.total), transfers: t.transfers, byYard: Object.fromEntries(byYard.map((y) => [y.yard, y.n])) },
    remittances: { count: r.n, total: Number(r.total), note: "remittances have no synced flag yet — count is the last 90 days" },
  };
}

// eslint-disable-next-line no-unused-vars
async function postToQuickBooks(cfg, pending, ctx) {
  // Next increment: OAuth refresh → for each unsynced Closed ticket post a Bill (buy) / Invoice
  // (sell) or a Journal Entry (kind = 'transfer', Intercompany accounts) → mark synced = true per
  // record → for each remittance post a BillPayment. Anything QuickBooks rejects is recorded on
  // that record and the run finishes with failed > 0 so it shows up on the Jobs screen.
  throw new Error("QuickBooks posting is not implemented yet");
}

module.exports = async function quickbooksSync(ctx) {
  const pending = await pendingWork();
  const cfg = qboConfig();
  if (!cfg) return { skipped: "QuickBooks is not connected (set QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REALM_ID, QBO_REFRESH_TOKEN)", pending };
  if (ctx.sandbox) return { skipped: "Sandbox never posts to QuickBooks", pending };
  return { skipped: `Connected to realm ${cfg.realmId}, but posting isn't built yet — nothing was sent`, pending };
};
