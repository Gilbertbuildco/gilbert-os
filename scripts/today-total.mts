import { pool } from "../lib/db"
const d = await pool.query(`select supplier_id, transaction_type, invoice_number, count(*) n from invoices group by 1,2,3 having count(*)>1`)
console.log(`duplicates: ${d.rows.length === 0 ? "0 rows — clean" : JSON.stringify(d.rows)}`)
const r = await pool.query(
  `select s.name, count(*) n, sum(i.gross)::numeric g from invoices i join suppliers s on s.id=i.supplier_id
    where i.created_at::date = current_date group by 1 order by 3 desc`)
let n=0,g=0
for (const x of r.rows) { n+=Number(x.n); g+=Number(x.g)
  console.log(`  ${String(x.name).slice(0,28).padEnd(29)} ${String(x.n).padStart(3)}  ${Number(x.g).toFixed(2).padStart(10)}`) }
console.log(`  ${"TOTAL TODAY".padEnd(29)} ${String(n).padStart(3)}  ${g.toFixed(2).padStart(10)}`)
process.exit(0)
