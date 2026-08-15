import Link from "next/link"
import { MapPin, ArrowUpRight, Plus } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { StatusBadge, type StatusVariant } from "@/components/status-badge"
import { EmptyState } from "@/components/empty-state"
import { getProjects, type ProjectRow } from "@/lib/queries"
import { formatGBP, formatNumber } from "@/lib/utils"

export const dynamic = "force-dynamic"

function statusVariant(status: string): StatusVariant {
  const s = status.toLowerCase()
  if (s.includes("site") || s.includes("progress") || s.includes("construction")) return "info"
  if (s.includes("appraisal") || s.includes("planning")) return "warning"
  if (s.includes("complete")) return "success"
  return "neutral"
}

export default async function ProjectsPage() {
  const projects = await getProjects()

  return (
    <>
      <PageHeader
        title="Projects"
        description="All development projects across the Gilbert Build Co portfolio."
        actions={
          <Link
            href="/projects/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            New project
          </Link>
        }
      />
      <main className="px-4 py-8 sm:px-8">
        {projects.length === 0 ? (
          <EmptyState
            title="No projects yet"
            description="Create your first development project to start tracking budgets, costs and spend."
            action={
              <Link
                href="/projects/new"
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                New project
              </Link>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {projects.map((project) => (
              <ProjectCard key={project.slug} project={project} />
            ))}
          </div>
        )}
      </main>
    </>
  )
}

function ProjectCard({ project }: { project: ProjectRow }) {
  return (
    <Link href={`/projects/${project.slug}`} className="block h-full">
      <div className="group flex h-full flex-col rounded-lg border border-border bg-card p-6 transition-colors hover:border-border-strong">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {project.name}
              {project.location ? `, ${project.location}` : ""}
            </h2>
            {project.location ? (
              <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} />
                {project.location}
              </p>
            ) : null}
          </div>
          <StatusBadge variant={statusVariant(project.status)} dot>
            {project.status}
          </StatusBadge>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-4">
          {project.homes ? <Fact label="Homes" value={`${project.homes} homes`} /> : null}
          {project.buildAreaSqft ? (
            <Fact label="Build area" value={`${formatNumber(project.buildAreaSqft)} sq ft`} />
          ) : null}
          {project.originalBuildBudget ? (
            <Fact label="Build budget" value={formatGBP(project.originalBuildBudget)} />
          ) : null}
          {project.developmentFacility ? (
            <Fact label="Facility" value={formatGBP(project.developmentFacility)} />
          ) : null}
          <Fact label="Spend to date" value={formatGBP(project.spendToDate)} />
          <Fact label="Invoices" value={String(project.invoiceCount)} />
        </dl>

        <div className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-accent">
          View project detail
          <ArrowUpRight
            className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
            strokeWidth={1.75}
          />
        </div>
      </div>
    </Link>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-foreground tabular-nums">{value}</dd>
    </div>
  )
}
