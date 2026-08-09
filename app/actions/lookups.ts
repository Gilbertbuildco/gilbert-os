"use server"

import { getPriceHistoryForProduct, getCostPackagesForProject } from "@/lib/queries"

export async function fetchPriceHistory(productId: number) {
  return getPriceHistoryForProduct(productId)
}

export async function fetchCostPackages(projectId: number) {
  const rows = await getCostPackagesForProject(projectId)
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name }))
}
