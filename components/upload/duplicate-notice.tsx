"use client"

import { AlertTriangle, Ban, Sparkles } from "lucide-react"
import { cn, formatGBP } from "@/lib/utils"
import { InvoiceViewCell } from "@/components/invoice-view-cell"
import type { DuplicateStatus, DuplicateVerdict } from "@/lib/duplicate-detection"

const LABELS: Record<DuplicateStatus, string> = {
  new: "New",
  possible_duplicate: "Possible duplicate",
  already_imported: "Already imported",
}

export function VerdictBadge({ status, className }: { status: DuplicateStatus; className?: string }) {
  const styles: Record<DuplicateStatus, string> = {
    new: "border-success/30 bg-success-bg text-success",
    possible_duplicate: "border-warning/30 bg-warning-bg text-warning",
    already_imported: "border-danger/30 bg-danger-bg text-danger",
  }
  const Icon = status === "new" ? Sparkles : status === "possible_duplicate" ? AlertTriangle : Ban
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide",
        styles[status],
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2} />
      {LABELS[status]}
    </span>
  )
}

function formatDate(d: string | null): string {
  if (!d) return "—"
  const parsed = new Date(d)
  if (Number.isNaN(parsed.getTime())) return d
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

/**
 * Full-width notice shown above the review form when a document is an exact
 * duplicate or a possible duplicate. For exact duplicates it summarises the
 * existing record and offers to open it; for possible duplicates it lets the
 * user confirm the document really is new before it can be committed.
 */
export function DuplicateNotice({
  verdict,
  confirmedNew,
  onConfirmChange,
}: {
  verdict: DuplicateVerdict
  confirmedNew: boolean
  onConfirmChange: (v: boolean) => void
}) {
  if (verdict.status === "new") return null
  const existing = verdict.existing

  if (verdict.status === "already_imported") {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3.5">
        <div className="flex items-start gap-2">
          <Ban className="mt-0.5 h-4 w-4 shrink-0 text-danger" strokeWidth={2} />
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-semibold text-danger">This invoice already exists in Gilbert OS.</p>
            <p className="text-xs text-danger/80">
              It has been excluded from the commit so your spend and VAT are not counted twice.
            </p>
          </div>
        </div>
        {existing ? (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md bg-card/60 px-3 py-3 text-sm sm:grid-cols-3">
              <Detail label="Supplier" value={existing.supplierName} />
              <Detail label="Invoice number" value={existing.invoiceNumber ?? "—"} />
              <Detail label="Invoice date" value={formatDate(existing.invoiceDate)} />
              <Detail label="Amount" value={formatGBP(existing.gross, { decimals: true })} />
              <Detail label="Existing project" value={existing.projectName ?? "Unassigned"} />
              <Detail label="Originally imported" value={formatDate(existing.importedAt)} />
            </dl>
            <div>
              <InvoiceViewCell
                fileUrl={existing.sourceFilePathname}
                invoiceNumber={existing.invoiceNumber}
                supplierName={existing.supplierName}
                pageStart={existing.sourcePageStart}
                pageEnd={existing.sourcePageEnd}
                label="View existing invoice"
              />
            </div>
          </>
        ) : null}
      </div>
    )
  }

  // possible_duplicate
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-bg px-4 py-3.5">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" strokeWidth={2} />
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-semibold text-warning">Possible duplicate — please confirm.</p>
          {verdict.reason ? <p className="text-xs text-warning/90">{verdict.reason}</p> : null}
        </div>
      </div>
      {existing ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-card/60 px-3 py-2.5 text-xs text-foreground">
          <span>
            <span className="text-muted-foreground">Existing: </span>
            {existing.supplierName}
          </span>
          <span>{existing.invoiceNumber ?? "no number"}</span>
          <span>{formatDate(existing.invoiceDate)}</span>
          <span>{formatGBP(existing.gross, { decimals: true })}</span>
          <InvoiceViewCell
            fileUrl={existing.sourceFilePathname}
            invoiceNumber={existing.invoiceNumber}
            supplierName={existing.supplierName}
            pageStart={existing.sourcePageStart}
            pageEnd={existing.sourcePageEnd}
            label="View existing"
          />
        </div>
      ) : null}
      <label className="flex items-center gap-2 text-sm font-medium text-foreground">
        <input
          type="checkbox"
          checked={confirmedNew}
          onChange={(e) => onConfirmChange(e.target.checked)}
          className="h-4 w-4 rounded border-border"
        />
        This is a different document — import it anyway
      </label>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  )
}
