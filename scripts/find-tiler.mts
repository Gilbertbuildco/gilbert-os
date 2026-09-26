import { pool } from "../lib/db"
console.log("=== anything tiling-related ===")
const t = await pool.query(
  `select to_char(received_at,'YYYY-MM-DD') d, sender, subject, attachments
     from email_invoice_candidates
    where status='found' and received_at > now() - interval '15 months'
      and (subject ilike '%til%' or sender ilike '%til%')
      and sender not ilike '%porcelanosa%'
    order by received_at desc limit 20`)
for (const x of t.rows) {
  const docs=String(x.attachments??"").split("\n").filter(Boolean)
  console.log(`${x.d}  ${String(x.sender).slice(0,44).padEnd(45)} ${String(x.subject).replace(/\s+/g," ").slice(0,48)} ${docs.length?`[${docs.length}]`:""}`)
}
console.log("\n=== individual-domain senders with docs (likely trades) ===")
const p = await pool.query(
  `select sender, count(*) filter (where nullif(attachments,'') is not null) docs,
          max(to_char(received_at,'YYYY-MM-DD')) last
     from email_invoice_candidates
    where status='found' and received_at > now() - interval '15 months'
      and (sender ilike '%gmail.com%' or sender ilike '%icloud.com%' or sender ilike '%btinternet%'
           or sender ilike '%hotmail%' or sender ilike '%live.co.uk%' or sender ilike '%aol%'
           or sender ilike '%yahoo%' or sender ilike '%outlook.com%')
    group by 1 having count(*) filter (where nullif(attachments,'') is not null) > 0
    order by 2 desc limit 30`)
for (const x of p.rows) console.log(`  ${String(x.docs).padStart(3)} docs  last ${x.last}  ${x.sender}`)
process.exit(0)
