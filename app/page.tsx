import Link from "next/link"
import {
  Wallet,
  FileSignature,
  Banknote,
  ArrowRight,
  Upload,
  FolderKanban,
  Building2,
  Boxes,
  AlertTriangle,
  CircleCheck,
} from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { MetricCard } from "@/components/metric-card"
import { StatusBadge } from "@/components/status-badge"
import { getProjects, getPortfolioStats, getInvoices } from "@/lib/queries"
import { formatGBP, formatNumber } from "@/lib/utils"

export const dynamic = "force-dynamic"

type Attention = {
  id: string
  title: string
  detail: string
  href: string
  tone: "warning" | "info" | "success"
}

function formatDate(d: string | null) {
  if (!d) return "—"
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export default async function DashboardPage() {
  const [projects, stats, invoices] = await Promise.all([
    getProjects(),
    getPortfolioStats(),
    getInvoices(),
  ])

  const totalCommitted = projects.reduce((sum, p) => sum + p.spendToDate, 0)
  const leadProject =
    projects.find((p) => p.remainingDrawdown != null) ?? projects[0] ?? null

  // Derive attention items truthfully from the data we actually have.
  const attention: Attention[] = []
  const unassigned = invoices.filter((i) => !i.projectName)
  if (unassigned.length > 0) {
    attention.push({
      id: "unassigned-invoices",
      title: `${unassigned.length} invoice${unassigned.length === 1 ? "" : "s"} not assigned to a project`,
      detail: "Assign these to a project so their spend rolls into the cost plan.",
      href: "/invoices",
      tone: "warning",
    })
  }
  for (const p of projects) {
    if (p.originalBuildBudget != null && p.spendToDate > p.originalBuildBudget) {
      attention.push({
        id: `over-budget-${p.slug}`,
        title: `${p.name} is over build budget`,
        detail: `Committed ${formatGBP(p.spendToDate)} against a ${formatGBP(p.originalBuildBudget)} budget.`,
        href: `/projects/${p.slug}`,
        tone: "warning",
      })
    }
  }
  if (stats.invoiceCount === 0) {
    attention.push({
      id: "no-invoices",
      title: "No invoices captured yet",
      detail: "Upload your first supplier invoice to start building costs and price history.",
      href: "/invoices/new",
      tone: "info",
    })
  }

  return (
    <>
      <PageHeader
        title="Good afternoon, Tom"
        description="Live commercial position across Gilbert Build Co, built from captured invoices."
        actions={
          <Link
            href="/invoices/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Upload className="h-4 w-4" strokeWidth={1.75} />
            Upload invoice
          </Link>
        }
      />

      <main className="flex flex-col gap-8 px-4 py-8 sm:px-8">
        {/* Primary KPIs */}
        <section aria-labelledby="kpi-heading">
          <h2 id="kpi-heading" className="sr-only">
            Portfolio key figures
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Committed Cost"
              value={formatGBP(totalCommitted)}
              hint={`Across ${formatNumber(stats.invoiceCount)} confirmed invoice${stats.invoiceCount === 1 ? "" : "s"}`}
              icon={<FileSignature className="h-[18px] w-[18px]" strokeWidth={1.75} />}
            />
            <MetricCard
              label="Active Projects"
              value={String(stats.activeProjects)}
              hint={`${formatNumber(stats.projectCount)} total in portfolio`}
              icon={<FolderKanban className="h-[18px] w-[18px]" strokeWidth={1.75} />}
            />
            <MetricCard
              label="Suppliers"
              value={String(stats.supplierCount)}
              hint={`${formatNumber(stats.productCount)} products priced`}
              icon={<Building2 className="h-[18px] w-[18px]" strokeWidth={1.75} />}
            />
            <MetricCard
              label="Next Drawdown"
              value={
                leadProject?.remainingDrawdown != null
                  ? formatGBP(leadProject.remainingDrawdown, { decimals: true })
                  : "—"
              }
              hint={
                leadProject?.remainingDrawdown != null
                  ? `Remaining development drawdown · ${leadProject.name}`
                  : "No drawdown recorded"
              }
              icon={<Banknote className="h-[18px] w-[18px]" strokeWidth={1.75} />}
            />
          </div>
        </section>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          {/* Attention Required */}
          <section aria-labelledby="attention-heading" className="xl:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2
                id="attention-heading"
                className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Attention Required
              </h2>
              <span className="text-xs text-muted-foreground">{attention.length} items</span>
            </div>
            <div className="rounded-lg border border-border bg-card">
              {attention.length === 0 ? (
                <div className="flex items-center gap-3 px-5 py-6 text-sm text-muted-foreground">
                  <CircleCheck className="h-5 w-5 text-success" strokeWidth={1.75} />
                  Nothing needs your attention right now.
                </div>
              ) : (
                attention.map((item) => (
                  <Link
                    key={item.id}
                    href={item.href}
                    className="flex items-start gap-3 border-b border-border px-5 py-4 transition-colors last:border-b-0 hover:bg-muted/50"
                  >
                    <span
                      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                        item.tone === "warning"
                          ? "bg-warning-bg text-warning"
                          : item.tone === "success"
                            ? "bg-success-bg text-success"
                            : "bg-info-bg text-info"
                      }`}
                    >
                      <AlertTriangle className="h-4 w-4" strokeWidth={1.75} />
                    </span>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">{item.title}</span>
                      <span className="text-sm text-muted-foreground">{item.detail}</span>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </section>

          {/* Project Performance */}
          <section aria-labelledby="performance-heading">
            <div className="mb-3 flex items-center justify-between">
              <h2
                id="performance-heading"
                className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Project Performance
              </h2>
            </div>
            {leadProject ? (
              <div className="flex flex-col rounded-lg border border-border bg-card p-5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-base font-semibold text-foreground">{leadProject.name}</h3>
                    {leadProject.location ? (
                      <p className="text-sm text-muted-foreground">{leadProject.location}</p>
                    ) : null}
                  </div>
                  <StatusBadge variant="info" dot>
                    {leadProject.status}
                  </StatusBadge>
                </div>

                <dl className="mt-5 flex flex-col divide-y divide-border">
                  {leadProject.homes ? (
                    <PerfRow label="Homes" value={`${leadProject.homes} homes`} />
                  ) : null}
                  {leadProject.buildAreaSqft ? (
                    <PerfRow
                      label="Total build area"
                      value={`${formatNumber(leadProject.buildAreaSqft)} sq ft`}
                    />
                  ) : null}
                  {leadProject.originalBuildBudget != null ? (
                    <PerfRow label="Build budget" value={formatGBP(leadProject.originalBuildBudget)} />
                  ) : null}
                  <PerfRow label="Committed spend" value={formatGBP(leadProject.spendToDate)} />
                  {leadProject.originalBuildBudget != null ? (
                    <PerfRow
                      label="Remaining budget"
                      value={formatGBP(leadProject.originalBuildBudget - leadProject.spendToDate)}
                    />
                  ) : null}
                </dl>

                <Link
                  href={`/projects/${leadProject.slug}`}
                  className="mt-5 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  Open project
                  <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
                </Link>
              </div>
            ) : (
              <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-6">
                <Boxes className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
                <p className="text-sm text-muted-foreground">
                  No projects yet. Create your first development to start tracking performance.
                </p>
                <Link
                  href="/projects/new"
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  New project
                </Link>
              </div>
            )}
          </section>
        </div>

        {/* Recent invoices */}
        <section aria-labelledby="recent-heading">
          <div className="mb-3 flex items-center justify-between">
            <h2
              id="recent-heading"
              className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Recent Invoices
            </h2>
            <Link href="/invoices" className="text-xs font-medium text-accent hover:underline">
              View all
            </Link>
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {invoices.length === 0 ? (
              <div className="px-5 py-6 text-sm text-muted-foreground">
                No invoices captured yet.{" "}
                <Link href="/invoices/new" className="text-accent hover:underline">
                  Upload one
                </Link>{" "}
                to get started.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="px-4 py-2.5 text-left font-semibold">Date</th>
                      <th scope="col" className="px-4 py-2.5 text-left font-semibold">Supplier</th>
                      <th scope="col" className="px-4 py-2.5 text-left font-semibold">Project</th>
                      <th scope="col" className="px-4 py-2.5 text-right font-semibold">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.slice(0, 6).map((inv) => (
                      <tr key={inv.id} className="border-b border-border last:border-b-0">
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                          {formatDate(inv.invoiceDate)}
                        </td>
                        <td className="px-4 py-3 font-medium text-foreground">{inv.supplierName}</td>
                        <td className="px-4 py-3 text-muted-foreground">{inv.projectName ?? "Unassigned"}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatGBP(inv.net, { decimals: true })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </main>
    </>
  )
}

function PerfRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-foreground tabular-nums">{value}</dd>
    </div>
  )
}
