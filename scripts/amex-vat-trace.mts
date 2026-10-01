import { xeroGet } from "../lib/xero/client"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):String(v??"").slice(0,10)}
const BATCH=["78483398","78481976","78494276","78508226","78513175","78518272","78575574","78565469",
 "78530306","78537916","78537307","78536853","78536200","78547422","78554269","78568125","78566952",
 "78566797","78565522","78596849"]
let gross=0, vat=0
const byMonth:Record<string,{n:number;v:number}>={}
console.log("invoice        dated       gross      VAT    Xero bill created   -> VAT claimed in")
for(const num of BATCH){
  const g=await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="${num}"`,{headers:{Accept:"application/json"}})
  const b=((await g.json()).Invoices??[])[0]
  if(!b){ console.log(`  ${num}  NOT IN XERO`); continue }
  const h=await xeroGet(`/api.xro/2.0/Invoices/${b.InvoiceID}/History`,{headers:{Accept:"application/json"}})
  const recs=h.ok?((await h.json()).HistoryRecords??[]):[]
  const cr=recs.find((r:any)=>/created/i.test(r.Changes??""))
  const cd=cr?parse(cr.DateUTC):"?"
  // a bill dated in month M entered in month M lands in M's return; entered later, it is a late claim then
  const dm=(b.DateString??parse(b.Date)).slice(0,7), cm=cd.slice(0,7)
  const landed = cm>dm ? `${cm} (late claim)` : `${dm}`
  gross+=b.Total??0; vat+=b.TotalTax??0
  byMonth[landed]??={n:0,v:0}; byMonth[landed].n++; byMonth[landed].v+=b.TotalTax??0
  console.log(`  ${num}  ${(b.DateString??"").slice(0,10)}  ${String(b.Total).padStart(9)}  ${String(b.TotalTax).padStart(8)}  ${cd}      ${landed}`)
}
console.log(`\n  batch gross ${gross.toFixed(2)}   VAT in it ${vat.toFixed(2)}   (gross/6 = ${(gross/6).toFixed(2)})`)
console.log("\n  which return each pound of that VAT falls in:")
for(const [k,v] of Object.entries(byMonth).sort())
  console.log(`    ${k.padEnd(22)} ${String(v.n).padStart(3)} invoices   ${v.v.toFixed(2).padStart(9)}`)
process.exit(0)
