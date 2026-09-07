import { pool } from "../lib/db"
const sup = await pool.query(`select id from suppliers where lower(name) like '%bradford%'`)
const ids = sup.rows.map((r: any) => r.id)
const open = await pool.query(
  `select invoice_number, invoice_date, gross, payment_status, transaction_type from invoices
   where supplier_id = any($1) and invoice_date < '2026-08-01'
     and coalesce(payment_status,'unpaid') <> 'paid' order by invoice_date`, [ids])
console.log(`pre-1-Aug Bradfords NOT marked paid: ${open.rows.length}`)
let t = 0
for (const r of open.rows) { t += Number(r.gross)
  console.log(`  ${r.invoice_number}  ${String(r.invoice_date).slice(0,15)}  ${Number(r.gross).toFixed(2).padStart(10)}  ${r.payment_status ?? "null"}  ${r.transaction_type}`) }
if (open.rows.length) console.log(`  total ${t.toFixed(2)}`)

const aug = await pool.query(
  `select invoice_number, invoice_date, gross, payment_status from invoices
   where supplier_id = any($1) and invoice_date >= '2026-08-01' order by invoice_date`, [ids])
console.log(`\nBradfords dated 1 Aug or later (should stay unpaid): ${aug.rows.length}`)
for (const r of aug.rows) console.log(`  ${r.invoice_number}  ${String(r.invoice_date).slice(0,15)}  ${Number(r.gross).toFixed(2).padStart(10)}  ${r.payment_status ?? "null"}`)
process.exit(0)
