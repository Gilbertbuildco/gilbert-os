import Link from "next/link"
import { X, ArrowUpRight, AlertTriangle } from "lucide-react"
import { cn, formatGBP } from "@/lib/utils"
import { DataTable, type Column } from "@/components/data-table"
import { MetricCard } from "@/components/metric-card"
import { StatusBadge } from "@/components/status-badge"
import { EmptyState } from "@/components/empty-state"
import { round2, type LineResult } from "@/lib/funding/calculations"
import type { PackageLineItemRow } from "@/lib/queries"

/** One funding line's apportioned share of a package's actual spend. */
export type LineShare = {
  lineId: number
  description: string
  amount: number
  /** Share of the package's spend, as a percentage. Null only if the package has £0 spend. */
  pct: number | null
  isTargetLine: boolean
}

export type ApportionmentBasis = "direct" | "weighted" | "amount_proportion" | "equal"

export type PackageBreakdown = {
  costPackageId: number
  code: string | null
  name: string
  /** This package's total actual spend (same figure the funding engine apportions from). */
  totalSpend: number
  basis: ApportionmentBasis
  shares: LineShare[]
}

export type FundingLineDrillDownData = {
  line: LineResult
  packages: PackageBreakdown[]
  lineItems: PackageLineItemRow[]
}

interface Props {
  data: FundingLineDrillDownData
  closeHref: string
}

