import { ChevronRight, AlertTriangle } from "lucide-react"
import { cn, formatGBP } from "@/lib/utils"
import { MetricCard } from "@/components/metric-card"
import { StatusBadge } from "@/components/status-badge"
import { EmptyState } from "@/components/empty-state"
import { round2 } from "@/lib/funding/calculations"
import type { DrawdownEvent } from "@/lib/funding/queries"
import type { LineResult } from "@/lib/funding/calculations"

interface Props {
  events: DrawdownEvent[]
  lines: LineResult[]
  /** The lender's control total for the whole facility (funding_budgets.original_total). */
  facilityTotal: number | null
}

function formatDate(d: string | null) {
  if (!d) return null
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

/**
 * Every Goldentree drawdown/payment event in schedule order, with a running
 * cumulative certified total and a summary strip. Pure server component —
 * expand/collapse uses native <details>, no client JS required. Every figure
 * here comes straight off `funding_drawdown_events`/`_allocations`; nothing
 * is derived beyond simple sums, and a NULL stays a NULL, shown with the
 * honest explanation already recorded on the event.
 */
export function DrawdownTimeline({ events, lines, facilityTotal }: Props) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No drawdown events recorded"
        description="Once the Goldentree drawdown schedule is ingested for this budget, each valuation, reimbursement and direct payment will appear here against the funding lines it covers."
      />
    )
  }

  const lineDescById = new Map(lines.map((l) => [l.lineId, l.description]))

  const totalCertified = round2(events.reduce((s, e) => s + (e.certifiedTotal ?? 0), 0))
  const borrowerEvents = events.filter((e) => !e.directPayment)
  const directEvents = events.filter((e) => e.directPayment)
  const matchedBorrowerEvents = borrowerEvents.filter((e) => e.cashReceived != null)
  const totalReceivedToBank = round2(matchedBorrowerEvents.reduce((s, e) => s + (e.cashReceived ?? 0), 0))
  const totalDirectPaid = round2(directEvents.reduce((s, e) => s + (e.certifiedTotal ?? 0), 0))
  const amountLeftToDraw = facilityTotal != null ? round2(facilityTotal - totalCertified) : null

  let running = 0

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Goldentree drawdown timeline</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every certified event from the lender&apos;s master matrix, in schedule order — what Gilbert Build Co has
          received to the bank, what Goldentree paid straight to a supplier, and the two footer corrections the
          lender itself made. Nothing here is a projection; each figure is transcribed verbatim from the schedule or
          matched to a Xero receipt.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Total certified to date"
          value={formatGBP(totalCertified, { decimals: true })}
          hint="Across every valuation, reimbursement, direct payment and correction"
        />
        <MetricCard
          label="Received to bank"
          value={formatGBP(totalReceivedToBank, { decimals: true })}
          hint={`${matchedBorrowerEvents.length} of ${borrowerEvents.length} borrower events matched to a specific Xero receipt`}
        />
        <MetricCard
          label="Paid direct by lender"
          value={formatGBP(totalDirectPaid, { decimals: true })}
          hint={`${directEvents.length} payment${directEvents.length === 1 ? "" : "s"} straight to a supplier — never reached the company account`}
        />
        <MetricCard
          label="Left to draw"
          value={amountLeftToDraw != null ? formatGBP(amountLeftToDraw, { decimals: true }) : undefined}
          unconnected={amountLeftToDraw == null}
          hint={facilityTotal != null ? `Facility ${formatGBP(facilityTotal, { decimals: true })} minus everything certified so far` : undefined}
        />
      </div>

      <div className="flex flex-col gap-2">
        {events.map((event) => {
          running = round2(running + (event.certifiedTotal ?? 0))
          return (
            <DrawdownEventRow key={event.id} event={event} cumulative={running} lineDescById={lineDescById} />
          )
        })}
      </div>
    </section>
  )
}

function DrawdownEventRow({
  event,
  cumulative,
  lineDescById,
}: {
  event: DrawdownEvent
  cumulative: number
  lineDescById: Map<number, string>
}) {
  const isCorrection = (event.certifiedTotal ?? 0) < 0
  const displayDate = event.eventDate ?? event.receivedDate

  return (
    <details
      className={cn(
        "group rounded-lg border bg-card",
        isCorrection ? "border-warning/40 bg-warning-bg" : event.directPayment ? "border-info/30" : "border-border",
      )}
    >
      <summary className="flex cursor-pointer list-none flex-col gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <ChevronRight
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
              aria-hidden
            />
            <div>
              <h3 className="text-sm font-semibold text-foreground">{event.label}</h3>
              <p className="text-xs text-muted-foreground">
                {displayDate ? formatDate(displayDate) : "No date recorded"}
                {event.allocations.length > 0
                  ? ` · ${event.allocations.length} funding line${event.allocations.length === 1 ? "" : "s"}`
                  : ""}
              </p>
            </div>
          </div>
          {isCorrection ? (
            <StatusBadge variant="warning">Lender correction</StatusBadge>
          ) : event.directPayment ? (
            <StatusBadge variant="info">Direct payment</StatusBadge>
          ) : event.cashReceived != null ? (
            <StatusBadge variant="success" dot>
              Received to bank
            </StatusBadge>
          ) : (
            <StatusBadge variant="neutral">Certified — not yet matched to bank</StatusBadge>
          )}
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
          <span className="text-muted-foreground">
            Certified{" "}
            <span className={cn("font-medium tabular-nums", isCorrection ? "text-warning" : "text-foreground")}>
              {event.certifiedTotal != null ? formatGBP(event.certifiedTotal, { decimals: true }) : "—"}
            </span>
          </span>
          <span className="text-muted-foreground">
            Cumulative certified{" "}
            <span className="font-medium tabular-nums text-foreground">{formatGBP(cumulative, { decimals: true })}</span>
          </span>
        </div>

        <div className="text-xs">
          {event.directPayment ? (
            <span className="text-info">Paid directly to the supplier by Goldentree — never reached the company bank account.</span>
          ) : event.cashReceived != null ? (
            <span className="text-success">
              {formatGBP(event.cashReceived, { decimals: true })} received
              {event.receivedDate ? ` on ${formatDate(event.receivedDate)}` : ""}
            </span>
          ) : isCorrection ? (
            <span className="text-warning">A footer adjustment on the master matrix, not a cash movement — see notes below.</span>
          ) : (
            <span className="text-warning">Certified but not yet matched to a specific bank receipt — see notes below.</span>
          )}
        </div>
      </summary>

      <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
        {event.notes ? <p className="text-xs text-muted-foreground">{event.notes}</p> : null}

        {event.allocations.length > 0 ? (
          <div className="overflow-hidden rounded-md border border-border">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      Funding line
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {event.allocations.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-b-0">
                      <td className="px-3 py-2 text-foreground">
                        {lineDescById.get(a.fundingBudgetLineId) ?? `Funding line ${a.fundingBudgetLineId}`}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-foreground">
                        {formatGBP(a.amount, { decimals: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
            No funding-line allocation recorded for this event — deliberately left unresolved rather than guessed at.
          </p>
        )}
      </div>
    </details>
  )
}
