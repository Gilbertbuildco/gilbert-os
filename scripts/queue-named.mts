import { pool } from "../lib/db"
const r = await pool.query(
  `select to_char(received_at,'YYYY-MM-DD') d, sender, subject, attachments
     from email_invoice_candidates where status='found'
       and (sender ilike '%screwfix%' or sender ilike '%harlequin%' or sender ilike '%mayflow%'
            or sender ilike '%smith%' or subject ilike '%harlequin%' or subject ilike '%crush%'
            or subject ilike '%kitchen%' or subject ilike '%screwfix%')
     order by received_at desc`)
console.log(`${r.rows.length} matching messages\n`)
for (const x of r.rows) {
  const docs = String(x.attachments ?? "").split("\n").filter(Boolean)
  console.log(`${x.d}  ${String(x.sender).replace(/.*</,"").replace(/>.*/,"").slice(0,34).padEnd(35)} ${String(x.subject).replace(/\s+/g," ").slice(0,58)}`)
  for (const p of docs) console.log(`            ${p.split("/").pop()}`)
}
process.exit(0)
