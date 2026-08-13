"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ChevronDown, ChevronRight, FileWarning, Loader2, Pencil, X } from "lucide-react"
import { StatusBadge } from "@/components/status-badge"
import { InvoiceViewCell } from "@/components/invoice-view-cell"
import { InvoicePaymentControl } from "@/components/invoice-payment-control"
import { classifyInvoiceLine, classifyMatchingLines } from "@/app/actions/invoices"
import { formatGBP } from "@/lib/utils"
import type { ClassificationSuggestion, CostPackageOption, InvoiceLineItemRow, InvoiceRow } from "@/lib/queries"

interface Props {
  inv: InvoiceRow
  /** Total number of columns in the parent table, for the expanded detail row's colSpan. */
  columnCount: number
  /**
   * Resolved from the invoice's project name against the project options
   * list (InvoiceRow itself only carries the name). Null when the invoice
   * has no project assigned — classification is blocked until one is set.
   */
  projectId: number | null
}

type LineItemsPayload = {
  lineItems: InvoiceLineItemRow[]
  costPackageOptions: CostPackageOption[]
  suggestions: ClassificationSuggestion[]
}

function formatDate(d: string | null) {
  if (!d) return "—"
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

/**
 * A single invoice row with an on-demand expansion showing its line items.
 * Line items (and, when the invoice has a project, cost-package options and
 * learned classification suggestions) are fetched only when a row is first
 * opened — never for all rows on the page up front.
 */
export function InvoiceTableRow({ inv, columnCount, projectId }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [data, setData] = useState<LineItemsPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const linesLabel = inv.lineItemCount > 0 ? `${inv.classifiedLineCount}/${inv.lineItemCount}` : "—"
  const fullyClassified = inv.lineItemCount > 0 && inv.classifiedLineCount === inv.lineItemCount

  async function load() {
    setLoading(true)
    setError(false)
    try {
      const url =
        projectId != null
          ? `/api/invoices/${inv.id}/line-items?projectId=${projectId}`
          : `/api/invoices/${inv.id}/line-items`
      const res = await fetch(url)
      if (!res.ok) throw new Error("Request failed")
      const payload = (await res.json()) as LineItemsPayload
      setData(payload)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  function toggle() {
    const next = !expanded
    setExpanded(next)
    if (next && data === null && !loading) {
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
            ) : data && data.lineItems.length > 0 ? (
              <LineItemsTable
                items={data.lineItems}
                costPackageOptions={data.costPackageOptions}
                suggestions={data.suggestions}
                projectId={projectId}
                onChanged={() => void load()}
              />
            ) : (
              <p className="py-4 text-sm text-muted-foreground">No line items recorded for this invoice.</p>
            )}
          </td>
        </tr>
      ) : null}
    </>
  )
}

