import { pool } from "../lib/db"
import { copyFileSync, existsSync } from "node:fs"
const W="/private/tmp/claude-501/-Users-tomgilbert-GilbertOS/e8dd9cc9-acd8-4425-b9b3-13e379ac71de/scratchpad/amex"
const NUMS=["78565469","78566952","78566797","78565522","78596849"]
const r=await pool.query(`select subject, attachments from email_invoice_candidates where nullif(attachments,'') is not null and sender ilike '%bradfords%'`)
const found=new Set<string>()
for(const x of r.rows){
  for(const n of NUMS){
    if(!String(x.subject??"").includes(n)) continue
    for(const p of String(x.attachments).split("\n").filter(Boolean)){
      const b=p.split("/").pop()!
      if(!/\.pdf$/i.test(b)||!existsSync(p)) continue
      if(!b.includes(n)) continue
      copyFileSync(p,`${W}/${b}`.replace(/\s+/g,"_")); found.add(n); console.log(`${n}  ${b}`)
    }
  }
}
console.log(`\nfound documents for ${found.size}/${NUMS.length}: ${[...found].join(", ")}`)
console.log(`no document: ${NUMS.filter(n=>!found.has(n)).join(", ") || "none"}`)
process.exit(0)
