"use client"

import { useEffect, useState } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { InvoiceSupplierOption, ProjectOption } from "@/lib/queries"

interface Props {
  supplierOptions: InvoiceSupplierOption[]
  projectOptions: ProjectOption[]
}

const selectCls =
  "h-9 rounded-md border border-border bg-card px-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"

export function InvoiceFilterBar({ supplierOptions, projectOptions }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const urlQuery = searchParams.get("q") ?? ""
  const [query, setQuery] = useState(urlQuery)

  // Keep the input in sync if the URL changes from elsewhere (e.g. a filter chip reset).
  useEffect(() => {
    setQuery(urlQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQuery])

  useEffect(() => {
    if (query === urlQuery) return
    const handle = setTimeout(() => {
      updateParams({ q: query.trim() || null })
    }, 350)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  function updateParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === "") next.delete(key)
      else next.set(key, value)
    }
    next.delete("page")
    const qs = next.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  const hasFilters =
    searchParams.get("q") ||
    searchParams.get("supplier") ||
    searchParams.get("project") ||
    searchParams.get("from") ||
    searchParams.get("to") ||
    searchParams.get("type") ||
    searchParams.get("review") ||
    searchParams.get("unclassified")

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative w-full sm:max-w-xs">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.75}
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search invoice no., supplier or line item"
          aria-label="Search invoices"
          className="h-9 w-full rounded-md border border-border bg-card pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
        />
      </div>

      <select
        value={searchParams.get("supplier") ?? ""}
        onChange={(e) => updateParams({ supplier: e.target.value || null })}
        aria-label="Filter by supplier"
        className={cn(selectCls, "min-w-0 max-w-full sm:max-w-[11rem]")}
      >
        <option value="">All suppliers</option>
        {supplierOptions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      <select
        value={searchParams.get("project") ?? ""}
        onChange={(e) => updateParams({ project: e.target.value || null })}
        aria-label="Filter by project"
        className={cn(selectCls, "min-w-0 max-w-full sm:max-w-[11rem]")}
      >
        <option value="">All projects</option>
        {projectOptions.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={searchParams.get("from") ?? ""}
          onChange={(e) => updateParams({ from: e.target.value || null })}
          aria-label="From date"
          className={selectCls}
        />
        <span className="text-xs text-muted-foreground">to</span>
        <input
          type="date"
          value={searchParams.get("to") ?? ""}
          onChange={(e) => updateParams({ to: e.target.value || null })}
          aria-label="To date"
          className={selectCls}
        />
      </div>

      <select
        value={searchParams.get("type") ?? ""}
        onChange={(e) => updateParams({ type: e.target.value || null })}
        aria-label="Filter by transaction type"
        className={selectCls}
      >
        <option value="">All types</option>
        <option value="invoice">Invoice</option>
        <option value="credit">Credit</option>
      </select>

      {hasFilters ? (
        <button
          type="button"
          onClick={() => router.push(pathname)}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          Clear filters
        </button>
      ) : null}
    </div>
  )
}