function LineItemsTable({
  items,
  costPackageOptions,
  suggestions,
  projectId,
  onChanged,
}: {
  items: InvoiceLineItemRow[]
  costPackageOptions: CostPackageOption[]
  suggestions: ClassificationSuggestion[]
  projectId: number | null
  onChanged: () => void
}) {
  const suggestionByLineId = new Map(suggestions.map((s) => [s.lineItemId, s]))

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
              <td className="px-3 py-2 align-top">
                <ClassificationCell
                  line={li}
                  options={costPackageOptions}
                  suggestion={suggestionByLineId.get(li.id)}
                  projectId={projectId}
                  onChanged={onChanged}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function packageLabel(code: string | null, name: string) {
  return code ? `${code} — ${name}` : name
}

/**
 * Per-line classification control. Unclassified lines get a picker (a learned
 * suggestion, when one exists, pre-fills it but is visibly flagged and never
 * auto-committed — the human still has to act). Classified lines show their
 * package with change/clear affordances. Never calls classifyMatchingLines
 * silently: it is always a separate, explicit follow-up action.
 */
function ClassificationCell({
  line,
  options,
  suggestion,
  projectId,
  onChanged,
}: {
  line: InvoiceLineItemRow
  options: CostPackageOption[]
  suggestion: ClassificationSuggestion | undefined
  projectId: number | null
  onChanged: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<string>(
    suggestion ? String(suggestion.suggestedCostPackageId) : "",
  )
  const [lastAssignedId, setLastAssignedId] = useState<number | null>(null)
  const [showApplyPrompt, setShowApplyPrompt] = useState(false)
  const [appliedCount, setAppliedCount] = useState<number | null>(null)

  function classify(costPackageId: number) {
    setError(null)
    startTransition(async () => {
      try {
        await classifyInvoiceLine(line.id, costPackageId)
        setLastAssignedId(costPackageId)
        setShowApplyPrompt(true)
        setAppliedCount(null)
        setEditing(false)
        onChanged()
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not classify this line.")
      }
    })
  }

  function clear() {
    setError(null)
    startTransition(async () => {
      try {
        await classifyInvoiceLine(line.id, null)
        setShowApplyPrompt(false)
        setAppliedCount(null)
        onChanged()
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not clear this line.")
      }
    })
  }

  function applyToMatching() {
    if (lastAssignedId == null) return
    setError(null)
    startTransition(async () => {
      try {
        const { updatedCount } = await classifyMatchingLines(line.id, lastAssignedId)
        setAppliedCount(Math.max(0, updatedCount - 1))
        setShowApplyPrompt(false)
        onChanged()
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not apply to matching lines.")
      }
    })
  }

  if (projectId == null) {
    return <span className="text-[11px] text-muted-foreground">Assign a project to classify</span>
  }

  if (line.costPackageId != null && !editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-foreground">{packageLabel(line.costPackageCode, line.costPackageName ?? "")}</span>
          {isPending ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" strokeWidth={2} />
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setSelected(String(line.costPackageId))
                  setEditing(true)
                }}
                aria-label="Change cost package"
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Pencil className="h-3 w-3" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={clear}
                aria-label="Clear cost package"
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-danger"
              >
                <X className="h-3 w-3" strokeWidth={1.75} />
              </button>
            </>
          )}
        </div>
        {error ? <span className="text-[11px] text-danger">{error}</span> : null}
      </div>
    )
  }

  if (options.length === 0) {
    return <span className="text-[11px] text-muted-foreground">No cost packages configured for this project</span>
  }

  return (
    <div className="flex flex-col gap-1">
      {!editing && suggestion ? (
        <span className="text-[11px] font-medium text-warning">
          Suggested · confirmed {suggestion.timesConfirmed}×
        </span>
      ) : !editing ? (
        <StatusBadge variant="warning" dot>
          Unclassified
        </StatusBadge>
      ) : null}
      <div className="flex items-center gap-1.5">
        <select
          value={selected}
          disabled={isPending}
          onChange={(e) => {
            const value = e.target.value
            setSelected(value)
            if (value) classify(Number(value))
          }}
          aria-label="Cost package"
          className="h-7 min-w-0 max-w-[220px] rounded-md border border-border bg-background px-1.5 text-[11px] text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
        >
          <option value="" disabled>
            Select a cost package…
          </option>
          {options.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {packageLabel(opt.code, opt.name)}
            </option>
          ))}
        </select>
        {isPending ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" strokeWidth={2} /> : null}
        {editing ? (
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-[11px] font-medium text-muted-foreground hover:underline"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {error ? <span className="text-[11px] text-danger">{error}</span> : null}
      {showApplyPrompt ? (
        <button
          type="button"
          onClick={applyToMatching}
          disabled={isPending}
          className="w-fit text-[11px] font-medium text-primary hover:underline disabled:opacity-60"
        >
          Apply to other matching lines
        </button>
      ) : null}
      {appliedCount != null ? (
        <span className="text-[11px] text-muted-foreground">
          {appliedCount > 0
            ? `Applied to ${appliedCount} more line${appliedCount === 1 ? "" : "s"}`
            : "No other matching unclassified lines found"}
        </span>
      ) : null}
    </div>
  )
}
