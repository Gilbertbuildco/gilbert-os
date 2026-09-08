import { pool } from "../lib/db"
const r = await pool.query(
  `select to_char(received_at,'YYYY-MM-DD') d, sender, subject, attachments
     from email_invoice_candidates
    where sender ilike '%bradfords%' or subject ilike '%GIL157%'
    order by received_at desc nulls last limit 6`)
console.log("Bradfords messages now in the queue:")
for (const x of r.rows) {
  const docs = String(x.attachments ?? "").split("\n").filter(Boolean)
  console.log(`  ${x.d ?? "?"}  ${String(x.subject).slice(0,44).padEnd(45)} ${docs.length} doc(s)`)
  for (const d of docs) console.log(`        ${d.split("/").pop()}`)
}
const c = await pool.query(
  `select count(*) total,
          count(*) filter (where nullif(attachments,'') is not null) with_docs
     from email_invoice_candidates where status = 'found'`)
console.log(`\nqueue: ${c.rows[0].total} awaiting review, ${c.rows[0].with_docs} with documents now attached`)
process.exit(0)
