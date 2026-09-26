import { pool } from "../lib/db"
const r = await pool.query(
  `select to_char(received_at,'MM-DD') d, sender, subject, attachments
     from email_invoice_candidates where status = 'found'
    order by received_at desc nulls last`)
console.log(`queue: ${r.rows.length} awaiting review\n`)
const norm = (s: string) => {
  const m = /<([^>]+)>/.exec(s ?? ""); const e = (m ? m[1] : s ?? "").toLowerCase()
  return e.split("@")[1] ?? e
}
const by: Record<string, any[]> = {}
for (const x of r.rows) (by[norm(x.sender)] ??= []).push(x)
const ordered = Object.entries(by).sort((a, b) => b[1].length - a[1].length)
for (const [dom, rows] of ordered) {
  const docs = rows.filter((x) => String(x.attachments ?? "").trim()).length
  console.log(`\n### ${dom}  (${rows.length} msg, ${docs} with docs)`)
  for (const x of rows.slice(0, 6))
    console.log(`  ${x.d}  ${String(x.subject).replace(/\s+/g," ").slice(0, 72)}`)
  if (rows.length > 6) console.log(`  ... and ${rows.length - 6} more`)
}
process.exit(0)
