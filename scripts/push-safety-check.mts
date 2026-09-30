import { xeroGet } from "../lib/xero/client"
import { pool } from "../lib/db"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):""}
const r2=await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000",{headers:{Accept:"application/json"}})
const spend=((await r2.json()).BankTransactions??[]).filter((t:any)=>t.Status==="AUTHORISED"&&t.Type==="SPEND")
const bills:any[]=[]
for (let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const xnum=new Set(bills.filter(b=>!["DELETED","VOIDED"].includes(b.Status)).map((b:any)=>String(b.InvoiceNumber??"").toUpperCase().replace(/[^A-Z0-9]/g,"")))

const os=await pool.query(
  `select s.name sup, i.invoice_number num, to_char(i.invoice_date,'YYYY-MM-DD') d, i.net, i.vat, i.gross
     from invoices i join suppliers s on s.id=i.supplier_id
    where i.transaction_type='invoice' and coalesce(i.payment_status,'unpaid')<>'paid'
    order by i.invoice_date`)
const missing=os.rows.filter((x:any)=>!xnum.has(String(x.num).toUpperCase().replace(/[^A-Z0-9]/g,"")))
console.log("OS invoice missing from Xero -> is that supplier already paid via coded SPEND?\n")
for(const m of missing){
  const first=String(m.sup).toLowerCase().split(/[ .]/)[0]
  const hits=spend.filter((t:any)=>String(t.Contact?.Name??"").toLowerCase().includes(first))
  const tax=hits.reduce((s:number,t:any)=>s+(t.TotalTax??0),0)
  const exact=hits.find((t:any)=>Math.abs(t.Total-Number(m.gross))<0.02)
  const flag = exact ? "!! EXACT-AMOUNT SPEND EXISTS — pushing would double-count"
            : tax>0 ? `!! supplier has ${hits.length} coded payments carrying ${tax.toFixed(2)} VAT — check`
            : hits.length ? `${hits.length} payments, no VAT on them` : "no payments — safe to push"
  console.log(`  ${String(m.sup).slice(0,24).padEnd(25)} ${String(m.num).padEnd(13)} ${m.d}  ${Number(m.gross).toFixed(2).padStart(9)}  ${flag}`)
  if (exact) console.log(`        matching SPEND: ${parse(exact.Date)}  ${exact.Total}  VAT ${exact.TotalTax}`)
}
process.exit(0)
