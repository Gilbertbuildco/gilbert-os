/**
 * Sync Xero's ACCPAY payment status into Gilbert OS `invoices.payment_status`
 * (+ `paid_date`, `payment_notes`). Intended to run DAILY.
 *
 * WHY THIS EXISTS
 *   The owner marks nothing manually going forward — Xero is the payment
 *   truth. This script reads every ACCPAY bill from Xero and updates the
 *   matching Gilbert OS invoice's payment_status to match, without touching
 *   anything else (never net/vat/gross, never line items, never
 *   classification, never Xero itself — `xeroGet` cannot express a write).
 *
 * MATCHING (exact only, never fuzzy — see lib/invoice-identity.ts)
 *   1. Supplier: Xero `Contact.Name` -> `normaliseSupplierName` -> exact
 *      lookup against `suppliers.name` (own name, normalised) or a learned
 *      `supplier_aliases.normalised_name`. No new suppliers are ever created
 *      by this script — an unmatched contact just means "no OS counterpart",
 *      reported, never guessed at.
 *   2. Invoice number: Xero `InvoiceNumber` -> `normaliseDocNumber` (both
 *      reproduced verbatim from lib/invoice-identity.ts, matching the pattern
 *      in scripts/ingest-xero-bills-2026-08.mts) -> exact match against
 *      `invoices.invoice_number` (same normalisation) for that supplier,
 *      `transaction_type = 'invoice'`.
 *   A Xero bill with an ambiguous match (two OS invoices at the same
 *   supplier normalise to the same number, or two live Xero bills at the
 *   same supplier normalise to the same number) is left UNRESOLVED and
 *   reported, never guessed.
 *
 * STATUS DERIVATION (from the Xero bill actually matched)
 *   Xero Status "PAID"                        -> payment_status 'paid',
 *                                                 paid_date = FullyPaidOnDate
 *                                                 (real Xero data, never
 *                                                 invented)
 *   Xero Status "AUTHORISED", AmountPaid > 0   -> payment_status 'part_paid'
 *   Xero Status "AUTHORISED", AmountPaid == 0  -> payment_status 'unpaid'
 *   Any other Xero status (DRAFT, SUBMITTED,
 *   VOIDED, DELETED, ...)                      -> no derived target; the
 *                                                 match is reported but never
 *                                                 acted on (a VOIDED/DELETED
 *                                                 Xero bill says nothing
 *                                                 trustworthy about whether
 *                                                 the real-world invoice was
 *                                                 paid).
 *
 * PROTECTED SKIPS (owner-asserted statuses are never silently overwritten)
 *   A row whose CURRENT `payment_notes` contains "owner" (case-insensitive —
 *   covers both scripts/mark-prejuly-paid.mjs's "per owner instruction" and
 *   scripts/apply-owner-decisions-2026-08-13.mjs's "Owner 2026-08-13: ..."
 *   provenance) is an owner assertion, not a default. It is updated ONLY when
 *   Xero now says PAID and the OS row currently says 'unpaid' or is
 *   unrecorded (NULL) — an upgrade to 'paid' backed by a real Xero
 *   FullyPaidOnDate is always safe, because it can only ever move a row
 *   *towards* more certain, better-evidenced data. Every other owner-noted
 *   row where the derived status would differ (e.g. currently 'part_paid',
 *   or already 'paid' but Xero suggests something else) is a PROTECTED SKIP:
 *   reported, never written.
 *
 * WHAT ELSE IS REPORTED, READ-ONLY, NEVER ACTED ON
 *   - OS invoices with no Xero counterpart at all (grouped by supplier) —
 *     matched against the FULL Xero pull regardless of bill status, so an OS
 *     invoice that matches only a DELETED/VOIDED Xero bill correctly does NOT
 *     show up here (it has a counterpart; that counterpart just isn't
 *     actionable — see below).
 *   - Xero ACCPAY bills (PAID/AUTHORISED only — DELETED/VOIDED are noise, not
 *     ingest candidates) with no OS counterpart — candidates for a future
 *     ingest run, never ingested by this script.
 *   - Matches where the Xero bill is in a terminal/other status
 *     (DELETED/VOIDED/DRAFT/SUBMITTED) — surfaced so a human can look, never
 *     turned into a status change.
 *   - Ambiguous matches (see MATCHING above).
 *   - No-op matches where status already agrees but Xero holds a real
 *     `paid_date` the OS row is missing — informational only; per spec this
 *     script updates ONLY when the derived STATUS differs from current, so a
 *     date-only backfill is never written here.
 *
 * SAFETY
 *   --dry-run is the default (no --execute needed to preview). The only
 *   network calls, in both modes, are Xero GETs (`xeroGet`, which cannot
 *   express a non-GET method regardless of `XERO_WRITE_ENABLED`). This
 *   script inserts nothing and deletes nothing, ever — it only ever updates
 *   `payment_status` / `paid_date` / `payment_notes` on existing rows, inside
 *   a transaction per row with a re-check of the row's current values
 *   immediately before the UPDATE (so a concurrent edit between the read
 *   pass and the write pass cannot be silently clobbered).
 *
 * USAGE
 *   npx tsx --env-file=.env.local --env-file=.env.development.local \
 *     scripts/sync-xero-payments.mts [--execute]
 */

