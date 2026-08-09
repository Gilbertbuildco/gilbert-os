import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export interface Column<T> {
  key: string
  header: string
  align?: "left" | "right" | "center"
  className?: string
  render: (row: T) => ReactNode
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  getRowKey: (row: T, index: number) => string
  onRowClick?: (row: T) => void
  emptyState?: ReactNode
  caption?: string
}

export function DataTable<T>({
  columns,
  data,
  getRowKey,
  onRowClick,
  emptyState,
  caption,
}: DataTableProps<T>) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr className="border-b border-border bg-muted/50">
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={cn(
                    "whitespace-nowrap px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground",
                    col.align === "right" && "text-right",
                    col.align === "center" && "text-center",
                    !col.align && "text-left",
                    col.className,
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10">
                  {emptyState ?? (
                    <p className="text-center text-sm text-muted-foreground">No records to display.</p>
                  )}
                </td>
              </tr>
            ) : (
              data.map((row, index) => (
                <tr
                  key={getRowKey(row, index)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "border-b border-border last:border-b-0 transition-colors",
                    onRowClick && "cursor-pointer hover:bg-muted/40",
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        "px-4 py-3 text-foreground",
                        col.align === "right" && "text-right tabular-nums",
                        col.align === "center" && "text-center",
                        col.className,
                      )}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
