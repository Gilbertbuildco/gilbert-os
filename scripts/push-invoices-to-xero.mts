/**
 * CLI wrapper around `pushInvoicesToXero` (lib/reconciliation/push-bills.ts)
 * — the ONE implementation, shared with `app/api/cron/reconcile/route.ts`.
 * This file only formats the result for a terminal; the three
 * anti-double-count guards and all matching logic live in the lib module.
 *
 * Push Gilbert OS invoices into Xero as ACCPAY bills, with their document
 * attached, so a later bank payment can be matched to the bill instead of
 * being coded as unattributed "spend money".
 *
 * Owner instruction 2026-08-20: "find invoices in my emails, add them to the OS
 * and also Xero. When a payment shows in Xero, add the invoice and reconcile."
 *
 * See lib/reconciliation/push-bills.ts for the full safety rationale.
 *
 * Dry run by default; --execute to write. --limit N to cap.
 */
import { pushInvoicesToXero } from "../lib/reconciliation/push-bills.ts"

const EXECUTE = process.argv.includes("--execute")
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) ?? "").split("=")[1]) || undefined
const money = (v: unknown) => "£" + Number(v ?? 0).toFixed(2)

const SKIP_LABEL: Record<string, string> = {
  BILL_EXISTS: "SKIP-BILL-EXISTS",
  ALREADY_PAID_AS_SPEND: "SKIP-ALREADY-PAID-AS-SPEND",
  NO_XERO_CONTACT: "SKIP-NO-XERO-CONTACT",
  NO_ACCOUNT_CODE: "SKIP-NO-ACCOUNT-CODE",
}

async function main() {
  console.log(`Mode: ${EXECUTE ? "EXECUTE" : "DRY RUN"}`)

  const result = await pushInvoicesToXero({ execute: EXECUTE, limit: LIMIT })

  console.log(`Unpaid OS invoices considered: ${result.candidatesConsidered}`)
  for (const s of result.skips) {
    const label = SKIP_LABEL[s.reason] ?? s.reason
    console.log(`  ${label}  ${s.supplier} ${s.invoiceNumber}${s.reason === "ALREADY_PAID_AS_SPEND" ? ` ${money(s.amount)} — creating a bill would double-count` : ""}${s.reason === "NO_XERO_CONTACT" ? " — owner must create the contact in Xero first" : ""}${s.reason === "NO_ACCOUNT_CODE" ? " — no prior Xero coding for this supplier to copy" : ""}`)
  }

  console.log(`\n--- WOULD CREATE ${result.planned.length} BILLS ---`)
  for (const p of result.planned) {
    console.log(
      `  ${p.invoiceDate} ${p.supplier.slice(0, 26).padEnd(27)} ${String(p.invoiceNumber).padEnd(14)} net ${money(p.net)} vat ${money(p.vat)} gross ${money(p.gross)}${p.hasDocument ? " +doc" : " (no document)"} [acct ${p.accountCode}]`,
    )
  }
  console.log(`total: ${money(result.plannedTotal)}`)

  if (!EXECUTE) {
    console.log("\nDRY RUN — nothing written to Xero.")
    process.exit(0)
  }

  for (const c of result.createdBills) {
    console.log(`  CREATED ${c.supplier} ${c.invoiceNumber} -> ${c.xeroInvoiceId}`)
    if (c.attached) console.log(`     +attached document`)
  }
  for (const f of result.failed) console.log(`  FAILED ${f.invoiceNumber} -> ${f.status} ${f.message.slice(0, 160)}`)

  console.log(`\nBills created: ${result.created} | documents attached: ${result.attached}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
