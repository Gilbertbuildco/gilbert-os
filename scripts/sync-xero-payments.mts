/**
 * CLI wrapper around `syncXeroPayments` (lib/reconciliation/sync-payments.ts)
 * — the ONE implementation of Xero-payment-status sync, shared with
 * `app/api/cron/reconcile/route.ts`. This file only formats the result for a
 * terminal; it must not re-derive any matching/status logic itself.
 *
 * Sync Xero's ACCPAY payment status into Gilbert OS `invoices.payment_status`
 * (+ `paid_date`, `payment_notes`). Intended to run DAILY (also now covered
 * by the Vercel cron at /api/cron/reconcile).
 *
 * See lib/reconciliation/sync-payments.ts for full semantics: matching rules,
 * status derivation, protected skips, and the "never fabricate, never guess"
 * guarantees. Nothing about those semantics changed in this refactor.
 *
 * SAFETY
 *   --dry-run is the default (no --execute needed to preview). Only Xero GETs
 *   are made in either mode. Nothing is inserted or deleted, ever — only
 *   payment_status/paid_date/payment_notes on existing rows, per-row
 *   transaction with a re-check immediately before the UPDATE.
 *
 * USAGE
 *   npx tsx --env-file=.env.local --env-file=.env.development.local \
 *     scripts/sync-xero-payments.mts [--execute]
 */

import { paymentChecksum, syncXeroPayments, loadPaymentSnapshot } from "../lib/reconciliation/sync-payments.ts"

