import { pool } from "../lib/db"
for (const pat of ["harlequin","mayflow","screwfix","smith"]) {
  const r = await pool.query(
    `select s.name, i.invoice_number n, to_char(i.invoice_date,'YYYY-MM-DD') d, i.gross, i.vat, i.payment_status
       from invoices i join suppliers s on s.id=i.supplier_id
      where lower(s.name) like '%'||$1||'%' order by i.invoice_date`, [pat])
  console.log(`\n=== ${pat} — ${r.rows.length} in the OS`)
  for (const x of r.rows) console.log(`  ${String(x.name).slice(0,22).padEnd(23)} ${String(x.n).padEnd(10)} ${x.d}  ${Number(x.gross).toFixed(2).padStart(10)}  vat ${Number(x.vat).toFixed(2).padStart(8)}  ${x.payment_status}`)
  if (!r.rows.length) {
    const s = await pool.query(`select name from suppliers where lower(name) like '%'||$1||'%'`, [pat])
    console.log(`  supplier rows: ${s.rows.length ? s.rows.map((x:any)=>x.name).join(", ") : "NO SUPPLIER"}`)
  }
}
process.exit(0)
