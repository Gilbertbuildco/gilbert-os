/**
 * Xero mapping layer — Phase 1 (dry-run only).
 *
 * Pure and dependency-free, exactly like `lib/funding/calculations.ts`: no DB
 * imports, no "server-only", no network, no mutation of inputs, fully
 * deterministic. It only ever computes a would-be Xero bill payload plus the
 * list of reasons it is not yet safe to push. It never calls Xero and never
 * invents a value to fill a gap — every unresolved field becomes a
 * `XeroMappingGap` instead.
 */

import type {
  XeroBillPayload,
  XeroBillType,
  XeroLineItem,
  XeroMappingGap,
  XeroTrackingOption,
} from "./types"

/** The subset of an `invoices` row this layer needs. Numeric columns arrive as strings (Postgres `numeric`). */
export type InvoiceForXero = {
  id: number
  supplierId: number
  projectId: number | null
  invoiceNumber: string | null
  /** ISO `YYYY-MM-DD`. Callers must format the `date` column themselves — never pass a JS `Date` (timezone-shift risk). */
  invoiceDate: string | null
  /** "invoice" | "credit" as stored in `invoices.transaction_type`. */
  transactionType: string
  net: string | number
  vat: string | number
  gross: string | number
  needsReview: boolean
  reconciled: boolean
}

/** The subset of an `invoice_line_items` row this layer needs. */
export type InvoiceLineForXero = {
  id: number
  invoiceId: number
  costPackageId: number | null
  costPackageCode: string | null
  /** Verbatim `description` — an immutable audit field. Never cleaned, truncated, or re-worded here. */
  description: string
  quantity: string | number | null
  unitPriceExVat: string | number | null
  lineNet: string | number
  lineVat: string | number
  lineGross: string | number
  /** UK VAT percentage, e.g. 20.000. Only 20 maps to a TaxType today. */
  vatRate: string | number | null
}

export type SupplierForXero = {
  id: number
  name: string
}

/**
 * Owner-populated lookup tables. All optional and all empty by default —
 * Phase 1 has none of these confirmed, so every invoice will carry gaps for
 * whichever of these it needs. Supplying an entry here is the *only* way a
 * gap for that dimension is resolved; this function never infers one itself.
 */
export type XeroMappingOptions = {
  /** cost_package_id -> Xero chart-of-accounts code. Sourced from `xero_account_map` once populated. */
  accountCodeByCostPackageId?: Record<number, string>
  /** supplier_id -> Xero ContactID. Sourced from confirmed contact matching once built. */
  contactIdBySupplierId?: Record<number, string>
  /** project_id -> Xero tracking-category option (category name below). */
  projectTrackingOptionByProjectId?: Record<number, string>
  /** cost_package_id -> Xero tracking-category option (category name below). */
  costPackageTrackingOptionByCostPackageId?: Record<number, string>
  /** Xero tracking-category name to use for the project dimension. Default "Project". */
  projectTrackingCategoryName?: string
  /** Xero tracking-category name to use for the cost-package dimension. Default "Cost Package". */
  costPackageTrackingCategoryName?: string
}

export type MapInvoiceResult = {
  payload: XeroBillPayload
  gaps: XeroMappingGap[]
  /** True only when there are zero gaps — the only condition under which this bill would be safe to push. */
  pushable: boolean
}

/**
 * Parse a Postgres `numeric` value (arrives as a string, e.g. "122.00") into
 * integer pence with no floating-point arithmetic. Used only for exact
 * equality checks (arithmetic integrity) — never for the JSON numbers
 * written into the payload itself, which are unavoidably JS numbers.
 *
 * Every caller passes a `numeric(14,2)` column (`net`, `vat`, `gross`,
 * `line_net`, `line_vat`, `line_gross`), which Postgres always renders with
 * exactly 2 fraction digits — so this never has to round in practice. It
 * still rounds half-up (via integer arithmetic only, never `Number(...) *
 * 100`) rather than truncating a 3rd-plus decimal digit, so a value with
 * more fraction digits than expected loses no pence silently if this is ever
 * reused against a coarser-scale column.
 */
