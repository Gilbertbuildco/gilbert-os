import { pool } from "../lib/db"
import { xeroGet } from "../lib/xero/client"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):String(v??"").slice(0,10)}
console.log("=== OS: kitchen suppliers ===")
const os=await pool.query(
  `select s.name sup, i.invoice_number num, to_char(i.invoice_date,'YYYY-MM-DD') d, i.net, i.vat, i.gross, i.payment_status, i.paid_date
     from invoices i join suppliers s on s.id=i.supplier_id
    where lower(s.name) ~ 'mayflower|carrarino|howden' and lower(s.name) !~ 'insurance'
    order by i.invoice_date`)
for(const x of os.rows) console.log(`  ${String(x.sup).slice(0,18).padEnd(19)} ${String(x.num).padEnd(10)} ${x.d}  net ${Number(x.net).toFixed(2).padStart(10)}  VAT ${Number(x.vat).toFixed(2).padStart(9)}  gross ${Number(x.gross).toFixed(2).padStart(10)}  ${x.payment_status??"null"}${x.paid_date?" "+String(x.paid_date).slice(0,10):""}`)
console.log(`  ${os.rows.length} invoices, gross ${os.rows.reduce((a:number,x:any)=>a+Number(x.gross),0).toFixed(2)}, VAT ${os.rows.reduce((a:number,x:any)=>a+Number(x.vat),0).toFixed(2)}`)

console.log("\n=== Xero: payments to kitchen suppliers ===")
const bt=await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000",{headers:{Accept:"application/json"}})
const sp=((await bt.json()).BankTransactions??[]).filter((t:any)=>t.Status==="AUTHORISED"&&t.Type==="SPEND"&&/mayflow|carrarino|howden|kitchen/i.test(String(t.Contact?.Name??"")))
for(const t of sp.sort((a:any,b:any)=>parse(a.Date).localeCompare(parse(b.Date))))
  console.log(`  ${parse(t.Date)}  ${String(t.Contact?.Name).slice(0,24).padEnd(25)} ${String(t.Total).padStart(10)}  VAT ${String(t.TotalTax).padStart(9)}`)
console.log(`  ${sp.length} payments, ${sp.reduce((a:number,t:any)=>a+t.Total,0).toFixed(2)}, VAT claimed on them ${sp.reduce((a:number,t:any)=>a+(t.TotalTax??0),0).toFixed(2)}`)

console.log("\n=== Xero: kitchen bills ===")
const bills:any[]=[]
for(let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
for(const b of bills.filter(b=>!["DELETED","VOIDED"].includes(b.Status)&&/mayflow|carrarino|howden/i.test(String(b.Contact?.Name??""))))
  console.log(`  ${(b.DateString??"").slice(0,10)}  ${String(b.Contact?.Name).slice(0,20).padEnd(21)} ${String(b.InvoiceNumber).padEnd(10)} total ${String(b.Total).padStart(10)}  VAT ${String(b.TotalTax).padStart(9)}  ${b.Status}  due ${b.AmountDue}`)

console.log("\n=== kitchen emails not yet matched to a held invoice ===")
const q=await pool.query(
  `select to_char(received_at,'MM-DD') d, subject,
          coalesce(array_length(string_to_array(nullif(attachments,''), E'\n'),1),0) n
     from email_invoice_candidates
    where (sender ilike '%mayflow%' or sender ilike '%carrarino%' or sender ilike '%howdens%')
      and received_at >= '2026-09-01' order by received_at desc limit 12`)
for(const r of q.rows) console.log(`  ${r.d} ${r.n?`[${r.n}]`:"   "} ${String(r.subject).replace(/\s+/g," ").slice(0,56)}`)
process.exit(0)
