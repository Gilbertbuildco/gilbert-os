import { pool } from "../lib/db"
import { copyFileSync, existsSync } from "node:fs"
const W="/private/tmp/claude-501/-Users-tomgilbert-GilbertOS/e8dd9cc9-acd8-4425-b9b3-13e379ac71de/scratchpad/chase"
const r=await pool.query(
  `select to_char(received_at,'YYYY-MM-DD') d, subject, attachments from email_invoice_candidates
    where nullif(attachments,'') is not null and received_at > now() - interval '8 months'
      and (subject ~* 'Staircase Delivery|Invoice & statement|^Invoice$|FW: Re: Invoice|Quote BA9')`)
let n=0
for(const x of r.rows) for(const p of String(x.attachments).split("\n").filter(Boolean)){
  const b=p.split("/").pop()!
  if(!/\.pdf$/i.test(b)||!existsSync(p)) continue
  if(/statement/i.test(b)&&!/AHC/i.test(b)) continue
  const dest=`${W}/${x.d}_${b}`.replace(/\s+/g,"_")
  if(existsSync(dest)) continue
  copyFileSync(p,dest); n++; console.log(`${x.d}  ${b}`)
}
console.log(`copied ${n}`)
process.exit(0)
