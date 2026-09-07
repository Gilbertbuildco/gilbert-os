import { pool } from "../lib/db"
const sup = await pool.query(`select id from suppliers where lower(name) like '%bradford%'`)
const ids = sup.rows.map((r: any) => r.id)
const v = await pool.query(
  `select count(*) n, sum(gross)::numeric g from invoices
   where supplier_id = any($1) and paid_date = '2026-09-07'`, [ids])
console.log(`marked paid today: ${v.rows[0].n} invoices, ${Number(v.rows[0].g).toFixed(2)}`)

// 78322984 was already flagged 'paid' with no date - that came from the blanket
// "pre-July Bradfords = paid" rule. Check what else carries that assumption.
const q = await pool.query(
  `select invoice_number, invoice_date, gross, payment_status from invoices
   where supplier_id = any($1) and payment_status = 'paid' and paid_date is null
   order by invoice_date`, [ids])
console.log(`\nBradfords invoices marked paid with NO paid_date (from the pre-July rule): ${q.rows.length}`)
let t = 0
for (const r of q.rows) { t += Number(r.gross); console.log(`  ${r.invoice_number}  ${String(r.invoice_date).slice(0,10)}  ${Number(r.gross).toFixed(2).padStart(10)}`) }
console.log(`  total ${t.toFixed(2)}  <- assumed paid, never confirmed against a payment`)
process.exit(0)
