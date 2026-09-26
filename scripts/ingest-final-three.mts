/**
 * Spire BCS INV-021889 and StairBox 413659. Figures verbatim.
 * Pasquill is NOT ingested: its documents are Pro-Forma Call-off Invoices and
 * say "This is not a VAT Invoice" on their face.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const ROWS = [
  { sup: "spire", num: "INV-021889", date: "2025-09-08", net: 650.00, vat: 130.00, gross: 780.00,
    note: "Building Control Services — initial instalment on registration. Job 15758/2025, demolition of existing agricultural buildings and erection of 3 new dwellings at Higher Farm." },
  { sup: "stairbox", newSup: ["StairBox","hello@stairbox.com","Staircases. Account 267312."] as [string,string,string],
    num: "413659", date: "2026-09-07", net: 12657.19, vat: 2531.44, gross: 15188.63,
    note: "Order 520258 (Final). Staircase plot 3 9,707.11 + plot 1 4,356.43, less manager-agreed discount 1,406.35. Delivery nil." },
]
for (const r of ROWS)
  if (Math.abs(r.net + r.vat - r.gross) > 0.02) { console.log(`REFUSING ${r.num}`); process.exit(1) }
const p = await pool.query(`select id from projects order by id limit 1`)
for (const r of ROWS) {
  let s = await pool.query(`select id, name from suppliers where lower(name) like '%'||$1||'%'`, [r.sup])
  if (!s.rows.length && (r as any).newSup) {
    if (EXECUTE) { s = await pool.query(`insert into suppliers (name, contact, notes) values ($1,$2,$3) returning id, name`, (r as any).newSup)
      console.log(`  created supplier ${(r as any).newSup[0]}`) }
    else { console.log(`  would create ${(r as any).newSup[0]}`); continue }
  }
  if (s.rows.length !== 1) { console.log(`  ${r.num}: supplier match ${s.rows.length}`, s.rows.map((x:any)=>x.name)); continue }
  const supplierId = s.rows[0].id
  const ex = await pool.query(`select id from invoices where supplier_id=$1 and invoice_number=$2`, [supplierId, r.num])
  if (ex.rows.length) { console.log(`  skip ${r.num}`); continue }
  if (!EXECUTE) { console.log(`  would add ${s.rows[0].name} ${r.num} ${r.gross.toFixed(2)}`); continue }
  await pool.query(
    `insert into invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
       net, vat, gross, status, notes, payment_status, needs_review, confidence)
     values ($1,$2,$3,$4,'invoice',$5,$6,$7,'confirmed',$8,'unpaid',false,1) on conflict do nothing`,
    [supplierId, p.rows[0].id, r.num, r.date, r.net, r.vat, r.gross, r.note])
  console.log(`  added ${String(s.rows[0].name).slice(0,22).padEnd(23)} ${r.num.padEnd(12)} ${r.date}  ${r.gross.toFixed(2).padStart(10)}`)
}
console.log("\nNOT ingested:")
console.log("  Pasquill C136135 / C136136 / C136790 — Pro-Forma Call-off Invoices, marked 'This is not a VAT Invoice'")
console.log("  Wessex Internet — home broadband (The Old Granary, account WIS21744/CU225217), not a site cost")
process.exit(0)
