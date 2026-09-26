import { pool } from "../lib/db"
const d = await pool.query(
  `select supplier_id, transaction_type, invoice_number, count(*) n from invoices
    group by 1,2,3 having count(*)>1`)
console.log(`duplicate check across ALL invoices: ${d.rows.length === 0 ? "0 rows — clean" : JSON.stringify(d.rows)}`)
const r = await pool.query(
  `select s.name, count(*) n, sum(i.gross)::numeric g, sum(i.vat)::numeric v
     from invoices i join suppliers s on s.id=i.supplier_id
    where i.created_at::date = current_date group by 1 order by 3 desc`)
console.log("\ningested today:")
let n=0,g=0,v=0
for (const x of r.rows) { n+=Number(x.n); g+=Number(x.g); v+=Number(x.v)
  console.log(`  ${String(x.name).slice(0,26).padEnd(27)} ${String(x.n).padStart(3)}  gross ${Number(x.g).toFixed(2).padStart(10)}  VAT ${Number(x.v).toFixed(2).padStart(9)}`) }
console.log(`  ${"TOTAL".padEnd(27)} ${String(n).padStart(3)}  gross ${g.toFixed(2).padStart(10)}  VAT ${v.toFixed(2).padStart(9)}`)
process.exit(0)
