import { pool } from "../lib/db"
const inv = await pool.query(
  `select i.id, i.invoice_number, i.invoice_date, i.net, i.vat, i.gross,
          i.payment_status, i.amount_paid, i.paid_date, i.payment_notes
   from invoices i join suppliers s on s.id = i.supplier_id
   where lower(s.name) like '%bradford%' and i.invoice_number = '77983461'`)
const r = inv.rows[0]
console.log(`77983461  ${String(r.invoice_date).slice(0,15)}`)
console.log(`  net ${Number(r.net).toFixed(2)}  VAT ${Number(r.vat).toFixed(2)}  gross ${Number(r.gross).toFixed(2)}`)
console.log(`  status ${r.payment_status}  amount_paid ${r.amount_paid ?? "null"}  paid_date ${r.paid_date ?? "-"}`)
console.log(`  notes: ${r.payment_notes ?? "-"}`)
const li = await pool.query(
  `select description, quantity, unit_price, line_net, line_vat, line_gross
   from invoice_line_items where invoice_id = $1 order by id`, [r.id])
console.log(`\nline items: ${li.rows.length}`)
for (const l of li.rows)
  console.log(`  ${String(l.description).slice(0,52).padEnd(52)} net ${Number(l.line_net).toFixed(2).padStart(10)}  vat ${Number(l.line_vat ?? 0).toFixed(2).padStart(9)}  gross ${Number(l.line_gross).toFixed(2).padStart(10)}`)
process.exit(0)
