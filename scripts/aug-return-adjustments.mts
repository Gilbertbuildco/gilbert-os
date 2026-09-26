/** Everything found that belongs on the NEXT (August-onward) VAT return. */
import { pool } from "../lib/db"
const items: [string, number, string][] = [
  ["Bradfords credit note 50884851 (plot 1 windows)", -646.68, "28/08/26 — goods not delivered in full"],
  ["Bradfords credit note 50884868 (plot 3 windows)", -1049.52, "28/08/26 — goods not delivered in full"],
  ["Jordan Reeves SPEND 03/08 coded with VAT", -180.00, "invoice 327 carries zero VAT — payment miscoded"],
]
console.log("ADJUSTMENTS ALREADY IDENTIFIED FOR THE AUGUST RETURN\n")
let t = 0
for (const [k, v, why] of items) { t += v; console.log(`  ${v.toFixed(2).padStart(10)}   ${k}\n${" ".repeat(15)}${why}`) }
console.log(`\n  ${t.toFixed(2).padStart(10)}   net reduction in input VAT`)
const d = await pool.query(`select supplier_id, transaction_type, invoice_number, count(*) n from invoices group by 1,2,3 having count(*)>1`)
console.log(`\nduplicate check: ${d.rows.length === 0 ? "0 rows — clean" : JSON.stringify(d.rows)}`)
const tot = await pool.query(`select count(*) n, sum(gross)::numeric g from invoices where created_at::date = current_date`)
console.log(`ingested today overall: ${tot.rows[0].n} invoices, ${Number(tot.rows[0].g).toFixed(2)} gross`)
process.exit(0)
