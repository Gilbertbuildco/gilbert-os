import { cn } from "@/lib/utils"

export type StatusVariant = "success" | "warning" | "danger" | "info" | "neutral"

const variantClasses: Record<StatusVariant, string> = {
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
  info: "bg-info-bg text-info",
  neutral: "bg-muted text-muted-foreground",
}

interface StatusBadgeProps {
  children: React.ReactNode
  variant?: StatusVariant
  dot?: boolean
  className?: string
}

export function StatusBadge({ children, variant = "neutral", dot = false, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        variantClasses[variant],
        className,
      )}
    >
      {dot ? (
        <span
          className={cn("h-1.5 w-1.5 rounded-full", {
            "bg-success": variant === "success",
            "bg-warning": variant === "warning",
            "bg-danger": variant === "danger",
            "bg-info": variant === "info",
            "bg-muted-foreground": variant === "neutral",
          })}
          aria-hidden
        />
      ) : null}
      {children}
    </span>
  )
}
