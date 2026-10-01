import { xeroGet } from "../lib/xero/client"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):String(v??"").slice(0,10)}
const bills:any[]=[]
for(let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const live=bills.filter(b=>!["DELETED","VOIDED","DRAFT"].includes(b.Status))
const dated=(x:any)=>x.DateString?x.DateString.slice(0,10):parse(x.Date)
const cand=live.filter(b=>dated(b)<"2026-09-01" && parse(b.UpdatedDateUTC)>"2026-09-07" && (b.TotalTax??0)>0)
console.log(`${cand.length} candidate late claims — checking CREATED date on each\n`)
let genuine=0, edits=0
for(const b of cand.sort((a,b)=>(b.TotalTax??0)-(a.TotalTax??0))){
  const h=await xeroGet(`/api.xro/2.0/Invoices/${b.InvoiceID}/History`,{headers:{Accept:"application/json"}})
  const recs=h.ok?((await h.json()).HistoryRecords??[]):[]
  const created=recs.find((r:any)=>/created/i.test(r.Changes??""))
  const cd=created?parse(created.DateUTC):"?"
  const isNew=cd>"2026-09-07"
  if(isNew) genuine+=b.TotalTax??0; else edits+=b.TotalTax??0
  console.log(`  ${String(b.InvoiceNumber).padEnd(14)} ${String(b.Contact?.Name).slice(0,22).padEnd(23)} dated ${dated(b)}  created ${cd}  VAT ${String(b.TotalTax).padStart(9)}  ${isNew?"NEW — claimable":"EDIT ONLY — already claimed"}`)
}
console.log(`\n  genuinely new late claims : ${genuine.toFixed(2)}`)
console.log(`  edits to already-claimed  : ${edits.toFixed(2)}  <- must NOT be claimed again`)
process.exit(0)
