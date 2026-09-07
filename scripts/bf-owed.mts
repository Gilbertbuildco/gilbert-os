import { pool } from "../lib/db"
const r = await pool.query(
  `select coalesce(sum(case when i.transaction_type = 'credit' then i.gross
                           else i.gross - coalesce(i.amount_paid, 0) end), 0)::numeric owed
   from invoices i join suppliers s on s.id = i.supplier_id
   where lower(s.name) like '%bradford%' and coalesce(i.payment_status,'unpaid') <> 'paid'`)
const d = await pool.query(
  `select i.invoice_number, i.invoice_date, i.gross, coalesce(i.amount_paid,0) paid, i.transaction_type
   from invoices i join suppliers s on s.id = i.supplier_id
   where lower(s.name) like '%bradford%' and coalesce(i.payment_status,'unpaid') <> 'paid'
   order by i.invoice_date`)
console.log("STILL OWED TO BRADFORDS")
let t = 0
for (const x of d.rows) {
  const v = x.transaction_type === "credit" ? Number(x.gross) : Number(x.gross) - Number(x.paid)
  t += v
  console.log(`  ${x.invoice_number}  ${String(x.invoice_date).slice(0,15)}  ${v.toFixed(2).padStart(10)}  ${x.transaction_type}`)
}
console.log(`  ${"".padEnd(28)} ${t.toFixed(2).padStart(10)}`)
process.exit(0)
