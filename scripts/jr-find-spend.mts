import { xeroGet } from "../lib/xero/client"
const parse = (v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):""}
const g = await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000", { headers: { Accept: "application/json" } })
for (const t of ((await g.json()).BankTransactions ?? [])) {
  if (!/jordan|reeves/i.test(t.Contact?.Name ?? "")) continue
  if ((t.TotalTax ?? 0) === 0) continue
  const d = await xeroGet(`/api.xro/2.0/BankTransactions/${t.BankTransactionID}`, { headers: { Accept: "application/json" } })
  const f = ((await d.json()).BankTransactions ?? [])[0]
  console.log(`${parse(f.Date)}  ${f.Contact?.Name}  total ${f.Total}  VAT ${f.TotalTax}  reconciled=${f.IsReconciled}  lineAmountTypes=${f.LineAmountTypes}`)
  for (const l of f.LineItems ?? []) console.log(`   acct ${l.AccountCode}  ${l.TaxType}  "${l.Description ?? ""}"`)
  console.log(`   bankAccountID ${f.BankAccount?.AccountID}`)
  console.log(`   EDIT: https://go.xero.com/Bank/EditCashReceipt.aspx?invoiceID=${f.BankTransactionID}&accountID=${f.BankAccount?.AccountID}&edit=True&type=INVOICETYPE/CASHPAID`)
}
process.exit(0)