import { createHash } from "node:crypto"
import { Pool } from "pg"
import { xeroGet } from "../lib/xero/client.ts"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const EXECUTE = args.includes("--execute")
const DRY_RUN = !EXECUTE

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run with --env-file=.env.development.local (see file header).")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Pure helpers, reproduced verbatim from lib/invoice-identity.ts — this is a
// standalone script (same pattern as scripts/ingest-xero-bills-2026-08.mts),
// reproduced rather than imported so drift can be caught by re-diffing
// against the source file noted.
// ---------------------------------------------------------------------------

function normaliseSupplierName(raw: string | null | undefined): string {
  if (!raw) return ""
  let s = raw.toLowerCase()
  s = s.replace(/&/g, " and ")
  s = s.replace(/[^a-z0-9\s]/g, " ")
  const stopWords = new Set([
    "ltd", "limited", "plc", "llp", "llc", "inc", "incorporated", "co", "company", "group", "holdings", "uk", "the",
  ])
  s = s.split(/\s+/).filter((w) => w && !stopWords.has(w)).join(" ")
  return s.trim()
}

function normaliseDocNumber(raw: string | null | undefined): string {
  if (!raw) return ""
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").trim()
}

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

/** Xero's `/Date(1763683200000+0000)/` wire format -> "YYYY-MM-DD" (UTC). Returns null rather than guessing on a bad shape — matches scripts/ingest-xero-bills-2026-08.mts. */
function xeroMsDateToIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//)
  if (!m) return null
  const ms = Number(m[1])
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 10)
}

const todayIso = new Date().toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// Pull every ACCPAY bill from Xero (paged GETs; xeroGet only, GET-only)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Derived target status
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

type OsInvoice = {
  id: number
  supplierId: number
  supplierName: string
  invoiceNumber: string
  paymentStatus: "unpaid" | "paid" | "part_paid" | null
  paidDate: string | null
  paymentNotes: string | null
}

type PlanRow =
  | { kind: "UPDATE"; invoice: OsInvoice; bill: XeroBill; target: DerivedTarget; newNotes: string; ownerUpgrade: boolean }
  | { kind: "NOOP"; invoice: OsInvoice; bill: XeroBill; target: DerivedTarget }
  | { kind: "PROTECTED_SKIP"; invoice: OsInvoice; bill: XeroBill; target: DerivedTarget; reason: string }
  | { kind: "NOT_ACTIONABLE"; invoice: OsInvoice; bill: XeroBill; reason: string }
  | { kind: "AMBIGUOUS"; key: string; bills?: XeroBill[]; invoices?: OsInvoice[]; reason: string }

