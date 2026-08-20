import { createHash, timingSafeEqual } from "node:crypto"
import { type NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { reconciliationRuns } from "@/lib/db/schema"
import { syncXeroPayments, type SyncPaymentsResult } from "@/lib/reconciliation/sync-payments"
import { pushInvoicesToXero, type PushBillsResult } from "@/lib/reconciliation/push-bills"
import { buildReconciliationReport, type ReconciliationReport } from "@/lib/reconciliation/report"

/**
 * Daily Xero-half reconciliation, as a Vercel Cron target — runs on schedule
 * whether or not the owner's Mac is awake. This route is XERO + GILBERT OS
 * ONLY: it syncs Xero payment status into OS invoices, pushes outstanding OS
 * invoices to Xero as ACCPAY bills, and builds the read-only three-way
 * reconciliation report. Email harvesting (the other half of the daily job)
 * stays on the Mac's own scheduled task — this route never touches email.
 *
 * All three phases call the SAME lib implementation the CLI scripts use
 * (`lib/reconciliation/*`) — there is exactly one copy of the matching rules,
 * status derivation, and the three anti-double-count guards, never a second
 * copy that could drift.
 *
 * AUTH IS MANDATORY. Gilbert OS has no login layer and this endpoint moves
 * money-adjacent data (Xero payment status, and — unless `?dryRun=1` is
 * given — creates real ACCPAY bills in Xero). Every request must carry
 * `Authorization: Bearer ${CRON_SECRET}`, checked with a timing-safe
 * comparison. If `CRON_SECRET` is unset, or the header is missing or wrong,
 * this returns 401 and does NOTHING ELSE — no Xero call, no DB read, no DB
 * write. Vercel Cron sends exactly this header (see `vercel.json`); nothing
 * else should ever be able to reach this route.
 */

export const maxDuration = 300
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Constant-time string comparison. Both inputs are first hashed to a fixed
 * 32-byte digest so `timingSafeEqual` never sees mismatched buffer lengths
 * (which itself would leak information about the secret's length) — a
 * malformed or empty header is exactly as expensive to reject as a
 * near-miss.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a).digest()
  const bh = createHash("sha256").update(b).digest()
  return timingSafeEqual(ah, bh)
}

function isAuthorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const header = request.headers.get("authorization") ?? ""
  return timingSafeEqualStrings(header, `Bearer ${secret}`)
}

type PhaseOutcome<T> = { ok: true; data: T } | { ok: false; error: string }

async function runPhase<T>(fn: () => Promise<T>): Promise<PhaseOutcome<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) }
  }
}

export async function GET(request: NextRequest) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  // Forces execute:false on every phase — proves the wiring end-to-end
  // without touching a payment_status column or creating a Xero bill.
  const dryRun = searchParams.get("dryRun") === "1"
  const execute = !dryRun

  // Sequential, per-spec order: sync payment status first, then push
  // outstanding bills, then build the read-only report. Each phase is
  // independently caught so a failure in one does not abort the others —
  // e.g. a Xero hiccup during the push must not prevent the report (which
  // reads Xero fresh, and reflects the payment sync that already happened).
  const syncOutcome: PhaseOutcome<SyncPaymentsResult> = await runPhase(() => syncXeroPayments({ execute }))
  const pushOutcome: PhaseOutcome<PushBillsResult> = await runPhase(() => pushInvoicesToXero({ execute }))
  const reportOutcome: PhaseOutcome<ReconciliationReport> = await runPhase(() => buildReconciliationReport())

  const ok = syncOutcome.ok && pushOutcome.ok && reportOutcome.ok
  const errors: string[] = []
  if (!syncOutcome.ok) errors.push(`sync-payments: ${syncOutcome.error}`)
  if (!pushOutcome.ok) errors.push(`push-bills: ${pushOutcome.error}`)
  if (!reportOutcome.ok) errors.push(`report: ${reportOutcome.error}`)

  const paymentsSynced = syncOutcome.ok
    ? (syncOutcome.data.execution ? syncOutcome.data.execution.applied : syncOutcome.data.counts.wouldBeUpdates)
    : null
  const billsCreated = pushOutcome.ok ? pushOutcome.data.created : null
  const paymentsMissingInvoiceCount = reportOutcome.ok ? reportOutcome.data.paymentsMissingInvoice.length : null
  const missingTotal = reportOutcome.ok ? reportOutcome.data.paymentsMissingInvoiceTotal : null

  const summary = {
    mode: execute ? "execute" : "dry_run",
    syncPayments: syncOutcome.ok ? { ok: true, ...syncOutcome.data } : { ok: false, error: syncOutcome.error },
    pushBills: pushOutcome.ok ? { ok: true, ...pushOutcome.data } : { ok: false, error: pushOutcome.error },
    report: reportOutcome.ok ? { ok: true, ...reportOutcome.data } : { ok: false, error: reportOutcome.error },
  }

  // Persist the run so the owner can see history, even in dry-run mode (the
  // row is still true history of "a check ran" — it just records that no
  // writes were made). A failure to persist must not fail the request; the
  // JSON response is already the authoritative answer to the caller.
  let runId: number | null = null
  try {
    const [row] = await db
      .insert(reconciliationRuns)
      .values({
        ok,
        paymentsSynced,
        billsCreated,
        paymentsMissingInvoice: paymentsMissingInvoiceCount,
        missingTotal: missingTotal != null ? String(missingTotal) : null,
        summary,
        error: errors.length ? errors.join(" | ") : null,
      })
      .returning({ id: reconciliationRuns.id })
    runId = row?.id ?? null
  } catch (err) {
    console.error("[cron/reconcile] failed to persist reconciliation_runs row:", (err as Error)?.message ?? err)
  }

  return NextResponse.json(
    {
      ok,
      runId,
      mode: execute ? "execute" : "dry_run",
      ranAt: new Date().toISOString(),
      errors,
      paymentsSynced,
      billsCreated,
      paymentsMissingInvoice: paymentsMissingInvoiceCount,
      missingTotal,
      phases: {
        syncPayments: syncOutcome,
        pushBills: pushOutcome,
        report: reportOutcome,
      },
    },
    { status: ok ? 200 : 207 },
  )
}
