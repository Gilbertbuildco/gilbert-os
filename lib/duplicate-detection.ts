import { normaliseSupplierName, normaliseDocNumber, amountsClose } from "./invoice-identity"

export type DocFingerprint = {
  supplierName: string | null
  transactionType: "invoice" | "credit"
  invoiceNumber: string | null
  invoiceDate: string | null
  net: number | null
  vat: number | null
  gross: number | null
  sourceFileHash: string | null
}

/** A committed invoice we might be duplicating, with everything needed to display it. */
export type ExistingInvoiceRef = {
  id: number
  supplierName: string
  invoiceNumber: string | null
  invoiceDate: string | null
  transactionType: string
  net: number
  vat: number
  gross: number
  projectName: string | null
  importedAt: string | null
  sourceFilePathname: string | null
  sourcePageStart: number | null
  sourcePageEnd: number | null
  sourceFileHash: string | null
}

export type DuplicateStatus = "new" | "possible_duplicate" | "already_imported"

export type DuplicateVerdict = {
  status: DuplicateStatus
  /** The best matching existing invoice, when one was found. */
  existing: ExistingInvoiceRef | null
  /** Human-readable explanation of why this verdict was reached. */
  reason: string | null
}

/**
 * Classify a single extracted document against the set of already-committed
 * invoices. Deliberately conservative: only an exact normalised
 * supplier + type + document-number match counts as ALREADY IMPORTED; weaker
 * signals are surfaced as POSSIBLE DUPLICATE for manual confirmation rather
 * than silently blocked.
 */
export function classifyAgainst(fp: DocFingerprint, existing: ExistingInvoiceRef[]): DuplicateVerdict {
  const nSupplier = normaliseSupplierName(fp.supplierName)
  const nNumber = normaliseDocNumber(fp.invoiceNumber)

  // 1) EXACT — the primary duplicate identity: supplier + type + number.
  if (nNumber) {
    const exact = existing.find(
      (e) =>
        e.transactionType === fp.transactionType &&
        normaliseDocNumber(e.invoiceNumber) === nNumber &&
        normaliseSupplierName(e.supplierName) === nSupplier,
    )
    if (exact) {
      return {
        status: "already_imported",
        existing: exact,
        reason: `Matches ${exact.transactionType === "credit" ? "credit note" : "invoice"} ${
          exact.invoiceNumber ?? ""
        } already imported for ${exact.supplierName}.`,
      }
    }
  }

  // 2) POSSIBLE DUPLICATE — weaker signals that need a human decision.

  // 2a) Same document number + type but a different supplier (possible mis-read supplier).
  if (nNumber) {
    const numberMatch = existing.find(
      (e) => e.transactionType === fp.transactionType && normaliseDocNumber(e.invoiceNumber) === nNumber,
    )
    if (numberMatch) {
      return {
        status: "possible_duplicate",
        existing: numberMatch,
        reason: `Document number ${numberMatch.invoiceNumber ?? ""} already exists under a different supplier (${
          numberMatch.supplierName
        }).`,
      }
    }
  }

  // 2b) Same supplier + type + identical gross AND (same date or identical net),
  // regardless of number (covers a missing or mis-read invoice number).
  const amountMatch = existing.find(
    (e) =>
      e.transactionType === fp.transactionType &&
      normaliseSupplierName(e.supplierName) === nSupplier &&
      amountsClose(e.gross, fp.gross) &&
      (e.invoiceDate === fp.invoiceDate || amountsClose(e.net, fp.net)),
  )
  if (amountMatch) {
    return {
      status: "possible_duplicate",
      existing: amountMatch,
      reason: `Same supplier and amount (${
        amountMatch.invoiceDate ?? "no date"
      }) as an existing document — check this isn't the same invoice with a different number.`,
    }
  }

  // 2c) The exact same file bytes were imported before (same checksum), same supplier.
  if (fp.sourceFileHash) {
    const hashMatch = existing.find(
      (e) => e.sourceFileHash && e.sourceFileHash === fp.sourceFileHash && normaliseSupplierName(e.supplierName) === nSupplier,
    )
    if (hashMatch) {
      return {
        status: "possible_duplicate",
        existing: hashMatch,
        reason: "The same source file has already been imported for this supplier.",
      }
    }
  }

  // 3) NEW — no meaningful match.
  return { status: "new", existing: null, reason: null }
}
