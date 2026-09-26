import { pool } from "../lib/db"
const r = await pool.query(
  `select s.name sup, i.invoice_number num, to_char(i.invoice_date,'DD/MM') d, i.gross, i.vat
     from invoices i join suppliers s on s.id=i.supplier_id
    where i.created_at::date = current_date
    order by s.name, i.invoice_date`)
let cur = ""
for (const x of r.rows) {
  if (x.sup !== cur) { cur = x.sup; console.log(`\n${cur}`) }
  console.log(`  ${x.d}  ${String(x.num).padEnd(12)} ${Number(x.gross).toFixed(2).padStart(9)}  vat ${Number(x.vat).toFixed(2).padStart(8)}`)
}
const t = await pool.query(`select count(*) n, sum(gross)::numeric g from invoices where created_at::date=current_date`)
console.log(`\n${t.rows[0].n} invoices, ${Number(t.rows[0].g).toFixed(2)} gross`)
process.exit(0)
