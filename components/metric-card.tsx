import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

interface MetricCardProps {
  label: string
  value?: string
  /** When true, shows a "Data connection required" unconnected state instead of a value. */
  unconnected?: boolean
  hint?: string
  trend?: { value: string; direction: "up" | "down" | "flat" }
  icon?: ReactNode
  className?: string
}

export function MetricCard({
  label,
  value,
  unconnected = false,
  hint,
  trend,
  icon,
  className,
}: MetricCardProps) {
  return (
    <div className={cn("flex flex-col justify-between rounded-lg border border-border bg-card p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </div>

      <div className="mt-4">
        {unconnected ? (
          <div className="flex flex-col gap-1.5">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" aria-hidden />
              Data connection required
            </span>
            <span className="text-xs text-muted-foreground">Awaiting connected data source</span>
          </div>
        ) : (
          <div className="flex items-end justify-between gap-2">
            <span className="text-2xl font-semibold tracking-tight text-foreground tabular-nums">
              {value}
            </span>
            {trend ? (
              <span
                className={cn("text-xs font-medium tabular-nums", {
                  "text-success": trend.direction === "up",
                  "text-danger": trend.direction === "down",
                  "text-muted-foreground": trend.direction === "flat",
                })}
              >
                {trend.value}
              </span>
            ) : null}
          </div>
        )}
        {hint && !unconnected ? (
          <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </div>
  )
}
