/**
 * JR Carpentry (supplier "Jordan Reeves") 332/333/334. Amounts read verbatim
 * from the QuickBooks emails; no link needed, the total is stated in the body.
 *
 * VAT 0.00 follows the established pattern - 308, 317, 327 and 330 all carry
 * zero VAT in both the OS and Xero. NOTE the 3 Aug SPEND of £1,080.00 that paid
 * invoice 327 is coded with £180.00 VAT, which contradicts that and looks like
 * an over-claim; reported, not altered.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const ROWS: [string,string,number,string][] = [
  ["332","2026-09-05",1997.50,"Half of the second fixes for plots 1 & 2."],
  ["333","2026-09-13",1088.75,"Last week's works; second fixing plot 3 starting."],
  ["334","2026-09-25",2375.00,"Past two weeks' works."],
]
const s = await pool.query(`select id, name from suppliers where lower(name) like '%reeves%' or lower(name) like '%jr%carpen%'`)
if (s.rows.length !== 1) { console.log("ambiguous supplier:", s.rows); process.exit(1) }
const supplierId = s.rows[0].id
console.log(`supplier: ${s.rows[0].name} (${supplierId})`)
const p = await pool.query(`select id from projects order by id limit 1`)
let add=0, skip=0
for (const [num,date,gross,desc] of ROWS) {
  const ex = await pool.query(`select id from invoices where supplier_id=$1 and invoice_number=$2 and transaction_type='invoice'`, [supplierId, num])
  if (ex.rows.length) { skip++; console.log(`  skip ${num}`); continue }
  add++
  if (!EXECUTE) { console.log(`  would add ${num} ${date} ${gross.toFixed(2)}`); continue }
  await pool.query(
    `insert into invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
       net, vat, gross, status, notes, payment_status, needs_review, confidence)
     values ($1,$2,$3,$4,'invoice',$5,0,$5,'confirmed',$6,'unpaid',false,1) on conflict do nothing`,
    [supplierId, p.rows[0].id, num, date, gross,
     `${desc} Amount stated verbatim in the QuickBooks email. Zero VAT, matching invoices 308/317/327/330 in both the OS and Xero.`])
  console.log(`  added ${num}  ${date}  ${gross.toFixed(2)}`)
}
console.log(`\n${EXECUTE ? "added" : "would add"} ${add}, already present ${skip}`)
if (EXECUTE) {
  const t = await pool.query(
    `select count(*) n, sum(gross)::numeric g,
            sum(case when coalesce(payment_status,'unpaid')<>'paid' then gross else 0 end)::numeric owed
       from invoices where supplier_id=$1`, [supplierId])
  console.log(`JR Carpentry total: ${t.rows[0].n} invoices, ${Number(t.rows[0].g).toFixed(2)} gross, ${Number(t.rows[0].owed).toFixed(2)} still owed`)
}
process.exit(0)