function toPence(raw: string | number): number {
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

const penceToNumber = (p: number): number => p / 100

/** Numeric string/number -> JS number for direct field copy (no summation, no comparison). */
function toNumber(raw: string | number | null | undefined): number | null {
  if (raw == null) return null
  const n = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Map one Gilbert OS invoice (+ its lines + supplier) to a would-be Xero
 * ACCPAY/ACCPAYCREDIT bill payload, plus every gap preventing it being pushed
 * today. Never mutates any input.
 */
export function mapInvoiceToXeroBill(
  invoice: InvoiceForXero,
  lines: InvoiceLineForXero[],
  supplier: SupplierForXero,
  opts: XeroMappingOptions = {},
): MapInvoiceResult {
  const gaps: XeroMappingGap[] = []
  const invoiceLines = lines.filter((l) => l.invoiceId === invoice.id)

  if (invoiceLines.length === 0) {
    gaps.push({
      type: "no_line_items",
      invoiceId: invoice.id,
      message: `Invoice ${invoice.id} has no line items — a Xero bill cannot be created with an empty LineItems array.`,
    })
  }

  if (!supplier.name || !supplier.name.trim()) {
    gaps.push({
      type: "missing_supplier_name",
      supplierId: supplier.id,
      message: `Supplier id ${supplier.id} has no name — cannot set the Xero Contact.Name without fabricating one.`,
    })
  }

  // --- Transaction type / sign ------------------------------------------
  // Gilbert OS stores a credit note's net/vat/gross (and its lines' line_net
  // /line_vat/line_gross) as NEGATIVE numbers (see app/actions/invoices.ts).
  // `quantity` and `unit_price_ex_vat` are NOT sign-flipped there — they stay
  // positive magnitudes on a credit too. Xero's ACCPAYCREDIT bills (and their
  // line items) are entered as POSITIVE amounts; the credit is implied by
  // Type, not by sign. We therefore flip the sign only on the money TOTALS
  // (LineAmount, TaxAmount) when building the payload for a credit, leaving
  // Quantity/UnitAmount untouched — documented here rather than left silent.
  const isCredit = invoice.transactionType === "credit"
  const type: XeroBillType = isCredit ? "ACCPAYCREDIT" : "ACCPAY"
  const sign = isCredit ? -1 : 1

  // --- Contact --------------------------------------------------------
  const contactId = opts.contactIdBySupplierId?.[supplier.id] ?? null
  if (!contactId) {
    gaps.push({
      type: "unresolved_contact",
      supplierId: supplier.id,
      supplierName: supplier.name,
      message: `Supplier "${supplier.name}" (id ${supplier.id}) has no confirmed Xero ContactID mapping yet.`,
    })
  }

  // --- Header fields ----------------------------------------------------
  if (!invoice.invoiceNumber) {
    gaps.push({
      type: "missing_invoice_number",
      invoiceId: invoice.id,
      message: `Invoice ${invoice.id} has no invoice_number.`,
    })
  }
  if (!invoice.invoiceDate) {
    gaps.push({
      type: "missing_invoice_date",
      invoiceId: invoice.id,
      message: `Invoice ${invoice.id} has no invoice_date.`,
    })
  }
  if (invoice.needsReview) {
    gaps.push({
      type: "needs_review",
      invoiceId: invoice.id,
      message: `Invoice ${invoice.id} is flagged needs_review — a human must resolve it before it can be pushed.`,
    })
  }
  if (!invoice.reconciled) {
    gaps.push({
      type: "not_reconciled",
      invoiceId: invoice.id,
      message: `Invoice ${invoice.id} line/total arithmetic did not reconcile at commit time.`,
    })
  }

  const projectTrackingOption =
    invoice.projectId != null ? opts.projectTrackingOptionByProjectId?.[invoice.projectId] ?? null : null
  if (invoice.projectId != null && !projectTrackingOption) {
    gaps.push({
      type: "unresolved_tracking_project",
      invoiceId: invoice.id,
      projectId: invoice.projectId,
      message: `Project ${invoice.projectId} has no Xero tracking-category option mapped yet.`,
    })
  }

  // Header amounts in pence, computed once and reused below both for the
  // header-level gross-consistency check and the line-sum-vs-header checks.
  const invoiceNetPence = toPence(invoice.net)
  const invoiceVatPence = toPence(invoice.vat)
  const invoiceGrossPence = toPence(invoice.gross)

  // Header-level internal consistency: does the invoice's own net + vat add
  // up to its own gross? This is independent of (and in addition to) the
  // cross-row line-sum-vs-header checks below — a header row can be
  // internally inconsistent even if nothing about the lines is wrong.
  if (invoiceNetPence + invoiceVatPence !== invoiceGrossPence) {
    gaps.push({
      type: "gross_mismatch",
      invoiceId: invoice.id,
      lineItemId: null,
      net: penceToNumber(invoiceNetPence),
      vat: penceToNumber(invoiceVatPence),
      gross: penceToNumber(invoiceGrossPence),
      message: `Invoice ${invoice.id}: net ${penceToNumber(invoiceNetPence).toFixed(2)} + vat ${penceToNumber(invoiceVatPence).toFixed(2)} != gross ${penceToNumber(invoiceGrossPence).toFixed(2)}.`,
    })
  }

  // --- Lines --------------------------------------------------------------
  // Arithmetic integrity is checked against the RAW stored values (as
  // signed in the DB), independent of the Xero sign convention chosen above
  // — this proves the source data is internally consistent before any
  // presentation choice is applied to it.
  let sumLineNetPenceRaw = 0
  let sumLineVatPenceRaw = 0

  const xeroLines: XeroLineItem[] = invoiceLines.map((line) => {
    const lineNetPence = toPence(line.lineNet)
    const lineVatPence = toPence(line.lineVat)
    sumLineNetPenceRaw += lineNetPence
    sumLineVatPenceRaw += lineVatPence

    // Line-level internal consistency: does this line's own net + vat add up
    // to its own stored gross? Distinct from the invoice-level sum checks —
    // this catches a single bad row even when the header total happens to
    // still reconcile (e.g. two offsetting line errors).
    const lineGrossPence = toPence(line.lineGross)
    if (lineNetPence + lineVatPence !== lineGrossPence) {
      gaps.push({
        type: "gross_mismatch",
        invoiceId: invoice.id,
        lineItemId: line.id,
        net: penceToNumber(lineNetPence),
        vat: penceToNumber(lineVatPence),
        gross: penceToNumber(lineGrossPence),
        message: `Line ${line.id} on invoice ${invoice.id}: line_net ${penceToNumber(lineNetPence).toFixed(2)} + line_vat ${penceToNumber(lineVatPence).toFixed(2)} != line_gross ${penceToNumber(lineGrossPence).toFixed(2)}.`,
      })
    }

    if (line.costPackageId == null) {
      gaps.push({
        type: "unclassified_line",
        invoiceId: invoice.id,
        lineItemId: line.id,
        message: `Line ${line.id} on invoice ${invoice.id} has no cost_package_id (unclassified).`,
      })
    }

    const accountCode = line.costPackageId != null ? opts.accountCodeByCostPackageId?.[line.costPackageId] ?? null : null
    if (!accountCode) {
      gaps.push({
        type: "missing_account_code",
        invoiceId: invoice.id,
        lineItemId: line.id,
        costPackageId: line.costPackageId,
        costPackageCode: line.costPackageCode,
        message: `No Xero AccountCode mapped for cost package ${line.costPackageCode ?? line.costPackageId ?? "(unclassified)"} (line ${line.id}).`,
      })
    }

    const costPackageTrackingOption =
      line.costPackageId != null ? opts.costPackageTrackingOptionByCostPackageId?.[line.costPackageId] ?? null : null
    if (line.costPackageId != null && !costPackageTrackingOption) {
      gaps.push({
        type: "unresolved_tracking_cost_package",
        invoiceId: invoice.id,
        lineItemId: line.id,
        costPackageId: line.costPackageId,
        message: `Cost package ${line.costPackageCode ?? line.costPackageId} has no Xero tracking-category option mapped yet.`,
      })
    }

    const vatRateNum = toNumber(line.vatRate)
    let taxType: string | null = null
    if (vatRateNum === 20) {
      taxType = "INPUT2"
    } else {
      gaps.push({
        type: "unsupported_vat_rate",
        invoiceId: invoice.id,
        lineItemId: line.id,
        vatRate: vatRateNum,
        message: `Line ${line.id} has vat_rate ${vatRateNum ?? "null"} — only the 20% UK standard rate maps to a TaxType today.`,
      })
    }

    const tracking: XeroTrackingOption[] = []
    if (projectTrackingOption) {
      tracking.push({ Name: opts.projectTrackingCategoryName ?? "Project", Option: projectTrackingOption })
    }
    if (costPackageTrackingOption) {
      tracking.push({ Name: opts.costPackageTrackingCategoryName ?? "Cost Package", Option: costPackageTrackingOption })
    }

    return {
      Description: line.description,
      Quantity: toNumber(line.quantity),
      UnitAmount: toNumber(line.unitPriceExVat),
      AccountCode: accountCode,
      TaxType: taxType,
      TaxAmount: penceToNumber(lineVatPence * sign),
      LineAmount: penceToNumber(lineNetPence * sign),
      Tracking: tracking,
    }
  })

  if (sumLineNetPenceRaw !== invoiceNetPence) {
    gaps.push({
      type: "arithmetic_mismatch",
      invoiceId: invoice.id,
      field: "net",
      invoiceTotal: penceToNumber(invoiceNetPence),
      lineSum: penceToNumber(sumLineNetPenceRaw),
      diff: penceToNumber(sumLineNetPenceRaw - invoiceNetPence),
      message: `Invoice ${invoice.id}: sum(line_net) ${penceToNumber(sumLineNetPenceRaw).toFixed(2)} != invoice.net ${penceToNumber(invoiceNetPence).toFixed(2)}.`,
    })
  }
  if (sumLineVatPenceRaw !== invoiceVatPence) {
    gaps.push({
      type: "arithmetic_mismatch",
      invoiceId: invoice.id,
      field: "vat",
      invoiceTotal: penceToNumber(invoiceVatPence),
      lineSum: penceToNumber(sumLineVatPenceRaw),
      diff: penceToNumber(sumLineVatPenceRaw - invoiceVatPence),
      message: `Invoice ${invoice.id}: sum(line_vat) ${penceToNumber(sumLineVatPenceRaw).toFixed(2)} != invoice.vat ${penceToNumber(invoiceVatPence).toFixed(2)}.`,
    })
  }

  const payload: XeroBillPayload = {
    Type: type,
    Contact: { ContactID: contactId, Name: supplier.name },
    Date: invoice.invoiceDate ?? "",
    InvoiceNumber: invoice.invoiceNumber ?? "",
    Reference: `Gilbert OS invoice ${invoice.id}`,
    LineAmountTypes: "Exclusive",
    LineItems: xeroLines,
    Status: "DRAFT",
  }

  return { payload, gaps, pushable: gaps.length === 0 }
}
