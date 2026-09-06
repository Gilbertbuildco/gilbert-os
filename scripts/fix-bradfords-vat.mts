/**
 * Removes the duplicated Bradfords input VAT.
 *
 * Every Bradfords invoice is entered as a bill carrying its own VAT - that is
 * the invoice-level evidence HMRC wants. The Amex payments were ALSO coded to
 * Building Materials at 20%, so the same input tax is claimed twice.
 *
 * Fix: set the tax rate on each coded Amex payment to NONE. Totals are left
 * untouched so the bank reconciliation still balances; only the tax treatment
 * changes. The bills keep claiming the VAT, once.
 *
 * Changes to already-filed periods surface on the next return as late-claim
 * adjustments, which is the HMRC-sanctioned error-correction route while the
 * net is under £10,000 (VAT Notice 700/45).
 *
 * Dry run by default. Pass --execute to write.
 */
import { xeroGet, xeroFetch } from "../lib/xero/client"

const EXECUTE = process.argv.includes("--execute")
const JULY_ONLY = process.argv.includes("--july-only")
const IDS = [
  ["2026-02-18", "6d94eb62-d613-42bd-ba7a-a01ea131430d"], ["2026-04-07", "77756d60-1700-4c55-96d2-65473b042303"],
  ["2026-05-01", "e038d7ae-721b-4412-9446-39200ef2ca6b"], ["2026-05-22", "38f89a9a-22c0-431c-9413-fdea4a74cf80"],
  ["2026-06-01", "f85f3d2c-dfb6-466a-bea7-9751b359b803"], ["2026-06-02", "840f298e-d4e0-4187-82c9-35a1004be280"],
  ["2026-07-01", "5185646a-9ac0-4a0d-8d20-8ed1c1363b39"], ["2026-07-01", "ca257fdf-69f4-4b65-b54d-136efa1331ae"],
  ["2026-07-24", "7287e78a-10e5-48e9-b09a-14d085994b21"], ["2026-07-30", "1efff7cb-662c-42bf-bc9b-fa4ef8d5ba79"],
]
const targets = JULY_ONLY ? IDS.filter(([d]) => d >= "2026-07-01") : IDS

console.log(EXECUTE ? "*** EXECUTING ***" : "DRY RUN - nothing will be written")
console.log(`scope: ${JULY_ONLY ? "July only (unfiled period)" : "all ten payments"}\n`)

let vatRemoved = 0, filedVat = 0
for (const [, id] of targets) {
  const g = await xeroGet(`/api.xro/2.0/BankTransactions/${id}`, { headers: { Accept: "application/json" } })
  const tx = ((await g.json()).BankTransactions ?? [])[0]
  if (!tx) { console.log(`  ${id} NOT FOUND`); continue }
  const date = tx.DateString?.slice(0, 10) ?? ""
  const before = tx.TotalTax ?? 0
  vatRemoved += before
  if (date < "2026-07-01") filedVat += before
  console.log(`  ${date}  total ${String(tx.Total).padStart(9)}  VAT ${String(before).padStart(8)} -> 0.00   lineAmountTypes=${tx.LineAmountTypes}  reconciled=${tx.IsReconciled}`)
  for (const l of tx.LineItems ?? []) console.log(`        acct ${l.AccountCode}  ${l.TaxType} -> NONE   "${(l.Description ?? "").slice(0, 44)}"`)

  if (!EXECUTE) continue
  const payload = {
    BankTransactionID: tx.BankTransactionID, Type: tx.Type,
    Contact: { ContactID: tx.Contact.ContactID }, BankAccount: { AccountID: tx.BankAccount.AccountID },
    Date: date, LineAmountTypes: "Inclusive",
    LineItems: (tx.LineItems ?? []).map((l: any) => ({
      LineItemID: l.LineItemID, Description: l.Description, Quantity: l.Quantity ?? 1,
      UnitAmount: Number(((l.LineAmount ?? 0) + (l.TaxAmount ?? 0)).toFixed(2)),
      AccountCode: l.AccountCode, TaxType: "NONE",
    })),
  }
  const r = await xeroFetch("/api.xro/2.0/BankTransactions", { method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ BankTransactions: [payload] }) })
  const txt = await r.text()
  if (!r.ok) { console.log(`        !! REFUSED ${r.status}: ${JSON.stringify(JSON.parse(txt).Elements?.[0]?.ValidationErrors ?? JSON.parse(txt).Elements?.[0] ?? txt)}`); continue }
  const now = JSON.parse(txt).BankTransactions?.[0]
  console.log(`        OK -> total ${now?.Total}  VAT ${now?.TotalTax}`)
}
console.log(`\n  VAT removed from the reclaim : ${vatRemoved.toFixed(2)}`)
console.log(`  of which sits in filed periods: ${filedVat.toFixed(2)} (appears as a late-claim adjustment)`)
console.log(`  July 2026 return falls from 40542.63 to ${(40542.63 - vatRemoved).toFixed(2)}`)
process.exit(0)
