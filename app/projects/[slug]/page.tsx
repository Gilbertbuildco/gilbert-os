import { notFound } from "next/navigation"
import { ProjectDetail } from "@/components/project-detail"
import {
  getProjectBySlug,
  getCostPackagesForProject,
  getRecentInvoicesForProject,
} from "@/lib/queries"

export const dynamic = "force-dynamic"

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const project = await getProjectBySlug(slug)

  if (!project) {
    notFound()
  }

  const [packages, invoices] = await Promise.all([
    getCostPackagesForProject(project.id),
    getRecentInvoicesForProject(project.id),
  ])

  return <ProjectDetail project={project} packages={packages} invoices={invoices} />
}
