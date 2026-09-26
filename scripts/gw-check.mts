import { pool } from "../lib/db"
const r = await pool.query(
  `select i.invoice_number, to_char(i.invoice_date,'YYYY-MM-DD') d, i.net, i.vat, i.gross, i.payment_status
     from invoices i join suppliers s on s.id=i.supplier_id
    where lower(s.name) like '%wilson%' or lower(s.name) like '%george%' order by i.invoice_date`)
for (const x of r.rows) console.log(`  ${x.invoice_number}  ${x.d}  net ${x.net}  vat ${x.vat}  gross ${x.gross}  ${x.payment_status}`)
process.exit(0)
