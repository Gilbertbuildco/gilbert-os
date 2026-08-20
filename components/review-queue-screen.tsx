"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ArrowLeft, ArrowRight, CheckCircle2, CircleHelp, Loader2 } from "lucide-react"
import { StatusBadge } from "@/components/status-badge"
import { InvoiceViewCell } from "@/components/invoice-view-cell"
import { InvoicePaymentControl } from "@/components/invoice-payment-control"
import { ClassificationCell } from "@/components/invoice-table-row"
import { markInvoiceReviewed, answerInvoiceQuestion } from "@/app/actions/invoices"
import { cn, formatGBP } from "@/lib/utils"
import type { ReviewQueueEntry } from "@/lib/queries"

interface Props {
  entry: ReviewQueueEntry
  /** 0-based offset into the needs_review ASC-by-date ordering. */
  cursor: number
  /** Total invoices currently needing review, across every project. */
  total: number
  /** Resolved from entry.projectName — null when the invoice has no project. */
  projectId: number | null
}

function formatDate(d: string | null) {
  if (!d) return "—"
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

/**
 * One invoice, full screen: header facts, the source document, its line
 * items with inline classification, any outstanding review question, and the
 * three navigation actions (mark reviewed / skip / back). All server-state
 * mutation goes through the same actions and mutate-then-router.refresh()
 * pattern already used across the app — never a bespoke write path.
 */
export function ReviewQueueScreen({ entry, cursor, total, projectId }: Props) {
  const router = useRouter()
  const [isMarking, startMarking] = useTransition()

  function markReviewed() {
    if (isMarking) return
    startMarking(async () => {
      await markInvoiceReviewed(entry.id, true)
      // Cursor stays put: the reviewed invoice drops out of the needs_review
      // set, so the next one shifts into this same offset on refresh.
      router.refresh()
    })
  }

  function skip() {
    router.push(`/invoices/review?cursor=${cursor + 1}`)
  }

  function back() {
    if (cursor === 0) return
    router.push(`/invoices/review?cursor=${cursor - 1}`)
  }

  // Keyboard: r = mark reviewed, s / → = skip, ← = back. Disabled while
  // focus is in any form control so typing an answer or picking a cost
  // package never fires a queue action by accident.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName
      const editable = (e.target as HTMLElement | null)?.isContentEditable
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || editable) return

      if (e.key === "r" || e.key === "R") {
        e.preventDefault()
        markReviewed()
      } else if (e.key === "s" || e.key === "S" || e.key === "ArrowRight") {
        e.preventDefault()
        skip()
      } else if (e.key === "ArrowLeft") {
        e.preventDefault()
        back()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, entry.id, isMarking])

  const pct = total > 0 ? Math.min(100, Math.round((cursor / total) * 100)) : 0

  return (
    <div className="flex flex-1 flex-col gap-4 pb-28 lg:pb-4">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-sm font-semibold text-foreground">
          Invoice {cursor + 1} of {total}
        </span>
        <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <QuestionPanel entry={entry} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        <DocumentPanel entry={entry} />

        <div className="flex flex-col gap-4">
          <InvoiceSummaryCard entry={entry} />
          <LineItemsPanel entry={entry} projectId={projectId} />
        </div>
      </div>

      <div className="sticky bottom-0 z-30 -mx-4 mt-2 border-t border-border bg-card px-4 py-3 sm:-mx-8 sm:px-8 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:px-0 lg:py-0">
        <div className="mx-auto flex max-w-3xl items-center gap-2 lg:mx-0 lg:max-w-none">
          <button
            type="button"
            onClick={back}
            disabled={cursor === 0}
            aria-label="Previous invoice"
            className="inline-flex min-h-12 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
            <span className="hidden sm:inline">Back</span>
          </button>
          <button
            type="button"
            onClick={skip}
            className="inline-flex min-h-12 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            Skip
            <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={markReviewed}
            disabled={isMarking}
            className="inline-flex min-h-12 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {isMarking ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            ) : (
              <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} />
            )}
            Mark reviewed
          </button>
        </div>
        <p className="mt-2 hidden text-center text-xs text-muted-foreground lg:block">
          Keyboard — R mark reviewed · S or → skip · ← back
        </p>
      </div>
    </div>
  )
}

