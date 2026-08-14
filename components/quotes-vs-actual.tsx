import { ChevronRight } from "lucide-react"
import { cn, formatGBP } from "@/lib/utils"
import { MetricCard } from "@/components/metric-card"
import { StatusBadge } from "@/components/status-badge"
import { EmptyState } from "@/components/empty-state"
import type { QuoteDrillDownRow, QuoteVsActualSupplierRow, QuotesVsActual } from "@/lib/queries"

interface Props {
  data: QuotesVsActual | null
  projectSelected: boolean
}

function formatDate(d: string | null) {
  if (!d) return null
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

/** Groups a supplier row and its quotes by the same identity the query itself uses:
 * supplier_id when resolved, otherwise the raw (trimmed, lowercased) quoted name.
 * Never matches by name across a resolved supplier_id — see getQuotesVsActual's
 * own header comment on why that would risk misattributing spend. */
function supplierKey(supplierId: number | null, supplierName: string): string {
  return supplierId != null ? `id:${supplierId}` : `raw:${supplierName.trim().toLowerCase()}`
}

function clampPct(n: number) {
  return Math.min(100, Math.max(0, n))
}

/**
 * "Quotes cover part of this supplier's scope" — Bradfords is the canonical case:
 * three roofing-materials quotes measured against the supplier's ENTIRE materials
 * account. Actual running well beyond double what was quoted is treated as a
 * signal the quotes are a subset of the supplier's scope, not a same-scope
 * over-quote. This changes how the row is PRESENTED only — quotedTotal and
 * actualNet themselves are never adjusted.
 */
function isPartialScope(row: QuoteVsActualSupplierRow): boolean {
  return row.quotedTotal > 0 && row.actualNet > row.quotedTotal * 2
}

function computeBar(row: QuoteVsActualSupplierRow) {
  const trackScale = Math.max(row.quotedTotal, row.actualNet, 1)
  const quotedPct = clampPct((row.quotedTotal / trackScale) * 100)
  const actualPct = clampPct((row.actualNet / trackScale) * 100)
  const withinQuotePct = clampPct((Math.min(row.actualNet, row.quotedTotal) / trackScale) * 100)
  const overQuotePct = clampPct((Math.max(0, row.actualNet - row.quotedTotal) / trackScale) * 100)
  const headroomPct = clampPct((Math.max(0, row.quotedTotal - row.actualNet) / trackScale) * 100)
  const unpaidPct = clampPct((Math.min(row.unpaidCommitted, row.actualNet) / trackScale) * 100)
  return { quotedPct, actualPct, withinQuotePct, overQuotePct, headroomPct, unpaidPct }
}

/** Read-only quotes-vs-actual comparison for one project's tradesmen. Pure server
 * component — expand/collapse uses native <details>, no client JS required. */
export function QuotesVsActualView({ data, projectSelected }: Props) {
  if (!projectSelected) {
    return (
      <EmptyState
        title="No project selected"
        description="Select a project to compare tradesman quotes against actual spend."
      />
    )
  }

  if (!data || (data.suppliers.length === 0 && data.quotes.length === 0)) {
    return (
      <EmptyState
        title="No quotes recorded yet"
        description="Once tradesman quotes are ingested for this project, they'll be compared here against confirmed invoice spend."
      />
    )
  }

  // Only suppliers that actually have a quote on file belong in this view — a
  // supplier with real invoice spend but no quote is simply not part of a
  // quotes-vs-actual comparison, and showing one here would read as a fabricated
  // "over quote" against a quote that never existed.
  const quotedKeys = new Set(data.quotes.map((q) => supplierKey(q.supplierId, q.supplierName)))
  const relevant = data.suppliers.filter((s) => quotedKeys.has(supplierKey(s.supplierId, s.supplierName)))
  const matched = relevant.filter((s) => s.supplierId != null)
  const unmatched = relevant.filter((s) => s.supplierId == null)

  const quotesBySupplier = new Map<string, QuoteDrillDownRow[]>()
  for (const q of data.quotes) {
    const key = supplierKey(q.supplierId, q.supplierName)
    const list = quotesBySupplier.get(key) ?? []
    list.push(q)
    quotesBySupplier.set(key, list)
  }

  const totalQuoted = matched.reduce((s, r) => s + r.quotedTotal, 0)
  const totalActual = matched.reduce((s, r) => s + r.actualNet, 0)
  const totalRemaining = totalQuoted - totalActual
  const totalUnpaid = matched.reduce((s, r) => s + r.unpaidCommitted, 0)

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Total quoted"
          value={formatGBP(totalQuoted, { decimals: true })}
          hint="Open and accepted quotes for linked suppliers — superseded revisions excluded"
        />
        <MetricCard
          label="Actual spend (quoted suppliers)"
          value={formatGBP(totalActual, { decimals: true })}
          hint="Confirmed invoice net against suppliers with a quote on file"
        />
        <MetricCard
          label={totalRemaining >= 0 ? "Forecast remaining" : "Over quote (net)"}
          value={formatGBP(totalRemaining, { decimals: true })}
          hint={
            totalRemaining >= 0
              ? "Still to come across quoted suppliers, in aggregate — not a promise, a forecast"
              : "Actual spend already exceeds quotes, in aggregate"
          }
        />
        <MetricCard
          label="Unpaid / committed"
          value={formatGBP(totalUnpaid, { decimals: true })}
          hint="Confirmed invoices against quoted suppliers not yet paid out"
        />
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Quoted tradesmen</h2>
          <span className="text-xs text-muted-foreground">Sorted by quoted total, largest first</span>
        </div>
        {matched.length === 0 ? (
          <EmptyState
            title="No linked suppliers with quotes"
            description="Quotes exist but none are yet linked to a supplier record with matching invoice spend — see unmatched quotes below."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {matched.map((row) => {
              const key = supplierKey(row.supplierId, row.supplierName)
              return <SupplierQuoteCard key={key} row={row} quotes={quotesBySupplier.get(key) ?? []} />
            })}
          </div>
        )}
      </section>

      {unmatched.length > 0 ? (
        <section className="flex flex-col gap-3 rounded-lg border border-info/40 bg-info-bg p-4">
          <div>
            <h2 className="text-sm font-semibold text-info">Unmatched quotes</h2>
            <p className="mt-1 text-sm text-info">
              These quotes haven&apos;t resolved to an existing supplier record, so they can&apos;t yet be measured
              against actual invoice spend. They are real quotes awaiting supplier linkage — never hidden.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            {unmatched.map((row) => {
              const key = supplierKey(row.supplierId, row.supplierName)
              return <UnmatchedSupplierCard key={key} row={row} quotes={quotesBySupplier.get(key) ?? []} />
            })}
          </div>
        </section>
      ) : null}

    </div>
  )
}

