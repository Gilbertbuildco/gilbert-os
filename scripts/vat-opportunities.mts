import { xeroGet } from "../lib/xero/client"
import { pool } from "../lib/db"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):String(v??"").slice(0,10)}
const bills:any[]=[]
for(let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const live=bills.filter(b=>!["DELETED","VOIDED"].includes(b.Status))
const xnum=new Set(live.map((b:any)=>String(b.InvoiceNumber??"").toUpperCase().replace(/[^A-Z0-9]/g,"")))

console.log("1) OS invoices carrying VAT with NO Xero bill — unclaimed input tax")
const os=await pool.query(
  `select s.name sup, i.invoice_number num, to_char(i.invoice_date,'YYYY-MM-DD') d, i.vat, i.gross, i.payment_status
     from invoices i join suppliers s on s.id=i.supplier_id
    where i.transaction_type='invoice' and i.vat > 0 order by i.invoice_date desc`)
const gap=os.rows.filter((x:any)=>!xnum.has(String(x.num).toUpperCase().replace(/[^A-Z0-9]/g,"")))
let g=0
for(const x of gap){ g+=Number(x.vat); console.log(`   ${String(x.sup).slice(0,24).padEnd(25)} ${String(x.num).padEnd(13)} ${x.d}  VAT ${Number(x.vat).toFixed(2).padStart(9)}  ${x.payment_status??"null"}`) }
console.log(`   ${gap.length} invoices, unclaimed VAT ${g.toFixed(2)}${gap.length?"":"  — none"}`)

console.log("\n2) Email candidates with documents, arrived in Sept, not yet in the OS")
const q=await pool.query(
  `select to_char(received_at,'MM-DD') d, sender, subject
     from email_invoice_candidates
    where status='found' and received_at >= '2026-09-01'
      and nullif(attachments,'') is not null
      and sender not ilike '%gilbertco%' and sender not ilike '%hannahgilbert%'
    order by received_at desc`)
const nums=new Set((await pool.query(`select upper(replace(invoice_number,' ','')) n from invoices`)).rows.map((r:any)=>String(r.n).replace(/[^A-Z0-9]/g,"")))
let shown=0
for(const r of q.rows){
  const m=String(r.subject).match(/\b(\d{6,11}|INV-?\d{3,5}|EVC-\d{4,6})\b/i)
  if(m && nums.has(m[1].toUpperCase().replace(/[^A-Z0-9]/g,""))) continue
  if(shown++>=18) continue
  console.log(`   ${r.d}  ${String(r.sender).replace(/"/g,"").slice(0,32).padEnd(33)} ${String(r.subject).replace(/\s+/g," ").slice(0,48)}`)
}
console.log(`   ${shown} candidates not obviously matched to a held invoice`)
process.exit(0)
