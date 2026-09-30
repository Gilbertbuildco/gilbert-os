import { pool } from "../lib/db"
import { xeroGet } from "../lib/xero/client"
const d=await pool.query(`select supplier_id,transaction_type,invoice_number,count(*) n from invoices group by 1,2,3 having count(*)>1`)
console.log(`duplicates: ${d.rows.length===0?"0 — clean":JSON.stringify(d.rows)}`)
const t=await pool.query(`select count(*) n, sum(gross)::numeric g from invoices where transaction_type='invoice'`)
const u=await pool.query(`select count(*) n, sum(gross-coalesce(amount_paid,0))::numeric g from invoices where transaction_type='invoice' and coalesce(payment_status,'unpaid')<>'paid'`)
console.log(`OS: ${t.rows[0].n} invoices, ${Number(t.rows[0].g).toFixed(2)}  |  unpaid ${u.rows[0].n}, ${Number(u.rows[0].g).toFixed(2)}`)
const bills:any[]=[]
for (let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const live=bills.filter(b=>!["DELETED","VOIDED","DRAFT"].includes(b.Status))
const xnum=new Set(live.map((b:any)=>String(b.InvoiceNumber??"").toUpperCase().replace(/[^A-Z0-9]/g,"")))
const os=await pool.query(`select s.name sup,i.invoice_number num,i.gross from invoices i join suppliers s on s.id=i.supplier_id where i.transaction_type='invoice' and coalesce(i.payment_status,'unpaid')<>'paid'`)
const gap=os.rows.filter((x:any)=>!xnum.has(String(x.num).toUpperCase().replace(/[^A-Z0-9]/g,"")))
console.log(`Xero: ${live.length} live bills  |  OS unpaid with no Xero bill: ${gap.length}, ${gap.reduce((s:number,x:any)=>s+Number(x.gross),0).toFixed(2)}`)
for(const x of gap) console.log(`   ${String(x.sup).slice(0,24).padEnd(25)} ${x.num}  ${Number(x.gross).toFixed(2)}`)
process.exit(0)
