"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn, formatGBP } from "@/lib/utils"
import { StatusBadge } from "@/components/status-badge"
import { EmptyState } from "@/components/empty-state"
import { setPackageBudget, assignLineItemToPackage } from "@/app/actions/projects"
import type { CostPackageRow, LineItemRow } from "@/lib/queries"

/** Number of columns in the cost-packages table, for the expanded drill-down row's colSpan. */
const PACKAGE_TABLE_COLUMN_COUNT = 6

function formatDate(d: string | null) {
  if (!d) return null
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

type ProjectOption = { id: number; name: string; slug: string }

interface Props {
  projects: ProjectOption[]
  selectedSlug: string | null
  packages: CostPackageRow[]
  lineItems: LineItemRow[]
}

export function CommercialView({ projects, selectedSlug, packages, lineItems }: Props) {
  const router = useRouter()

  // Packages flagged is_build_cost = false (e.g. legal & broker fees) are real
  // spend but deliberately not part of the build cost, per the owner's rule.
  // They are shown as their own figure, never folded into the build totals.
  const buildPackages = packages.filter((p) => p.isBuildCost !== false)
  const nonBuildPackages = packages.filter((p) => p.isBuildCost === false)
  const totalBudget = buildPackages.reduce((s, p) => s + (p.originalBudget ?? 0), 0)
  // "Committed" sums every confirmed invoice line regardless of payment_status —
  // it is money invoiced, not money paid. That makes it a broader measure than
  // "Spent" on the Breakdown tab, which counts paid invoices only. An unpaid
  // invoice sits inside Committed here and, separately, as a liability on Cash
  // Position — never read the two figures as the same thing.
  const totalCommitted = buildPackages.reduce((s, p) => s + p.committed, 0)
  const nonBuildCommitted = nonBuildPackages.reduce((s, p) => s + p.committed, 0)
  const variance = totalBudget - totalCommitted

  const unassigned = lineItems.filter((li) => li.costPackageId == null)

  return (
    <main className="flex flex-col gap-6 px-4 py-8 sm:px-8">
      {projects.length > 1 ? (
        <div role="tablist" aria-label="Project" className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1">
          {projects.map((p) => (
            <button
              key={p.id}
              role="tab"
              type="button"
              aria-selected={p.slug === selectedSlug}
              onClick={() => router.push(`/commercial?project=${p.slug}`)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                p.slug === selectedSlug
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p.name}
            </button>
          ))}
        </div>
      ) : null}

      {!selectedSlug ? (
        <EmptyState
          title="No project selected"
          description="Create a project to build its cost plan."
        />
      ) : (
        <>
          <div className={cn("grid grid-cols-1 gap-4", nonBuildCommitted > 0 ? "sm:grid-cols-4" : "sm:grid-cols-3")}>
            <SummaryCard label="Total budget" value={totalBudget > 0 ? formatGBP(totalBudget) : "Not set"} />
            <SummaryCard label="Committed build cost" value={formatGBP(totalCommitted)} />
            <SummaryCard
              label="Variance"
              value={totalBudget > 0 ? formatGBP(variance) : "—"}
              accent={totalBudget > 0 ? (variance >= 0 ? "success" : "danger") : undefined}
            />
            {nonBuildCommitted > 0 ? (
              <SummaryCard label="Non-build costs (excluded)" value={formatGBP(nonBuildCommitted)} />
            ) : null}
          </div>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">Cost packages</h2>
              <span className="text-xs text-muted-foreground">
                Budgets are editable · committed values are derived from confirmed invoices
              </span>
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="px-4 py-2.5 text-left font-semibold">Code</th>
                      <th scope="col" className="px-4 py-2.5 text-left font-semibold">Package</th>
                      <th scope="col" className="px-4 py-2.5 text-right font-semibold">Original Budget</th>
                      <th scope="col" className="px-4 py-2.5 text-right font-semibold">Committed</th>
                      <th scope="col" className="px-4 py-2.5 text-right font-semibold">Variance</th>
                      <th scope="col" className="px-4 py-2.5 text-left font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {packages.map((pkg) => (
                      <PackageRow
                        key={pkg.id}
                        pkg={pkg}
                        lineItems={lineItems.filter((li) => li.costPackageId === pkg.id)}
                        totalCommitted={totalCommitted}
                        onSaved={() => router.refresh()}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-foreground">
              Committed line items
              {unassigned.length > 0 ? (
                <span className="ml-2">
                  <StatusBadge variant="warning">{unassigned.length} unassigned</StatusBadge>
                </span>
              ) : null}
            </h2>
            {lineItems.length === 0 ? (
              <EmptyState
                title="No committed costs yet"
                description="Upload an invoice for this project and assign its line items to cost packages — they will appear here and roll up into the committed totals above."
              />
            ) : (
              <div className="flex flex-col gap-2">
                {lineItems.map((li) => (
                  <LineItemCard
                    key={li.id}
                    item={li}
                    packages={packages}
                    onSaved={() => router.refresh()}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  )
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: "success" | "danger"
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-2 text-2xl font-semibold tabular-nums",
          accent === "success" && "text-success",
          accent === "danger" && "text-danger",
          !accent && "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  )
}

function PackageRow({
  pkg,
  lineItems,
  totalCommitted,
  onSaved,
}: {
  pkg: CostPackageRow
  lineItems: LineItemRow[]
  totalCommitted: number
  onSaved: () => void
}) {
  const [value, setValue] = useState(pkg.originalBudget != null ? String(pkg.originalBudget) : "")
  const [isPending, startTransition] = useTransition()
  const [expanded, setExpanded] = useState(false)

  function save() {
    const parsed = value.trim() === "" ? null : parseFloat(value)
    if (parsed === pkg.originalBudget) return
    startTransition(async () => {
      await setPackageBudget(pkg.id, Number.isNaN(parsed as number) ? null : parsed)
      onSaved()
    })
  }

  const budget = pkg.originalBudget ?? 0
  const variance = budget - pkg.committed
  const over = pkg.originalBudget != null && variance < 0
  const shareOfCommitted = totalCommitted > 0 ? (pkg.committed / totalCommitted) * 100 : null
  const canExpand = lineItems.length > 0

  return (
    <>
      <tr className="border-b border-border last:border-b-0 hover:bg-muted/40">
        <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              disabled={!canExpand}
              aria-expanded={expanded}
              aria-label={expanded ? `Collapse ${pkg.name} line items` : `Expand ${pkg.name} line items`}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent max-sm:h-10 max-sm:w-10"
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
            </button>
            {pkg.code ?? "—"}
          </div>
        </td>
        <td className="px-4 py-3 font-medium text-foreground">
          <div className="flex flex-col">
            <span>{pkg.name}</span>
            {lineItems.length > 0 ? (
              <span className="text-xs font-normal text-muted-foreground">
                {lineItems.length} item{lineItems.length === 1 ? "" : "s"}
                {shareOfCommitted != null ? ` · ${shareOfCommitted.toFixed(1)}% of committed` : ""}
              </span>
            ) : null}
          </div>
        </td>
        <td className="px-4 py-2 text-right">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={save}
            inputMode="decimal"
            placeholder="—"
            aria-label={`Budget for ${pkg.name}`}
            className="h-9 w-28 rounded-md border border-border bg-background px-2 text-right text-sm tabular-nums text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
          />
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {pkg.committed > 0 ? formatGBP(pkg.committed) : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {pkg.originalBudget != null ? (
            <span className={over ? "text-danger" : "text-success"}>{formatGBP(variance)}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-4 py-3">
          {isPending ? (
            <StatusBadge variant="info">Saving…</StatusBadge>
          ) : pkg.originalBudget == null ? (
            <StatusBadge variant="neutral">No budget</StatusBadge>
          ) : over ? (
            <StatusBadge variant="danger" dot>Over budget</StatusBadge>
          ) : pkg.committed > 0 ? (
            <StatusBadge variant="success" dot>On budget</StatusBadge>
          ) : (
            <StatusBadge variant="neutral">Awaiting spend</StatusBadge>
          )}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-border bg-muted/20 last:border-b-0">
          <td colSpan={PACKAGE_TABLE_COLUMN_COUNT} className="px-4 py-3">
            <PackageLineItems items={lineItems} />
          </td>
        </tr>
      ) : null}
    </>
  )
}

type GroupedLineItem = {
  description: string
  count: number
  totalNet: number
  unit: string | null
  quantity: number | null
  items: LineItemRow[]
}

/** Collapses repeat purchases of the same product into one summed row. */
function groupLineItems(items: LineItemRow[]): GroupedLineItem[] {
  const groups = new Map<string, GroupedLineItem>()
  for (const item of items) {
    const existing = groups.get(item.description)
    if (existing) {
      existing.count += 1
      existing.totalNet += item.lineNet
      existing.items.push(item)
      existing.quantity =
        existing.quantity != null && item.quantity != null && existing.unit === item.unit
          ? existing.quantity + item.quantity
          : null
    } else {
      groups.set(item.description, {
        description: item.description,
        count: 1,
        totalNet: item.lineNet,
        unit: item.unit,
        quantity: item.quantity,
        items: [item],
      })
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.totalNet - a.totalNet)
}

/** A package's committed line items, biggest cost first, with repeat products grouped. */
function PackageLineItems({ items }: { items: LineItemRow[] }) {
  const grouped = groupLineItems(items)

  if (grouped.length === 0) {
    return <p className="py-2 text-sm text-muted-foreground">No committed line items in this package.</p>
  }

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border bg-muted text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-semibold">Description</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Qty</th>
              <th scope="col" className="px-3 py-2 text-left font-semibold">Unit</th>
              <th scope="col" className="px-3 py-2 text-left font-semibold">Supplier / invoice</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Net</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map((group) => (
              <GroupedLineItemRow key={group.description} group={group} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function GroupedLineItemRow({ group }: { group: GroupedLineItem }) {
  const [expanded, setExpanded] = useState(false)

  if (group.count === 1) {
    const item = group.items[0]
    const invoiceDate = formatDate(item.invoiceDate)
    return (
      <tr className="border-b border-border last:border-b-0">
        <td className="px-3 py-2 text-foreground">{group.description}</td>
        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{item.quantity ?? "—"}</td>
        <td className="px-3 py-2 text-muted-foreground">{item.unit ?? "—"}</td>
        <td className="px-3 py-2 text-muted-foreground">
          {item.supplierName}
          {item.invoiceNumber ? ` · ${item.invoiceNumber}` : ""}
          {invoiceDate ? ` · ${invoiceDate}` : ""}
        </td>
        <td className="px-3 py-2 text-right font-medium tabular-nums text-foreground">
          {formatGBP(group.totalNet, { decimals: true })}
        </td>
      </tr>
    )
  }

  return (
    <>
      <tr className="border-b border-border last:border-b-0 hover:bg-muted/40">
        <td className="px-3 py-2 text-foreground">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse breakdown" : "Expand breakdown"}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground max-sm:h-9 max-sm:w-9"
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" strokeWidth={1.75} />
              ) : (
                <ChevronRight className="h-3 w-3" strokeWidth={1.75} />
              )}
            </button>
            {group.description}
          </div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{group.quantity ?? "—"}</td>
        <td className="px-3 py-2 text-muted-foreground">{group.unit ?? "—"}</td>
        <td className="px-3 py-2 text-muted-foreground">×{group.count}</td>
        <td className="px-3 py-2 text-right font-medium tabular-nums text-foreground">
          {formatGBP(group.totalNet, { decimals: true })}
        </td>
      </tr>
      {expanded
        ? group.items.map((item) => {
            const invoiceDate = formatDate(item.invoiceDate)
            return (
              <tr key={item.id} className="border-b border-border bg-muted/20 last:border-b-0">
                <td className="py-2 pl-8 pr-3 text-muted-foreground">{item.description}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{item.quantity ?? "—"}</td>
                <td className="px-3 py-2 text-muted-foreground">{item.unit ?? "—"}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {item.supplierName}
                  {item.invoiceNumber ? ` · ${item.invoiceNumber}` : ""}
                  {invoiceDate ? ` · ${invoiceDate}` : ""}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {formatGBP(item.lineNet, { decimals: true })}
                </td>
              </tr>
            )
          })
        : null}
    </>
  )
}

function LineItemCard({
  item,
  packages,
  onSaved,
}: {
  item: LineItemRow
  packages: CostPackageRow[]
  onSaved: () => void
}) {
  const [isPending, startTransition] = useTransition()

  function assign(costPackageId: string) {
    startTransition(async () => {
      await assignLineItemToPackage(item.id, costPackageId ? Number(costPackageId) : null)
      onSaved()
    })
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col">
        <span className="font-medium text-foreground">{item.description}</span>
        <span className="text-xs text-muted-foreground">
          {item.supplierName}
          {item.invoiceNumber ? ` · ${item.invoiceNumber}` : ""}
          {item.quantity != null ? ` · ${item.quantity}${item.unit ? " " + item.unit : ""}` : ""}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-semibold tabular-nums text-foreground">{formatGBP(item.lineNet, { decimals: true })}</span>
        <select
          value={item.costPackageId != null ? String(item.costPackageId) : ""}
          onChange={(e) => assign(e.target.value)}
          disabled={isPending}
          aria-label="Assign cost package"
          className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
        >
          <option value="">Unassigned</option>
          {packages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code ? `${p.code} · ` : ""}
              {p.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
