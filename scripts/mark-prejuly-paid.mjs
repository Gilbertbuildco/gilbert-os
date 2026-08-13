/**
 * Mark every confirmed invoice dated before 2026-07-01 as paid.
 *
 * Owner instruction (2026-08-13): "any invoice dated before July 1st 2026 can
 * be marked as paid." The status is the owner's assertion of fact; the actual
 * payment DATE of each invoice is unknown, so paid_date stays NULL rather than
 * inventing one (non-negotiable #1). The instruction is recorded in
 * payment_notes for audit.
 *
 * Only touches payment_status / payment_notes, only where payment_status is
 * currently NULL (never overwrites an existing payment state). Insert-free,
 * delete-free, re-runnable.
 *
 *   node --env-file=.env.development.local scripts/mark-prejuly-paid.mjs            # dry run
 *   node --env-file=.env.development.local scripts/mark-prejuly-paid.mjs --execute  # apply
 */

import pg from "pg"

const EXECUTE = process.argv.includes("--execute")
const CUTOFF = "2026-07-01"
const NOTE = "Marked paid in bulk 2026-08-13 per owner instruction: all invoices dated before 2026-07-01 are paid. Actual payment date not recorded."

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env.development.local scripts/mark-prejuly-paid.mjs")
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const money = (v) => "£" + Number(v ?? 0).toFixed(2)

const client = await pool.connect()
try {
  await client.query("BEGIN")

  const { rows: [plan] } = await client.query(
    `SELECT count(*)::int AS n, COALESCE(SUM(gross), 0) AS gross
       FROM invoices
      WHERE status = 'confirmed' AND invoice_date < $1 AND payment_status IS NULL`,
    [CUTOFF],
  )
  const { rows: [skip] } = await client.query(
    `SELECT count(*)::int AS n FROM invoices
      WHERE status = 'confirmed' AND invoice_date < $1 AND payment_status IS NOT NULL`,
    [CUTOFF],
  )

  console.log(`Invoices dated before ${CUTOFF}, currently unrecorded: ${plan.n} (gross ${money(plan.gross)})`)
  console.log(`Already have a payment status (left untouched): ${skip.n}`)

  if (!EXECUTE) {
    await client.query("ROLLBACK")
    console.log("\nDRY RUN — nothing written. Re-run with --execute to apply.")
    process.exit(0)
  }

  const res = await client.query(
    `UPDATE invoices
        SET payment_status = 'paid', payment_notes = $2
      WHERE status = 'confirmed' AND invoice_date < $1 AND payment_status IS NULL`,
    [CUTOFF, NOTE],
  )
  const { rows: [after] } = await client.query(
    `SELECT count(*)::int AS paid, COALESCE(SUM(gross) FILTER (WHERE payment_status = 'paid'), 0) AS paid_gross,
            count(*) FILTER (WHERE payment_status IS NULL)::int AS unrecorded
       FROM invoices WHERE status = 'confirmed'`,
  )

  await client.query("COMMIT")
  console.log(`\nUpdated: ${res.rowCount}`)
  console.log(`Now paid: ${after.paid} (gross ${money(after.paid_gross)}), still unrecorded: ${after.unrecorded}`)
} catch (err) {
  await client.query("ROLLBACK")
  console.error("Rolled back:", err.message)
  process.exit(1)
} finally {
  client.release()
  await pool.end()
}