function QuestionPanel({ entry }: { entry: ReviewQueueEntry }) {
  const router = useRouter()
  const [answer, setAnswer] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  if (!entry.reviewQuestion) return null

  const answered = entry.reviewAnswer != null

  function send() {
    const trimmed = answer.trim()
    if (!trimmed) return
    setError(null)
    startTransition(async () => {
      try {
        await answerInvoiceQuestion(entry.id, trimmed)
        setAnswer("")
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not send this answer.")
      }
    })
  }

  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        answered ? "border-border bg-muted/40" : "border-info/40 bg-info-bg",
      )}
    >
      <div className="flex items-start gap-2.5">
        <CircleHelp className={cn("mt-0.5 h-4 w-4 shrink-0", answered ? "text-muted-foreground" : "text-info")} strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <p className={cn("text-xs font-semibold uppercase tracking-wide", answered ? "text-muted-foreground" : "text-info")}>
            Question from the assistant
          </p>
          <p className="mt-1 text-sm text-foreground">{entry.reviewQuestion}</p>
        </div>
      </div>

      {answered ? (
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your answer</p>
          <p className="mt-1 text-sm text-foreground">{entry.reviewAnswer}</p>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Type your answer…"
            rows={2}
            disabled={isPending}
            aria-label="Answer the assistant's question"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={send}
              disabled={isPending || !answer.trim()}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : null}
              Send answer
            </button>
            {error ? <span className="text-xs text-danger">{error}</span> : null}
          </div>
        </div>
      )}
    </div>
  )
}

function DocumentPanel({ entry }: { entry: ReviewQueueEntry }) {
  const content = entry.sourceFilePathname ? (
    <div className="flex flex-col items-start gap-3">
      {entry.sourceFileName ? <p className="truncate text-xs text-muted-foreground">{entry.sourceFileName}</p> : null}
      <InvoiceViewCell
        fileUrl={entry.sourceFilePathname}
        invoiceNumber={entry.invoiceNumber}
        supplierName={entry.supplierName}
        pageStart={entry.sourcePageStart}
        pageEnd={entry.sourcePageEnd}
        label="View document"
      />
    </div>
  ) : (
    <p className="text-sm text-muted-foreground">No document on file for this invoice.</p>
  )

  return (
    <>
      {/* Desktop: alongside the data, always open */}
      <div className="hidden rounded-lg border border-border bg-card p-4 lg:block">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Document</h2>
        {content}
      </div>

      {/* Mobile: stacked, collapsed by default */}
      <details className="rounded-lg border border-border bg-card p-4 lg:hidden">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-foreground">
          Document
        </summary>
        <div className="mt-3">{content}</div>
      </details>
    </>
  )
}

function InvoiceSummaryCard({ entry }: { entry: ReviewQueueEntry }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-foreground">{entry.supplierName}</h2>
          <p className="text-sm text-muted-foreground">
            {entry.invoiceNumber ? `Invoice ${entry.invoiceNumber}` : "No invoice number"} · {formatDate(entry.invoiceDate)}
          </p>
          <p className={cn("text-xs", entry.projectName ? "text-muted-foreground" : "text-warning")}>
            {entry.projectName ?? "No project assigned"}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge variant={entry.needsReview ? "warning" : "success"} dot>
            {entry.needsReview ? "Needs review" : "Reviewed"}
          </StatusBadge>
          {entry.transactionType === "credit" ? <StatusBadge variant="info">Credit</StatusBadge> : null}
          {entry.confidence && entry.confidence !== "high" ? (
            <span className="text-[11px] text-muted-foreground">{entry.confidence} confidence extraction</span>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-4">
        <div>
          <p className="text-xs text-muted-foreground">Net</p>
          <p className="font-medium tabular-nums text-foreground">{formatGBP(entry.net, { decimals: true })}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">VAT</p>
          <p className="font-medium tabular-nums text-foreground">{formatGBP(entry.vat, { decimals: true })}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Gross</p>
          <p className="font-semibold tabular-nums text-foreground">{formatGBP(entry.gross, { decimals: true })}</p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">Payment</span>
        <InvoicePaymentControl invoiceId={entry.id} paymentStatus={entry.paymentStatus} paidDate={entry.paidDate} />
      </div>
    </div>
  )
}

function LineItemsPanel({ entry, projectId }: { entry: ReviewQueueEntry; projectId: number | null }) {
  const router = useRouter()

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Line items</h2>
        <span className="text-xs text-muted-foreground">
          {entry.classifiedLineCount}/{entry.lineItemCount} classified
        </span>
      </div>

      {entry.lineItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">No line items recorded for this invoice.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {entry.lineItems.map((li) => (
            <li key={li.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">{li.description}</p>
                  {li.quantity != null || li.unit ? (
                    <p className="text-xs text-muted-foreground">
                      {li.quantity != null ? li.quantity : ""} {li.unit ?? ""}
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
                  {formatGBP(li.lineNet, { decimals: true })}
                </span>
              </div>
              <ClassificationCell
                line={li}
                options={entry.costPackageOptions}
                suggestion={undefined}
                projectId={projectId}
                onChanged={() => router.refresh()}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
