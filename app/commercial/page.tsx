import Link from "next/link"
import { PageHeader } from "@/components/page-header"
import { FundingVsActual } from "@/components/funding-vs-actual"
import { QuotesVsActualView } from "@/components/quotes-vs-actual"
import { CashPositionView } from "@/components/cash-position-view"
import { GoldentreeView } from "@/components/goldentree-view"
import type {
  FundingLineDrillDownData,
  PackageBreakdown,
  ApportionmentBasis,
  LineDrawdownAllocation,
} from "@/components/funding-line-drilldown"
import { cn } from "@/lib/utils"
import {
  getProjectOptions,
  getProjectBySlug,
  getCostPackageOptions,
  getLineItemsForCostPackages,
  getQuotesVsActual,
} from "@/lib/queries"
import { getFundingCommercial, getDrawdownEvents, type DrawdownEvent } from "@/lib/funding/queries"
import { getCashPosition } from "@/lib/funding/cash-position"
import { getGoldentreeSchedule } from "@/lib/funding/goldentree"
import { applyLineGroups, EXTRA_CATEGORIES } from "@/lib/funding/line-groups"
import { getExtraCategorySpend } from "@/lib/funding/extra-categories"
import { apportionSpend, type FundingLineInput, type MappingInput } from "@/lib/funding/calculations"

export const dynamic = "force-dynamic"

type CommercialTab = "funding" | "quotes" | "cash" | "goldentree"

/**
 * Same classification `apportionSpend`'s internal share logic uses (single
 * edge → direct; all edges weighted → weighted; else original-amount
 * proportion; else equal). This mirrors that DECISION only — the actual
 * arithmetic always comes from `apportionSpend` itself, never a second
 * calculation of the split.
 */
function classifyBasis(edges: MappingInput[], lineById: Map<number, FundingLineInput>): ApportionmentBasis {
  if (edges.length <= 1) return "direct"
  const allWeighted = edges.every((e) => e.weight != null && e.weight > 0)
  if (allWeighted) return "weighted"
  const sum = edges.reduce((a, e) => a + Math.abs(lineById.get(e.fundingBudgetLineId)?.originalAmount ?? 0), 0)
  return sum > 0 ? "amount_proportion" : "equal"
}

