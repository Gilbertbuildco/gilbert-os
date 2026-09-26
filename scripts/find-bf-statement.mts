import { pool } from "../lib/db"
const r = await pool.query(
  `select to_char(received_at,'YYYY-MM-DD') d, subject, attachments
     from email_invoice_candidates
    where (subject ilike '%statement%' or subject ilike '%GIL157%')
      and (sender ilike '%bradfords%')
    order by received_at desc limit 8`)
for (const x of r.rows) {
  console.log(`${x.d}  ${String(x.subject).replace(/\s+/g,' ').slice(0,60)}`)
  for (const p of String(x.attachments ?? "").split("\n").filter(Boolean)) console.log(`      ${p}`)
}
process.exit(0)
