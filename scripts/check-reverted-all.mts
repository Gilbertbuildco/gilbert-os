import { pool } from "../lib/db"
const WATCH=["INV-021889","EVC-11597","INV-0547","SM08","413659","78518272","78596849","664","685","INV-1579","42/26"]
const r=await pool.query(
  `select i.invoice_number n, s.name sup, i.payment_status, i.paid_date, i.amount_paid, i.gross,
          position('wner' in coalesce(i.payment_notes,'')) prot
     from invoices i join suppliers s on s.id=i.supplier_id
    where i.invoice_number = any($1) order by s.name`,[WATCH])
for(const x of r.rows)
  console.log(`  ${String(x.sup).slice(0,20).padEnd(21)} ${String(x.n).padEnd(12)} ${String(x.payment_status).padEnd(7)}  paid_date ${String(x.paid_date??"null").slice(0,10).padEnd(10)}  protected=${x.prot>0?"yes":"NO"}`)
const all=await pool.query(
  `select count(*) n, sum(gross)::numeric g from invoices
    where transaction_type='invoice' and coalesce(payment_status,'unpaid')<>'paid'`)
console.log(`\n  OS unpaid now: ${all.rows[0].n} invoices, ${Number(all.rows[0].g).toFixed(2)}`)
const prot=await pool.query(
  `select count(*) n from invoices where payment_status='paid' and coalesce(payment_notes,'') ilike '%owner%'`)
console.log(`  rows protected from the sync by an "owner" note: ${prot.rows[0].n}`)
process.exit(0)
