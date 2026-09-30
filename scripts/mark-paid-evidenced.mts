/**
 * Five OS invoices sitting as unpaid that Xero shows an exact-amount SPEND for.
 * Each verified individually against the payment list, not by fuzzy match -
 * the same check flagged R. Smith (0 payments) and Mayflower (a different
 * July deposit) as false positives, which are deliberately NOT here.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const ROWS: [string,string,string,number,string][] = [
  ["spire","INV-021889","2025-11-02",780.00,"Xero SPEND 02/11/2025 for 780.00 exactly."],
  ["events","EVC-11597","2026-01-05",816.00,"Xero SPEND 05/01/2026 for 816.00 exactly."],
  ["rhys","INV-0547","2026-08-20",1464.00,"Xero SPEND 20/08/2026 for 1,464.00 exactly. NOTE the payment is coded No VAT while the invoice charges 244.00 - part of the held zero-rating question, not corrected."],
  ["wilson","SM08","2026-09-01",6000.00,"Xero SPEND 01/09/2026 for 6,000.00. Seven monthly 6,000 payments exist against SM02-SM08; six were already marked paid, so this is the seventh."],
  ["stairbox","413659","2026-09-08",15188.63,"Xero SPEND 08/09/2026 for 15,188.63 exactly."],
]
let n=0, total=0
for (const [sup,num,paid,amt,note] of ROWS) {
  const s = await pool.query(`select id, name from suppliers where lower(name) like '%'||$1||'%'`, [sup])
  if (s.rows.length !== 1) { console.log(`  ${num}: supplier match ${s.rows.length} — skipped`); continue }
  const inv = await pool.query(
    `select id, gross, payment_status from invoices where supplier_id=$1 and invoice_number=$2`, [s.rows[0].id, num])
  if (!inv.rows.length) { console.log(`  ${num}: not found`); continue }
  const r = inv.rows[0]
  if (Math.abs(Number(r.gross) - amt) > 0.02) { console.log(`  ${num}: gross ${r.gross} != payment ${amt} — SKIPPED`); continue }
  if (r.payment_status === "paid") { console.log(`  ${num}: already paid`); continue }
  n++; total += amt
  if (!EXECUTE) { console.log(`  would mark ${String(s.rows[0].name).slice(0,22).padEnd(23)} ${num.padEnd(13)} paid ${paid}  ${amt.toFixed(2)}`); continue }
  await pool.query(
    `update invoices set payment_status='paid', paid_date=$2, amount_paid=gross,
       payment_notes = coalesce(payment_notes || ' | ','') || $3 where id=$1`, [r.id, paid, note])
  console.log(`  marked ${String(s.rows[0].name).slice(0,22).padEnd(23)} ${num.padEnd(13)} paid ${paid}  ${amt.toFixed(2).padStart(10)}`)
}
console.log(`\n${EXECUTE?"marked":"would mark"} ${n} paid, ${total.toFixed(2)}`)
process.exit(0)
