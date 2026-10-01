import { xeroGet } from "../lib/xero/client"
import { pool } from "../lib/db"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):String(v??"").slice(0,10)}
const bills:any[]=[]
for(let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const live=bills.filter(b=>!["DELETED","VOIDED"].includes(b.Status))
const bt=await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000",{headers:{Accept:"application/json"}})
const spend=((await bt.json()).BankTransactions??[]).filter((t:any)=>t.Status==="AUTHORISED"&&t.Type==="SPEND")
const xnum=new Set(live.map((b:any)=>String(b.InvoiceNumber??"").toUpperCase().replace(/[^A-Z0-9]/g,"")))

const os=await pool.query(
  `select s.name sup, i.invoice_number num, to_char(i.invoice_date,'YYYY-MM-DD') d, i.vat, i.gross
     from invoices i join suppliers s on s.id=i.supplier_id
    where i.transaction_type='invoice' and i.vat > 0`)
const gap=os.rows.filter((x:any)=>!xnum.has(String(x.num).toUpperCase().replace(/[^A-Z0-9]/g,"")))

// classify each gap row
const consolidated = new Set(live.filter((b:any)=>/CONSOL/i.test(String(b.InvoiceNumber??""))).map((b:any)=>b.Contact?.Name))
let claimedElsewhere=0, trulyOpen=0
const open:any[]=[]
for(const x of gap){
  const sup=String(x.sup)
  if(/city plumb/i.test(sup) && consolidated.size){ claimedElsewhere+=Number(x.vat); continue }   // inside CP-JUN2026-CONSOL
  const exact=spend.find((t:any)=>Math.abs(t.Total-Number(x.gross))<0.02 && (t.TotalTax??0)>0)
  if(exact){ claimedElsewhere+=Number(x.vat); continue }                                          // claimed on the coded payment
  if(/bradford/i.test(sup) && x.d < "2026-07-01"){ claimedElsewhere+=Number(x.vat); continue }     // inside the Amex coded payments
  trulyOpen+=Number(x.vat); open.push(x)
}
console.log(`OS invoices with VAT and no Xero bill: ${gap.length}`)
console.log(`  already claimed another way (CP consolidation, coded payment, pre-July Amex): ${claimedElsewhere.toFixed(2)}`)
console.log(`  genuinely unclaimed:                                                          ${trulyOpen.toFixed(2)}\n`)
for(const x of open.sort((a,b)=>Number(b.vat)-Number(a.vat)))
  console.log(`   ${String(x.sup).slice(0,24).padEnd(25)} ${String(x.num).padEnd(13)} ${x.d}  VAT ${Number(x.vat).toFixed(2).padStart(9)}`)
process.exit(0)
