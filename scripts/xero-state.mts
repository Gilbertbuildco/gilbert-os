import { xeroGet } from "../lib/xero/client"
import { pool } from "../lib/db"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):""}
const bills:any[]=[]
for (let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const live=bills.filter(b=>!["DELETED","VOIDED","DRAFT"].includes(b.Status))
const awaiting=live.filter(b=>b.Status==="AUTHORISED")
console.log(`Xero bills: ${live.length} live, ${awaiting.length} AWAITING PAYMENT`)
console.log(`  outstanding: ${awaiting.reduce((s,b)=>s+(b.AmountDue??0),0).toFixed(2)}`)
const by:Record<string,{n:number;due:number}>={}
for(const b of awaiting){const k=b.Contact?.Name??"?"; by[k]??={n:0,due:0}; by[k].n++; by[k].due+=b.AmountDue??0}
console.log("\nAWAITING PAYMENT by supplier:")
for(const [k,v] of Object.entries(by).sort((a,b)=>b[1].due-a[1].due))
  console.log(`  ${k.slice(0,32).padEnd(33)} ${String(v.n).padStart(3)}  ${v.due.toFixed(2).padStart(11)}`)

const r2=await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000",{headers:{Accept:"application/json"}})
const bank=((await r2.json()).BankTransactions??[]).filter((t:any)=>t.Status==="AUTHORISED")
const spend=bank.filter((t:any)=>t.Type==="SPEND")
console.log(`\nSPEND transactions: ${spend.length}, total ${spend.reduce((s:number,t:any)=>s+t.Total,0).toFixed(2)}`)
const cn=await xeroGet("/api.xro/2.0/CreditNotes",{headers:{Accept:"application/json"}})
const credits=((await cn.json()).CreditNotes??[]).filter((c:any)=>c.Status!=="DELETED")
console.log(`Credit notes: ${credits.length}, remaining credit ${credits.reduce((s:number,c:any)=>s+(c.RemainingCredit??0),0).toFixed(2)}`)
for(const c of credits) console.log(`  ${c.CreditNoteNumber}  ${parse(c.Date)}  ${c.Contact?.Name}  total ${c.Total}  remaining ${c.RemainingCredit}`)

// OS invoices unpaid that have NO Xero bill — candidates to push
const os=await pool.query(
  `select s.name sup, i.invoice_number num, to_char(i.invoice_date,'YYYY-MM-DD') d, i.gross
     from invoices i join suppliers s on s.id=i.supplier_id
    where i.transaction_type='invoice' and coalesce(i.payment_status,'unpaid')<>'paid'
    order by i.invoice_date desc`)
const xnum=new Set(live.map((b:any)=>String(b.InvoiceNumber??"").toUpperCase().replace(/[^A-Z0-9]/g,"")))
const missing=os.rows.filter((x:any)=>!xnum.has(String(x.num).toUpperCase().replace(/[^A-Z0-9]/g,"")))
console.log(`\nOS unpaid invoices with NO Xero bill: ${missing.length}, ${missing.reduce((s:number,x:any)=>s+Number(x.gross),0).toFixed(2)}`)
const mby:Record<string,{n:number;g:number}>={}
for(const x of missing){mby[x.sup]??={n:0,g:0}; mby[x.sup].n++; mby[x.sup].g+=Number(x.gross)}
for(const [k,v] of Object.entries(mby).sort((a,b)=>b[1].g-a[1].g))
  console.log(`  ${k.slice(0,32).padEnd(33)} ${String(v.n).padStart(3)}  ${v.g.toFixed(2).padStart(11)}`)
process.exit(0)
