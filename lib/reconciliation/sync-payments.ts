import "server-only"
import { createHash } from "node:crypto"
import { pool } from "../db"
import { normaliseDocNumber, normaliseSupplierName } from "../invoice-identity"
import { xeroGet } from "../xero/client"

/**
 * Sync Xero's ACCPAY payment status into Gilbert OS `invoices.payment_status`
 * (+ `paid_date`, `payment_notes`).
 *
 * This is the ONE implementation of that logic — `scripts/sync-xero-payments.mts`
 * (CLI, prints a formatted report) and `app/api/cron/reconcile/route.ts` (daily
 * cron) both call `syncXeroPayments` below rather than each re-deriving the
 * matching/status rules, so the two call sites cannot drift apart.
 *
 * Semantics reproduced verbatim from the original standalone script — see that
 * file's history for the full rationale. Summary:
 *
 * MATCHING (exact only, never fuzzy — lib/invoice-identity.ts)
 *   1. Supplier: Xero `Contact.Name` -> normaliseSupplierName -> exact lookup
 *      against `suppliers.name` (own name, normalised) or a learned
 *      `supplier_aliases.normalised_name`. No new suppliers are ever created.
 *   2. Invoice number: Xero `InvoiceNumber` -> normaliseDocNumber -> exact
 *      match against `invoices.invoice_number` (same normalisation) for that
 *      supplier, `transaction_type = 'invoice'`.
 *   Ambiguous matches (two OS invoices, or two live Xero bills, normalising to
 *   the same key) are left UNRESOLVED and reported, never guessed.
 *
 * STATUS DERIVATION
 *   Xero "PAID"                        -> 'paid', paid_date = FullyPaidOnDate
 *   Xero "AUTHORISED", AmountPaid > 0  -> 'part_paid'
 *   Xero "AUTHORISED", AmountPaid == 0 -> 'unpaid'
 *   Anything else (DRAFT/SUBMITTED/VOIDED/DELETED/...) -> not actionable.
 *
 * PROTECTED SKIPS
 *   A row whose current `payment_notes` contains "owner" (case-insensitive) is
 *   an owner assertion. It is updated ONLY for the PAID+unpaid/unrecorded
 *   upgrade exception (moving towards more certain, better-evidenced data);
 *   every other case is a protected skip, reported, never written.
 *
 * SAFETY
 *   The only network calls, in both modes, are Xero GETs (`xeroGet`, which
 *   cannot express a write). This module inserts nothing and deletes nothing,
 *   ever — it only ever updates `payment_status` / `paid_date` /
 *   `payment_notes` on existing rows, inside a transaction per row with a
 *   re-check of the row's current values immediately before the UPDATE.
 */

// ---------------------------------------------------------------------------
// Xero bill shape (subset actually used)
// ---------------------------------------------------------------------------

type XeroBill = {
  Type: string
  InvoiceID: string
  InvoiceNumber?: string
  Contact: { Name?: string }
  Status: string
  AmountDue: number
  AmountPaid: number
  Total: number
  FullyPaidOnDate?: string
}

/** Xero's `/Date(1763683200000+0000)/` wire format -> "YYYY-MM-DD" (UTC). Returns null rather than guessing on a bad shape. */
function xeroMsDateToIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//)
  if (!m) return null
  const ms = Number(m[1])
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 10)
}