export default async function CommercialPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; view?: string; line?: string }>
}) {
  const { project, view, line } = await searchParams
  const projects = await getProjectOptions()
  const tab: CommercialTab =
    view === "quotes" ? "quotes" : view === "cash" ? "cash" : view === "goldentree" ? "goldentree" : "funding"

  const selectedSlug = project ?? projects[0]?.slug ?? null
  const selected = selectedSlug ? await getProjectBySlug(selectedSlug) : null


  const fundingRaw = selected && tab === "funding" ? await getFundingCommercial(selected.id) : null
  /**
   * First/second fix plumbing and electrical are one trade each to the owner,
   * and the lender's split made both read wrongly — first fix carried the whole
   * spend while second fix sat untouched (and Second Fix Electrical has a £0
   * allowance because Goldentree folded it into first fix).
   *
   * Display only: the underlying rows, and the Goldentree tab that mirrors the
   * lender's document, are untouched (non-negotiable #2). Drill-down still
   * targets a real line id, so expanding a grouped row opens its first member.
   */
  // Categories the owner tracks that the lender's schedule does not carry.
  // Appended here, never written to funding_budget_lines, so the Goldentree tab
  // continues to mirror their document exactly.
  const extraSpend = fundingRaw ? await getExtraCategorySpend(selected!.id) : new Map<string, number>()
  const extraLines = fundingRaw
    ? EXTRA_CATEGORIES.map((e, i) => {
        const spent = extraSpend.get(e.key) ?? 0
        const budget = e.budget ?? 0
        return {
          lineId: -1 - i, section: "professional_fees" as const, description: e.description,
          originalFundingBudget: budget, actualSpendToDate: spent, committedCost: spent,
          varianceAmount: budget - spent, variancePct: budget > 0 ? ((budget - spent) / budget) * 100 : null,
          favourable: budget - spent >= 0, forecastCostToComplete: 0, hasForecast: false,
          forecastFinalCost: spent, forecastFinalVariance: budget - spent,
          workCompletePct: null, fundingEarned: null, fundingCertified: null, fundingDrawn: null,
          fundingRemaining: null, amountSpentNotYetFunded: null, amountFundedAheadOfCost: null,
        }
      })
    : []

  const funding = fundingRaw
    ? { ...fundingRaw, lines: [...applyLineGroups(fundingRaw.lines, [
        "originalFundingBudget", "actualSpendToDate", "committedCost", "varianceAmount",
        "forecastCostToComplete", "forecastFinalCost", "forecastFinalVariance",
        "fundingEarned", "fundingCertified", "fundingDrawn", "fundingRemaining",
        "amountSpentNotYetFunded", "amountFundedAheadOfCost",
      ]), ...extraLines] }
    : null
  const drawdownEvents: DrawdownEvent[] = funding ? await getDrawdownEvents(funding.budget.id) : []
  const quotesVsActual = selected && tab === "quotes" ? await getQuotesVsActual(selected.id) : null
  const cashPosition = selected && tab === "cash" ? await getCashPosition(selected.id) : null
  const goldentree = selected && tab === "goldentree" ? await getGoldentreeSchedule(selected.id) : null

  const expandedLineId = tab === "funding" && line != null && line.trim() !== "" ? Number(line) : null
  let drilldown: FundingLineDrillDownData | null = null

  if (funding && selected && expandedLineId != null && Number.isFinite(expandedLineId)) {
    const targetLine = funding.lines.find((l) => l.lineId === expandedLineId) ?? null
    if (targetLine) {
      const packageIds = [
        ...new Set(funding.mappings.filter((m) => m.fundingBudgetLineId === expandedLineId).map((m) => m.costPackageId)),
      ]

      const [packageOptions, packageLineItems] = await Promise.all([
        packageIds.length > 0 ? getCostPackageOptions(selected.id) : Promise.resolve([]),
        getLineItemsForCostPackages(packageIds),
      ])

      const lineInputsAll: FundingLineInput[] = funding.lines.map((l) => ({
        id: l.lineId,
        section: l.section,
        description: l.description,
        originalAmount: l.originalFundingBudget,
      }))
      const lineById = new Map(lineInputsAll.map((l) => [l.id, l]))

      const packageBreakdown: PackageBreakdown[] = packageIds.map((pkgId) => {
        const pkgSpend = funding.packages.find((p) => p.costPackageId === pkgId)?.actualSpend ?? 0
        const edges = funding.mappings.filter((m) => m.costPackageId === pkgId)
        // Reuse the real engine function — never a separate calculation of the split.
        const { byLine } = apportionSpend(lineInputsAll, [{ costPackageId: pkgId, actualSpend: pkgSpend }], edges)
        const pkgOption = packageOptions.find((p) => p.id === pkgId)

        return {
          costPackageId: pkgId,
          code: pkgOption?.code ?? null,
          name: pkgOption?.name ?? `Cost package ${pkgId}`,
          totalSpend: pkgSpend,
          basis: classifyBasis(edges, lineById),
          shares: edges.map((e) => {
            const amount = byLine.get(e.fundingBudgetLineId) ?? 0
            return {
              lineId: e.fundingBudgetLineId,
              description: lineById.get(e.fundingBudgetLineId)?.description ?? `Funding line ${e.fundingBudgetLineId}`,
              amount,
              pct: pkgSpend !== 0 ? (amount / pkgSpend) * 100 : null,
              isTargetLine: e.fundingBudgetLineId === expandedLineId,
            }
          }),
        }
      })

      // This line's share of every drawdown event that allocated to it, in schedule order —
      // reads straight off the same events shown in the timeline below, never recomputed.
      const drawdownHistory: LineDrawdownAllocation[] = drawdownEvents
        .flatMap((event) =>
          event.allocations
            .filter((a) => a.fundingBudgetLineId === expandedLineId)
            .map((a) => ({
              eventId: event.id,
              eventLabel: event.label,
              eventDate: event.eventDate,
              receivedDate: event.receivedDate,
              amount: a.amount,
              directPayment: event.directPayment,
              cashReceived: event.cashReceived,
            })),
        )

      drilldown = { line: targetLine, packages: packageBreakdown, lineItems: packageLineItems, drawdownHistory }
    }
  }

  return (
    <>
      <PageHeader
        title="Commercial"
        description="Cost plan by package for each project. Set original budgets and watch committed spend roll up automatically from confirmed invoices."
      />
      <div className="overflow-x-auto px-4 pt-6 sm:px-8">
        <div role="tablist" aria-label="Commercial view" className="inline-flex gap-1 rounded-lg border border-border bg-card p-1">
          <Link
            href={`/commercial${selectedSlug ? `?project=${selectedSlug}` : ""}`}
            role="tab"
            aria-selected={tab === "funding"}
            className={cn(
              "flex min-h-10 items-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === "funding"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Funding vs Actual
          </Link>
          <Link
            href={`/commercial?view=quotes${selectedSlug ? `&project=${selectedSlug}` : ""}`}
            role="tab"
            aria-selected={tab === "quotes"}
            className={cn(
              "flex min-h-10 items-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === "quotes"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Quotes
          </Link>
          <Link
            href={`/commercial?view=cash${selectedSlug ? `&project=${selectedSlug}` : ""}`}
            role="tab"
            aria-selected={tab === "cash"}
            className={cn(
              "flex min-h-10 items-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === "cash"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Cash Position
          </Link>
          <Link
            href={`/commercial?view=goldentree${selectedSlug ? `&project=${selectedSlug}` : ""}`}
            role="tab"
            aria-selected={tab === "goldentree"}
            className={cn(
              "flex min-h-10 items-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === "goldentree"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Goldentree
          </Link>
        </div>
      </div>

      {tab === "goldentree" ? (
        <main className="flex flex-col gap-6 px-4 py-8 sm:px-8">
          {goldentree ? <GoldentreeView g={goldentree} /> : (
            <p className="text-sm text-muted-foreground">No funding budget recorded for this project.</p>
          )}
        </main>
      ) : tab === "cash" ? (
        <main className="flex flex-col gap-6 px-4 py-8 sm:px-8">
          {cashPosition ? (
            <CashPositionView p={cashPosition} />
          ) : (
            <p className="text-sm text-muted-foreground">
              No funding budget recorded for this project, so there is nothing to draw against.
            </p>
          )}
        </main>
      ) : tab === "quotes" ? (
        <main className="flex flex-col gap-6 px-4 py-8 sm:px-8">
          {projects.length > 1 ? (
            <div role="tablist" aria-label="Project" className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1">
              {projects.map((p) => (
                <Link
                  key={p.id}
                  href={`/commercial?view=quotes&project=${p.slug}`}
                  role="tab"
                  aria-selected={p.slug === selectedSlug}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    p.slug === selectedSlug
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p.name}
                </Link>
              ))}
            </div>
          ) : null}
          <QuotesVsActualView data={quotesVsActual} projectSelected={!!selected} />
        </main>
      ) : (
        <main className="flex flex-col gap-6 px-4 py-8 sm:px-8">
          {projects.length > 1 ? (
            <div role="tablist" aria-label="Project" className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1">
              {projects.map((p) => (
                <Link
                  key={p.id}
                  href={`/commercial?view=funding&project=${p.slug}`}
                  role="tab"
                  aria-selected={p.slug === selectedSlug}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    p.slug === selectedSlug
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p.name}
                </Link>
              ))}
            </div>
          ) : null}
          <FundingVsActual
            data={funding}
            projectSelected={!!selected}
            selectedSlug={selectedSlug}
            expandedLineId={expandedLineId}
            drilldown={drilldown}
            drawdownEvents={drawdownEvents}
          />
        </main>
      )}
    </>
  )
}
