import { pool } from "../lib/db"
import { copyFileSync, existsSync } from "node:fs"
const W="/private/tmp/claude-501/-Users-tomgilbert-GilbertOS/e8dd9cc9-acd8-4425-b9b3-13e379ac71de/scratchpad/ec-cm"
const WANT=/INV-1412|INV-1511|INV-1536|INV-1606|INV-1639|EVC-11597|EVC-12150|EVC-12505|EVC-13080|EVC-13606/i
const r = await pool.query(`select subject, attachments from email_invoice_candidates where status='found' and nullif(attachments,'') is not null`)
let n=0
for (const x of r.rows) {
  const m = WANT.exec(String(x.subject ?? ""))
  if (!m) continue
  for (const p of String(x.attachments).split("\n").filter(Boolean)) {
    if (!/\.pdf$/i.test(p) || !existsSync(p)) continue
    copyFileSync(p, `${W}/${m[0].toUpperCase()}.pdf`); n++
  }
}
console.log(`copied ${n}`)
process.exit(0)
