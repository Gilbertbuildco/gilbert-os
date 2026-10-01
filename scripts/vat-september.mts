import { xeroGet } from "../lib/xero/client"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):String(v??"").slice(0,10)}
const LO="2026-09-01", HI="2026-09-30"

const bills:any[]=[]
for(let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const live=bills.filter(b=>!["DELETED","VOIDED","DRAFT"].includes(b.Status))

const cn=await xeroGet("/api.xro/2.0/CreditNotes",{headers:{Accept:"application/json"}})
const credits=((await cn.json()).CreditNotes??[]).filter((c:any)=>!["DELETED","VOIDED","DRAFT"].includes(c.Status))

const bt=await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000",{headers:{Accept:"application/json"}})
const bank=((await bt.json()).BankTransactions??[]).filter((t:any)=>t.Status==="AUTHORISED")

const inPeriod=(d:string)=>d>=LO&&d<=HI
const dated=(x:any)=>x.DateString?x.DateString.slice(0,10):parse(x.Date)

// Box 4 — input VAT dated in September
const sepBills=live.filter(b=>inPeriod(dated(b)))
const sepCredits=credits.filter(c=>inPeriod(dated(c)))
const sepSpend=bank.filter((t:any)=>t.Type==="SPEND"&&inPeriod(dated(t)))
const vBills=sepBills.reduce((s,b)=>s+(b.TotalTax??0),0)
const vCredits=sepCredits.reduce((s:number,c:any)=>s+(c.TotalTax??0),0)
const vSpend=sepSpend.reduce((s:number,t:any)=>s+(t.TotalTax??0),0)

console.log(`SEPTEMBER 2026 (${LO} .. ${HI})\n`)
console.log(`  bills dated in Sept        ${String(sepBills.length).padStart(4)}   input VAT ${vBills.toFixed(2).padStart(10)}`)
console.log(`  coded SPEND dated in Sept  ${String(sepSpend.length).padStart(4)}   input VAT ${vSpend.toFixed(2).padStart(10)}`)
console.log(`  credit notes dated in Sept ${String(sepCredits.length).padStart(4)}   input VAT ${(-vCredits).toFixed(2).padStart(10)}`)
console.log(`  ${"".padEnd(30)}             ${"".padEnd(10,"-")}`)
console.log(`  Box 4 from September itself            ${(vBills+vSpend-vCredits).toFixed(2).padStart(10)}`)

// Late claims: anything entered after 7 Sep (when the July return was filed) but dated earlier
const LATE_AFTER="2026-09-07"
const lateBills=live.filter(b=>dated(b)<LO && parse(b.UpdatedDateUTC)>LATE_AFTER)
const lateCredits=credits.filter((c:any)=>dated(c)<LO && parse(c.UpdatedDateUTC)>LATE_AFTER)
const vLate=lateBills.reduce((s,b)=>s+(b.TotalTax??0),0)-lateCredits.reduce((s:number,c:any)=>s+(c.TotalTax??0),0)
console.log(`\n  LATE CLAIMS — dated before Sept, entered since the July return went in:`)
const byS:Record<string,{n:number;v:number}>={}
for(const b of lateBills){const k=b.Contact?.Name??"?"; byS[k]??={n:0,v:0}; byS[k].n++; byS[k].v+=b.TotalTax??0}
for(const c of lateCredits){const k=(c.Contact?.Name??"?")+" (credit)"; byS[k]??={n:0,v:0}; byS[k].n++; byS[k].v-=c.TotalTax??0}
for(const [k,v] of Object.entries(byS).sort((a,b)=>b[1].v-a[1].v))
  console.log(`    ${k.slice(0,30).padEnd(31)} ${String(v.n).padStart(3)}  ${v.v.toFixed(2).padStart(10)}`)
console.log(`    ${"".padEnd(31)} ${"".padEnd(3)}  ${vLate.toFixed(2).padStart(10)}`)
console.log(`\n  ESTIMATED BOX 4 FOR SEPTEMBER           ${(vBills+vSpend-vCredits+vLate).toFixed(2).padStart(10)}`)

// Output VAT — any sales invoices in the period
const sales:any[]=[]
for(let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCREC"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; sales.push(...inv); if(inv.length<100)break}
const sepSales=sales.filter(s=>!["DELETED","VOIDED","DRAFT"].includes(s.Status)&&inPeriod(dated(s)))
const out=sepSales.reduce((s,x)=>s+(x.TotalTax??0),0)
const recv=bank.filter((t:any)=>t.Type==="RECEIVE"&&inPeriod(dated(t))).reduce((s:number,t:any)=>s+(t.TotalTax??0),0)
console.log(`\n  Box 1 output VAT (sales ${sepSales.length} + receipts)   ${(out+recv).toFixed(2).padStart(10)}`)
console.log(`  NET RECLAIM DUE TO YOU                  ${((vBills+vSpend-vCredits+vLate)-(out+recv)).toFixed(2).padStart(10)}`)
process.exit(0)
