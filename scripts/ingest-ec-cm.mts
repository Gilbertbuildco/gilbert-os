/**
 * Events Crew x5 and Crestmoor x3, read verbatim off the rendered invoices.
 * INV-1412 and INV-1606 are NOT here: 1412's only attachment is a Defects
 * Certificate for "Temple Island - Restoration of River Wall Repairs", a
 * different project entirely, and 1606 was sent as a link with no document.
 * Neither has figures I can read, so neither is invented.
 *
 * INV-1639 states Amount due 4,316.88; its net/VAT are derived at the 20% shown
 * on every line, flagged needs_review.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const EVC: [string,string,number,number,number][] = [
  ["EVC-11597","2025-12-22", 680.00,136.00, 816.00],
  ["EVC-12150","2026-03-10", 300.00, 60.00, 360.00],
  ["EVC-12505","2026-05-23", 300.00, 60.00, 360.00],
  ["EVC-13080","2026-06-29", 240.00, 48.00, 288.00],
  ["EVC-13606","2026-08-26", 300.00, 60.00, 360.00],
]
const CM: [string,string,number,number,number,boolean][] = [
  ["INV-1511","2026-05-08",1048.00,209.60,1257.60,false],
  ["INV-1536","2026-06-03",1183.00,236.60,1419.60,false],
  ["INV-1639","2026-09-14",3597.40,719.48,4316.88,true],
]
for (const [n,,net,vat,g] of [...EVC, ...CM] as any[])
  if (Math.abs(net+vat-g) > 0.005) { console.log(`REFUSING ${n}`); process.exit(1) }
const p = await pool.query(`select id from projects order by id limit 1`)
const ec = await pool.query(`select id from suppliers where lower(name) like '%events crew%'`)
const cm = await pool.query(`select id from suppliers where lower(name) like '%crestmoor construction%'`)
console.log(`Events Crew supplier ${ec.rows[0].id}   Crestmoor Construction supplier ${cm.rows[0].id}`)
let add=0
for (const [rows, supplierId, note] of [
  [EVC, ec.rows[0].id, "Portable toilet hire, site. Transcribed verbatim from the emailed invoice."],
  [CM,  cm.rows[0].id, "Plant hire, Higher Farm. Transcribed verbatim from the emailed invoice."]] as any[]) {
  for (const r of rows) {
    const [num,date,net,vat,gross,derived] = r
    const ex = await pool.query(`select id from invoices where supplier_id=$1 and invoice_number=$2 and transaction_type='invoice'`, [supplierId, num])
    if (ex.rows.length) { console.log(`  skip ${num}`); continue }
    add++
    if (!EXECUTE) { console.log(`  would add ${num} ${date} ${gross.toFixed(2)}`); continue }
    await pool.query(
      `insert into invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
         net, vat, gross, status, notes, payment_status, needs_review, confidence)
       values ($1,$2,$3,$4,'invoice',$5,$6,$7,'confirmed',$8,'unpaid',$9,1) on conflict do nothing`,
      [supplierId, p.rows[0].id, num, date, net, vat, gross,
       note + (derived ? " Gross stated on the invoice; net and VAT derived at the 20% shown on every line - confirm." : ""),
       !!derived])
    console.log(`  added ${num.padEnd(12)} ${date}  ${gross.toFixed(2).padStart(9)}`)
  }
}
console.log(`\n${EXECUTE ? "added" : "would add"} ${add}`)
console.log("NOT ingested — no readable document:")
console.log("  INV-1412 (09 Jan 2026) — attachment is a Temple Island defects certificate, wrong project")
console.log("  INV-1606 (17 Aug 2026) — sent as a link, no attachment")
process.exit(0)
