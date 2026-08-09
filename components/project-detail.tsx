"use client"

import { useState } from "react"
import Link from "next/link"
import { ChevronLeft, Info, FileText, Boxes, GitBranch, CalendarRange, Wallet } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { StatusBadge } from "@/components/status-badge"
import { EmptyState } from "@/components/empty-state"
import { cn, formatGBP, formatNumber } from "@/lib/utils"
import type { Project } from "@/lib/data"

const tabs = [
  "Overview",
  "Commercial",
  "Invoices",
  "Procurement",
  "Variations",
  "Programme",
  "Documents",
] as const

type Tab = (typeof tabs)[number]

export function ProjectDetail({ project }: { project: Project }) {
  const [active, setActive] = useState<Tab>("Overview")

  return (
    <>
      <PageHeader
        title={`${project.name}, ${project.location}`}
        description={`${project.homes} detached houses · ${formatNumber(project.buildAreaSqFt ?? 0)} sq ft`}
        actions={<StatusBadge variant="info" dot>{project.status}</StatusBadge>}
      >
        <Link
          href="/projects"
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
          Back to projects
        </Link>
      </PageHeader>

      <div className="border-b border-border bg-card px-8">
        <div
          role="tablist"
          aria-label="Project sections"
          className="flex gap-1 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const isActive = tab === active
            return (
              <button
                key={tab}
                role="tab"
                type="button"
                aria-selected={isActive}
                onClick={() => setActive(tab)}
                className={cn(
                  "relative whitespace-nowrap px-3 py-3 text-sm font-medium transition-colors",
                  isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab}
                {isActive ? (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary" aria-hidden />
                ) : null}
              </button>
            )
          })}
        </div>
      </div>

      <main className="px-8 py-8">
        {active === "Overview" ? <Overview project={project} /> : null}
        {active === "Commercial" ? (
          <EmptyState
            icon={<Wallet className="h-5 w-5" strokeWidth={1.75} />}
            title="Cost plan not yet connected"
            description="The commercial cost plan for this project will appear here once budgets and invoice ingestion are connected. View the portfolio cost-plan structure on the Commercial page."
          />
        ) : null}
        {active === "Invoices" ? (
          <EmptyState
            icon={<FileText className="h-5 w-5" strokeWidth={1.75} />}
            title="No invoices recorded"
            description="Invoices allocated to Higher Farm will appear here. Invoice ingestion will update both project costs and procurement price history."
          />
        ) : null}
        {active === "Procurement" ? (
          <EmptyState
            icon={<Boxes className="h-5 w-5" strokeWidth={1.75} />}
            title="Procurement not yet linked to this project"
            description="Once the 211-product procurement database is imported, project-specific material pricing and purchasing will be tracked here."
          />
        ) : null}
        {active === "Variations" ? (
          <EmptyState
            icon={<GitBranch className="h-5 w-5" strokeWidth={1.75} />}
            title="No variations logged"
            description="Client upgrades and extras — such as Plot 2 Extras — will be tracked here against payments and remaining balances."
          />
        ) : null}
        {active === "Programme" ? (
          <EmptyState
            icon={<CalendarRange className="h-5 w-5" strokeWidth={1.75} />}
            title="Programme not yet connected"
            description="The construction programme and QS valuation schedule will be shown here to drive drawdown timing."
          />
        ) : null}
        {active === "Documents" ? (
          <EmptyState
            icon={<FileText className="h-5 w-5" strokeWidth={1.75} />}
            title="No documents uploaded"
            description="Drawings, warranties, contracts and certificates for this project will be stored here."
          />
        ) : null}
      </main>
    </>
  )
}

function Overview({ project }: { project: Project }) {
  const known: { label: string; value: string }[] = [
    { label: "Project", value: `${project.name}, ${project.location}` },
    { label: "Scheme", value: `${project.homes} detached houses` },
    { label: "Total build area", value: `${formatNumber(project.buildAreaSqFt ?? 0)} sq ft` },
    { label: "Original development build budget", value: formatGBP(project.originalBuildBudget ?? 0) },
    { label: "Development facility", value: formatGBP(project.developmentFacility ?? 0) },
    {
      label: "Remaining development drawdown",
      value: formatGBP(project.remainingDrawdown ?? 0, { decimals: true }),
    },
    { label: "Project status", value: project.status },
  ]

  const unconnected = [
    "Current total spend",
    "Current forecast profit",
    "Current cash position",
    "Committed cost to date",
  ]

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <section className="lg:col-span-2">
        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h2 className="text-sm font-semibold text-foreground">Known project information</h2>
            <StatusBadge variant="success" dot>Verified</StatusBadge>
          </div>
          <dl className="flex flex-col divide-y divide-border px-5">
            {known.map((row) => (
              <div key={row.label} className="flex items-center justify-between gap-4 py-3">
                <dt className="text-sm text-muted-foreground">{row.label}</dt>
                <dd className="text-right text-sm font-medium text-foreground tabular-nums">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section>
        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
            <Info className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
            <h2 className="text-sm font-semibold text-foreground">Not yet connected</h2>
          </div>
          <ul className="flex flex-col divide-y divide-border px-5">
            {unconnected.map((item) => (
              <li key={item} className="flex items-center justify-between gap-4 py-3">
                <span className="text-sm text-muted-foreground">{item}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  Pending
                </span>
              </li>
            ))}
          </ul>
          <div className="px-5 pb-4 pt-1">
            <p className="text-xs text-muted-foreground">
              These figures require connected invoice and cost data and are deliberately not estimated.
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
