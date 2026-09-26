import { pool } from "../lib/db"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
const W = "/private/tmp/claude-501/-Users-tomgilbert-GilbertOS/e8dd9cc9-acd8-4425-b9b3-13e379ac71de/scratchpad/backlog"
mkdirSync(W, { recursive: true })
const WANT = /Bradfords Building Supplies Invoice No|TP Invoice \(|Invoice\(s\) \d{9,11}|Invoice INV-05(47|63)|Invoice INV-1639|Invoice SM08/i
const r = await pool.query(`select subject, attachments from email_invoice_candidates where status='found' and nullif(attachments,'') is not null`)
let n = 0, missingFile = 0
for (const x of r.rows) {
  if (!WANT.test(String(x.subject ?? "").replace(/\s+/g, " "))) continue
  for (const p of String(x.attachments).split("\n").filter(Boolean)) {
    const base = p.split("/").pop()!
    if (!/\.(pdf|docx)$/i.test(base)) continue
    if (!existsSync(p)) { missingFile++; continue }
    try { copyFileSync(p, `${W}/${base}`); n++ } catch { missingFile++ }
  }
}
console.log(`copied ${n} documents, ${missingFile} unreadable/missing`)
process.exit(0)
