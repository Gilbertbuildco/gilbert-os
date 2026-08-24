import "server-only"
import { pool } from "../db"

/**
 * What the evidence actually says about whether an invoice is paid.
 *
 * WHY THIS EXISTS. Every ingest so far decided `payment_status` from whichever
 * document happened to be in front of it — a supplier statement, a portal, an
 * email — with no rule forcing a cross-check against money that actually moved.
 * That produced the same defect repeatedly: Marshalls INV3904 marked unpaid
 * because their statement said so when the owner had paid it; Bradfords
 * invoices marked unpaid off Xero bills this system had itself just created;
 * Rhys Harvey showing £2,025 drawn against £10,764 of payments.
 *
 * A claimed status is now checked against the payments Xero holds for that
 * supplier, and a disagreement is REPORTED rather than silently resolved. It
 * never overwrites an owner assertion (non-negotiable #3: flag, never fix).
 *
 * Uses the cached `supplier_external_paid` snapshot rather than calling Xero,
 * so it is fast enough to run on every ingested row. The daily job refreshes
 * that snapshot via scripts/refresh-supplier-paid.mts.
 */
export type PaymentEvidence = {
  supplier: string
  invoiceNumber: string
  claimed: string | null
  /** Total paid to this supplier per Xero, gross. */
  paidToSupplier: number
  /** Total this supplier has invoiced us, gross. */
  invoicedFromSupplier: number
  /** true when the claimed status cannot be reconciled with the money. */
  conflict: boolean
  reason: string
}

export async function checkPaymentEvidence(
  supplierId: number,
  invoiceNumber: string,
  gross: number,
  claimed: string | null,
): Promise<PaymentEvidence> {
  const { rows: [s] } = await pool.query(`SELECT name FROM suppliers WHERE id = $1`, [supplierId])
  const { rows: [x] } = await pool.query(
    `SELECT COALESCE(SUM(paid_gross), 0) AS paid FROM supplier_external_paid WHERE supplier_id = $1`, [supplierId])
  const { rows: [i] } = await pool.query(
    `SELECT COALESCE(SUM(gross), 0) AS invoiced,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN gross
                              WHEN payment_status = 'part_paid' AND amount_paid IS NOT NULL THEN amount_paid
                              ELSE 0 END), 0) AS marked_paid
       FROM invoices WHERE supplier_id = $1 AND status = 'confirmed'`, [supplierId])

  const paid = Number(x.paid)
  const invoiced = Number(i.invoiced)
  const markedPaid = Number(i.marked_paid)
  const base = { supplier: s?.name ?? "?", invoiceNumber, claimed, paidToSupplier: paid, invoicedFromSupplier: invoiced }

  // Claiming unpaid while the supplier has been paid MORE than everything we
  // have already marked paid — the money for this invoice may well be there.
  if (claimed === "unpaid" && paid > markedPaid + 0.005) {
    return { ...base, conflict: true,
      reason: `marked unpaid, but Xero shows ${money(paid)} paid to ${base.supplier} against ${money(markedPaid)} already accounted for — ${money(paid - markedPaid)} of payments have no invoice against them, which may include this one` }
  }
  // Claiming paid with no payment evidence at all.
  if (claimed === "paid" && paid < 0.005) {
    return { ...base, conflict: true,
      reason: `marked paid, but Xero holds no payment to ${base.supplier} at all — the payment may be sitting unreconciled, which this system cannot see` }
  }
  return { ...base, conflict: false, reason: `${money(paid)} paid to this supplier per Xero; consistent with the claimed status` }
}

const money = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
