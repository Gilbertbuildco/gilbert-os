import { pool } from "../lib/db"
const TARGETS: [string,string,string][] = [
  ["MKM","mkmbs.co.uk","mkm"],
  ["Wessex Internet","wessexinternet.com","wessex internet"],
  ["Spire BCS","spirebcs.co.uk","spire"],
  ["StairBox","stairbox.com","stairbox"],
  ["Leroc","lerocproducts.co","leroc"],
  ["Pasquill","pasquill.co.uk","pasquill"],
]
for (const [label, domain, supPat] of TARGETS) {
  console.log(`\n########## ${label}   (${domain})`)
  const s = await pool.query(`select id, name from suppliers where lower(name) like '%'||$1||'%'`, [supPat])
  if (!s.rows.length) console.log("  OS: NO SUPPLIER")
  for (const x of s.rows) {
    const i = await pool.query(
      `select invoice_number, to_char(invoice_date,'YYYY-MM-DD') d, gross, payment_status
         from invoices where supplier_id=$1 order by invoice_date`, [x.id])
    console.log(`  OS [${x.id}] ${x.name}: ${i.rows.length} invoices, ${i.rows.reduce((a:number,y:any)=>a+Number(y.gross),0).toFixed(2)}`)
    for (const y of i.rows.slice(-4)) console.log(`      ${String(y.invoice_number).padEnd(14)} ${y.d}  ${Number(y.gross).toFixed(2).padStart(9)}  ${y.payment_status ?? "null"}`)
    if (i.rows.length > 4) console.log(`      (${i.rows.length - 4} earlier)`)
  }
  const e = await pool.query(
    `select to_char(received_at,'YYYY-MM-DD') d, subject,
            coalesce(array_length(string_to_array(nullif(attachments,''), E'\n'),1),0) n
       from email_invoice_candidates where sender ilike '%'||$1||'%'
         and received_at > now() - interval '15 months'
       order by received_at desc limit 10`, [domain])
  console.log(`  emails from ${domain}: ${e.rows.length} most recent`)
  for (const x of e.rows) console.log(`      ${x.d} ${x.n?`[${x.n}]`:"   "} ${String(x.subject).replace(/\s+/g," ").slice(0,58)}`)
}
process.exit(0)
