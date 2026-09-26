import { pool } from "../lib/db"
const s = await pool.query(`select id, name from suppliers where lower(name) like '%crestmoor%'`)
console.log("suppliers:", s.rows.map((x:any)=>`[${x.id}] ${x.name}`).join(" | "))
const i = await pool.query(
  `select invoice_number, to_char(invoice_date,'YYYY-MM-DD') d, gross, payment_status
     from invoices where supplier_id=$1 order by invoice_date`, [s.rows[0].id])
for (const x of i.rows) console.log(`  ${String(x.invoice_number).padEnd(12)} ${x.d}  ${Number(x.gross).toFixed(2).padStart(9)}  ${x.payment_status ?? "null"}`)
const d = await pool.query(`select supplier_id, transaction_type, invoice_number, count(*) n from invoices group by 1,2,3 having count(*)>1`)
console.log(`duplicates across all invoices: ${d.rows.length === 0 ? "0 — clean" : JSON.stringify(d.rows)}`)
process.exit(0)
