/**
 * Plot 2's VAT (£3,264.20 on the £16,321.00 net) settled Friday 4 Sep 2026.
 * Plot 2 is now fully paid at £19,585.20; Plot 3 (£31,485.60 gross) remains.
 *
 * NO VAT CHANGE. The full £8,511.80 on this invoice is already reclaimed, once:
 * £2,720.17 via the coded Amex payment in the June return, and £5,791.63 via the
 * bill in July after the split. This is a cash event only.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const PLOT2_NET = 16321.00, PLOT2_VAT = 3264.20, NEW_PAID = 19585.20
const NOTE = "Plot 2 VAT £3,264.20 paid 2026-09-04, so the Plot 2 Windows line is fully settled at £19,585.20 (net £16,321.00 + VAT). Plot 3 Windows £31,485.60 gross still outstanding. No VAT effect: the invoice's £8,511.80 was already fully reclaimed - £2,720.17 on the June coded payment, £5,791.63 on the bill in July."

const q = await pool.query(
  `select i.id, i.gross, i.vat, i.amount_paid, i.payment_status from invoices i
   join suppliers s on s.id = i.supplier_id
   where lower(s.name) like '%bradford%' and i.invoice_number = '77983461'`)
const r = q.rows[0]
console.log(`before: status ${r.payment_status}  amount_paid ${Number(r.amount_paid).toFixed(2)}  of gross ${Number(r.gross).toFixed(2)}`)
console.log(`plot 2: net ${PLOT2_NET.toFixed(2)} + VAT ${PLOT2_VAT.toFixed(2)} = ${NEW_PAID.toFixed(2)}`)
console.log(`plot 3 outstanding: ${(Number(r.gross) - NEW_PAID).toFixed(2)}`)
if (!EXECUTE) { console.log("\n(dry run)"); process.exit(0) }
const u = await pool.query(
  `update invoices set amount_paid = $2, payment_status = 'part_paid',
     payment_notes = coalesce(payment_notes || ' | ', '') || $3
   where id = $1 returning amount_paid, payment_status`, [r.id, NEW_PAID, NOTE])
console.log(`\nafter:  status ${u.rows[0].payment_status}  amount_paid ${Number(u.rows[0].amount_paid).toFixed(2)}`)
console.log(`outstanding on this invoice: ${(Number(r.gross) - Number(u.rows[0].amount_paid)).toFixed(2)}  (Plot 3 Windows)`)
process.exit(0)
