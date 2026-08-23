import { PageHeader } from "@/components/page-header"
import { PositionView } from "@/components/position-view"
import { getPosition } from "@/lib/funding/position"
import { getProjectBySlug, getProjectOptions } from "@/lib/queries"

export const dynamic = "force-dynamic"

export default async function PositionPage() {
  const projects = await getProjectOptions()
  const selected = projects[0] ? await getProjectBySlug(projects[0].slug) : null
  const position = selected ? await getPosition(selected.id) : null

  return (
    <>
      <PageHeader
        title="Position"
        description="Cash, what is owed, what is left to draw, and what is expected to be paid. Nothing here is estimated — a future payment appears only with an accepted quote or a figure you have given."
      />
      <main className="flex flex-col gap-6 px-4 py-8 sm:px-8">
        {position ? <PositionView p={position} /> : (
          <p className="text-sm text-muted-foreground">No funding budget recorded, so there is no position to show.</p>
        )}
      </main>
    </>
  )
}
