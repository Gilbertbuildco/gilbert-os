import { pool } from "../lib/db"
console.log("=== suppliers matching 'howden' in the OS ===")
const s = await pool.query(`select id, name, contact from suppliers where lower(name) like '%howden%'`)
for (const x of s.rows) {
  console.log(`  [${x.id}] ${x.name}   ${x.contact ?? ""}`)
  const i = await pool.query(
    `select invoice_number, to_char(invoice_date,'YYYY-MM-DD') d, net, vat, gross, payment_status
       from invoices where supplier_id=$1 order by invoice_date`, [x.id])
  for (const y of i.rows) console.log(`        ${String(y.invoice_number).padEnd(14)} ${y.d}  net ${y.net}  vat ${y.vat}  gross ${y.gross}  ${y.payment_status}`)
}
console.log("\n=== emails by sender domain ===")
for (const d of ["howdens.com","howdeninsurance.co.uk"]) {
  const e = await pool.query(
    `select to_char(received_at,'YYYY-MM-DD') dt, sender, subject,
            coalesce(array_length(string_to_array(nullif(attachments,''), E'\n'),1),0) n
       from email_invoice_candidates where sender ilike '%'||$1||'%'
       order by received_at desc limit 14`, [d])
  console.log(`\n--- ${d}: ${e.rows.length} shown`)
  for (const x of e.rows) console.log(`  ${x.dt} ${x.n?`[${x.n}]`:"   "} ${String(x.subject).replace(/\s+/g," ").slice(0,60)}`)
  const rng = await pool.query(
    `select min(to_char(received_at,'YYYY-MM-DD')) lo, max(to_char(received_at,'YYYY-MM-DD')) hi, count(*) n
       from email_invoice_candidates where sender ilike '%'||$1||'%'`, [d])
  console.log(`  range: ${rng.rows[0].lo} .. ${rng.rows[0].hi}  (${rng.rows[0].n} messages)`)
}
process.exit(0)
