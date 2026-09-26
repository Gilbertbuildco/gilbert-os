import { pool } from "../lib/db"
for (const pat of ["harlequin","lee richards","morris","city plumb","tom gilbert","b online","sse","wessex"]) {
  const r = await pool.query(
    `select s.name, count(*) n, sum(case when i.vat=0 then 1 else 0 end) zero,
            sum(case when i.vat>0 then 1 else 0 end) withvat, sum(i.gross)::numeric g
       from invoices i join suppliers s on s.id=i.supplier_id
      where lower(s.name) like '%'||$1||'%' and i.transaction_type='invoice' group by 1`, [pat])
  for (const x of r.rows)
    console.log(`${String(x.name).slice(0,26).padEnd(27)} ${String(x.n).padStart(3)} invoices  ${String(x.zero).padStart(3)} zero-VAT  ${String(x.withvat).padStart(3)} with VAT   gross ${Number(x.g).toFixed(2)}`)
  if (!r.rows.length) console.log(`${pat.padEnd(27)} — no invoices held in the OS`)
}
process.exit(0)