function formatDate(d: string | null) {
  if (!d) return null
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

const BASIS_LABEL: Record<ApportionmentBasis, string> = {
  direct: "Directly attributed — this cost package maps only to this funding line, so every penny of its spend belongs here.",
  weighted: "Split across the mapped funding lines by a manually set apportionment weight, not by spend.",
  amount_proportion:
    "Split across the mapped funding lines in proportion to each line's own original lender allowance (no manual weight is set).",
  equal: "Split equally across the mapped funding lines (no weight or allowance basis is available).",
}

const RECON_TOLERANCE = 0.01

/** Read-only explain view for one funding line: how its actual-spend figure was built. */
export function FundingLineDrillDown({ data, closeHref }: Props) {
  const { line, packages, lineItems } = data

  const lineItemColumns: Column<PackageLineItemRow>[] = [
    {
      key: "description",
      header: "Description",
      render: (li) => <span className="text-foreground">{li.description}</span>,
    },
    {
      key: "supplier",
      header: "Supplier",
      render: (li) => <span className="text-muted-foreground">{li.supplierName}</span>,
    },
    {
      key: "invoice",
      header: "Invoice",
      render: (li) =>
        li.invoiceNumber ? (
          <Link
            href={`/invoices?q=${encodeURIComponent(li.invoiceNumber)}`}
            className="inline-flex items-center gap-1 text-info hover:underline"
          >
            {li.invoiceNumber}
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </Link>
        ) : (
          <span className="text-muted-foreground">— no invoice number recorded</span>
        ),
    },
    {
      key: "date",
      header: "Date",
      render: (li) => <span className="text-muted-foreground">{formatDate(li.invoiceDate) ?? "—"}</span>,
    },
    {
      key: "net",
      header: "Net",
      align: "right",
      render: (li) => formatGBP(li.lineNet, { decimals: true }),
    },
  ]

  const totalOfShares = round2(packages.reduce((s, pkg) => s + (pkg.shares.find((sh) => sh.isTargetLine)?.amount ?? 0), 0))
  const lineTotalReconciles = Math.abs(totalOfShares - line.actualSpendToDate) <= RECON_TOLERANCE * Math.max(1, packages.length)

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-primary/30 bg-card p-5"
      aria-label={`Drill-down for ${line.description}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Funding line detail</p>
          <h2 className="text-base font-semibold text-foreground">{line.description}</h2>
        </div>
        <Link
          href={closeHref}
          aria-label="Close drill-down"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden />
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Original funding budget" value={formatGBP(line.originalFundingBudget, { decimals: true })} />
        <MetricCard label="Actual spend to date" value={formatGBP(line.actualSpendToDate, { decimals: true })} />
        <MetricCard
          label={line.favourable ? "Favourable variance" : "Adverse variance"}
          value={formatGBP(line.varianceAmount, { decimals: true })}
          hint={line.variancePct != null ? `${line.variancePct.toFixed(1)}%` : undefined}
        />
        <MetricCard
          label="Forecast final cost"
          value={formatGBP(line.forecastFinalCost, { decimals: true })}
          hint={!line.hasForecast ? "no forecast entered" : undefined}
        />
      </div>

      {packages.length === 0 ? (
        <EmptyState
          title="Not mapped to a cost package"
          description="This funding line has no cost-package mapping yet, so no actual spend can be attributed to it. The figures above reflect that — a genuine unmapped state, not a computed zero."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {packages.map((pkg) => {
            const pkgLineItems = lineItems.filter((li) => li.costPackageId === pkg.costPackageId)
            const itemsTotal = round2(pkgLineItems.reduce((s, li) => s + li.lineNet, 0))
            const itemsReconcile = Math.abs(itemsTotal - pkg.totalSpend) <= RECON_TOLERANCE
            const shared = pkg.shares.length > 1

            return (
              <div key={pkg.costPackageId} className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">
                      Cost package {pkg.code ? `${pkg.code} · ` : ""}
                      {pkg.name}
                    </h3>
                    <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">{BASIS_LABEL[pkg.basis]}</p>
                  </div>
                  {shared ? (
                    <StatusBadge variant="warning">
                      Shared with {pkg.shares.length - 1} other funding line{pkg.shares.length - 1 === 1 ? "" : "s"}
                    </StatusBadge>
                  ) : (
                    <StatusBadge variant="success">Directly attributed</StatusBadge>
                  )}
                </div>

                {shared ? (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium text-warning">
                      This package's spend is a proportional share here, not a direct attribution — see the split below.
                    </p>
                    <div className="overflow-hidden rounded-md border border-border">
                      <table className="w-full border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-border bg-muted text-[11px] uppercase tracking-wide text-muted-foreground">
                            <th scope="col" className="px-3 py-2 text-left font-semibold">Funding line</th>
                            <th scope="col" className="px-3 py-2 text-right font-semibold">Share</th>
                            <th scope="col" className="px-3 py-2 text-right font-semibold">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pkg.shares.map((s) => (
                            <tr
                              key={s.lineId}
                              className={cn("border-b border-border last:border-b-0", s.isTargetLine && "bg-primary/5")}
                            >
                              <td className="px-3 py-2 text-foreground">
                                {s.description}
                                {s.isTargetLine ? (
                                  <span className="ml-2 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                                    This line
                                  </span>
                                ) : null}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                                {s.pct != null ? `${s.pct.toFixed(1)}%` : "—"}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-foreground">
                                {formatGBP(s.amount, { decimals: true })}
                              </td>
                            </tr>
                          ))}
                          <tr className="bg-muted/40">
                            <td className="px-3 py-2 font-medium text-foreground">Package spend total</td>
                            <td className="px-3 py-2 text-right text-muted-foreground">100%</td>
                            <td className="px-3 py-2 text-right font-semibold tabular-nums text-foreground">
                              {formatGBP(pkg.totalSpend, { decimals: true })}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                <DataTable
                  columns={lineItemColumns}
                  data={pkgLineItems}
                  getRowKey={(li) => String(li.id)}
                  caption={`Confirmed line items in ${pkg.name}`}
                  emptyState={
                    <p className="text-center text-sm text-muted-foreground">
                      No confirmed line items in this package yet.
                    </p>
                  }
                />

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {pkgLineItems.length} line item{pkgLineItems.length === 1 ? "" : "s"} shown, totalling{" "}
                    <span className="font-medium text-foreground">{formatGBP(itemsTotal, { decimals: true })}</span>
                  </span>
                  {itemsReconcile ? (
                    <span className="text-success">Reconciles with package spend above</span>
                  ) : (
                    <span className="flex items-center gap-1 text-warning">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                      Shown items total {formatGBP(itemsTotal, { decimals: true })} vs package spend{" "}
                      {formatGBP(pkg.totalSpend, { decimals: true })} — flagged, not corrected.
                    </span>
                  )}
                </div>
              </div>
            )
          })}

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              This line&apos;s share across {packages.length === 1 ? "its mapped package" : "all its mapped packages"} above
            </span>
            <div className="flex items-center gap-3">
              <span className="font-semibold tabular-nums text-foreground">{formatGBP(totalOfShares, { decimals: true })}</span>
              {lineTotalReconciles ? (
                <StatusBadge variant="success">Matches actual spend to date</StatusBadge>
              ) : (
                <StatusBadge variant="warning">
                  Differs from {formatGBP(line.actualSpendToDate, { decimals: true })} above
                </StatusBadge>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
