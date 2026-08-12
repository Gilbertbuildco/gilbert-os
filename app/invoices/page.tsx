import { Suspense } from "react"
import Link from "next/link"
import { Upload, ReceiptText, ChevronUp, ChevronDown, FileWarning } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { StatusBadge } from "@/components/status-badge"
import { InvoiceViewCell } from "@/components/invoice-view-cell"
import { InvoiceFilterBar } from "@/components/invoice-filter-bar"
import { MetricCard } from "@/components/metric-card"
import {
  getInvoices,
  getInvoiceSummary,
  getInvoiceSupplierOptions,
  getProjectOptions,
  type InvoiceListFilters,
  type InvoiceRow,
  type InvoiceSort,
  type SortDirection,
} from "@/lib/queries"
import { cn, formatGBP, formatNumber } from "@/lib/utils"

export const dynamic = "force-dynamic"

const PAGE_SIZE = 50
const SORT_COLUMNS: InvoiceSort[] = ["date", "supplier", "number", "net", "gross"]

type SearchParams = {
  q?: string
  supplier?: string
  project?: string
  from?: string
  to?: string
  type?: string
  review?: string
  unclassified?: string
  sort?: string
  dir?: string
  page?: string
}

function formatDate(d: string | null) {
  if (!d) return "—"
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

function toId(v?: string): number | undefined {
  if (!v) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Full filter set for the current view, driven entirely by the URL. */
function parseFilters(sp: SearchParams): InvoiceListFilters {
  return {
    search: sp.q?.trim() || undefined,
    supplierId: toId(sp.supplier),
    projectId: toId(sp.project),
    dateFrom: sp.from || undefined,
    dateTo: sp.to || undefined,
    transactionType: sp.type === "invoice" ? "invoice" : sp.type === "credit" ? "credit" : undefined,
    needsReview: sp.review === "1" ? true : undefined,
    unclassifiedOnly: sp.unclassified === "1" ? true : undefined,
  }
}

/** What the workflow chips (Needs review / Unclassified / Credits) sit on top of. */
function parseBaseFilters(sp: SearchParams): InvoiceListFilters {
  return {
    search: sp.q?.trim() || undefined,
    supplierId: toId(sp.supplier),
    projectId: toId(sp.project),
    dateFrom: sp.from || undefined,
    dateTo: sp.to || undefined,
  }
}

/** Builds an /invoices href from the current params plus a patch, dropping empty values. */
function hrefFor(sp: SearchParams, patch: Partial<SearchParams>, opts: { resetPage?: boolean } = {}) {
  const merged: SearchParams = { ...sp, ...patch }
  if (opts.resetPage !== false) delete merged.page
  const next = new URLSearchParams()
  for (const [key, value] of Object.entries(merged)) {
    if (value) next.set(key, value)
  }
  const qs = next.toString()
  return qs ? `/invoices?${qs}` : "/invoices"
}

function sortHref(sp: SearchParams, column: InvoiceSort, currentSort: InvoiceSort, currentDir: SortDirection) {
  const nextDir: SortDirection =
    currentSort === column
      ? currentDir === "asc"
        ? "desc"
        : "asc"
      : column === "supplier" || column === "number"
        ? "asc"
        : "desc"
  return hrefFor(sp, { sort: column, dir: nextDir })
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const filters = parseFilters(sp)
  const baseFilters = parseBaseFilters(sp)
  const sort: InvoiceSort = SORT_COLUMNS.includes(sp.sort as InvoiceSort) ? (sp.sort as InvoiceSort) : "date"
  const direction: SortDirection = sp.dir === "asc" ? "asc" : "desc"
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1)

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Capture supplier invoices to feed both project costs and procurement price history."
        actions={
          <Link
            href="/invoices/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Upload className="h-4 w-4" strokeWidth={1.75} />
            Upload Invoice
          </Link>
        }
      />
      <main className="flex flex-col gap-5 px-8 py-8">
        <Suspense fallback={<SummarySkeleton />}>
          <SummarySection sp={sp} filters={filters} baseFilters={baseFilters} />
        </Suspense>

        <Suspense fallback={<FilterBarSkeleton />}>
          <FilterOptionsSection />
        </Suspense>

        <Suspense fallback={<TableSkeleton />}>
          <TableSection sp={sp} filters={filters} sort={sort} direction={direction} page={page} />
        </Suspense>
      </main>
    </>
  )
}

