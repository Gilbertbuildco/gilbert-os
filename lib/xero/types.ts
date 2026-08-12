/**
 * Xero Accounts Payable bill types — Phase 1 (dry-run mapping layer only).
 *
 * These mirror the subset of the Xero "Invoices" API payload we need to
 * represent a Gilbert OS supplier invoice/credit as an ACCPAY bill. Nothing
 * here performs I/O; this file is types only.
 *
 * Reference shape: https://developer.xero.com/documentation/api/accounting/invoices
 */

/** ACCPAY = a bill owed to a supplier. ACCPAYCREDIT = a supplier credit note. */
export type XeroBillType = "ACCPAY" | "ACCPAYCREDIT"

/**
 * We only ever emit "Exclusive" — net line amounts plus explicit tax — per
 * the Phase 1 mapping rules. The other Xero values are modelled for
 * completeness but this codebase never produces them.
 */
export type XeroLineAmountTypes = "Exclusive" | "Inclusive" | "NoTax"

/**
 * Xero bill statuses. Phase 1 never authorises anything — every payload this
 * layer produces is a "DRAFT" so a human (and later, a real Xero review step)
 * always sits between Gilbert OS and money moving.
 */
export type XeroBillStatus = "DRAFT" | "SUBMITTED" | "AUTHORISED" | "DELETED" | "VOIDED"

/**
 * A Xero Accounts Payable contact reference. `ContactID` is the UUID Xero
 * assigns to a contact once matched; Gilbert OS has no supplier -> Xero
 * contact mapping yet (Phase 2), so it is always null in Phase 1. `Name` is
 * carried through unconditionally so a human can match it by eye.
 */
export type XeroContact = {
  ContactID: string | null
  Name: string
}

/**
 * A Xero tracking-category option (e.g. category "Project", option "Higher
 * Farm"). Project and cost package are the natural tracking dimensions for
 * this business but neither has an owner-confirmed Xero mapping yet.
 */
export type XeroTrackingOption = {
  Name: string
  Option: string
}

export type XeroLineItem = {
  /** Verbatim `invoice_line_items.description` — an immutable audit field. Never cleaned, truncated, or re-worded. */
  Description: string
  Quantity: number | null
  UnitAmount: number | null
  /**
   * Xero chart-of-accounts code for this line. There is currently NO mapping
   * from a Gilbert OS cost package to a Xero account. Always null until the
   * owner populates `xero_account_map` — never invented or defaulted.
   */
  AccountCode: string | null
  /**
   * Xero tax type code. Only the UK 20% standard rate is mapped, to
   * "INPUT2". Any other or missing `vat_rate` yields null here (see
   * `XeroMappingGap` "unsupported_vat_rate") — never guessed.
   */
  TaxType: string | null
  TaxAmount: number
  LineAmount: number
  Tracking: XeroTrackingOption[]
}

/** The Xero Accounts Payable bill payload this layer produces (would-be, never sent). */
export type XeroBillPayload = {
  Type: XeroBillType
  Contact: XeroContact
  Date: string
  DueDate?: string
  InvoiceNumber: string
  Reference?: string
  LineAmountTypes: XeroLineAmountTypes
  LineItems: XeroLineItem[]
  Status: XeroBillStatus
}

/**
 * Every reason a Gilbert OS invoice is NOT yet safely pushable to Xero.
 * A discriminated union so callers can group, count, and render each gap
 * without ever needing to invent a value to fill the hole it represents.
 */
export type XeroMappingGap =
  | {
      type: "unresolved_contact"
      supplierId: number
      supplierName: string
      message: string
    }
  | {
      type: "missing_account_code"
      invoiceId: number
      lineItemId: number
      costPackageId: number | null
      costPackageCode: string | null
      message: string
    }
  | {
      type: "unresolved_tracking_project"
      invoiceId: number
      projectId: number
      message: string
    }
  | {
      type: "unresolved_tracking_cost_package"
      invoiceId: number
      lineItemId: number
      costPackageId: number
      message: string
    }
  | {
      type: "missing_invoice_number"
      invoiceId: number
      message: string
    }
  | {
      type: "missing_invoice_date"
      invoiceId: number
      message: string
    }
  | {
      type: "unclassified_line"
      invoiceId: number
      lineItemId: number
      message: string
    }
  | {
      type: "needs_review"
      invoiceId: number
      message: string
    }
  | {
      type: "not_reconciled"
      invoiceId: number
      message: string
    }
  | {
      type: "unsupported_vat_rate"
      invoiceId: number
      lineItemId: number
      vatRate: number | null
      message: string
    }
  | {
      type: "arithmetic_mismatch"
      invoiceId: number
      field: "net" | "vat"
      invoiceTotal: number
      lineSum: number
      diff: number
      message: string
    }
  | {
      /** A row's own net + vat does not add up to its own stored gross — header-level (`lineItemId: null`) or line-level. */
      type: "gross_mismatch"
      invoiceId: number
      lineItemId: number | null
      net: number
      vat: number
      gross: number
      message: string
    }
  | {
      /** A confirmed invoice has zero line items — Xero rejects a bill with an empty LineItems array. */
      type: "no_line_items"
      invoiceId: number
      message: string
    }
  | {
      /** The supplier record has no (or blank) name — never invent a Contact.Name. */
      type: "missing_supplier_name"
      supplierId: number
      message: string
    }

/** Every `XeroMappingGap["type"]` value, for building gap-report tables. */
export const XERO_MAPPING_GAP_TYPES = [
  "unresolved_contact",
  "missing_account_code",
  "unresolved_tracking_project",
  "unresolved_tracking_cost_package",
  "missing_invoice_number",
  "missing_invoice_date",
  "unclassified_line",
  "needs_review",
  "not_reconciled",
  "unsupported_vat_rate",
  "arithmetic_mismatch",
  "gross_mismatch",
  "no_line_items",
  "missing_supplier_name",
] as const satisfies readonly XeroMappingGap["type"][]
