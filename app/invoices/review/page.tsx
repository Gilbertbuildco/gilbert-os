import Link from "next/link"
import { ArrowLeft, CheckCircle2, PartyPopper } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { ReviewQueueScreen } from "@/components/review-queue-screen"
import { getReviewQueue, getInvoiceSummary, getProjectOptions } from "@/lib/queries"

export const dynamic = "force-dynamic"

type SearchParams = { cursor?: string }

function parseCursor(v?: string): number {
  const n = Number.parseInt(v ?? "0", 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/**
 * One invoice per screen, oldest first — the fast phone-friendly alternative
 * to reviewing 70+ rows in the big table. Global across projects (the queue
 * itself is not project-scoped); each invoice's own project still governs
 * which cost packages it can classify against.
 */
export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const cursor = parseCursor(sp.cursor)

  const [entries, summary, projectOptions] = await Promise.all([
    getReviewQueue(null, { cursor, limit: 1 }),
    getInvoiceSummary({ needsReview: true }),
    getProjectOptions(),
  ])
  const entry = entries[0] ?? null

  // ReviewQueueEntry (like InvoiceRow) carries the project's name, not its
  // id. Resolve it from project options — the same pattern the invoices
  // table uses — so the classifier fetches the right project's packages.
  const projectIdByName = new Map(projectOptions.map((p) => [p.name, p.id]))
  const projectId = entry?.projectName ? (projectIdByName.get(entry.projectName) ?? null) : null

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Work through flagged invoices one at a time — classify lines, answer questions, mark reviewed."
        actions={
          <Link
            href="/invoices"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
            Back to invoices
          </Link>
        }
      />
      <main className="flex flex-1 flex-col px-4 py-6 sm:px-8">
        {entry ? (
          <ReviewQueueScreen key={entry.id} entry={entry} cursor={cursor} total={summary.count} projectId={projectId} />
        ) : summary.count === 0 ? (
          <EmptyState
            icon={<PartyPopper className="h-5 w-5" strokeWidth={1.75} />}
            title="Queue clear"
            description="No invoices need review right now. New flagged invoices will appear here."
            action={
              <Link
                href="/invoices"
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Back to invoices
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={<CheckCircle2 className="h-5 w-5" strokeWidth={1.75} />}
            title="End of queue"
            description={`${summary.count} invoice${summary.count === 1 ? "" : "s"} still need review. Go back to the start of the queue?`}
            action={
              <Link
                href="/invoices/review?cursor=0"
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Back to start
              </Link>
            }
          />
        )}
      </main>
    </>
  )
}