async function fetchAllAccpayBills(): Promise<XeroBill[]> {
  const all: XeroBill[] = []
  for (let page = 1; page <= 200; page++) {
    const res = await xeroGet(`/api.xro/2.0/Invoices?where=${encodeURIComponent('Type=="ACCPAY"')}&page=${page}`)
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Xero Invoices fetch (page ${page}) failed: HTTP ${res.status} ${text.slice(0, 300)}`)
    }
    const body = (await res.json()) as { Invoices?: XeroBill[] }
    const invs = body.Invoices ?? []
    all.push(...invs)
    if (invs.length < 100) break // Xero pages at 100; a short page is the last one.
  }
  return all
}

type DerivedTarget = { status: "paid" | "part_paid" | "unpaid"; paidDate: string | null }

function deriveTarget(bill: XeroBill): DerivedTarget | null {
  if (bill.Status === "PAID") {
    return { status: "paid", paidDate: xeroMsDateToIso(bill.FullyPaidOnDate) }
  }
  if (bill.Status === "AUTHORISED") {
    return bill.AmountPaid > 0 ? { status: "part_paid", paidDate: null } : { status: "unpaid", paidDate: null }
  }
  return null // DRAFT / SUBMITTED / VOIDED / DELETED / anything else: not actionable.
}

type OsInvoice = {
  id: number
  supplierId: number
  supplierName: string
  invoiceNumber: string
  paymentStatus: "unpaid" | "paid" | "part_paid" | null
  paidDate: string | null
  paymentNotes: string | null
}

async function loadOsInvoices(): Promise<OsInvoice[]> {
  const res = await pool.query(`
    SELECT i.id, i.supplier_id, s.name AS supplier_name, i.invoice_number,
           i.payment_status, to_char(i.paid_date, 'YYYY-MM-DD') AS paid_date, i.payment_notes
      FROM invoices i
      JOIN suppliers s ON s.id = i.supplier_id
     WHERE i.transaction_type = 'invoice' AND i.invoice_number IS NOT NULL
     ORDER BY i.id
  `)
  return res.rows.map((r: any) => ({
    id: r.id,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    invoiceNumber: r.invoice_number,
    paymentStatus: r.payment_status,
    paidDate: r.paid_date,
    paymentNotes: r.payment_notes,
  }))
}

/** Rows sorted+hashed so a caller can prove a dry run wrote nothing. Exported for the CLI wrapper's own before/after paranoia check. */
export function paymentChecksum(rows: { id: number; paymentStatus: string | null; paidDate: string | null; paymentNotes: string | null }[]): string {
  const material = rows
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((r) => `${r.id}|${r.paymentStatus ?? ""}|${r.paidDate ?? ""}|${r.paymentNotes ?? ""}`)
    .join("\n")
  return createHash("sha256").update(material).digest("hex")
}

/** Snapshot of every payment-tracking column, for the checksum above. */
export async function loadPaymentSnapshot() {
  return loadOsInvoices()
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type SyncPaymentsChange = {
  invoiceId: number
  supplier: string
  invoiceNumber: string
  fromStatus: string
  toStatus: DerivedTarget["status"]
  paidDate: string | null
  ownerUpgrade: boolean
  xeroInvoiceId: string
  xeroStatus: string
  xeroAmountDue: number
  xeroAmountPaid: number
}

export type SyncPaymentsProtectedSkip = {
  invoiceId: number
  supplier: string
  invoiceNumber: string
  currentStatus: string
  derivedStatus: string
  currentPaymentNotes: string | null
  reason: string
}

export type SyncPaymentsNotActionable = {
  invoiceId: number
  supplier: string
  invoiceNumber: string
  xeroStatus: string
}

export type SyncPaymentsAmbiguous = { reason: string }

export type SyncPaymentsNoCounterpartGroup = { supplier: string; count: number }

export type SyncPaymentsXeroNoOsMatch = { status: string; invoiceNumber: string; contact: string; total: number }

export type SyncPaymentsExecution = {
  applied: number
  raced: number
  errored: number
  errors: { invoiceId: number; message: string }[]
}

export type SyncPaymentsResult = {
  mode: "dry_run" | "execute"
  runDate: string
  billsFetched: number
  billsByStatus: Record<string, number>
  osInvoicesConsidered: number
  changes: SyncPaymentsChange[]
  protectedSkips: SyncPaymentsProtectedSkip[]
  noops: number
  noopMissingPaidDate: number
  notActionable: SyncPaymentsNotActionable[]
  ambiguous: SyncPaymentsAmbiguous[]
  noXeroCounterpart: SyncPaymentsNoCounterpartGroup[]
  noXeroCounterpartTotal: number
  xeroNoOsMatch: SyncPaymentsXeroNoOsMatch[]
  xeroNoSupplierMatchByContact: { contact: string; count: number }[]
  execution: SyncPaymentsExecution | null
  counts: {
    billsFetched: number
    osInvoicesConsidered: number
    wouldBeUpdates: number
    ownerProtectedUpgrades: number
    protectedSkips: number
    noops: number
    notActionable: number
    ambiguous: number
    noXeroCounterpart: number
    xeroNoOsMatch: number
  }
}

type PlanRow =
  | { kind: "UPDATE"; invoice: OsInvoice; bill: XeroBill; target: DerivedTarget; newNotes: string; ownerUpgrade: boolean }
  | { kind: "NOOP"; invoice: OsInvoice; bill: XeroBill; target: DerivedTarget }
  | { kind: "PROTECTED_SKIP"; invoice: OsInvoice; bill: XeroBill; target: DerivedTarget; reason: string }
  | { kind: "NOT_ACTIONABLE"; invoice: OsInvoice; bill: XeroBill; reason: string }
  | { kind: "AMBIGUOUS"; reason: string }

export async function syncXeroPayments({ execute }: { execute: boolean }): Promise<SyncPaymentsResult> {
  const todayIso = new Date().toISOString().slice(0, 10)

  // --- Pull Xero (GET only) ---
  const bills = await fetchAllAccpayBills()
  const billsByStatus: Record<string, number> = {}
  for (const b of bills) billsByStatus[b.Status] = (billsByStatus[b.Status] || 0) + 1

  // --- Load OS invoices + suppliers/aliases for exact-normalised matching ---
  const osInvoices = await loadOsInvoices()

  const suppliersRes = await pool.query("SELECT id, name FROM suppliers ORDER BY id")
  const aliasRes = await pool.query("SELECT supplier_id, normalised_name FROM supplier_aliases")
  const aliasMap = new Map<string, { id: number; name: string }>()
  for (const s of suppliersRes.rows) aliasMap.set(normaliseSupplierName(s.name), { id: s.id, name: s.name })
  for (const a of aliasRes.rows) {
    const supplier = suppliersRes.rows.find((s: any) => s.id === a.supplier_id)
    if (supplier) aliasMap.set(a.normalised_name, { id: supplier.id, name: supplier.name })
  }

  const osByKey = new Map<string, OsInvoice[]>()
  for (const inv of osInvoices) {
    const key = `${inv.supplierId}|${normaliseDocNumber(inv.invoiceNumber)}`
    const arr = osByKey.get(key) ?? []
    arr.push(inv)
    osByKey.set(key, arr)
  }

  const xeroByKey = new Map<string, XeroBill[]>()
  const xeroNoSupplierMatch: XeroBill[] = []
  const xeroNoNumber: XeroBill[] = []
  for (const bill of bills) {
    const contactName = (bill.Contact?.Name ?? "").trim()
    const nContact = normaliseSupplierName(contactName)
    const supplier = nContact ? aliasMap.get(nContact) : undefined
    if (!supplier) {
      xeroNoSupplierMatch.push(bill)
      continue
    }
    if (!bill.InvoiceNumber || !bill.InvoiceNumber.trim()) {
      xeroNoNumber.push(bill)
      continue
    }
    const key = `${supplier.id}|${normaliseDocNumber(bill.InvoiceNumber)}`
    const arr = xeroByKey.get(key) ?? []
    arr.push(bill)
    xeroByKey.set(key, arr)
  }

  const plan: PlanRow[] = []
  const matchedOsIds = new Set<number>()
  const seenAmbiguousOsKeys = new Set<string>()

  for (const inv of osInvoices) {
    const key = `${inv.supplierId}|${normaliseDocNumber(inv.invoiceNumber)}`
    const osGroup = osByKey.get(key)!
    const xeroGroup = xeroByKey.get(key)

    if (osGroup.length > 1) {
      if (!seenAmbiguousOsKeys.has(key)) {
        seenAmbiguousOsKeys.add(key)
        plan.push({
          kind: "AMBIGUOUS",
          reason: `${osGroup.length} OS invoices for supplier #${inv.supplierId} "${inv.supplierName}" normalise to the same invoice number "${normaliseDocNumber(inv.invoiceNumber)}" — cannot safely attribute a Xero match to one of them.`,
        })
      }
      continue
    }

    if (!xeroGroup || xeroGroup.length === 0) continue // handled in the "no Xero counterpart" pass below

    matchedOsIds.add(inv.id)

    const actionableBills = xeroGroup.filter((b) => b.Status === "PAID" || b.Status === "AUTHORISED")
    if (actionableBills.length > 1) {
      plan.push({
        kind: "AMBIGUOUS",
        reason: `${actionableBills.length} live (PAID/AUTHORISED) Xero ACCPAY bills for contact matching supplier #${inv.supplierId} "${inv.supplierName}" normalise to the same invoice number "${normaliseDocNumber(inv.invoiceNumber)}" — cannot safely pick one.`,
      })
      continue
    }

    if (actionableBills.length === 0) {
      const statuses = [...new Set(xeroGroup.map((b) => b.Status))].join(", ")
      plan.push({ kind: "NOT_ACTIONABLE", invoice: inv, bill: xeroGroup[0], reason: `Xero status "${statuses}" has no defined payment_status mapping` })
      continue
    }

    const bill = actionableBills[0]
    const target = deriveTarget(bill)
    if (!target) {
      plan.push({ kind: "NOT_ACTIONABLE", invoice: inv, bill, reason: `Xero status "${bill.Status}" has no defined payment_status mapping` })
      continue
    }

    if (inv.paymentStatus === target.status) {
      plan.push({ kind: "NOOP", invoice: inv, bill, target })
      continue
    }

    const isOwnerNoted = /owner/i.test(inv.paymentNotes ?? "")
    const isUpgradeException = target.status === "paid" && (inv.paymentStatus === "unpaid" || inv.paymentStatus == null)

    if (isOwnerNoted && !isUpgradeException) {
      plan.push({
        kind: "PROTECTED_SKIP",
        invoice: inv,
        bill,
        target,
        reason: `payment_notes contains an owner assertion; current='${inv.paymentStatus ?? "unrecorded"}', Xero-derived='${target.status}' does not qualify for the paid-upgrade exception`,
      })
      continue
    }

    const syncNote = `Synced from Xero ${todayIso}: ${target.status}${target.paidDate ? ` (paid ${target.paidDate})` : ""}.`
    const newNotes = inv.paymentNotes ? `${inv.paymentNotes} | ${syncNote}` : syncNote

    plan.push({ kind: "UPDATE", invoice: inv, bill, target, newNotes, ownerUpgrade: isOwnerNoted && isUpgradeException })
  }

  const noCounterpart = osInvoices.filter(
    (inv) => !matchedOsIds.has(inv.id) && (osByKey.get(`${inv.supplierId}|${normaliseDocNumber(inv.invoiceNumber)}`)?.length ?? 0) === 1,
  )
  const noCounterpartBySupplier = new Map<string, number>()
  for (const inv of noCounterpart) noCounterpartBySupplier.set(inv.supplierName, (noCounterpartBySupplier.get(inv.supplierName) ?? 0) + 1)

  const actionableNoOsMatch: XeroBill[] = []
  for (const [key, group] of xeroByKey) {
    if (osByKey.has(key)) continue
    for (const b of group) {
      if (b.Status === "PAID" || b.Status === "AUTHORISED") actionableNoOsMatch.push(b)
    }
  }
  const xeroNoSupplierMatchByContact = new Map<string, number>()
  for (const b of xeroNoSupplierMatch) {
    if (b.Status === "PAID" || b.Status === "AUTHORISED") {
      const name = b.Contact?.Name ?? "(none)"
      xeroNoSupplierMatchByContact.set(name, (xeroNoSupplierMatchByContact.get(name) ?? 0) + 1)
    }
  }

  const updates = plan.filter((r): r is Extract<PlanRow, { kind: "UPDATE" }> => r.kind === "UPDATE")
  const noops = plan.filter((r): r is Extract<PlanRow, { kind: "NOOP" }> => r.kind === "NOOP")
  const protectedSkips = plan.filter((r): r is Extract<PlanRow, { kind: "PROTECTED_SKIP" }> => r.kind === "PROTECTED_SKIP")
  const notActionable = plan.filter((r): r is Extract<PlanRow, { kind: "NOT_ACTIONABLE" }> => r.kind === "NOT_ACTIONABLE")
  const ambiguous = plan.filter((r): r is Extract<PlanRow, { kind: "AMBIGUOUS" }> => r.kind === "AMBIGUOUS")
  const noopMissingPaidDate = noops.filter((r) => r.target.status === "paid" && r.target.paidDate && !r.invoice.paidDate).length

  const changes: SyncPaymentsChange[] = updates.map((r) => ({
    invoiceId: r.invoice.id,
    supplier: r.invoice.supplierName,
    invoiceNumber: r.invoice.invoiceNumber,
    fromStatus: r.invoice.paymentStatus ?? "unrecorded",
    toStatus: r.target.status,
    paidDate: r.target.paidDate,
    ownerUpgrade: r.ownerUpgrade,
    xeroInvoiceId: r.bill.InvoiceID,
    xeroStatus: r.bill.Status,
    xeroAmountDue: r.bill.AmountDue,
    xeroAmountPaid: r.bill.AmountPaid,
  }))

  let execution: SyncPaymentsExecution | null = null

  if (execute) {
    let applied = 0
    let raced = 0
    let errored = 0
    const errors: { invoiceId: number; message: string }[] = []
    for (const r of updates) {
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        // Re-check the row's current values immediately before writing, inside
        // the transaction, so a concurrent edit between the read pass above and
        // this write cannot be silently clobbered.
        const cur = await client.query(
          "SELECT payment_status, to_char(paid_date, 'YYYY-MM-DD') AS paid_date, payment_notes FROM invoices WHERE id = $1 FOR UPDATE",
          [r.invoice.id],
        )
        if (!cur.rows.length) {
          await client.query("ROLLBACK")
          errored++
          errors.push({ invoiceId: r.invoice.id, message: "invoice no longer exists" })
          continue
        }
        const row = cur.rows[0]
        const stillMatches =
          row.payment_status === r.invoice.paymentStatus &&
          (row.paid_date ?? null) === (r.invoice.paidDate ?? null) &&
          (row.payment_notes ?? null) === (r.invoice.paymentNotes ?? null)
        if (!stillMatches) {
          await client.query("ROLLBACK")
          raced++
          continue
        }
        await client.query("UPDATE invoices SET payment_status = $2, paid_date = $3, payment_notes = $4 WHERE id = $1", [
          r.invoice.id,
          r.target.status,
          r.target.paidDate,
          r.newNotes,
        ])
        await client.query("COMMIT")
        applied++
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {})
        errored++
        errors.push({ invoiceId: r.invoice.id, message: (err as Error).message })
      } finally {
        client.release()
      }
    }
    execution = { applied, raced, errored, errors }
  }

  return {
    mode: execute ? "execute" : "dry_run",
    runDate: todayIso,
    billsFetched: bills.length,
    billsByStatus,
    osInvoicesConsidered: osInvoices.length,
    changes,
    protectedSkips: protectedSkips.map((r) => ({
      invoiceId: r.invoice.id,
      supplier: r.invoice.supplierName,
      invoiceNumber: r.invoice.invoiceNumber,
      currentStatus: r.invoice.paymentStatus ?? "unrecorded",
      derivedStatus: r.target.status,
      currentPaymentNotes: r.invoice.paymentNotes,
      reason: r.reason,
    })),
    noops: noops.length,
    noopMissingPaidDate,
    notActionable: notActionable.map((r) => ({
      invoiceId: r.invoice.id,
      supplier: r.invoice.supplierName,
      invoiceNumber: r.invoice.invoiceNumber,
      xeroStatus: r.bill.Status,
    })),
    ambiguous: ambiguous.map((r) => ({ reason: r.reason })),
    noXeroCounterpart: [...noCounterpartBySupplier.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([supplier, count]) => ({ supplier, count })),
    noXeroCounterpartTotal: noCounterpart.length,
    xeroNoOsMatch: actionableNoOsMatch.map((b) => ({
      status: b.Status,
      invoiceNumber: b.InvoiceNumber ?? "(no number)",
      contact: b.Contact?.Name ?? "",
      total: b.Total,
    })),
    xeroNoSupplierMatchByContact: [...xeroNoSupplierMatchByContact.entries()].map(([contact, count]) => ({ contact, count })),
    execution,
    counts: {
      billsFetched: bills.length,
      osInvoicesConsidered: osInvoices.length,
      wouldBeUpdates: updates.length,
      ownerProtectedUpgrades: updates.filter((r) => r.ownerUpgrade).length,
      protectedSkips: protectedSkips.length,
      noops: noops.length,
      notActionable: notActionable.length,
      ambiguous: ambiguous.length,
      noXeroCounterpart: noCounterpart.length,
      xeroNoOsMatch: actionableNoOsMatch.length,
    },
  }
}