function SupplierQuoteCard({ row, quotes }: { row: QuoteVsActualSupplierRow; quotes: QuoteDrillDownRow[] }) {
  const caveat = isPartialScope(row)
  const bar = computeBar(row)
  const over = row.remainingVsQuote < 0

  return (
    <details className="group rounded-lg border border-border bg-card">
      <summary className="flex cursor-pointer list-none flex-col gap-3 px-4 py-4 [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <ChevronRight
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
              aria-hidden
            />
            <div>
              <h3 className="text-sm font-semibold text-foreground">{row.supplierName}</h3>
              <p className="text-xs text-muted-foreground">
                {row.quoteCount} live quote{row.quoteCount === 1 ? "" : "s"}
                {quotes.length !== row.quoteCount ? ` · ${quotes.length} total incl. superseded` : ""}
              </p>
            </div>
          </div>
          {caveat ? (
            <StatusBadge variant="info">Quotes cover part of scope</StatusBadge>
          ) : over ? (
            <StatusBadge variant="danger" dot>Over quote</StatusBadge>
          ) : row.actualNet > 0 ? (
            <StatusBadge variant="success" dot>Within quote</StatusBadge>
          ) : (
            <StatusBadge variant="neutral">No spend yet</StatusBadge>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="relative h-3 w-full overflow-hidden rounded-full bg-muted">
            {!caveat && bar.headroomPct > 0 ? (
              <div
                className="absolute inset-y-0 bg-success/25"
                style={{ left: `${bar.actualPct}%`, width: `${bar.headroomPct}%` }}
                aria-hidden
              />
            ) : null}
            <div
              className={cn("absolute inset-y-0 left-0", caveat ? "bg-info" : "bg-primary")}
              style={{ width: `${caveat ? bar.actualPct : bar.withinQuotePct}%` }}
              aria-hidden
            />
            {!caveat && bar.overQuotePct > 0 ? (
              <div
                className="absolute inset-y-0 bg-danger"
                style={{ left: `${bar.quotedPct}%`, width: `${bar.overQuotePct}%` }}
                aria-hidden
              />
            ) : null}
            {bar.unpaidPct > 0 ? (
              <div
                className="absolute inset-y-0 bg-hatch text-card"
                style={{ left: `${Math.max(0, bar.actualPct - bar.unpaidPct)}%`, width: `${bar.unpaidPct}%` }}
                aria-hidden
              />
            ) : null}
            <div
              className="absolute inset-y-0 w-px bg-foreground/40"
              style={{ left: `${bar.quotedPct}%` }}
              aria-hidden
            />
          </div>

          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">
              Quoted{" "}
              <span className="font-medium tabular-nums text-foreground">
                {formatGBP(row.quotedTotal, { decimals: true })}
              </span>
              {" · "}
              Actual{" "}
              <span className="font-medium tabular-nums text-foreground">
                {formatGBP(row.actualNet, { decimals: true })}
              </span>
              {row.unpaidCommitted > 0 ? (
                <>
                  {" · "}
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm bg-primary/70 bg-hatch text-card" aria-hidden />
                    {formatGBP(row.unpaidCommitted, { decimals: true })} unpaid
                  </span>
                </>
              ) : null}
            </span>
            {caveat ? null : over ? (
              <span className="font-medium tabular-nums text-danger">
                {formatGBP(Math.abs(row.remainingVsQuote), { decimals: true })} over quote
              </span>
            ) : row.remainingVsQuote > 0 ? (
              <span className="font-medium tabular-nums text-success">
                {formatGBP(row.remainingVsQuote, { decimals: true })} still to come
              </span>
            ) : null}
          </div>

          {caveat ? (
            <p className="text-xs text-info">
              Quotes cover part of this supplier&apos;s scope ({row.quoteCount} quote
              {row.quoteCount === 1 ? "" : "s"} totalling {formatGBP(row.quotedTotal, { decimals: true })}) — actual
              spend of {formatGBP(row.actualNet, { decimals: true })} is this supplier&apos;s whole account, most of
              which was never quoted. Not shown as an over-quote.
            </p>
          ) : null}
        </div>
      </summary>

      <div className="border-t border-border px-4 py-3">
        <QuotesList quotes={quotes} />
      </div>
    </details>
  )
}

function UnmatchedSupplierCard({ row, quotes }: { row: QuoteVsActualSupplierRow; quotes: QuoteDrillDownRow[] }) {
  return (
    <details className="group rounded-lg border border-info/30 bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-2">
          <ChevronRight
            className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
            aria-hidden
          />
          <div>
            <h3 className="text-sm font-semibold text-foreground">{row.supplierName}</h3>
            <p className="text-xs text-muted-foreground">
              {row.quoteCount} live quote{row.quoteCount === 1 ? "" : "s"}
              {quotes.length !== row.quoteCount ? ` · ${quotes.length} total incl. superseded` : ""}
              {" · not linked to a supplier record — actual spend can't be compared here"}
            </p>
          </div>
        </div>
        <span className="shrink-0 font-medium tabular-nums text-foreground">
          {formatGBP(row.quotedTotal, { decimals: true })}
        </span>
      </summary>
      <div className="border-t border-border px-4 py-3">
        <QuotesList quotes={quotes} />
      </div>
    </details>
  )
}

function QuotesList({ quotes }: { quotes: QuoteDrillDownRow[] }) {
  if (quotes.length === 0) {
    return <p className="text-sm text-muted-foreground">No quote detail recorded.</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {quotes.map((q) => (
        <div
          key={q.id}
          className={cn(
            "flex flex-col gap-1 rounded-md border border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between",
            q.status === "superseded" && "opacity-60",
          )}
        >
          <div className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">{q.reference ?? "No reference"}</span>
              <QuoteStatusBadge status={q.status} />
              {q.sourceFilePathname ? (
                <a
                  href={q.sourceFilePathname}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium text-info underline-offset-2 hover:underline"
                >
                  View document
                </a>
              ) : null}
            </div>
            <span className="text-xs text-muted-foreground">
              {q.scope ? `${q.scope} · ` : ""}
              {q.description ?? "No description recorded"}
              {q.quoteDate ? ` · ${formatDate(q.quoteDate)}` : ""}
            </span>
          </div>
          <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
            {q.net != null
              ? formatGBP(q.net, { decimals: true })
              : q.gross != null
                ? `${formatGBP(q.gross, { decimals: true })} gross`
                : "—"}
          </span>
        </div>
      ))}
    </div>
  )
}

function QuoteStatusBadge({ status }: { status: string | null }) {
  if (status === "accepted") {
    return (
      <StatusBadge variant="success" dot>
        Accepted
      </StatusBadge>
    )
  }
  if (status === "superseded") return <StatusBadge variant="neutral">Superseded</StatusBadge>
  if (status === "open") return <StatusBadge variant="info">Open</StatusBadge>
  return <StatusBadge variant="neutral">Unknown status</StatusBadge>
}
