import { pool } from "../lib/db"
import { copyFileSync, existsSync } from "node:fs"
const W="/private/tmp/claude-501/-Users-tomgilbert-GilbertOS/e8dd9cc9-acd8-4425-b9b3-13e379ac71de/scratchpad/new"
const WANT=/INV-1579|Invoice No - 685|787101|787068|1052242465|INV-1654/i
const r=await pool.query(`select subject, attachments from email_invoice_candidates where status='found' and nullif(attachments,'') is not null and received_at > now() - interval '5 days'`)
for(const x of r.rows){
  const m=WANT.exec(String(x.subject??"")); if(!m) continue
  for(const p of String(x.attachments).split("\n").filter(Boolean)){
    const b=p.split("/").pop()!; if(!/\.(pdf|docx)$/i.test(b)||!existsSync(p)) continue
    copyFileSync(p,`${W}/${b}`.replace(/\s+/g,"_")); console.log(`${String(x.subject).slice(0,44).padEnd(45)} ${b}`)
  }
}
process.exit(0)
