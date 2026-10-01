/**
 * Mayflower, from the Xero reconcile queue (which the API cannot see - read off
 * the screen). Six unreconciled payments totalling 24,534.10, plus the 2,000
 * already reconciled in July = 26,534.10 received.
 *
 *   invoice 664  9,664.08 = deposit 4,832.50 (Aug) + balance 4,831.58 (21 Sep)  -> PAID
 *   invoice 685 14,316.17 = deposit 7,158.50 (Aug), balance 7,157.67 outstanding
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const NOTE664="Owner-confirmed 2026-10-01: fully paid. Deposit 4,832.50 (Aug, per proforma P554) plus the balance 4,831.58 paid 21 Sep 2026 - that payment is sitting unreconciled in Xero, which is why no payment shows against the bill."
const NOTE685="Owner-confirmed 2026-10-01: deposit 7,158.50 paid (Aug, per proforma P556). Balance 7,157.67 outstanding unless covered by a payment made after 28 Sep - the bank feed has not imported past that date."
const s=await pool.query(`select id from suppliers where lower(name) like '%mayflow%' limit 1`)
if(!EXECUTE){ console.log("dry run"); process.exit(0) }
const a=await pool.query(
  `update invoices set payment_status='paid', paid_date='2026-09-21', amount_paid=gross,
     payment_notes = coalesce(payment_notes||' | ','')||$2
   where supplier_id=$1 and invoice_number='664' returning gross`,[s.rows[0].id,NOTE664])
console.log(`664 -> paid, ${Number(a.rows[0].gross).toFixed(2)}`)
const b=await pool.query(
  `update invoices set payment_status='part_paid', amount_paid=7158.50,
     payment_notes = coalesce(payment_notes||' | ','')||$2
   where supplier_id=$1 and invoice_number='685' returning gross`,[s.rows[0].id,NOTE685])
console.log(`685 -> part_paid 7158.50 of ${Number(b.rows[0].gross).toFixed(2)}, outstanding ${(Number(b.rows[0].gross)-7158.50).toFixed(2)}`)
const t=await pool.query(
  `select sum(gross-coalesce(amount_paid,0))::numeric g, count(*) n from invoices
    where transaction_type='invoice' and coalesce(payment_status,'unpaid')<>'paid'`)
console.log(`\nOS owed now: ${t.rows[0].n} invoices, ${Number(t.rows[0].g).toFixed(2)}`)
process.exit(0)
