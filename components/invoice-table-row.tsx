"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight, FileWarning, Loader2 } from "lucide-react"
import { StatusBadge } from "@/components/status-badge"
import { InvoiceViewCell } from "@/components/invoice-view-cell"
import { InvoicePaymentControl } from "@/components/invoice-payment-control"
import { cn, formatGBP } from "@/lib/utils"
import type { InvoiceLineItemRow, InvoiceRow } from "@/lib/queries"

interface Props {
  inv: InvoiceRow
  /** Total number of columns in the parent table, for the expanded detail row's colSpan. */
  columnCount: number
}

function formatDate(d: string | null) {
  if (!d) return "—"
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

/**
 * A single invoice row with an on-demand expansion showing its line items.
 * Line items are fetched only when a row is first opened — never for all
 * rows on the page up front.
 */
export function InvoiceTableRow({ inv, columnCount }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [lineItems, setLineItems] = useState<InvoiceLineItemRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const linesLabel = inv.lineItemCount > 0 ? `${inv.classifiedLineCount}/${inv.lineItemCount}` : "—"
  const fullyClassified = inv.lineItemCount > 0 && inv.classifiedLineCount === inv.lineItemCount

  async function load() {
    setLoading(true)
    setError(false)
    try {
      const res = await fetch(`/api/invoices/${inv.id}/line-items`)
      if (!res.ok) throw new Error("Request failed")
      const data = (await res.json()) as InvoiceLineItemRow[]
      setLineItems(data)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  function toggle() {
    const next = !expanded
    setExpanded(next)
    if (next && lineItems === null && !loading) {
      void load()
    }
  }

  return (
    <>
      <tr className="border-b border-border last:border-b-0 hover:bg-muted/40">
        <td className="whitespace-nowrap px-2 py-3 text-muted-foreground">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={toggle}
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse line items" : "Expand line items"}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
            </button>
            {formatDate(inv.invoiceDate)}
          </div>
        </td>
        <td className="px-4 py-3 font-medium text-foreground">{inv.supplierName}</td>
        <td className="px-4 py-3 text-muted-foreground">{inv.invoiceNumber ?? "—"}</td>
        <td className="px-4 py-3 text-muted-foreground">{inv.projectName ?? "Unassigned"}</td>
        <td className="px-4 py-3 text-right tabular-nums">
          <span className={fullyClassified ? "text-muted-foreground" : "font-medium text-warning"}>{linesLabel}</span>
          {inv.unclassifiedNet > 0 ? (
            <span className="block text-[11px] text-warning">
              {formatGBP(inv.unclassifiedNet, { decimals: true })} unclassified
            </span>
          ) : null}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">{formatGBP(inv.net, { decimals: true })}</td>
        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
          {formatGBP(inv.vat, { decimals: true })}
        </td>
        <td className="px-4 py-3 text-right font-semibold tabular-nums">{formatGBP(inv.gross, { decimals: true })}</td>
        <td className="px-4 py-3">
          <div className="flex flex-col items-start gap-1">
            <StatusBadge variant={inv.needsReview ? "warning" : "success"} dot>
              {inv.needsReview ? "Needs review" : "Reviewed"}
            </StatusBadge>
            {inv.transactionType === "credit" ? <StatusBadge variant="info">Credit</StatusBadge> : null}
            {inv.confidence && inv.confidence !== "high" ? (
              <span className="text-[11px] text-muted-foreground">{inv.confidence} confidence extraction</span>
            ) : null}
          </div>
        </td>
        <td className="px-4 py-3">
          <InvoicePaymentControl invoiceId={inv.id} paymentStatus={inv.paymentStatus} paidDate={inv.paidDate} />
        </td>
        <td className="px-4 py-3">
          <InvoiceViewCell
            fileUrl={inv.sourceFilePathname}
            invoiceNumber={inv.invoiceNumber}
            supplierName={inv.supplierName}
            pageStart={inv.sourcePageStart}
            pageEnd={inv.sourcePageEnd}
          />
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-border bg-muted/20 last:border-b-0">
          <td colSpan={columnCount} className="px-4 py-3">
            {loading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                Loading line items…
              </div>
            ) : error ? (
              <div className="flex items-center gap-3 py-4 text-sm text-danger">
                <FileWarning className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                Could not load line items.
                <button type="button" onClick={() => void load()} className="font-medium underline hover:no-underline">
                  Retry
                </button>
              </div>
            ) : lineItems && lineItems.length > 0 ? (
              <LineItemsTable items={lineItems} />
            ) : (
              <p className="py-4 text-sm text-muted-foreground">No line items recorded for this invoice.</p>
            )}
          </td>
        </tr>
      ) : null}
    </>
  )
}

function LineItemsTable({ items }: { items: InvoiceLineItemRow[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border bg-muted text-[11px] uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="px-3 py-2 text-left font-semibold">Description</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Qty</th>
            <th scope="col" className="px-3 py-2 text-left font-semibold">Unit</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Unit price</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Net</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">VAT</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Gross</th>
            <th scope="col" className="px-3 py-2 text-left font-semibold">Cost package</th>
          </tr>
        </thead>
        <tbody>
          {items.map((li) => (
            <tr key={li.id} className="border-b border-border last:border-b-0">
              <td className="px-3 py-2 text-foreground">{li.description}</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {li.quantity ?? "—"}
              </td>
              <td className="px-3 py-2 text-muted-foreground">{li.unit ?? "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {li.unitPriceExVat != null ? formatGBP(li.unitPriceExVat, { decimals: true }) : "—"}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-foreground">
                {formatGBP(li.lineNet, { decimals: true })}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {formatGBP(li.lineVat, { decimals: true })}
              </td>
              <td className="px-3 py-2 text-right font-medium tabular-nums text-foreground">
                {formatGBP(li.lineGross, { decimals: true })}
              </td>
              <td className={cn("px-3 py-2", li.costPackageId == null && "py-2.5")}>
                {li.costPackageId != null ? (
                  <span className="text-foreground">
                    {li.costPackageCode ? `${li.costPackageCode} · ` : ""}
                    {li.costPackageName}
                  </span>
                ) : (
                  <StatusBadge variant="warning" dot>
                    Unclassified
                  </StatusBadge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
