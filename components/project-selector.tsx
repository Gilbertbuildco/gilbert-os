"use client"

import { cn } from "@/lib/utils"

interface ProjectSelectorProps {
  options: string[]
  value: string
  onChange: (value: string) => void
  className?: string
}

export function ProjectSelector({ options, value, onChange, className }: ProjectSelectorProps) {
  return (
    <div
      role="tablist"
      aria-label="Project scope"
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1",
        className,
      )}
    >
      {options.map((option) => {
        const isActive = option === value
        return (
          <button
            key={option}
            role="tab"
            type="button"
            aria-selected={isActive}
            onClick={() => onChange(option)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}
