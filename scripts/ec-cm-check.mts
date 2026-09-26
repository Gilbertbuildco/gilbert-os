import { pool } from "../lib/db"
for (const pat of ["crestmoor","events"]) {
  console.log(`\n########## ${pat.toUpperCase()}`)
  const s = await pool.query(`select id, name from suppliers where lower(name) like '%'||$1||'%'`, [pat])
  console.log(`suppliers: ${s.rows.length}`)
  for (const x of s.rows) {
    const i = await pool.query(
      `select invoice_number, to_char(invoice_date,'YYYY-MM-DD') d, gross, vat, payment_status
         from invoices where supplier_id=$1 order by invoice_date`, [x.id])
    console.log(`  [${x.id}] ${x.name} — ${i.rows.length} invoices`)
    for (const y of i.rows) console.log(`        ${String(y.invoice_number).padEnd(12)} ${y.d}  ${Number(y.gross).toFixed(2).padStart(9)}  vat ${Number(y.vat).toFixed(2).padStart(7)}  ${y.payment_status}`)
  }
  const e = await pool.query(
    `select to_char(received_at,'YYYY-MM-DD') d, subject,
            coalesce(array_length(string_to_array(nullif(attachments,''), E'\n'),1),0) n
       from email_invoice_candidates
      where (sender ilike '%'||$1||'%' or subject ilike '%'||$1||'%')
        and received_at > now() - interval '15 months'
      order by received_at desc limit 26`, [pat])
  console.log(`  emails (${e.rows.length} shown):`)
  for (const x of e.rows) console.log(`        ${x.d} ${x.n?`[${x.n}]`:"   "} ${String(x.subject).replace(/\s+/g," ").slice(0,62)}`)
}
process.exit(0)
