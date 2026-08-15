"use client"

import { CheckCircle2, Copy, AlertTriangle, FileText } from "lucide-react"
import { formatGBP } from "@/lib/utils"

export interface BatchSummaryData {
  sourceFileCount: number
  documentsDetected: number
  invoicesAdded: number
  creditsAdded: number
  duplicatesSkipped: number
  otherSkipped: number
  failed: number
  totalNetAdded: number
  suppliersAffected: string[]
  priceRecordsCreated: number
  needingAttention: { label: string; reason: string }[]
}

interface Props {
  data: BatchSummaryData
  onDone: () => void
  onUploadMore: () => void
}

export function BatchSummary({ data, onDone, onUploadMore }: Props) {
  const added = data.invoicesAdded + data.creditsAdded
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10 sm:px-8">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-success-bg text-success">
          <CheckCircle2 className="h-6 w-6" strokeWidth={2} />
        </div>
        <div className="flex flex-col">
          <h2 className="text-lg font-semibold text-foreground">Import complete</h2>
          <p className="text-sm text-muted-foreground">
            {added} {added === 1 ? "record" : "records"} added from {data.sourceFileCount}{" "}
            {data.sourceFileCount === 1 ? "file" : "files"} · {data.documentsDetected} documents detected
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Invoices added" value={String(data.invoicesAdded)} />
        <Stat label="Credit notes added" value={String(data.creditsAdded)} />
        <Stat label="Duplicates skipped" value={String(data.duplicatesSkipped)} tone="warning" />
        <Stat label="Net value added" value={formatGBP(data.totalNetAdded, { decimals: true })} />
        <Stat label="Price records created" value={String(data.priceRecordsCreated)} />
        <Stat
          label="Need attention"
          value={String(data.needingAttention.length + data.failed)}
          tone={data.needingAttention.length + data.failed > 0 ? "danger" : undefined}
        />
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Copy className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
          Suppliers affected ({data.suppliersAffected.length})
        </h3>
        {data.suppliersAffected.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {data.suppliersAffected.map((s) => (
              <span
                key={s}
                className="rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground"
              >
                {s}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">None</p>
        )}
      </div>

      {data.needingAttention.length > 0 || data.failed > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-danger/30 bg-danger-bg p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-danger">
            <AlertTriangle className="h-4 w-4" strokeWidth={2} />
            Documents needing manual attention
          </h3>
          <ul className="flex flex-col gap-1.5">
            {data.needingAttention.map((d, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-danger">
                <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                <span>
                  <span className="font-medium">{d.label}</span> — {d.reason}
                </span>
              </li>
            ))}
            {data.failed > 0 ? (
              <li className="text-sm text-danger">
                {data.failed} file{data.failed === 1 ? "" : "s"} could not be read automatically.
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onUploadMore}
          className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted"
        >
          Upload more
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          Go to invoices
        </button>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "warning" | "danger"
}) {
  const valueColor =
    tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : "text-foreground"
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-3">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-xl font-semibold ${valueColor}`}>{value}</span>
    </div>
  )
}
