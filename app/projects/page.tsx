import Link from "next/link"
import { MapPin, ArrowUpRight } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { StatusBadge, type StatusVariant } from "@/components/status-badge"
import { projects, type Project } from "@/lib/data"
import { formatGBP, formatNumber } from "@/lib/utils"

const statusVariant: Record<Project["status"], StatusVariant> = {
  Construction: "info",
  Appraisal: "warning",
  Planning: "neutral",
  Complete: "success",
}

export default function ProjectsPage() {
  return (
    <>
      <PageHeader
        title="Projects"
        description="All development projects across the Gilbert Build Co portfolio."
      />
      <main className="px-8 py-8">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {projects.map((project) => (
            <ProjectCard key={project.slug} project={project} />
          ))}
        </div>
      </main>
    </>
  )
}

function ProjectCard({ project }: { project: Project }) {
  const isLinked = project.slug === "higher-farm"

  const body = (
    <div className="group flex h-full flex-col rounded-lg border border-border bg-card p-6 transition-colors hover:border-border-strong">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {project.name}, {project.location}
          </h2>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} />
            {project.location}
          </p>
        </div>
        <StatusBadge variant={statusVariant[project.status]} dot>
          {project.status}
        </StatusBadge>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-4">
        {project.homes ? <Fact label="Homes" value={`${project.homes} homes`} /> : null}
        {project.buildAreaSqFt ? (
          <Fact label="Build area" value={`${formatNumber(project.buildAreaSqFt)} sq ft`} />
        ) : null}
        {project.expectedGDV ? <Fact label="Expected GDV" value={formatGBP(project.expectedGDV)} /> : null}
        {project.landPrice ? <Fact label="Land price" value={formatGBP(project.landPrice)} /> : null}
        {project.buildCostPerSqFt ? (
          <Fact label="Build-cost assumption" value={`${formatGBP(project.buildCostPerSqFt)}/sq ft`} />
        ) : null}
        {project.originalBuildBudget ? (
          <Fact label="Original build budget" value={formatGBP(project.originalBuildBudget)} />
        ) : null}
      </dl>

      {isLinked ? (
        <div className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-accent">
          View project detail
          <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" strokeWidth={1.75} />
        </div>
      ) : (
        <div className="mt-6 text-sm text-muted-foreground">Currently in appraisal stage</div>
      )}
    </div>
  )

  if (isLinked) {
    return (
      <Link href={`/projects/${project.slug}`} className="block h-full">
        {body}
      </Link>
    )
  }
  return body
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-foreground tabular-nums">{value}</dd>
    </div>
  )
}
