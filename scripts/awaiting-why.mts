import { xeroGet } from "../lib/xero/client"
import { pool } from "../lib/db"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):""}
// 1. did the two edits land?
console.log("=== the two September Bradfords payments ===")
let stillVat=0
for(const id of ["90df1c04-3270-4824-83bd-8d7839edc415","618f98cd-3be9-44c6-a52f-9d5ea8a41b7d"]){
  const r=await xeroGet(`/api.xro/2.0/BankTransactions/${id}`,{headers:{Accept:"application/json"}})
  const t=((await r.json()).BankTransactions??[])[0]
  stillVat+=t.TotalTax??0
  console.log(`  ${parse(t.Date)}  total ${t.Total}  VAT ${t.TotalTax}  reconciled=${t.IsReconciled}  ${(t.TotalTax??0)===0?"FIXED":"STILL CLAIMING"}`)
}
console.log(`  September reclaim is now ${(14466.09-2090.19+stillVat).toFixed(2)}`)

// 2. why are bills still awaiting?
const bills:any[]=[]
for(let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const aw=bills.filter(b=>b.Status==="AUTHORISED")
const osRows=await pool.query(
  `select upper(replace(i.invoice_number,' ','')) n, i.payment_status, i.gross
     from invoices i where i.transaction_type='invoice'`)
const os=new Map(osRows.rows.map((r:any)=>[String(r.n).replace(/[^A-Z0-9]/g,""), r.payment_status]))
const paid:any[]=[], unpaid:any[]=[], unknown:any[]=[]
for(const b of aw){
  const k=String(b.InvoiceNumber??"").toUpperCase().replace(/[^A-Z0-9]/g,"")
  const st=os.get(k)
  if(st==="paid") paid.push(b); else if(st) unpaid.push(b); else unknown.push(b)
}
const sum=(a:any[])=>a.reduce((s,b)=>s+(b.AmountDue??0),0)
console.log(`\n=== ${aw.length} bills showing AWAITING PAYMENT, ${sum(aw).toFixed(2)} ===`)
console.log(`  the OS says PAID    : ${String(paid.length).padStart(3)} bills  ${sum(paid).toFixed(2).padStart(11)}   <- actually settled, Xero just has no payment linked`)
console.log(`  the OS says UNPAID  : ${String(unpaid.length).padStart(3)} bills  ${sum(unpaid).toFixed(2).padStart(11)}   <- genuinely owed`)
console.log(`  not in the OS       : ${String(unknown.length).padStart(3)} bills  ${sum(unknown).toFixed(2).padStart(11)}`)
const by:Record<string,{n:number;d:number}>={}
for(const b of paid){const k=b.Contact?.Name??"?"; by[k]??={n:0,d:0}; by[k].n++; by[k].d+=b.AmountDue??0}
console.log(`\n  PAID but still showing as owed, by supplier:`)
for(const [k,v] of Object.entries(by).sort((a,b)=>b[1].d-a[1].d))
  console.log(`    ${k.slice(0,26).padEnd(27)} ${String(v.n).padStart(3)}  ${v.d.toFixed(2).padStart(11)}`)
const by2:Record<string,{n:number;d:number}>={}
for(const b of [...unpaid,...unknown]){const k=b.Contact?.Name??"?"; by2[k]??={n:0,d:0}; by2[k].n++; by2[k].d+=b.AmountDue??0}
console.log(`\n  GENUINELY OWED, by supplier:`)
for(const [k,v] of Object.entries(by2).sort((a,b)=>b[1].d-a[1].d).slice(0,12))
  console.log(`    ${k.slice(0,26).padEnd(27)} ${String(v.n).padStart(3)}  ${v.d.toFixed(2).padStart(11)}`)
process.exit(0)
