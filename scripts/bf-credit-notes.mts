/**
 * Two Bradfords credit notes dated 28/08/26, "Goods Not Received In Full But
 * Invoiced" - 20% of the goods value on the plot 1 and plot 3 window invoices.
 * NOT VAT adjustments: each carries its own 20% VAT, which claws back input tax.
 * Both fall in the August period, so they reduce the NEXT return by £1,696.20 -
 * no filed-period issue.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const CN = [
  { num: "50884851", net: -3233.40, vat: -646.68,  gross: -3880.08, against: "77983446", desc: "Plot 1 Windows goods not received in full but invoiced. Supplier credit 101249-C1 against invoice 77983446." },
  { num: "50884868", net: -5247.60, vat: -1049.52, gross: -6297.12, against: "77983461", desc: "Plot 3 Windows goods not received in full but invoiced. Supplier credit 101249-C2 against invoice 77983461." },
]
const s = await pool.query(`select id from suppliers where lower(name) like '%bradford%' limit 1`)
const supplierId = s.rows[0].id
const p = await pool.query(
  `select i.project_id from invoices i where i.supplier_id = $1 and i.project_id is not null limit 1`, [supplierId])
const projectId = p.rows[0]?.project_id ?? null
console.log(`supplier ${supplierId}  project ${projectId}`)

for (const c of CN) {
  const ex = await pool.query(`select id, gross from invoices where supplier_id = $1 and invoice_number = $2`, [supplierId, c.num])
  console.log(`${c.num}  net ${c.net}  vat ${c.vat}  gross ${c.gross}  vs ${c.against}  ${ex.rows.length ? "ALREADY IN OS" : "new"}`)
}
if (!EXECUTE) { console.log("\n(dry run)"); process.exit(0) }
for (const c of CN) {
  const ex = await pool.query(`select id from invoices where supplier_id = $1 and invoice_number = $2`, [supplierId, c.num])
  if (ex.rows.length) { console.log(`${c.num} already present - skipped`); continue }
  await pool.query(
    `insert into invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
       net, vat, gross, status, notes, payment_status, needs_review, confidence)
     values ($1,$2,$3,'2026-08-28','credit',$4,$5,$6,'confirmed',$7,null,false,1)`,
    [supplierId, projectId, c.num, c.net, c.vat, c.gross, c.desc])
  console.log(`${c.num} inserted`)
}
const t = await pool.query(
  `select sum(gross)::numeric g, sum(vat)::numeric v from invoices
   where supplier_id = $1 and invoice_number = any($2)`, [supplierId, CN.map(c => c.num)])
console.log(`\ncredit notes now in the OS: gross ${Number(t.rows[0].g).toFixed(2)}  VAT ${Number(t.rows[0].v).toFixed(2)}`)
process.exit(0)
