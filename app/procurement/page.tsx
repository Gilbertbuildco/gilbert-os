import { PageHeader } from "@/components/page-header"
import { ProcurementView } from "@/components/procurement-view"

export default function ProcurementPage() {
  return (
    <>
      <PageHeader
        title="Procurement"
        description="Compare merchant pricing across build stages to identify the best price and track savings. The full 211-product database will be imported into this view."
      />
      <main className="px-8 py-8">
        <ProcurementView />
      </main>
    </>
  )
}
