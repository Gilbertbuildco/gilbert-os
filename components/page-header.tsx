import type { ReactNode } from "react"

interface PageHeaderProps {
  title: string
  description?: string
  actions?: ReactNode
  children?: ReactNode
}

export function PageHeader({ title, description, actions, children }: PageHeaderProps) {
  return (
    <header className="border-b border-border bg-card">
      <div className="flex flex-col gap-4 px-8 py-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-pretty text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="max-w-2xl text-pretty text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="px-8 pb-5">{children}</div> : null}
    </header>
  )
}
