import { pool } from "../lib/db"
const ex = await pool.query(`select id, name from suppliers where lower(name) like '%porcel%'`)
let id: number
if (ex.rows.length) { id = ex.rows[0].id; console.log("supplier exists:", ex.rows[0].name, id) }
else {
  const r = await pool.query(
    `insert into suppliers (name, contact, notes) values ($1,$2,$3) returning id`,
    ["Porcelanosa", "accounts.uk@porcelanosa.co.uk",
     "Tiles/bathrooms. Customer no. 2183231, VAT GB668153316. Invoices print European decimals (136,40 = £136.40)."])
  id = r.rows[0].id; console.log("created Porcelanosa, id", id)
}
const p = await pool.query(`select id from projects order by id limit 1`)
const ROWS: [string,string,number,number,number,string][] = [
  ["6626107526","2026-08-28",136.40,27.28,163.68,"Saddle Caliza 45x120(A), 3.240 SQM. Tax base 136,40 / VAT 27,28 / total 163,68 as printed."],
  ["6626108220","2026-09-22",449.75,89.95,539.70,"UK stock transfer, Mediterranea Calpe Warmgrey, Capri Bone 45x120(A). Tax base 449,75 / VAT 89,95 / total 539,70 as printed."],
]
for (const [num,date,net,vat,gross,note] of ROWS) {
  if (Math.abs(net+vat-gross) > 0.005) { console.log("REFUSING", num); continue }
  const e = await pool.query(`select id from invoices where supplier_id=$1 and invoice_number=$2`, [id, num])
  if (e.rows.length) { console.log("  skip", num); continue }
  await pool.query(
    `insert into invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
       net, vat, gross, status, notes, payment_status, needs_review, confidence)
     values ($1,$2,$3,$4,'invoice',$5,$6,$7,'confirmed',$8,'unpaid',false,1) on conflict do nothing`,
    [id, p.rows[0].id, num, date, net, vat, gross, note])
  console.log(`  added ${num}  ${date}  ${gross.toFixed(2)}`)
}
console.log("\nNOTE: invoice 6626900284 (28/08/2026) is a NIL-value replacement for damaged tiles")
console.log("      (Capri Bone, 100% discount, correction order 0015280228) - reported, not ingested.")
process.exit(0)
