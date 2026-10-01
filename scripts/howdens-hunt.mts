import { pool } from "../lib/db"
const r=await pool.query(
  `select to_char(received_at,'YYYY-MM-DD') d, sender, subject, attachments
     from email_invoice_candidates
    where (sender ilike '%howdens%' or subject ilike '%howden%')
      and sender not ilike '%insurance%'
    order by received_at desc limit 14`)
for(const x of r.rows){
  console.log(`${x.d}  ${String(x.sender).replace(/.*</,"").replace(/>.*/,"").slice(0,30).padEnd(31)} ${String(x.subject).replace(/\s+/g," ").slice(0,48)}`)
  for(const p of String(x.attachments??"").split("\n").filter(Boolean)) console.log(`        ${p.split("/").pop()}`)
}
process.exit(0)
