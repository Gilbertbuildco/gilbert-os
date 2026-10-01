import { xeroGet } from "../lib/xero/client"
import { pool } from "../lib/db"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):String(v??"").slice(0,10)}
const bills:any[]=[]
for(let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const awaiting=bills.filter(b=>b.Status==="AUTHORISED")
const bt=await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000",{headers:{Accept:"application/json"}})
const spend=((await bt.json()).BankTransactions??[]).filter((t:any)=>t.Status==="AUTHORISED"&&t.Type==="SPEND")
const osPaid=new Set((await pool.query(
  `select upper(replace(i.invoice_number,' ','')) n from invoices i
    where i.payment_status='paid' and i.transaction_type='invoice'`)).rows.map((r:any)=>String(r.n).replace(/[^A-Z0-9]/g,"")))

const used=new Set<string>()
const cat={exact:[] as any[], osSaysPaid:[] as any[], openNoEvidence:[] as any[]}
for(const b of awaiting.sort((a,b)=>(b.AmountDue??0)-(a.AmountDue??0))){
  const key=String(b.InvoiceNumber??"").toUpperCase().replace(/[^A-Z0-9]/g,"")
  const sup=String(b.Contact?.Name??"").toLowerCase().split(" ")[0]
  const hit=spend.find((t:any)=>!used.has(t.BankTransactionID)
    && String(t.Contact?.Name??"").toLowerCase().includes(sup)
    && Math.abs(t.Total-(b.AmountDue??0))<0.02)
  if(hit){ used.add(hit.BankTransactionID); cat.exact.push({b,hit}); continue }
  if(osPaid.has(key)){ cat.osSaysPaid.push(b); continue }
  cat.openNoEvidence.push(b)
}
const sum=(a:any[],f:(x:any)=>number)=>a.reduce((s,x)=>s+f(x),0)
console.log(`${awaiting.length} bills AWAITING PAYMENT, ${sum(awaiting,b=>b.AmountDue??0).toFixed(2)}\n`)
console.log(`A) an exact-amount SPEND exists for the same supplier — the cost is ALREADY in Xero twice`)
console.log(`   ${cat.exact.length} bills, ${sum(cat.exact,x=>x.b.AmountDue??0).toFixed(2)}`)
for(const {b,hit} of cat.exact.slice(0,12))
  console.log(`     ${String(b.Contact?.Name).slice(0,22).padEnd(23)} ${String(b.InvoiceNumber).padEnd(13)} ${String(b.AmountDue).padStart(10)}   SPEND ${parse(hit.Date)}`)
console.log(`\nB) the OS says paid but Xero holds no matching payment`)
console.log(`   ${cat.osSaysPaid.length} bills, ${sum(cat.osSaysPaid,b=>b.AmountDue??0).toFixed(2)}`)
const byB:Record<string,{n:number;d:number}>={}
for(const b of cat.osSaysPaid){const k=b.Contact?.Name??"?"; byB[k]??={n:0,d:0}; byB[k].n++; byB[k].d+=b.AmountDue??0}
for(const [k,v] of Object.entries(byB).sort((a,b)=>b[1].d-a[1].d)) console.log(`     ${k.slice(0,26).padEnd(27)} ${String(v.n).padStart(3)}  ${v.d.toFixed(2).padStart(10)}`)
console.log(`\nC) genuinely open — no payment evidence anywhere`)
console.log(`   ${cat.openNoEvidence.length} bills, ${sum(cat.openNoEvidence,b=>b.AmountDue??0).toFixed(2)}`)
const byC:Record<string,{n:number;d:number}>={}
for(const b of cat.openNoEvidence){const k=b.Contact?.Name??"?"; byC[k]??={n:0,d:0}; byC[k].n++; byC[k].d+=b.AmountDue??0}
for(const [k,v] of Object.entries(byC).sort((a,b)=>b[1].d-a[1].d)) console.log(`     ${k.slice(0,26).padEnd(27)} ${String(v.n).padStart(3)}  ${v.d.toFixed(2).padStart(10)}`)
console.log(`\nSPEND transactions with no bill at all: ${spend.filter((t:any)=>!used.has(t.BankTransactionID)).length}`)
process.exit(0)
