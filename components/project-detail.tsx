import Link from "next/link"
import { ChevronLeft, MapPin, Upload, ArrowUpRight, Layers, ReceiptText } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { StatusBadge, type StatusVariant } from "@/components/status-badge"
import { EmptyState } from "@/components/empty-state"
import { formatGBP, formatNumber } from "@/lib/utils"
import type { ProjectRow, CostPackageRow, InvoiceRow } from "@/lib/queries"

function statusVariant(status: string): StatusVariant {
  const s = status.toLowerCase()
  if (s.includes("site") || s.includes("progress") || s.includes("construction")) return "info"
  if (s.includes("appraisal") || s.includes("planning")) return "warning"
  if (s.includes("complete")) return "success"
  return "neutral"
}

function formatDate(d: string | null) {
  if (!d) return "—"
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export function ProjectDetail({
  project,
  packages,
  invoices,
}: {
  project: ProjectRow
  packages: CostPackageRow[]
  invoices: InvoiceRow[]
}) {
  const spendToDate = project.spendToDate
  const budget = project.originalBuildBudget
  const remainingBudget = budget != null ? budget - spendToDate : null
  const pctUsed = budget && budget > 0 ? Math.min(100, (spendToDate / budget) * 100) : null
  const packagesWithSpend = packages.filter((p) => p.committed > 0).length

  return (
    <>
      <PageHeader
        title={`${project.name}${project.location ? `, ${project.location}` : ""}`}
        description={
          [
            project.homes ? `${project.homes} homes` : null,
            project.buildAreaSqft ? `${formatNumber(project.buildAreaSqft)} sq ft` : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined
        }
        actions={
          <Link
            href={`/invoices/new?project=${project.slug}`}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Upload className="h-4 w-4" strokeWidth={1.75} />
            Upload invoice
          </Link>
        }
      >
        <Link
          href="/projects"
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
          Back to projects
        </Link>
      </PageHeader>

      <main className="flex flex-col gap-8 px-8 py-8">
        <div className="flex items-center gap-3">
          <StatusBadge variant={statusVariant(project.status)} dot>
            {project.status}
          </StatusBadge>
          {project.location ? (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <MapPin className="h-4 w-4" strokeWidth={1.75} />
              {project.location}
            </span>
          ) : null}
        </div>

        {/* Known facts */}
        <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Fact label="Homes" value={project.homes ? `${project.homes}` : "—"} />
          <Fact
            label="Build area"
            value={project.buildAreaSqft ? `${formatNumber(project.buildAreaSqft)} sq ft` : "—"}
          />
          <Fact label="Build budget" value={budget != null ? formatGBP(budget) : "—"} />
          <Fact
            label="Development facility"
            value={project.developmentFacility != null ? formatGBP(project.developmentFacility) : "—"}
          />
        </section>

        {/* Budget vs spend */}
        <section className="rounded-lg border border-border bg-card p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Build budget vs committed spend</h3>
            <span className="text-xs text-muted-foreground">
              {formatNumber(project.invoiceCount)} invoice{project.invoiceCount === 1 ? "" : "s"} ·{" "}
              {packagesWithSpend} of {packages.length} packages with spend
            </span>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <SpendStat label="Committed spend" value={formatGBP(spendToDate)} tone="foreground" />
            <SpendStat
              label="Remaining budget"
              value={remainingBudget != null ? formatGBP(remainingBudget) : "Set a budget"}
              tone={remainingBudget != null && remainingBudget < 0 ? "danger" : "success"}
            />
            <SpendStat
              label="Budget used"
              value={pctUsed != null ? `${pctUsed.toFixed(1)}%` : "—"}
              tone="foreground"
            />
          </div>

          {pctUsed != null ? (
            <div className="mt-5 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${pctUsed >= 100 ? "bg-danger" : "bg-accent"}`}
                style={{ width: `${pctUsed}%` }}
              />
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              No build budget set for this project yet. Set one on the{" "}
              <Link
                href={`/commercial?project=${project.slug}`}
                className="text-accent underline-offset-2 hover:underline"
              >
                Commercial
              </Link>{" "}
              page to track budget usage.
            </p>
          )}
        </section>

        {/* Cost packages */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Layers className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
              Cost packages
            </h3>
            <Link
              href={`/commercial?project=${project.slug}`}
              className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
            >
              Manage cost plan
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
            </Link>
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-4 py-2.5 text-left font-semibold">Package</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">Budget</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">Committed</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">Variance</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((pkg) => {
                  const variance = pkg.originalBudget != null ? pkg.originalBudget - pkg.committed : null
                  return (
                    <tr key={pkg.id} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-3">
                        <span className="text-xs text-muted-foreground tabular-nums">{pkg.code}</span>{" "}
                        <span className="font-medium text-foreground">{pkg.name}</span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                        {pkg.originalBudget != null ? formatGBP(pkg.originalBudget) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums text-foreground">
                        {pkg.committed > 0 ? formatGBP(pkg.committed) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {variance != null ? (
                          <span className={variance < 0 ? "text-danger" : "text-success"}>
                            {formatGBP(variance)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Recent invoices */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ReceiptText className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
              Recent invoices
            </h3>
            <Link
              href="/invoices"
              className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
            >
              All invoices
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
            </Link>
          </div>

          {invoices.length === 0 ? (
            <EmptyState
              icon={<ReceiptText className="h-5 w-5" strokeWidth={1.75} />}
              title="No invoices for this project yet"
              description="Upload a supplier invoice and assign it to this project to build up committed spend and price history."
              action={
                <Link
                  href={`/invoices/new?project=${project.slug}`}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  <Upload className="h-4 w-4" strokeWidth={1.75} />
                  Upload invoice
                </Link>
              }
            />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <th scope="col" className="px-4 py-2.5 text-left font-semibold">Date</th>
                    <th scope="col" className="px-4 py-2.5 text-left font-semibold">Supplier</th>
                    <th scope="col" className="px-4 py-2.5 text-left font-semibold">Invoice No.</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">Net</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">Gross</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="border-b border-border last:border-b-0">
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {formatDate(inv.invoiceDate)}
                      </td>
                      <td className="px-4 py-3 font-medium text-foreground">{inv.supplierName}</td>
                      <td className="px-4 py-3 text-muted-foreground">{inv.invoiceNumber ?? "—"}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatGBP(inv.net, { decimals: true })}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">
                        {formatGBP(inv.gross, { decimals: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold text-foreground tabular-nums">{value}</span>
    </div>
  )
}

function SpendStat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: "foreground" | "success" | "danger"
}) {
  const toneClass =
    tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-foreground"
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-xl font-semibold tabular-nums ${toneClass}`}>{value}</span>
    </div>
  )
}
