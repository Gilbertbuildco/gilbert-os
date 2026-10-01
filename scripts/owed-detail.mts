import { pool } from "../lib/db"
console.log("=== Bradfords the OS thinks are owed, by month ===")
const b=await pool.query(
  `select to_char(i.invoice_date,'YYYY-MM') m, count(*) n, sum(i.gross)::numeric g,
          string_agg(i.invoice_number, ' ' order by i.invoice_date) nums
     from invoices i join suppliers s on s.id=i.supplier_id
    where lower(s.name) like '%bradford%' and coalesce(i.payment_status,'unpaid')<>'paid'
      and i.transaction_type='invoice'
    group by 1 order by 1`)
for(const x of b.rows){
  console.log(`  ${x.m}  ${String(x.n).padStart(3)} invoices  ${Number(x.g).toFixed(2).padStart(10)}`)
  console.log(`         ${String(x.nums).slice(0,150)}`)
}
console.log("\n=== Mayflower ===")
const m=await pool.query(
  `select i.invoice_number n, to_char(i.invoice_date,'YYYY-MM-DD') d, i.gross, i.payment_status, left(i.payment_notes,80) notes
     from invoices i join suppliers s on s.id=i.supplier_id
    where lower(s.name) like '%mayflow%' order by i.invoice_date`)
for(const x of m.rows) console.log(`  ${String(x.n).padEnd(6)} ${x.d}  ${Number(x.gross).toFixed(2).padStart(10)}  ${x.payment_status}`)
console.log("\n=== most recent Bradfords statement in the mail queue ===")
const s=await pool.query(
  `select to_char(received_at,'YYYY-MM-DD') d, subject, attachments
     from email_invoice_candidates
    where sender ilike '%bradfords%' and (subject ilike '%statement%' or subject ilike '%GIL157%')
    order by received_at desc limit 4`)
for(const x of s.rows){
  console.log(`  ${x.d}  ${String(x.subject).replace(/\s+/g," ").slice(0,52)}`)
  for(const p of String(x.attachments??"").split("\n").filter(Boolean)) console.log(`        ${p.split("/").pop()}`)
}
process.exit(0)
