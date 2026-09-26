import { pool } from "../lib/db"
import { copyFileSync, existsSync } from "node:fs"
const W = "/private/tmp/claude-501/-Users-tomgilbert-GilbertOS/e8dd9cc9-acd8-4425-b9b3-13e379ac71de/scratchpad/missed"
const r = await pool.query(
  `select subject, attachments from email_invoice_candidates where status='found'
     and nullif(attachments,'') is not null
     and (sender ilike '%screwfix%' or sender ilike '%harlequin%' or sender ilike '%smith%'
          or (sender ilike '%mayflow%' and subject ilike '%664%'))`)
let n=0
for (const x of r.rows)
  for (const p of String(x.attachments).split("\n").filter(Boolean)) {
    const base = p.split("/").pop()!
    if (!/\.(pdf|docx)$/i.test(base) || /image00/i.test(base)) continue
    if (!existsSync(p)) { console.log("missing on disk:", base); continue }
    copyFileSync(p, `${W}/${base}`); n++
  }
console.log(`copied ${n}`)
process.exit(0)