const args = process.argv.slice(2)
const EXECUTE = args.includes("--execute")
const DRY_RUN = !EXECUTE

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run with --env-file=.env.development.local (see file header).")
  process.exit(1)
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no DB writes)" : "EXECUTE (will write payment_status/paid_date/payment_notes only)"}`)

  const beforeInvoices = DRY_RUN ? await loadPaymentSnapshot() : null
  const beforeChecksum = beforeInvoices ? paymentChecksum(beforeInvoices) : null
  if (beforeChecksum) console.log(`Payment-columns checksum BEFORE: ${beforeChecksum}\n`)

  const result = await syncXeroPayments({ execute: EXECUTE })

  console.log(`Run date: ${result.runDate}`)
  console.log(`Xero ACCPAY bills fetched: ${result.billsFetched}`)
  console.log(`  by status: ${Object.entries(result.billsByStatus).map(([s, n]) => `${s}=${n}`).join(", ")}\n`)
  console.log(`Gilbert OS invoices (transaction_type='invoice', has invoice_number): ${result.osInvoicesConsidered}\n`)

  console.log("--- WOULD-BE CHANGES ---")
  if (result.changes.length === 0) console.log("  (none)")
  for (const c of result.changes) {
    console.log(
      `  UPDATE  inv #${c.invoiceId} "${c.supplier}" #${c.invoiceNumber}  ` +
        `${c.fromStatus} -> ${c.toStatus}` +
        `${c.paidDate ? ` (paid_date ${c.paidDate})` : ""}` +
        `${c.ownerUpgrade ? "  [owner-protected row, upgraded via PAID+unpaid/unrecorded exception]" : ""}` +
        `  [Xero bill ${c.xeroInvoiceId} status=${c.xeroStatus} due=${c.xeroAmountDue} paid=${c.xeroAmountPaid}]`,
    )
  }

  console.log(`\n--- PROTECTED SKIPS (owner-asserted, not overwritten) — ${result.protectedSkips.length} ---`)
  for (const r of result.protectedSkips) {
    console.log(`  SKIP  inv #${r.invoiceId} "${r.supplier}" #${r.invoiceNumber}  current='${r.currentStatus}' Xero-derived='${r.derivedStatus}'  — ${r.reason}`)
    console.log(`        current payment_notes: ${r.currentPaymentNotes}`)
  }

  console.log(`\n--- NOT ACTIONABLE (Xero status has no payment_status mapping) — ${result.notActionable.length} ---`)
  for (const r of result.notActionable) console.log(`  inv #${r.invoiceId} "${r.supplier}" #${r.invoiceNumber}  Xero status=${r.xeroStatus}`)

  console.log(`\n--- AMBIGUOUS (never guessed) — ${result.ambiguous.length} ---`)
  for (const r of result.ambiguous) console.log(`  ${r.reason}`)

  console.log(`\n--- NO-OP (already agrees) — ${result.noops} ---`)
  console.log(`  informational only, not written: ${result.noopMissingPaidDate} of these are 'paid' with a real Xero paid_date the OS row lacks (status already agrees, so out of scope for this script per spec).`)

  console.log(`\n--- OS invoices with NO Xero counterpart (${result.noXeroCounterpartTotal}, by supplier) ---`)
  for (const { supplier, count } of result.noXeroCounterpart) console.log(`  ${String(count).padStart(4)}  ${supplier}`)

  console.log(`\n--- Xero ACCPAY bills (PAID/AUTHORISED) with NO OS counterpart — candidates for future ingest (${result.xeroNoOsMatch.length}) ---`)
  for (const b of result.xeroNoOsMatch) console.log(`  ${b.status.padEnd(11)} #${b.invoiceNumber.padEnd(16)} "${b.contact}"  total=£${b.total}`)
  if (result.xeroNoSupplierMatchByContact.length) {
    const noSupplierTotal = result.xeroNoSupplierMatchByContact.reduce((a, r) => a + r.count, 0)
    console.log(`  (of which, contact has no OS supplier/alias match at all: ${noSupplierTotal} — new-supplier candidates, listed by contact below)`)
    for (const { contact, count } of result.xeroNoSupplierMatchByContact) console.log(`    ${String(count).padStart(4)}  ${contact}`)
  }

  console.log("\n--- SUMMARY ---")
  console.log(`Xero ACCPAY bills fetched:              ${result.counts.billsFetched}`)
  console.log(`OS invoices considered:                 ${result.counts.osInvoicesConsidered}`)
  console.log(`Would-be updates:                       ${result.counts.wouldBeUpdates}`)
  console.log(`  of which owner-protected upgrades:    ${result.counts.ownerProtectedUpgrades}`)
  console.log(`Protected skips:                        ${result.counts.protectedSkips}`)
  console.log(`No-ops (already agrees):                ${result.counts.noops}`)
  console.log(`Not actionable (unmapped Xero status):  ${result.counts.notActionable}`)
  console.log(`Ambiguous (skipped, never guessed):     ${result.counts.ambiguous}`)
  console.log(`OS invoices with no Xero counterpart:   ${result.counts.noXeroCounterpart}`)
  console.log(`Xero PAID/AUTHORISED with no OS match:  ${result.counts.xeroNoOsMatch}`)

  if (DRY_RUN) {
    const afterInvoices = await loadPaymentSnapshot()
    const afterChecksum = paymentChecksum(afterInvoices)
    console.log(`\nPayment-columns checksum AFTER:  ${afterChecksum}`)
    console.log(afterChecksum === beforeChecksum ? "Checksum UNCHANGED — zero writes in this dry run." : "CHECKSUM CHANGED — this should never happen in dry run.")
    console.log("\nDry run only — nothing written. The only network calls made were Xero GETs (paged bill fetch);")
    console.log("xeroGet cannot express a write regardless of flags. Re-run with --execute to apply the updates above.")
    if (afterChecksum !== beforeChecksum) process.exitCode = 1
    return
  }

  console.log("\n--- EXECUTED ---")
  console.log(`Applied: ${result.execution?.applied ?? 0}  Raced/changed-since-plan: ${result.execution?.raced ?? 0}  Errors: ${result.execution?.errored ?? 0}`)
  for (const e of result.execution?.errors ?? []) console.error(`ERROR updating invoice #${e.invoiceId}: ${e.message}`)
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
