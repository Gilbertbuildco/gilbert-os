/**
 * Mark Hodges, tiler. Invoices are typed into the email body - no attachment,
 * no invoice word in the subject - so neither the attachment rule nor the
 * subject regex in the sweep could see them. Figures verbatim from the emails.
 * No VAT is stated on any of them; recorded as 0 and flagged for confirmation.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const ROWS: [string,string,number,string][] = [
  ["MH-2026-08-21","2026-08-21", 605.00,"Materials: 1 roll floor matting 280, 6 tubes wall adhesive 125, 8 bags flexible floor adhesive 200. Total 605."],
  ["MH-2026-08-28","2026-08-28",1050.00,"Tiling 30 m2 wall and floor at 35/m2 = 1050."],
  ["MH-2026-09-16","2026-09-16",1695.00,"Tiling 37 m2 at 35/m2 = 1295, flexible floor adhesive 250, flexible wall adhesive 150. Sub total 1695."],
]
let s = await pool.query(`select id from suppliers where lower(name) like '%hodges%'`)
if (!s.rows.length) {
  if (!EXECUTE) { console.log("would create supplier Mark Hodges") }
  else { s = await pool.query(`insert into suppliers (name, contact, notes) values ($1,$2,$3) returning id`,
    ["Mark Hodges","markhodgeo67@gmail.com","Tiler. Invoices arrive as plain text in the email body, no attachment. No VAT number given - confirm registration."])
    console.log("created supplier Mark Hodges") }
}
if (!s.rows.length) { console.log("(dry run - stopping)"); process.exit(0) }
const supplierId = s.rows[0].id
const p = await pool.query(`select id from projects order by id limit 1`)
for (const [num,date,gross,note] of ROWS) {
  const ex = await pool.query(`select id from invoices where supplier_id=$1 and invoice_number=$2`, [supplierId, num])
  if (ex.rows.length) { console.log(`  skip ${num}`); continue }
  if (!EXECUTE) { console.log(`  would add ${num} ${gross.toFixed(2)}`); continue }
  await pool.query(
    `insert into invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
       net, vat, gross, status, notes, payment_status, needs_review, confidence)
     values ($1,$2,$3,$4,'invoice',$5,0,$5,'confirmed',$6,'unpaid',true,1) on conflict do nothing`,
    [supplierId, p.rows[0].id, num, date, gross,
     `${note} Transcribed verbatim from the email body; he does not issue a numbered invoice, so the reference is date-derived. No VAT stated - confirm whether he is VAT registered.`])
  console.log(`  added ${num}  ${date}  ${gross.toFixed(2)}`)
}
const t = await pool.query(`select count(*) n, sum(gross)::numeric g from invoices where supplier_id=$1`, [supplierId])
console.log(`\nMark Hodges: ${t.rows[0].n} invoices, ${Number(t.rows[0].g ?? 0).toFixed(2)}`)
process.exit(0)
