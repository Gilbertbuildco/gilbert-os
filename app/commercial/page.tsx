import Link from "next/link"
import { PageHeader } from "@/components/page-header"
import { CommercialView } from "@/components/commercial-view"
import { FundingVsActual } from "@/components/funding-vs-actual"
import { cn } from "@/lib/utils"
import {
  getProjectOptions,
  getProjectBySlug,
  getCostPackagesForProject,
  getLineItemsForProject,
} from "@/lib/queries"
import { getFundingCommercial } from "@/lib/funding/queries"

export const dynamic = "force-dynamic"

type CommercialTab = "budget" | "funding"

export default async function CommercialPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; view?: string }>
}) {
  const { project, view } = await searchParams
  const projects = await getProjectOptions()
  const tab: CommercialTab = view === "funding" ? "funding" : "budget"

  const selectedSlug = project ?? projects[0]?.slug ?? null
  const selected = selectedSlug ? await getProjectBySlug(selectedSlug) : null

  const [packages, lineItems] = selected && tab === "budget"
    ? await Promise.all([
        getCostPackagesForProject(selected.id),
        getLineItemsForProject(selected.id),
      ])
    : [[], []]

  const funding = selected && tab === "funding" ? await getFundingCommercial(selected.id) : null

  return (
    <>
      <PageHeader
        title="Commercial"
        description="Cost plan by package for each project. Set original budgets and watch committed spend roll up automatically from confirmed invoices."
      />
      <div className="px-8 pt-6">
        <div role="tablist" aria-label="Commercial view" className="inline-flex gap-1 rounded-lg border border-border bg-card p-1">
          <Link
            href={`/commercial${selectedSlug ? `?project=${selectedSlug}` : ""}`}
            role="tab"
            aria-selected={tab === "budget"}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === "budget"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Budget
          </Link>
          <Link
            href={`/commercial?view=funding${selectedSlug ? `&project=${selectedSlug}` : ""}`}
            role="tab"
            aria-selected={tab === "funding"}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === "funding"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Funding vs Actual
          </Link>
        </div>
      </div>

      {tab === "funding" ? (
        <main className="flex flex-col gap-6 px-8 py-8">
          {projects.length > 1 ? (
            <div role="tablist" aria-label="Project" className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1">
              {projects.map((p) => (
                <Link
                  key={p.id}
                  href={`/commercial?view=funding&project=${p.slug}`}
                  role="tab"
                  aria-selected={p.slug === selectedSlug}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    p.slug === selectedSlug
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p.name}
                </Link>
              ))}
            </div>
          ) : null}
          <FundingVsActual data={funding} projectSelected={!!selected} />
        </main>
      ) : (
        <CommercialView
          projects={projects}
          selectedSlug={selected ? selectedSlug : null}
          packages={packages}
          lineItems={lineItems}
        />
      )}
    </>
  )
}
