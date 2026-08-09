"use client"

import { useMemo, useState, useTransition } from "react"
import { Search, X, Boxes } from "lucide-react"
import { DataTable, type Column } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { StatusBadge } from "@/components/status-badge"
import { cn, formatGBP } from "@/lib/utils"
import { fetchPriceHistory } from "@/app/actions/lookups"
import type { ProductPriceRow, PriceHistoryRow } from "@/lib/queries"

interface Props {
  products: ProductPriceRow[]
}

function formatDate(d: string) {
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export function ProcurementView({ products }: Props) {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("all")
  const [selected, setSelected] = useState<ProductPriceRow | null>(null)
  const [history, setHistory] = useState<PriceHistoryRow[]>([])
  const [isPending, startTransition] = useTransition()

  const categories = useMemo(() => {
    const set = new Set<string>()
    products.forEach((p) => p.category && set.add(p.category))
    return Array.from(set).sort()
  }, [products])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return products.filter((p) => {
      if (category !== "all" && p.category !== category) return false
      if (!q) return true
      return (
        p.name.toLowerCase().includes(q) ||
        (p.manufacturer?.toLowerCase().includes(q) ?? false) ||
        (p.description?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [products, query, category])

  function openProduct(p: ProductPriceRow) {
    setSelected(p)
    setHistory([])
    startTransition(async () => {
      const rows = await fetchPriceHistory(p.id)
      setHistory(rows)
    })
  }

  const columns: Column<ProductPriceRow>[] = [
    {
      key: "name",
      header: "Product",
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">{r.name}</span>
          <span className="text-xs text-muted-foreground">
            {[r.manufacturer, r.category].filter(Boolean).join(" · ") || "Uncategorised"}
          </span>
        </div>
      ),
    },
    {
      key: "suppliers",
      header: "Merchants",
      align: "center",
      render: (r) =>
        r.supplierCount > 0 ? (
          <span className="tabular-nums">{r.supplierCount}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "best",
      header: "Best price",
      align: "right",
      render: (r) =>
        r.minPrice != null ? (
          <span className="font-medium tabular-nums text-success">
            {formatGBP(r.minPrice, { decimals: true })}
            {r.unit ? <span className="text-xs text-muted-foreground">/{r.unit}</span> : null}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "spread",
      header: "Range",
      align: "right",
      render: (r) =>
        r.minPrice != null && r.maxPrice != null && r.maxPrice > r.minPrice ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            up to {formatGBP(r.maxPrice, { decimals: true })}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "latest",
      header: "Latest",
      align: "right",
      render: (r) =>
        r.latestPrice != null ? (
          <div className="flex flex-col items-end">
            <span className="tabular-nums">{formatGBP(r.latestPrice, { decimals: true })}</span>
            {r.latestDate ? (
              <span className="text-xs text-muted-foreground">{formatDate(r.latestDate)}</span>
            ) : null}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "records",
      header: "Records",
      align: "right",
      render: (r) => <span className="tabular-nums text-muted-foreground">{r.recordCount}</span>,
    },
  ]

  return (
    <div className="flex flex-col gap-4 px-8 py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.75}
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products or manufacturers"
            aria-label="Search products"
            className="h-11 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-base text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30 sm:h-9 sm:text-sm"
          />
        </div>
        {categories.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            <FilterChip active={category === "all"} onClick={() => setCategory("all")}>
              All
            </FilterChip>
            {categories.map((c) => (
              <FilterChip key={c} active={category === c} onClick={() => setCategory(c)}>
                {c}
              </FilterChip>
            ))}
          </div>
        ) : null}
      </div>

      {products.length === 0 ? (
        <EmptyState
          icon={<Boxes className="h-5 w-5" strokeWidth={1.75} />}
          title="No pricing captured yet"
          description="Product prices build automatically from confirmed supplier invoices. Upload an invoice and mark line items as tracked products to start a price history across merchants."
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {filtered.length} of {products.length} tracked products
          </p>
          <DataTable
            columns={columns}
            data={filtered}
            getRowKey={(r) => String(r.id)}
            onRowClick={openProduct}
            caption="Product pricing across merchants"
            emptyState={
              <p className="text-center text-sm text-muted-foreground">
                No products match your search.
              </p>
            }
          />
        </>
      )}

      {selected ? (
        <ProductDrawer
          product={selected}
          history={history}
          loading={isPending}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

function ProductDrawer({
  product,
  history,
  loading,
  onClose,
}: {
  product: ProductPriceRow
  history: PriceHistoryRow[]
  loading: boolean
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close panel"
        className="absolute inset-0 bg-primary/30 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${product.name} detail`}
        className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-5">
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Boxes className="h-3.5 w-3.5" strokeWidth={1.75} />
              {product.category || "Uncategorised"}
            </span>
            <h2 className="text-pretty text-lg font-semibold text-foreground">{product.name}</h2>
            {product.manufacturer ? (
              <span className="text-sm text-muted-foreground">{product.manufacturer}</span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 px-6 py-5">
          <DrawerStat
            label="Best price"
            value={product.minPrice != null ? formatGBP(product.minPrice, { decimals: true }) : "—"}
            accent="success"
          />
          <DrawerStat
            label="Highest seen"
            value={product.maxPrice != null ? formatGBP(product.maxPrice, { decimals: true }) : "—"}
          />
          <DrawerStat
            label="Average"
            value={product.avgPrice != null ? formatGBP(product.avgPrice, { decimals: true }) : "—"}
          />
          <DrawerStat label="Merchants" value={String(product.supplierCount)} />
        </div>

        <div className="border-t border-border px-6 py-5">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Price history
          </h3>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No price records yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {history.map((h) => (
                <li
                  key={h.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
                >
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">{h.supplierName}</span>
                    <span className="text-xs text-muted-foreground">
                      {h.invoiceDate ? formatDate(h.invoiceDate) : "Undated"}
                      {h.invoiceNumber ? ` · ${h.invoiceNumber}` : ""}
                      {h.projectName ? ` · ${h.projectName}` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {h.transactionType === "credit" ? (
                      <StatusBadge variant="warning">Credit</StatusBadge>
                    ) : null}
                    <span className="font-medium tabular-nums text-foreground">
                      {formatGBP(h.priceExVat, { decimals: true })}
                      {h.unit ? <span className="text-xs text-muted-foreground">/{h.unit}</span> : null}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  )
}

function DrawerStat({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: "success"
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums",
          accent === "success" ? "text-success" : "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  )
}
