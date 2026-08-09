import { ArrowRight } from "lucide-react"
import { StatusBadge, type StatusVariant } from "@/components/status-badge"
import { cn } from "@/lib/utils"

export interface AttentionItemData {
  id: string
  severity: "high" | "medium" | "low"
  category: string
  project: string
  title: string
  detail: string
  impact?: string
  action: string
}

const severityMap: Record<AttentionItemData["severity"], { label: string; variant: StatusVariant }> = {
  high: { label: "High", variant: "danger" },
  medium: { label: "Medium", variant: "warning" },
  low: { label: "Low", variant: "info" },
}

export function AttentionItem({ item }: { item: AttentionItemData }) {
  const severity = severityMap[item.severity]
  return (
    <div className="flex items-start gap-4 border-b border-border px-5 py-4 last:border-b-0">
      <span
        className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", {
          "bg-danger": item.severity === "high",
          "bg-warning": item.severity === "medium",
          "bg-info": item.severity === "low",
        })}
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{item.title}</span>
          <StatusBadge variant={severity.variant}>{severity.label}</StatusBadge>
          <span className="text-xs text-muted-foreground">
            {item.category} · {item.project}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">{item.detail}</p>
        {item.impact ? (
          <p className="text-sm font-medium text-foreground tabular-nums">{item.impact}</p>
        ) : null}
      </div>
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        {item.action}
        <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
    </div>
  )
}