async function SummarySection({
  sp,
  filters,
  baseFilters,
}: {
  sp: SearchParams
  filters: InvoiceListFilters
  baseFilters: InvoiceListFilters
}) {
  const [summary, allSummary, reviewSummary, unclassifiedSummary, creditsSummary] = await Promise.all([
    getInvoiceSummary(filters),
    getInvoiceSummary(baseFilters),
    getInvoiceSummary({ ...baseFilters, needsReview: true }),
    getInvoiceSummary({ ...baseFilters, unclassifiedOnly: true }),
    getInvoiceSummary({ ...baseFilters, transactionType: "credit" }),
  ])

  const activeChip: "all" | "review" | "unclassified" | "credits" =
    sp.review === "1" ? "review" : sp.unclassified === "1" ? "unclassified" : sp.type === "credit" ? "credits" : "all"

  const chips = [
    {
      key: "all" as const,
      label: "All",
      count: allSummary.count,
      href: hrefFor(sp, { review: undefined, unclassified: undefined, type: undefined }),
    },
    {
      key: "review" as const,
      label: "Needs review",
      count: reviewSummary.count,
      href: hrefFor(sp, { review: "1", unclassified: undefined, type: undefined }),
    },
    {
      key: "unclassified" as const,
      label: "Unclassified",
      count: unclassifiedSummary.count,
      href: hrefFor(sp, { unclassified: "1", review: undefined, type: undefined }),
    },
    {
      key: "credits" as const,
      label: "Credits",
      count: creditsSummary.count,
      href: hrefFor(sp, { type: "credit", review: undefined, unclassified: undefined }),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Invoices" value={formatNumber(summary.count)} hint={`${formatNumber(summary.needsReviewCount)} need review`} />
        <MetricCard label="Net spend" value={formatGBP(summary.totalNet, { decimals: true })} />
        <MetricCard
          label="Gross spend"
          value={formatGBP(summary.totalGross, { decimals: true })}
          hint={`VAT ${formatGBP(summary.totalVat, { decimals: true })}`}
        />
        <MetricCard
          label="Unclassified net"
          value={formatGBP(summary.unclassifiedNet, { decimals: true })}
          hint={summary.unclassifiedNet > 0 ? "Not yet attributed to a cost package" : "Fully classified"}
          icon={summary.unclassifiedNet > 0 ? <FileWarning className="h-4 w-4" strokeWidth={1.75} /> : undefined}
          className={summary.unclassifiedNet > 0 ? "border-warning/40 bg-warning-bg" : undefined}
        />
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Invoice workflow filter">
        {chips.map((chip) => (
          <Link
            key={chip.key}
            href={chip.href}
            role="tab"
            aria-selected={activeChip === chip.key}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              activeChip === chip.key
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {chip.label}
            <span
              className={cn(
                "tabular-nums",
                activeChip === chip.key ? "text-primary-foreground/80" : "text-muted-foreground",
              )}
            >
              {formatNumber(chip.count)}
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}

async function FilterOptionsSection() {
  const [supplierOptions, projectOptions] = await Promise.all([getInvoiceSupplierOptions(), getProjectOptions()])
  return <InvoiceFilterBar supplierOptions={supplierOptions} projectOptions={projectOptions} />
}

async function TableSection({
  sp,
  filters,
  sort,
  direction,
  page,
}: {
  sp: SearchParams
  filters: InvoiceListFilters
  sort: InvoiceSort
  direction: SortDirection
  page: number
}) {
  const offset = (page - 1) * PAGE_SIZE
  const [invoices, summary] = await Promise.all([
    getInvoices({ ...filters, sort, direction, limit: PAGE_SIZE, offset }),
    getInvoiceSummary(filters),
  ])

  const hasFilters = Object.values(filters).some((v) => v !== undefined)

  if (summary.count === 0) {
    return hasFilters ? (
      <EmptyState
        icon={<ReceiptText className="h-5 w-5" strokeWidth={1.75} />}
        title="No invoices match these filters"
        description="Try widening the date range, clearing a filter, or searching a different term."
        action={
          <Link
            href="/invoices"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Clear filters
          </Link>
        }
      />
    ) : (
      <EmptyState
        icon={<ReceiptText className="h-5 w-5" strokeWidth={1.75} />}
        title="No invoices recorded yet"
        description="Upload your first invoice. Once ingested, invoices automatically update project cost packages and refresh procurement price history for the relevant supplier and products."
        action={
          <Link
            href="/invoices/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Upload className="h-4 w-4" strokeWidth={1.75} />
            Upload Invoice
          </Link>
        }
      />
    )
  }

  const totalPages = Math.max(1, Math.ceil(summary.count / PAGE_SIZE))
  const columns: { key: InvoiceSort | null; label: string; align?: "right" }[] = [
    { key: "date", label: "Date" },
    { key: "supplier", label: "Supplier" },
    { key: "number", label: "Invoice No." },
    { key: null, label: "Project" },
    { key: null, label: "Lines", align: "right" },
    { key: "net", label: "Net", align: "right" },
    { key: null, label: "VAT", align: "right" },
    { key: "gross", label: "Gross", align: "right" },
    { key: null, label: "Status" },
    { key: null, label: "Source" },
  ]

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Showing {formatNumber(offset + 1)}–{formatNumber(Math.min(offset + PAGE_SIZE, summary.count))} of{" "}
        {formatNumber(summary.count)} invoices
      </p>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                {columns.map((col) => (
                  <th
                    key={col.label}
                    scope="col"
                    className={cn(
                      "whitespace-nowrap px-4 py-2.5 font-semibold",
                      col.align === "right" ? "text-right" : "text-left",
                    )}
                  >
                    {col.key ? (
                      <Link
                        href={sortHref(sp, col.key, sort, direction)}
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground",
                          col.align === "right" && "flex-row-reverse",
                        )}
                      >
                        {col.label}
                        {sort === col.key ? (
                          direction === "asc" ? (
                            <ChevronUp className="h-3 w-3" strokeWidth={2} />
                          ) : (
                            <ChevronDown className="h-3 w-3" strokeWidth={2} />
                          )
                        ) : null}
                      </Link>
                    ) : (
                      col.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <InvoiceTableRow key={inv.id} inv={inv} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Pagination sp={sp} page={page} totalPages={totalPages} />
    </div>
  )
}

function InvoiceTableRow({ inv }: { inv: InvoiceRow }) {
  const linesLabel = inv.lineItemCount > 0 ? `${inv.classifiedLineCount}/${inv.lineItemCount}` : "—"
  const fullyClassified = inv.lineItemCount > 0 && inv.classifiedLineCount === inv.lineItemCount

  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-muted/40">
      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{formatDate(inv.invoiceDate)}</td>
      <td className="px-4 py-3 font-medium text-foreground">{inv.supplierName}</td>
      <td className="px-4 py-3 text-muted-foreground">{inv.invoiceNumber ?? "—"}</td>
      <td className="px-4 py-3 text-muted-foreground">{inv.projectName ?? "Unassigned"}</td>
      <td className="px-4 py-3 text-right tabular-nums">
        <span className={fullyClassified ? "text-muted-foreground" : "font-medium text-warning"}>{linesLabel}</span>
        {inv.unclassifiedNet > 0 ? (
          <span className="block text-[11px] text-warning">
            {formatGBP(inv.unclassifiedNet, { decimals: true })} unclassified
          </span>
        ) : null}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{formatGBP(inv.net, { decimals: true })}</td>
      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
        {formatGBP(inv.vat, { decimals: true })}
      </td>
      <td className="px-4 py-3 text-right font-semibold tabular-nums">{formatGBP(inv.gross, { decimals: true })}</td>
      <td className="px-4 py-3">
        <div className="flex flex-col items-start gap-1">
          <StatusBadge variant={inv.needsReview ? "warning" : "success"} dot>
            {inv.needsReview ? "Needs review" : "Reviewed"}
          </StatusBadge>
          {inv.transactionType === "credit" ? <StatusBadge variant="info">Credit</StatusBadge> : null}
          {inv.confidence && inv.confidence !== "high" ? (
            <span className="text-[11px] text-muted-foreground">{inv.confidence} confidence extraction</span>
          ) : null}
        </div>
      </td>
      <td className="px-4 py-3">
        <InvoiceViewCell
          fileUrl={inv.sourceFilePathname}
          invoiceNumber={inv.invoiceNumber}
          supplierName={inv.supplierName}
          pageStart={inv.sourcePageStart}
          pageEnd={inv.sourcePageEnd}
        />
      </td>
    </tr>
  )
}

function Pagination({ sp, page, totalPages }: { sp: SearchParams; page: number; totalPages: number }) {
  if (totalPages <= 1) return null

  const prevHref = page > 1 ? hrefFor(sp, { page: String(page - 1) }, { resetPage: false }) : null
  const nextHref = page < totalPages ? hrefFor(sp, { page: String(page + 1) }, { resetPage: false }) : null

  return (
    <div className="flex items-center justify-between gap-3">
      {prevHref ? (
        <Link
          href={prevHref}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          Previous
        </Link>
      ) : (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-muted-foreground opacity-40">
          Previous
        </span>
      )}
      <span className="text-xs text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      {nextHref ? (
        <Link
          href={nextHref}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          Next
        </Link>
      ) : (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-muted-foreground opacity-40">
          Next
        </span>
      )}
    </div>
  )
}

function SummarySkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-[104px] animate-pulse rounded-lg border border-border bg-card" />
      ))}
    </div>
  )
}

function FilterBarSkeleton() {
  return <div className="h-9 w-full max-w-2xl animate-pulse rounded-md border border-border bg-card" />
}

function TableSkeleton() {
  return <div className="h-96 animate-pulse rounded-lg border border-border bg-card" />
}
