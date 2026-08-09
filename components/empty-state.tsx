import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-strong bg-card px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      ) : null}
      <div className="flex max-w-md flex-col gap-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description ? <p className="text-pretty text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}
