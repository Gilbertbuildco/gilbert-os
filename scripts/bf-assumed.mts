import { pool } from "../lib/db"
const sup = await pool.query(`select id from suppliers where lower(name) like '%bradford%'`)
const ids = sup.rows.map((r: any) => r.id)
const r = await pool.query(
  `select count(*) n, sum(gross)::numeric g, min(invoice_date) lo, max(invoice_date) hi
   from invoices where supplier_id = any($1) and payment_status = 'paid' and paid_date is null`, [ids])
console.log(`assumed paid by the pre-July rule: ${r.rows[0].n} invoices, ${Number(r.rows[0].g).toFixed(2)}`)
console.log(`date range: ${String(r.rows[0].lo).slice(0,15)} .. ${String(r.rows[0].hi).slice(0,15)}`)
const j = await pool.query(
  `select count(*) n, sum(gross)::numeric g from invoices
   where supplier_id = any($1) and payment_status = 'paid' and paid_date is null
     and invoice_date >= '2026-06-01'`, [ids])
console.log(`\nof those, dated June 2026 (the riskiest, closest to the cutoff): ${j.rows[0].n} invoices, ${Number(j.rows[0].g ?? 0).toFixed(2)}`)
process.exit(0)
