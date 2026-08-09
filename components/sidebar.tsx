"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  Building2,
  Wallet,
  Truck,
  ReceiptText,
  Store,
  Map,
} from "lucide-react"
import { cn } from "@/lib/utils"

const navItems = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Projects", href: "/projects", icon: Building2 },
  { label: "Commercial", href: "/commercial", icon: Wallet },
  { label: "Procurement", href: "/procurement", icon: Truck },
  { label: "Invoices", href: "/invoices", icon: ReceiptText },
  { label: "Suppliers", href: "/suppliers", icon: Store },
  { label: "Land Appraisal", href: "/land-appraisal", icon: Map },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex flex-col gap-1 px-5 pb-6 pt-6">
        <div className="flex flex-col leading-none">
          <span className="text-lg font-semibold tracking-tight text-sidebar-brand">GILBERT</span>
          <span className="text-lg font-semibold tracking-tight text-sidebar-brand">OS</span>
        </div>
        <span className="mt-2 text-[10px] font-medium uppercase tracking-[0.18em] text-sidebar-muted">
          Development Operating System
        </span>
      </div>

      <div className="mx-5 border-t border-sidebar-border" />

      <nav className="flex flex-1 flex-col gap-0.5 px-3 py-4" aria-label="Primary">
        {navItems.map((item) => {
          const isActive =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-active text-sidebar-active-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-sidebar-active-foreground",
              )}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="mx-5 border-t border-sidebar-border" />

      <div className="px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sidebar-active text-xs font-semibold text-sidebar-active-foreground">
            TG
          </div>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-medium text-sidebar-foreground">Tom Gilbert</span>
            <span className="truncate text-xs text-sidebar-muted">Director</span>
          </div>
        </div>
      </div>
    </aside>
  )
}
