/**
 * Xero dry-run — Phase 1 mapping validation only.
 *
 * READ-ONLY. No network calls, no OAuth, no writes to Xero, no writes to
 * the Gilbert OS database, no files written. It:
 *   1. reads every confirmed invoice (+ lines + supplier) from production,
 *   2. maps each one through the pure `mapInvoiceToXeroBill` engine,
 *   3. prints the full would-be JSON payload for a few representative
 *      invoices,
 *   4. prints an aggregate gap report (count of invoices by gap type, and
 *      how many are cleanly pushable today),
 *   5. prints a reconciliation line proving the mapping loses no money.
 *
 * Run with:
 *   node --env-file=.env.development.local $(npx which tsx) scripts/xero-dry-run.mts
 * or:
 *   npx tsx --env-file=.env.development.local scripts/xero-dry-run.mts
 */
import { Pool } from "pg"
import {
  mapInvoiceToXeroBill,
  type InvoiceForXero,
  type InvoiceLineForXero,
  type SupplierForXero,
} from "../lib/xero/mapping.ts"
import { XERO_MAPPING_GAP_TYPES, type XeroMappingGap } from "../lib/xero/types.ts"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// pg returns `date` columns as JS Date objects shifted by local timezone,
// which would corrupt an immutable audit date. Format on the server side
// instead so we get the exact stored calendar date as a string.
const invoiceRows = (
  await pool.query(`
    SELECT
      inv.id, inv.supplier_id, inv.project_id,
      inv.invoice_number,
      to_char(inv.invoice_date, 'YYYY-MM-DD') AS invoice_date,
      inv.transaction_type, inv.net, inv.vat, inv.gross,
      inv.needs_review, inv.reconciled,
      s.id AS s_id, s.name AS s_name
    FROM invoices inv
    JOIN suppliers s ON s.id = inv.supplier_id
    WHERE inv.status = 'confirmed'
    ORDER BY inv.id
  `)
).rows

const lineRows = (
  await pool.query(`
    SELECT
      li.id, li.invoice_id, li.cost_package_id, cp.code AS cost_package_code,
      li.description, li.quantity, li.unit_price_ex_vat,
      li.line_net, li.line_vat, li.line_gross, li.vat_rate
    FROM invoice_line_items li
    JOIN invoices inv ON inv.id = li.invoice_id
    LEFT JOIN cost_packages cp ON cp.id = li.cost_package_id
    WHERE inv.status = 'confirmed'
    ORDER BY li.invoice_id, li.id
  `)
).rows

await pool.end()

const linesByInvoice = new Map<number, InvoiceLineForXero[]>()
for (const r of lineRows) {
  const line: InvoiceLineForXero = {
    id: r.id,
    invoiceId: r.invoice_id,
    costPackageId: r.cost_package_id,
    costPackageCode: r.cost_package_code,
    description: r.description,
    quantity: r.quantity,
    unitPriceExVat: r.unit_price_ex_vat,
    lineNet: r.line_net,
    lineVat: r.line_vat,
    lineGross: r.line_gross,
    vatRate: r.vat_rate,
  }
  const arr = linesByInvoice.get(r.invoice_id) ?? []
  arr.push(line)
  linesByInvoice.set(r.invoice_id, arr)
}

type Mapped = {
  invoiceId: number
  result: ReturnType<typeof mapInvoiceToXeroBill>
}

const mapped: Mapped[] = []
for (const r of invoiceRows) {
  const invoice: InvoiceForXero = {
    id: r.id,
    supplierId: r.supplier_id,
    projectId: r.project_id,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date,
    transactionType: r.transaction_type,
    net: r.net,
    vat: r.vat,
    gross: r.gross,
    needsReview: r.needs_review,
    reconciled: r.reconciled,
  }
  const supplier: SupplierForXero = { id: r.s_id, name: r.s_name }
  const lines = linesByInvoice.get(r.id) ?? []
  // opts intentionally omitted: Phase 1 has zero owner-confirmed mappings for
  // account codes, contacts or tracking categories — every invoice must gap
  // on those dimensions rather than have a value invented for it here.
  const result = mapInvoiceToXeroBill(invoice, lines, supplier)
  mapped.push({ invoiceId: r.id, result })
}

console.log(`\n=== Xero dry-run: ${mapped.length} confirmed invoices mapped (read-only, nothing written) ===\n`)

// ── 1. Representative payloads ──────────────────────────────────────────
console.log("--- Representative would-be payloads ---\n")
const representativeIds = new Set<number>()
// First invoice.
if (mapped[0]) representativeIds.add(mapped[0].invoiceId)
// One with the most gap types, to show a busy example.
const byGapCount = [...mapped].sort((a, b) => b.result.gaps.length - a.result.gaps.length)
if (byGapCount[0]) representativeIds.add(byGapCount[0].invoiceId)
// One with an arithmetic mismatch (the 1p VAT-rounding cases), if any exist.
const withMismatch = mapped.find((m) => m.result.gaps.some((g) => g.type === "arithmetic_mismatch"))
if (withMismatch) representativeIds.add(withMismatch.invoiceId)

