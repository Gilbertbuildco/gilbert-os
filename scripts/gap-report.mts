import { pool } from "../lib/db"
for (const p of ["events","crestmoor","hodges","howden","stairbox","leroc","pasquill","marshall","spire","wessex internet","mkm","lazenby"]) {
  const inv = await pool.query(
    `select s.name, count(*) n, max(to_char(i.invoice_date,'YYYY-MM-DD')) latest, sum(i.gross)::numeric g
       from invoices i join suppliers s on s.id=i.supplier_id
      where lower(s.name) like '%'||$1||'%' group by 1`, [p])
  const em = await pool.query(
    `select count(*) n, max(to_char(received_at,'YYYY-MM-DD')) latest
       from email_invoice_candidates
      where status='found' and (sender ilike '%'||$1||'%' or subject ilike '%'||$1||'%')
        and received_at > now() - interval '15 months'`, [p])
  const i = inv.rows[0]
  console.log(`${p.padEnd(16)} OS: ${i ? `${String(i.n).padStart(3)} inv, latest ${i.latest}, ${Number(i.g).toFixed(2).padStart(10)}` : "  NO SUPPLIER            "}   |  emails: ${String(em.rows[0].n).padStart(3)}, latest ${em.rows[0].latest ?? "-"}`)
}
process.exit(0)
