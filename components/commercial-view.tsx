"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { cn, formatGBP } from "@/lib/utils"
import { StatusBadge } from "@/components/status-badge"
import { EmptyState } from "@/components/empty-state"
import { setPackageBudget, assignLineItemToPackage } from "@/app/actions/projects"
import type { CostPackageRow, LineItemRow } from "@/lib/queries"

type ProjectOption = { id: number; name: string; slug: string }

interface Props {
  projects: ProjectOption[]
  selectedSlug: string | null
  packages: CostPackageRow[]
  lineItems: LineItemRow[]
}

export function CommercialView({ projects, selectedSlug, packages, lineItems }: Props) {
  const router = useRouter()

  const totalBudget = packages.reduce((s, p) => s + (p.originalBudget ?? 0), 0)
  const totalCommitted = packages.reduce((s, p) => s + p.committed, 0)
  const variance = totalBudget - totalCommitted

  const unassigned = lineItems.filter((li) => li.costPackageId == null)

  return (
    <main className="flex flex-col gap-6 px-8 py-8">
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <SummaryCard label="Total budget" value={totalBudget > 0 ? formatGBP(totalBudget) : "Not set"} />
            <SummaryCard label="Committed (from invoices)" value={formatGBP(totalCommitted)} />
            <SummaryCard
              label="Variance"
              value={totalBudget > 0 ? formatGBP(variance) : "—"}
              accent={totalBudget > 0 ? (variance >= 0 ? "success" : "danger") : undefined}
            />
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
                      <PackageRow key={pkg.id} pkg={pkg} onSaved={() => router.refresh()} />
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

function PackageRow({ pkg, onSaved }: { pkg: CostPackageRow; onSaved: () => void }) {
  const [value, setValue] = useState(pkg.originalBudget != null ? String(pkg.originalBudget) : "")
  const [isPending, startTransition] = useTransition()

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

  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{pkg.code ?? "—"}</td>
      <td className="px-4 py-3 font-medium text-foreground">{pkg.name}</td>
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
