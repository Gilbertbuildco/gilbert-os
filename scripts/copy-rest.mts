import { pool } from "../lib/db"
import { copyFileSync, existsSync } from "node:fs"
const W="/private/tmp/claude-501/-Users-tomgilbert-GilbertOS/e8dd9cc9-acd8-4425-b9b3-13e379ac71de/scratchpad/rest"
const r = await pool.query(
  `select to_char(received_at,'YYYY-MM-DD') d, sender, subject, attachments
     from email_invoice_candidates where nullif(attachments,'') is not null
       and ((sender ilike '%spirebcs%' and subject ilike '%Invoice%')
         or (sender ilike '%stairbox%' and subject ilike '%Order Confirmation%')
         or (sender ilike '%pasquill%')
         or (sender ilike '%wessexinternet%' and subject ilike '%invoice%'))`)
let n=0
for (const x of r.rows)
  for (const p of String(x.attachments).split("\n").filter(Boolean)) {
    const b=p.split("/").pop()!
    if (!/\.(pdf|docx)$/i.test(b) || !existsSync(p)) continue
    copyFileSync(p, `${W}/${x.d}_${b}`.replace(/\s+/g,"_")); n++
    console.log(`${x.d}  ${String(x.subject).slice(0,42).padEnd(43)} ${b}`)
  }
console.log(`copied ${n}`)
process.exit(0)
