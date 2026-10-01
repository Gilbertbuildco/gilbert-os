import { pool } from "../lib/db"
import { copyFileSync, existsSync } from "node:fs"
const W="/private/tmp/claude-501/-Users-tomgilbert-GilbertOS/e8dd9cc9-acd8-4425-b9b3-13e379ac71de/scratchpad/how"
const r=await pool.query(
  `select attachments from email_invoice_candidates
    where sender ilike '%howdens.com%' and nullif(attachments,'') is not null`)
const seen=new Set<string>()
for(const x of r.rows) for(const p of String(x.attachments).split("\n").filter(Boolean)){
  const b=p.split("/").pop()!
  if(!/\.pdf$/i.test(b)||!existsSync(p)||seen.has(b)) continue
  seen.add(b); copyFileSync(p,`${W}/${b}`.replace(/\s+/g,"_")); console.log(b)
}
process.exit(0)
