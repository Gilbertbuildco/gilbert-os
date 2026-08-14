import Link from "next/link"
import { AlertTriangle, Ban, ChevronRight } from "lucide-react"
import { cn, formatGBP } from "@/lib/utils"
import { DataTable, type Column } from "@/components/data-table"
import { MetricCard } from "@/components/metric-card"
import { EmptyState } from "@/components/empty-state"
import { StatusBadge } from "@/components/status-badge"
import { FundingLineDrillDown, type FundingLineDrillDownData } from "@/components/funding-line-drilldown"
import type { FundingCommercial } from "@/lib/funding/queries"
import type { LineResult } from "@/lib/funding/calculations"

interface Props {
  data: FundingCommercial
  /** Whether a project is currently selected at all (distinct from "no funding budget"). */
  projectSelected: boolean
  selectedSlug: string | null
  /** The funding line whose description is currently clicked open, if any. */
  expandedLineId: number | null
  /** Pre-assembled drill-down content for `expandedLineId`, computed server-side. */
  drilldown: FundingLineDrillDownData | null
}

export function FundingVsActual({ data, projectSelected, selectedSlug, expandedLineId, drilldown }: Props) {
  if (!projectSelected) {
    return (
      <EmptyState
        title="No project selected"
        description="Select a project to see its funding-vs-actual position."
      />
    )
  }

  if (!data) {
    return (
      <EmptyState
        title="No funding budget"
        description="This project doesn't have a lender funding budget loaded yet. Once one is imported, actual spend from confirmed invoices will be measured against it here."
      />
    )
  }

  const { project, lines, unmappedSpend, recon } = data

  // Data-completeness indicator: how much of the funding budget has actual spend
  // been ingested against, so far. This is a ratio of two engine-computed totals,
  // shown to explain an otherwise-misleading headline variance — not a new
  // financial figure.
  const completenessPct =
    project.totalFundingBudget > 0
      ? Math.min(100, Math.round((project.totalActualSpendAll / project.totalFundingBudget) * 1000) / 10)
      : null

  const worksLines = lines.filter((l) => l.section === "works")
  const feeLines = lines.filter((l) => l.section === "professional_fees")

  function lineHref(l: LineResult) {
    const isExpanded = expandedLineId === l.lineId
    const base = `/commercial?view=funding${selectedSlug ? `&project=${selectedSlug}` : ""}`
    return isExpanded ? base : `${base}&line=${l.lineId}`
  }

  const columns: Column<LineResult>[] = [
    {
      key: "description",
      header: "Description",
      render: (l) => (
        <Link
          href={lineHref(l)}
          className={cn(
            "inline-flex items-center gap-1 font-medium text-foreground hover:text-primary hover:underline",
            expandedLineId === l.lineId && "text-primary",
          )}
          aria-expanded={expandedLineId === l.lineId}
        >
          <ChevronRight
            className={cn("h-3.5 w-3.5 shrink-0 transition-transform", expandedLineId === l.lineId && "rotate-90")}
            aria-hidden
          />
          {l.description}
        </Link>
      ),
    },
    {
      key: "originalFundingBudget",
      header: "Original funding budget",
      align: "right",
      render: (l) => formatGBP(l.originalFundingBudget, { decimals: true }),
    },
    {
      key: "actualSpendToDate",
      header: "Actual spend to date",
      align: "right",
      render: (l) =>
        l.actualSpendToDate !== 0 ? (
          formatGBP(l.actualSpendToDate, { decimals: true })
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "varianceAmount",
      header: "Variance £",
      align: "right",
      render: (l) => (
        <span className={l.favourable ? "text-success" : "text-danger"}>
          {formatGBP(l.varianceAmount, { decimals: true })}
        </span>
      ),
    },
    {
      key: "variancePct",
      header: "Variance %",
      align: "right",
      render: (l) =>
        l.variancePct != null ? (
          <span className={l.favourable ? "text-success" : "text-danger"}>
            {l.variancePct.toFixed(1)}%
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "forecastFinalCost",
      header: "Forecast final cost",
      align: "right",
      render: (l) => (
        <div className="flex flex-col items-end">
          <span>{formatGBP(l.forecastFinalCost, { decimals: true })}</span>
          {!l.hasForecast ? (
            <span className="text-[11px] font-normal text-muted-foreground">no forecast entered</span>
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      {!recon.ok ? (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-bg p-4">
          <div className="flex items-center gap-2 text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            <h2 className="text-sm font-semibold">Funding schedule reconciliation failed</h2>
          </div>
          <p className="text-sm text-warning">
            The stored funding lines don't tie back to the schedule's control totals. This is flagged, not fixed —
            the lender baseline is never altered automatically.
          </p>
          <ul className="mt-1 flex flex-col gap-1 text-sm text-warning">
            {recon.checks
              .filter((c) => !c.ok)
              .map((c) => (
                <li key={c.label} className="tabular-nums">
                  <span className="font-medium">{c.label}:</span> expected{" "}
                  {c.expected != null ? formatGBP(c.expected, { decimals: true }) : "—"}, got{" "}
                  {formatGBP(c.actual, { decimals: true })}
                  {c.diff != null ? ` (diff ${formatGBP(c.diff, { decimals: true })})` : ""}
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Total funding budget" value={formatGBP(project.totalFundingBudget, { decimals: true })} />
        <MetricCard
          label="Actual spend to date"
          value={formatGBP(project.totalActualSpendAll, { decimals: true })}
          hint={completenessPct != null ? `${completenessPct}% of budget — data completeness, not performance` : undefined}
        />
        <MetricCard
          label={
            project.varianceLabel === "adverse"
              ? "Adverse funding variance"
              : project.varianceLabel === "on_budget"
                ? "Funding variance"
                : "Favourable funding variance"
          }
          value={formatGBP(project.favourableFundingVariance, { decimals: true })}
          hint="Headroom vs the lender allowance — not profit. Early in ingestion this reads misleadingly large; see data completeness above."
        />
        <MetricCard label="Forecast final cost" value={formatGBP(project.forecastFinalCost, { decimals: true })} />
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Works</h2>
          <span className="text-xs text-muted-foreground">
            Funding budget {formatGBP(project.totalWorksBudget, { decimals: true })}
          </span>
        </div>
        <DataTable
          columns={columns}
          data={worksLines}
          getRowKey={(l) => String(l.lineId)}
          caption="Works funding lines vs actual spend"
        />
        {drilldown && drilldown.line.section === "works" ? (
          <FundingLineDrillDown
            data={drilldown}
            closeHref={`/commercial?view=funding${selectedSlug ? `&project=${selectedSlug}` : ""}`}
          />
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Professional Fees</h2>
          <span className="text-xs text-muted-foreground">
            Funding budget {formatGBP(project.totalProfessionalFeesBudget, { decimals: true })}
          </span>
        </div>
        <DataTable
          columns={columns}
          data={feeLines}
          getRowKey={(l) => String(l.lineId)}
          caption="Professional fee funding lines vs actual spend"
        />
        {drilldown && drilldown.line.section === "professional_fees" ? (
          <FundingLineDrillDown
            data={drilldown}
            closeHref={`/commercial?view=funding${selectedSlug ? `&project=${selectedSlug}` : ""}`}
          />
        ) : null}
      </section>

      <section
        className={cn(
          "flex flex-col gap-2 rounded-lg border p-4",
          unmappedSpend !== 0 ? "border-info/40 bg-info-bg" : "border-border bg-card",
        )}
      >
        <div className="flex items-center gap-2">
          <Ban className={cn("h-4 w-4 shrink-0", unmappedSpend !== 0 ? "text-info" : "text-muted-foreground")} aria-hidden />
          <h2 className={cn("text-sm font-semibold", unmappedSpend !== 0 ? "text-info" : "text-foreground")}>
            Unmapped spend
          </h2>
          {unmappedSpend !== 0 ? <StatusBadge variant="info">Not attributed to any funding line</StatusBadge> : null}
        </div>
        <p className={cn("text-sm", unmappedSpend !== 0 ? "text-info" : "text-muted-foreground")}>
          Actual spend on cost packages that aren't mapped to a funding line. Some funding lines are deliberately
          left unresolved until attribution is certain, so this is a normal structural state — never silently
          folded into the totals above.
        </p>
        <span className={cn("text-2xl font-semibold tabular-nums", unmappedSpend !== 0 ? "text-info" : "text-foreground")}>
          {formatGBP(unmappedSpend, { decimals: true })}
        </span>
      </section>
    </div>
  )
}
