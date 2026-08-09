import { PageHeader } from "@/components/page-header"
import { AppraisalCalculator } from "@/components/appraisal-calculator"

export default function LandAppraisalPage() {
  return (
    <>
      <PageHeader
        title="Land Appraisal"
        description="Model development viability from land price through to residual land value. Pre-populated with the Phase 2 assumptions."
      />
      <main className="px-8 py-8">
        <AppraisalCalculator />
      </main>
    </>
  )
}
