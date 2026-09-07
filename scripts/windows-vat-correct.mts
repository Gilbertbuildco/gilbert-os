/**
 * Correction. Plot 2's VAT of £3,264.20 was discharged on 4 Sep 2026 by
 * £3,062.81 cash plus £201.39 of existing Bradfords credit notes
 * (50864517 £138.71 + 50866214 £62.68), per Bradfords' email of 7 Sep.
 * amount_paid stays £19,585.20 - the full Plot 2 value - and the two credits
 * are marked used so the £201.39 is not counted twice.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const NOTE = "Correction 2026-09-07: the £3,264.20 Plot 2 VAT was settled by £3,062.81 cash plus £201.39 of credit notes 50864517 and 50866214, per Bradfords' email. Plot 2 fully discharged at £19,585.20."

const sup = await pool.query(`select id from suppliers where lower(name) like '%bradford%'`)
const ids = sup.rows.map((r: any) => r.id)
const cr = await pool.query(
  `select id, invoice_number, gross, payment_status from invoices
   where supplier_id = any($1) and invoice_number = any($2)`, [ids, ["50864517", "50866214"]])
console.log("credit notes to mark used:")
for (const c of cr.rows) console.log(`  ${c.invoice_number}  ${Number(c.gross).toFixed(2)}  currently ${c.payment_status ?? "null"}`)
console.log(`  sum ${cr.rows.reduce((s: number, c: any) => s + Math.abs(Number(c.gross)), 0).toFixed(2)}  (email says 201.39)`)
if (!EXECUTE) { console.log("\n(dry run)"); process.exit(0) }

await pool.query(
  `update invoices set payment_status = 'paid', paid_date = '2026-09-04',
     payment_notes = coalesce(payment_notes || ' | ', '') || 'Applied against the Plot 2 VAT payment on 2026-09-04 (part of the £201.39 deducted).'
   where id = any($1)`, [cr.rows.map((c: any) => c.id)])
const u = await pool.query(
  `update invoices set payment_notes = coalesce(payment_notes || ' | ', '') || $1
   where id in (select i.id from invoices i join suppliers s on s.id = i.supplier_id
                where lower(s.name) like '%bradford%' and i.invoice_number = '77983461')
   returning amount_paid`, [NOTE])
console.log(`\ncredits marked used: ${cr.rows.length}`)
console.log(`77983461 amount_paid stays ${Number(u.rows[0].amount_paid).toFixed(2)} (cash 3062.81 + credits 201.39 = VAT 3264.20)`)
process.exit(0)
