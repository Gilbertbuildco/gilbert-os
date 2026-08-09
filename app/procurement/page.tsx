import { PageHeader } from "@/components/page-header"
import { ProcurementView } from "@/components/procurement-view"
import { getProductPrices } from "@/lib/queries"

export const dynamic = "force-dynamic"

export default async function ProcurementPage() {
  const products = await getProductPrices()

  return (
    <>
      <PageHeader
        title="Procurement"
        description="Live merchant pricing built from confirmed supplier invoices. Open a product to see its full price history and compare merchants."
      />
      <ProcurementView products={products} />
    </>
  )
}
