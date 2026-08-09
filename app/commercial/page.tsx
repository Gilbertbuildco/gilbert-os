import { PageHeader } from "@/components/page-header"
import { CommercialView } from "@/components/commercial-view"
import {
  getProjectOptions,
  getProjectBySlug,
  getCostPackagesForProject,
  getLineItemsForProject,
} from "@/lib/queries"

export const dynamic = "force-dynamic"

export default async function CommercialPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>
}) {
  const { project } = await searchParams
  const projects = await getProjectOptions()

  const selectedSlug = project ?? projects[0]?.slug ?? null
  const selected = selectedSlug ? await getProjectBySlug(selectedSlug) : null

  const [packages, lineItems] = selected
    ? await Promise.all([
        getCostPackagesForProject(selected.id),
        getLineItemsForProject(selected.id),
      ])
    : [[], []]

  return (
    <>
      <PageHeader
        title="Commercial"
        description="Cost plan by package for each project. Set original budgets and watch committed spend roll up automatically from confirmed invoices."
      />
      <CommercialView
        projects={projects}
        selectedSlug={selected ? selectedSlug : null}
        packages={packages}
        lineItems={lineItems}
      />
    </>
  )
}
