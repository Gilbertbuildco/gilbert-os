"use client"

import { useMemo, useState } from "react"
import { Search, X, Boxes } from "lucide-react"
import { StatusBadge } from "@/components/status-badge"
import { cn, formatGBP } from "@/lib/utils"
import { procurementSample, type ProcurementRow } from "@/lib/data"

const MERCHANTS = ["Bradfords", "Travis Perkins", "CRS", "MKM"] as const

type PriceEntry = { merchant: string; price: number }

function priceEntries(row: ProcurementRow): PriceEntry[] {
  const entries: PriceEntry[] = []
  if (row.bradfordsRevised ?? row.bradfordsCurrent)
    entries.push({ merchant: "Bradfords", price: (row.bradfordsRevised ?? row.bradfordsCurrent)! })
  if (row.travisRevised ?? row.travisCurrent)
    entries.push({ merchant: "Travis Perkins", price: (row.travisRevised ?? row.travisCurrent)! })
  if (row.crs) entries.push({ merchant: "CRS", price: row.crs })
  if (row.mkm) entries.push({ merchant: "MKM", price: row.mkm })
  return entries
}

function bestPrice(row: ProcurementRow) {
  const entries = priceEntries(row)
  if (entries.length === 0) return null
  return entries.reduce((min, e) => (e.price < min.price ? e : min), entries[0])
}

function saving(row: ProcurementRow) {
  const entries = priceEntries(row)
  const best = bestPrice(row)
  if (!best || entries.length < 2) return null
  const highest = entries.reduce((max, e) => (e.price > max.price ? e : max), entries[0])
  return highest.price - best.price
}

const stages = ["All stages", ...Array.from(new Set(procurementSample.map((r) => r.buildStage)))]

function money(v?: number) {
  return v == null ? "—" : formatGBP(v, { decimals: true })
}

export function ProcurementView() {
  const [search, setSearch] = useState("")
  const [stage, setStage] = useState("All stages")
  const [merchant, setMerchant] = useState("All merchants")
  const [priced, setPriced] = useState("All")
  const [selected, setSelected] = useState<ProcurementRow | null>(null)

  const rows = useMemo(() => {
    return procurementSample.filter((row) => {
      if (stage !== "All stages" && row.buildStage !== stage) return false
      if (search && !row.product.toLowerCase().includes(search.toLowerCase())) return false
      const entries = priceEntries(row)
      if (merchant !== "All merchants" && !entries.some((e) => e.merchant === merchant)) return false
      if (priced === "Priced" && entries.length === 0) return false
      if (priced === "Unpriced" && entries.length > 0) return false
      return true
    })
  }, [search, stage, merchant, priced])

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products…"
            aria-label="Search products"
            className="h-9 w-full rounded-md border border-border bg-card pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect label="Build stage" value={stage} onChange={setStage} options={stages} />
          <FilterSelect
            label="Merchant"
            value={merchant}
            onChange={setMerchant}
            options={["All merchants", ...MERCHANTS]}
          />
          <FilterSelect
            label="Priced"
            value={priced}
            onChange={setPriced}
            options={["All", "Priced", "Unpriced"]}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Showing {rows.length} of {procurementSample.length} sample products
        </p>
        <StatusBadge variant="warning">Sample data · full 211-product import pending</StatusBadge>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">Build Stage</th>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">Product</th>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">Unit</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Bradfords Cur.</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Bradfords Rev.</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Travis Cur.</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Travis Rev.</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">CRS</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">MKM</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Best Price</th>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">Winning Merchant</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Saving</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No products match the current filters.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const best = bestPrice(row)
                  const save = saving(row)
                  return (
                    <tr
                      key={row.id}
                      onClick={() => setSelected(row)}
                      className="cursor-pointer border-b border-border last:border-b-0 transition-colors hover:bg-muted/40"
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{row.buildStage}</td>
                      <td className="px-4 py-3 font-medium text-foreground">{row.product}</td>
                      <td className="px-4 py-3 text-muted-foreground">{row.unit}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(row.bradfordsCurrent)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(row.bradfordsRevised)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(row.travisCurrent)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(row.travisRevised)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(row.crs)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{money(row.mkm)}</td>
                      <td className="px-4 py-3 text-right font-semibold text-foreground tabular-nums">
                        {best ? formatGBP(best.price, { decimals: true }) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        {best ? (
                          <StatusBadge variant="success">{best.merchant}</StatusBadge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">
                        {save != null && save > 0 ? (
                          <span className="text-success">{formatGBP(save, { decimals: true })}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected ? <ProductDrawer row={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: string[]
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span className="sr-only sm:not-sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="h-9 rounded-md border border-border bg-card px-2.5 text-sm font-normal text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  )
}

function ProductDrawer({ row, onClose }: { row: ProcurementRow; onClose: () => void }) {
  const best = bestPrice(row)
  const entries = priceEntries(row)

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-primary/30 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${row.product} detail`}
        className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-5">
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Boxes className="h-3.5 w-3.5" strokeWidth={1.75} />
              {row.buildStage}
            </span>
            <h2 className="text-lg font-semibold text-foreground">{row.product}</h2>
            <span className="text-sm text-muted-foreground">Priced per {row.unit}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex flex-col gap-6 px-6 py-6">
          {best ? (
            <div className="rounded-lg border border-success/30 bg-success-bg px-4 py-3">
              <p className="text-xs font-medium text-success">Best current price</p>
              <p className="mt-0.5 text-xl font-semibold text-success tabular-nums">
                {formatGBP(best.price, { decimals: true })}{" "}
                <span className="text-sm font-normal">via {best.merchant}</span>
              </p>
            </div>
          ) : null}

          <DrawerSection title="Merchant comparison">
            <ul className="flex flex-col divide-y divide-border">
              {entries.map((e) => (
                <li key={e.merchant} className="flex items-center justify-between py-2">
                  <span className="text-sm text-foreground">{e.merchant}</span>
                  <span
                    className={cn(
                      "text-sm font-medium tabular-nums",
                      best && e.merchant === best.merchant ? "text-success" : "text-foreground",
                    )}
                  >
                    {formatGBP(e.price, { decimals: true })}
                  </span>
                </li>
              ))}
            </ul>
          </DrawerSection>

          <DrawerSection title="Price history" pending>
            <PendingNote text="Historic price points will chart here once the procurement database is imported." />
          </DrawerSection>

          <DrawerSection title="Invoice history" pending>
            <PendingNote text="Purchases of this product from ingested invoices will be listed here." />
          </DrawerSection>

          <DrawerSection title="Supplier product codes" pending>
            <PendingNote text="Merchant-specific SKUs and product codes will be mapped here." />
          </DrawerSection>

          <DrawerSection title="Last purchase date" pending>
            <PendingNote text="Populated from the most recent ingested invoice line." />
          </DrawerSection>
        </div>
      </aside>
    </div>
  )
}

function DrawerSection({
  title,
  pending,
  children,
}: {
  title: string
  pending?: boolean
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {pending ? <StatusBadge variant="neutral">Pending import</StatusBadge> : null}
      </div>
      {children}
    </section>
  )
}

function PendingNote({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-border-strong bg-muted/40 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  )
}