for (const id of representativeIds) {
  const m = mapped.find((x) => x.invoiceId === id)!
  console.log(`--- Invoice ${id} ---`)
  console.log(JSON.stringify(m.result.payload, null, 2))
  console.log(`gaps (${m.result.gaps.length}):`, m.result.gaps.map((g) => g.type).join(", ") || "(none)")
  console.log()
}

// ── 2. Aggregate gap report ─────────────────────────────────────────────
console.log("--- Aggregate gap report (count of invoices affected, by gap type) ---\n")
const invoicesByGapType = new Map<string, Set<number>>()
for (const t of XERO_MAPPING_GAP_TYPES) invoicesByGapType.set(t, new Set())
let totalGapOccurrences = 0
for (const m of mapped) {
  for (const g of m.result.gaps) {
    invoicesByGapType.get(g.type)!.add(m.invoiceId)
    totalGapOccurrences++
  }
}
for (const t of XERO_MAPPING_GAP_TYPES) {
  const count = invoicesByGapType.get(t)!.size
  console.log(`  ${t.padEnd(32)} ${count} invoice(s)`)
}
const pushableCount = mapped.filter((m) => m.result.pushable).length
console.log(`\nTotal gap occurrences across all lines/invoices: ${totalGapOccurrences}`)
console.log(`Cleanly pushable today (zero gaps): ${pushableCount} / ${mapped.length}`)

// ── 3. Reconciliation: Gilbert OS totals vs summed payload totals ──────
console.log("\n--- Reconciliation: Gilbert OS totals vs summed payload totals ---\n")

// Kept in sync with `toPence` in lib/xero/mapping.ts — rounds half-up rather
// than truncating a 3rd-plus decimal digit (defensive; every caller here
// passes a numeric(14,2) column, which always has exactly 2).
const toPence = (raw: string | number): number => {
  const s = typeof raw === "number" ? raw.toFixed(2) : raw.trim()
  const negative = s.startsWith("-")
  const abs = negative ? s.slice(1) : s
  const [wholeRaw, fracRaw = ""] = abs.split(".")
  const whole = wholeRaw === "" ? 0 : parseInt(wholeRaw, 10)
  const fracDigits = (fracRaw + "000").slice(0, 3)
  const frac = Math.round(parseInt(fracDigits, 10) / 10)
  const pence = whole * 100 + frac
  return negative ? -pence : pence
}
const penceToPounds = (p: number) => (p / 100).toFixed(2)

// Gilbert OS authoritative totals (as stored on the invoice header, signed).
let gilbertNetPence = 0
let gilbertVatPence = 0
let gilbertGrossPence = 0
for (const r of invoiceRows) {
  gilbertNetPence += toPence(r.net)
  gilbertVatPence += toPence(r.vat)
  gilbertGrossPence += toPence(r.gross)
}

// Summed payload totals. Payload LineAmount/TaxAmount are sign-adjusted for
// credits per the mapping's documented convention (positive on ACCPAYCREDIT),
// so we reverse that per-invoice to compare like-for-like against Gilbert
// OS's signed header totals.
let payloadNetPence = 0
let payloadVatPence = 0
for (const m of mapped) {
  const isCredit = m.result.payload.Type === "ACCPAYCREDIT"
  const sign = isCredit ? -1 : 1
  for (const li of m.result.payload.LineItems) {
    payloadNetPence += toPence(li.LineAmount) * sign
    payloadVatPence += toPence(li.TaxAmount) * sign
  }
}
const payloadGrossPence = payloadNetPence + payloadVatPence

console.log(`Gilbert OS  net=£${penceToPounds(gilbertNetPence)}  vat=£${penceToPounds(gilbertVatPence)}  gross=£${penceToPounds(gilbertGrossPence)}`)
console.log(`Payload     net=£${penceToPounds(payloadNetPence)}  vat=£${penceToPounds(payloadVatPence)}  gross=£${penceToPounds(payloadGrossPence)}`)
const netDiff = payloadNetPence - gilbertNetPence
const vatDiff = payloadVatPence - gilbertVatPence
const grossDiff = payloadGrossPence - gilbertGrossPence
console.log(`Diff        net=£${penceToPounds(netDiff)}  vat=£${penceToPounds(vatDiff)}  gross=£${penceToPounds(grossDiff)}`)
console.log(
  netDiff === 0 && vatDiff === 0 && grossDiff === 0
    ? "RECONCILED: the mapping loses no money — payload totals match Gilbert OS totals exactly."
    : "MISMATCH: payload totals do not match Gilbert OS totals — investigate before trusting this mapping.",
)

console.log("\n=== Dry-run complete. Nothing was written anywhere. ===\n")
