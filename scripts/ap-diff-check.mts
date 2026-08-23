/** Where Xero's payables and the OS disagree, invoice by invoice. Read-only. */
import { xeroGet } from "../lib/xero/client"
import { pool } from "../lib/db"
const m = (n: number) => `£${n.toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`
const j = async (p: string) => (await (await xeroGet(p, { headers: { Accept: "application/json" } })).json()) as any
const bills = ((await j(`/api.xro/2.0/Invoices?where=${encodeURIComponent('Type=="ACCPAY"')}`)).Invoices ?? [])
  .filter((b: any) => !["DELETED","VOIDED"].includes(b.Status))
const xeroDue = new Map<string, number>()
for (const b of bills) if (Number(b.AmountDue) > 0) xeroDue.set(String(b.InvoiceNumber), Number(b.AmountDue))

const { rows } = await pool.query(`
  SELECT i.invoice_number n, s.name sup, i.gross, i.amount_paid, i.payment_status,
         (CASE WHEN i.payment_status='part_paid' AND i.amount_paid IS NOT NULL THEN i.gross-i.amount_paid
               WHEN i.payment_status IN ('unpaid','part_paid') THEN i.gross ELSE 0 END) owed
    FROM invoices i JOIN suppliers s ON s.id=i.supplier_id
   WHERE i.status='confirmed' AND i.transaction_type='invoice'`)
const osOwed = new Map<string, {owed:number,sup:string,status:string}>()
for (const r of rows) osOwed.set(String(r.n), { owed: Number(r.owed), sup: r.sup, status: r.payment_status })

console.log("=== XERO SAYS DUE, OS SAYS PAID (Xero needs the payment recording) ===")
let a=0
for (const [n,due] of xeroDue) { const o=osOwed.get(n); if (o && o.owed===0) { a+=due; console.log(`  ${n.padEnd(12)} ${m(due).padStart(12)}  ${o.sup}`) } }
console.log(`  subtotal ${m(a)}`)
console.log("\n=== BOTH SAY DUE BUT DIFFERENT AMOUNTS ===")
let b2=0
for (const [n,due] of xeroDue) { const o=osOwed.get(n); if (o && o.owed>0 && Math.abs(o.owed-due)>0.005) { b2+=due-o.owed; console.log(`  ${n.padEnd(12)} Xero ${m(due)} vs OS ${m(o.owed)}  (${o.status})  ${o.sup}`) } }
console.log(`  net difference ${m(b2)}`)
console.log("\n=== OS SAYS OWED, NO XERO BILL AT ALL ===")
let c=0
for (const [n,o] of osOwed) { if (o.owed>0 && !xeroDue.has(n)) { c+=o.owed; console.log(`  ${n.padEnd(12)} ${m(o.owed).padStart(12)}  ${o.sup}`) } }
console.log(`  subtotal ${m(c)}`)
await pool.end()
