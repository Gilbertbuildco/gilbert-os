/**
 * Audit every invoice's payment_status against the money Xero actually holds.
 *
 * Runs as part of the daily job. Reports only; it never changes a status,
 * because the evidence is incomplete by design — payments sitting unreconciled
 * in Xero are invisible to this system, so an apparent conflict may simply mean
 * the owner has paid and Xero has not caught up.
 */
import { checkPaymentEvidence } from "../lib/reconciliation/payment-evidence"
import { pool } from "../lib/db"

const { rows } = await pool.query(`
  SELECT i.id, i.supplier_id, i.invoice_number, i.gross, i.payment_status, s.name AS supplier
    FROM invoices i JOIN suppliers s ON s.id = i.supplier_id
   WHERE i.status = 'confirmed' AND i.transaction_type = 'invoice'
   ORDER BY s.name, i.invoice_date`)

const conflicts: string[] = []
const seen = new Set<number>()
for (const r of rows) {
  if (seen.has(r.supplier_id)) continue // one check per supplier — the evidence is supplier-level
  seen.add(r.supplier_id)
  const e = await checkPaymentEvidence(r.supplier_id, r.invoice_number, Number(r.gross), r.payment_status)
  if (e.conflict) conflicts.push(`  ${e.supplier}\n      ${e.reason}`)
}
console.log(`\n--- PAYMENT STATUS vs MONEY IN XERO (${conflicts.length} suppliers worth checking) ---`)
console.log(conflicts.length ? conflicts.join("\n") : "  every supplier's invoice statuses are consistent with the payments Xero holds")
console.log(`\n  ${seen.size} suppliers checked. Reported only — nothing changed.`)
await pool.end()
