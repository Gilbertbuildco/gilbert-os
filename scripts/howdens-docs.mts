import { pool } from "../lib/db"
const r = await pool.query(
  `select to_char(received_at,'YYYY-MM-DD') d, subject, attachments
     from email_invoice_candidates where sender ilike '%howdens.com%' order by received_at desc`)
for (const x of r.rows) {
  console.log(`${x.d}  ${String(x.subject).replace(/\s+/g," ").slice(0,52)}`)
  for (const p of String(x.attachments ?? "").split("\n").filter(Boolean)) console.log(`        ${p.split("/").pop()}`)
}
process.exit(0)
