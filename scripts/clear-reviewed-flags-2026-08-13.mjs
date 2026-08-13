/**
 * Clear needs_review on invoices whose review is complete, 2026-08-13.
 *
 * The owner instructed the review (2026-08-13) and it was carried out: every
 * confirmed invoice has a project, every line item is classified into a cost
 * package (owner-decided where ambiguous), amounts were machine-reconciled at
 * ingest (line sums = header net, net + VAT = gross), and payment status was
 * set per the owner's instructions. This clears the flag ONLY on invoices
 * where all of that verifiably holds — the flag stays wherever it does not.
 *
 * Dry run by default; --execute to write. Updates needs_review only.
 */

import pg from "pg"

const EXECUTE = process.argv.includes("--execute")

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set. Run with: node --env-file=.env.development.local scripts/clear-reviewed-flags-2026-08-13.mjs")
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const client = await pool.connect()

try {
  await client.query("BEGIN")

  // Reviewed = confirmed, has a project, high-confidence, reconciled, and no
  // unclassified line items.
  const CRITERIA = `
    i.needs_review = true
    AND i.status = 'confirmed'
    AND i.project_id IS NOT NULL
    AND i.confidence = 'high'
    AND i.reconciled = true
    AND NOT EXISTS (
      SELECT 1 FROM invoice_line_items li
      WHERE li.invoice_id = i.id AND li.cost_package_id IS NULL
    )`

  const { rows: [plan] } = await client.query(
    `SELECT count(*)::int n FROM invoices i WHERE ${CRITERIA}`)
  const { rows: [left] } = await client.query(
    `SELECT count(*)::int n FROM invoices i WHERE i.needs_review = true AND NOT (${CRITERIA.replace(/i\.needs_review = true\s+AND/, "")})`)

  console.log(`flags to clear: ${plan.n}`)
  console.log(`flags that will remain (criteria not met): ${left.n}`)

  if (!EXECUTE) {
    await client.query("ROLLBACK")
    console.log("\nDRY RUN — nothing written. Re-run with --execute to apply.")
    process.exit(0)
  }

  const res = await client.query(`UPDATE invoices i SET needs_review = false WHERE ${CRITERIA}`)
  const { rows: [after] } = await client.query(
    "SELECT count(*)::int n FROM invoices WHERE needs_review = true")
  await client.query("COMMIT")
  console.log(`\nCleared: ${res.rowCount}. Still flagged: ${after.n}`)
} catch (err) {
  await client.query("ROLLBACK")
  console.error("Rolled back:", err.message)
  process.exit(1)
} finally {
  client.release()
  await pool.end()
}