function paymentChecksum(rows: { id: number; paymentStatus: string | null; paidDate: string | null; paymentNotes: string | null }[]): string {
  const material = rows
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((r) => `${r.id}|${r.paymentStatus ?? ""}|${r.paidDate ?? ""}|${r.paymentNotes ?? ""}`)
    .join("\n")
  return createHash("sha256").update(material).digest("hex")
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

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no DB writes)" : "EXECUTE (will write payment_status/paid_date/payment_notes only)"}`)
  console.log(`Run date: ${todayIso}\n`)

  // --- Pull Xero (GET only) ---
  console.log("Fetching all ACCPAY bills from Xero (paged GETs)...")
  const bills = await fetchAllAccpayBills()
  console.log(`Xero ACCPAY bills fetched: ${bills.length}`)
  const byStatus: Record<string, number> = {}
  for (const b of bills) byStatus[b.Status] = (byStatus[b.Status] || 0) + 1
  console.log(`  by status: ${Object.entries(byStatus).map(([s, n]) => `${s}=${n}`).join(", ")}\n`)

  // --- Load OS invoices + suppliers/aliases for exact-normalised matching ---
  const osInvoices = await loadOsInvoices()
  const beforeChecksum = paymentChecksum(osInvoices)
  console.log(`Gilbert OS invoices (transaction_type='invoice', has invoice_number): ${osInvoices.length}`)
  console.log(`Payment-columns checksum BEFORE: ${beforeChecksum}\n`)

  const suppliersRes = await pool.query("SELECT id, name FROM suppliers ORDER BY id")
  const aliasRes = await pool.query("SELECT supplier_id, normalised_name FROM supplier_aliases")
  const aliasMap = new Map<string, { id: number; name: string }>()
  for (const s of suppliersRes.rows) aliasMap.set(normaliseSupplierName(s.name), { id: s.id, name: s.name })
  for (const a of aliasRes.rows) {
    const supplier = suppliersRes.rows.find((s: any) => s.id === a.supplier_id)
    if (supplier) aliasMap.set(a.normalised_name, { id: supplier.id, name: supplier.name })
  }

  // OS invoices keyed by supplier+normalised number, for O(1) lookup from the
  // Xero side. Also detect OS-side ambiguity (two OS invoices for the same
  // supplier normalising to the same number) up front — never silently pick one.
  const osByKey = new Map<string, OsInvoice[]>()
  for (const inv of osInvoices) {
    const key = `${inv.supplierId}|${normaliseDocNumber(inv.invoiceNumber)}`
    const arr = osByKey.get(key) ?? []
    arr.push(inv)
    osByKey.set(key, arr)
  }

  // Xero bills keyed the same way, restricted to bills with a resolvable
  // supplier (own name or learned alias) and a non-blank invoice number.
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

  // --- Walk every OS invoice, look for its Xero counterpart(s) ---
  for (const inv of osInvoices) {
    const key = `${inv.supplierId}|${normaliseDocNumber(inv.invoiceNumber)}`
    const osGroup = osByKey.get(key)!
    const xeroGroup = xeroByKey.get(key)

    if (osGroup.length > 1) {
      // OS-side ambiguity: only report once per key (on the first invoice seen).
      if (osGroup[0].id === inv.id) {
        plan.push({
          kind: "AMBIGUOUS",
          key,
          invoices: osGroup,
          reason: `${osGroup.length} OS invoices for supplier #${inv.supplierId} "${inv.supplierName}" normalise to the same invoice number "${normaliseDocNumber(inv.invoiceNumber)}" — cannot safely attribute a Xero match to one of them.`,
        })
      }
      continue
    }

    if (!xeroGroup || xeroGroup.length === 0) continue // handled in the "no Xero counterpart" pass below

    matchedOsIds.add(inv.id)

    // Ambiguity on the Xero side only matters among bills that would actually
    // produce a target (PAID/AUTHORISED) — two terminal (DELETED/VOIDED)
    // entries sharing a number is noise, not a real conflict, and neither is
    // actionable regardless of which one "wins".
    const actionableBills = xeroGroup.filter((b) => b.Status === "PAID" || b.Status === "AUTHORISED")
    if (actionableBills.length > 1) {
      plan.push({
        kind: "AMBIGUOUS",
        key,
        bills: actionableBills,
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
      // Unreachable given the actionableBills filter above, but kept as a
      // defensive fallback rather than a non-null assertion.
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

  // --- OS invoices with genuinely no Xero counterpart at all ---
  const noCounterpart = osInvoices.filter((inv) => !matchedOsIds.has(inv.id) && (osByKey.get(`${inv.supplierId}|${normaliseDocNumber(inv.invoiceNumber)}`)?.length ?? 0) === 1)
  const noCounterpartBySupplier = new Map<string, number>()
  for (const inv of noCounterpart) noCounterpartBySupplier.set(inv.supplierName, (noCounterpartBySupplier.get(inv.supplierName) ?? 0) + 1)

  // --- Xero ACCPAY bills (PAID/AUTHORISED only) with no OS counterpart ---
  const actionableNoOsMatch: XeroBill[] = []
  for (const [key, group] of xeroByKey) {
    if (osByKey.has(key)) continue
    for (const b of group) {
      if (b.Status === "PAID" || b.Status === "AUTHORISED") actionableNoOsMatch.push(b)
    }
  }

  // ---------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------
  const updates = plan.filter((r): r is Extract<PlanRow, { kind: "UPDATE" }> => r.kind === "UPDATE")
  const noops = plan.filter((r) => r.kind === "NOOP")
  const protectedSkips = plan.filter((r) => r.kind === "PROTECTED_SKIP")
  const notActionable = plan.filter((r) => r.kind === "NOT_ACTIONABLE")
  const ambiguous = plan.filter((r) => r.kind === "AMBIGUOUS")

  console.log("--- WOULD-BE CHANGES ---")
  if (updates.length === 0) console.log("  (none)")
  for (const r of updates) {
    console.log(
      `  UPDATE  inv #${r.invoice.id} "${r.invoice.supplierName}" #${r.invoice.invoiceNumber}  ` +
        `${r.invoice.paymentStatus ?? "unrecorded"} -> ${r.target.status}` +
        `${r.target.paidDate ? ` (paid_date ${r.target.paidDate})` : ""}` +
        `${r.ownerUpgrade ? "  [owner-protected row, upgraded via PAID+unpaid/unrecorded exception]" : ""}` +
        `  [Xero bill ${r.bill.InvoiceID} status=${r.bill.Status} due=${r.bill.AmountDue} paid=${r.bill.AmountPaid}]`,
    )
  }

  console.log(`\n--- PROTECTED SKIPS (owner-asserted, not overwritten) — ${protectedSkips.length} ---`)
  for (const r of protectedSkips as Extract<PlanRow, { kind: "PROTECTED_SKIP" }>[]) {
    console.log(
      `  SKIP  inv #${r.invoice.id} "${r.invoice.supplierName}" #${r.invoice.invoiceNumber}  ` +
        `current='${r.invoice.paymentStatus ?? "unrecorded"}' Xero-derived='${r.target.status}'  — ${r.reason}`,
    )
    console.log(`        current payment_notes: ${r.invoice.paymentNotes}`)
  }

  console.log(`\n--- NOT ACTIONABLE (Xero status has no payment_status mapping) — ${notActionable.length} ---`)
  for (const r of notActionable as Extract<PlanRow, { kind: "NOT_ACTIONABLE" }>[]) {
    console.log(`  inv #${r.invoice.id} "${r.invoice.supplierName}" #${r.invoice.invoiceNumber}  Xero status=${r.bill.Status}`)
  }

  console.log(`\n--- AMBIGUOUS (never guessed) — ${ambiguous.length} ---`)
  for (const r of ambiguous as Extract<PlanRow, { kind: "AMBIGUOUS" }>[]) console.log(`  ${r.reason}`)

  console.log(`\n--- NO-OP (already agrees) — ${noops.length} ---`)
  const noopMissingPaidDate = (noops as Extract<PlanRow, { kind: "NOOP" }>[]).filter(
    (r) => r.target.status === "paid" && r.target.paidDate && !r.invoice.paidDate,
  )
  console.log(`  informational only, not written: ${noopMissingPaidDate.length} of these are 'paid' with a real Xero paid_date the OS row lacks (status already agrees, so out of scope for this script per spec).`)

  console.log(`\n--- OS invoices with NO Xero counterpart (${noCounterpart.length}, by supplier) ---`)
  for (const [supplier, n] of [...noCounterpartBySupplier.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${supplier}`)

  console.log(`\n--- Xero ACCPAY bills (PAID/AUTHORISED) with NO OS counterpart — candidates for future ingest (${actionableNoOsMatch.length}) ---`)
  for (const b of actionableNoOsMatch) console.log(`  ${b.Status.padEnd(11)} #${(b.InvoiceNumber ?? "(no number)").padEnd(16)} "${b.Contact?.Name}"  total=£${b.Total}`)
  if (xeroNoSupplierMatch.filter((b) => b.Status === "PAID" || b.Status === "AUTHORISED").length) {
    console.log(`  (of which, contact has no OS supplier/alias match at all: ${xeroNoSupplierMatch.filter((b) => b.Status === "PAID" || b.Status === "AUTHORISED").length} — new-supplier candidates, listed by contact below)`)
    const byContact = new Map<string, number>()
    for (const b of xeroNoSupplierMatch) if (b.Status === "PAID" || b.Status === "AUTHORISED") byContact.set(b.Contact?.Name ?? "(none)", (byContact.get(b.Contact?.Name ?? "(none)") ?? 0) + 1)
    for (const [name, n] of byContact) console.log(`    ${String(n).padStart(4)}  ${name}`)
  }

  // --- Summary ---
  console.log("\n--- SUMMARY ---")
  console.log(`Xero ACCPAY bills fetched:              ${bills.length}`)
  console.log(`OS invoices considered:                 ${osInvoices.length}`)
  console.log(`Would-be updates:                       ${updates.length}`)
  console.log(`  of which owner-protected upgrades:    ${updates.filter((r) => r.ownerUpgrade).length}`)
  console.log(`Protected skips:                        ${protectedSkips.length}`)
  console.log(`No-ops (already agrees):                ${noops.length}`)
  console.log(`Not actionable (unmapped Xero status):  ${notActionable.length}`)
  console.log(`Ambiguous (skipped, never guessed):     ${ambiguous.length}`)
  console.log(`OS invoices with no Xero counterpart:   ${noCounterpart.length}`)
  console.log(`Xero PAID/AUTHORISED with no OS match:  ${actionableNoOsMatch.length}`)

  if (DRY_RUN) {
    const afterInvoices = await loadOsInvoices()
    const afterChecksum = paymentChecksum(afterInvoices)
    console.log(`\nPayment-columns checksum AFTER:  ${afterChecksum}`)
    console.log(afterChecksum === beforeChecksum ? "Checksum UNCHANGED — zero writes in this dry run." : "CHECKSUM CHANGED — this should never happen in dry run.")
    console.log("\nDry run only — nothing written. The only network calls made were Xero GETs (paged bill fetch);")
    console.log("xeroGet cannot express a write regardless of flags. Re-run with --execute to apply the updates above.")
    await pool.end()
    if (afterChecksum !== beforeChecksum) process.exitCode = 1
    return
  }

  // --- Execute ---
  console.log("\n--- EXECUTING ---")
  let applied = 0
  let raced = 0
  let errored = 0
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
        console.error(`ERROR: invoice #${r.invoice.id} no longer exists`)
        continue
      }
      const row = cur.rows[0]
      const stillMatches = row.payment_status === r.invoice.paymentStatus && (row.paid_date ?? null) === (r.invoice.paidDate ?? null) && (row.payment_notes ?? null) === (r.invoice.paymentNotes ?? null)
      if (!stillMatches) {
        await client.query("ROLLBACK")
        raced++
        console.log(`SKIPPED (changed since plan was built) inv #${r.invoice.id}`)
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
      console.log(`UPDATED inv #${r.invoice.id} "${r.invoice.supplierName}" #${r.invoice.invoiceNumber} -> ${r.target.status}`)
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {})
      errored++
      console.error(`ERROR updating invoice #${r.invoice.id}: ${(err as Error).message}`)
    } finally {
      client.release()
    }
  }
  console.log(`\nApplied: ${applied}  Raced/changed-since-plan: ${raced}  Errors: ${errored}`)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
