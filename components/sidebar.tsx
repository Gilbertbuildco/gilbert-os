"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  Building2,
  Wallet,
  Truck,
  ReceiptText,
  ListChecks,
  Store,
  Map,
  Menu,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * A route is "active" if it matches exactly or is a genuine sub-route — but
 * `/invoices/review` gets its own nav entry, so it must NOT also light up
 * the parent `/invoices` tab (a plain `startsWith` would double-highlight).
 */
function isNavActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/"
  if (href === "/invoices") {
    return pathname === "/invoices" || (pathname.startsWith("/invoices/") && !pathname.startsWith("/invoices/review"))
  }
  return pathname === href || pathname.startsWith(`${href}/`)
}

interface Props {
  /** Count of invoices with needs_review = true, across every project. Omit/0 hides the badge. */
  reviewCount?: number
}

export function Sidebar({ reviewCount = 0 }: Props) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  const navItems = [
    { label: "Dashboard", href: "/", icon: LayoutDashboard },
    { label: "Position", href: "/position", icon: Wallet },
    { label: "Projects", href: "/projects", icon: Building2 },
    { label: "Commercial", href: "/commercial", icon: Wallet },
    { label: "Procurement", href: "/procurement", icon: Truck },
    { label: "Invoices", href: "/invoices", icon: ReceiptText },
    { label: "Review", href: "/invoices/review", icon: ListChecks, badge: reviewCount > 0 ? reviewCount : undefined },
    { label: "Suppliers", href: "/suppliers", icon: Store },
    { label: "Land Appraisal", href: "/land-appraisal", icon: Map },
  ]

  // Close the drawer whenever the route changes (e.g. after tapping a link).
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  // Lock background scroll while the mobile drawer is open.
  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  const navLinks = (
    <nav className="flex flex-1 flex-col gap-0.5 px-3 py-4" aria-label="Primary">
      {navItems.map((item) => {
        const isActive = isNavActive(item.href, pathname)
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-sidebar-active text-sidebar-active-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-sidebar-active-foreground",
            )}
          >
            <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
            <span className="flex-1">{item.label}</span>
            {item.badge ? (
              <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-warning-bg px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                {item.badge}
              </span>
            ) : null}
          </Link>
        )
      })}
    </nav>
  )

  const brand = (
    <div className="flex flex-col gap-1 px-5 pb-6 pt-6">
      <div className="flex flex-col leading-none">
        <span className="text-lg font-semibold tracking-tight text-sidebar-brand">GILBERT</span>
        <span className="text-lg font-semibold tracking-tight text-sidebar-brand">OS</span>
      </div>
      <span className="mt-2 text-[10px] font-medium uppercase tracking-[0.18em] text-sidebar-muted">
        Development Operating System
      </span>
    </div>
  )

  const profile = (
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
  )

  return (
    <>
      {/* Mobile top bar — replaces the fixed sidebar below lg, never eats page width */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-sidebar-border bg-sidebar px-4 py-3 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          className="flex h-11 w-11 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-active/60"
        >
          <Menu className="h-5 w-5" strokeWidth={1.75} />
        </button>
        <span className="text-sm font-semibold tracking-tight text-sidebar-brand">GILBERT OS</span>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sidebar-active text-xs font-semibold text-sidebar-active-foreground">
          TG
        </div>
      </header>

      {/* Mobile drawer + backdrop */}
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-primary/30 backdrop-blur-[1px]"
            onClick={() => setOpen(false)}
          />
          <aside className="relative flex h-full w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar shadow-xl">
            <div className="flex items-center justify-between px-2 pr-3 pt-2">
              {brand}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-active/60"
              >
                <X className="h-5 w-5" strokeWidth={1.75} />
              </button>
            </div>
            <div className="mx-5 border-t border-sidebar-border" />
            {navLinks}
            <div className="mx-5 border-t border-sidebar-border" />
            {profile}
          </aside>
        </div>
      ) : null}

      {/* Desktop sidebar — unchanged fixed layout at lg and above */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        {brand}
        <div className="mx-5 border-t border-sidebar-border" />
        {navLinks}
        <div className="mx-5 border-t border-sidebar-border" />
        {profile}
      </aside>
    </>
  )
}
