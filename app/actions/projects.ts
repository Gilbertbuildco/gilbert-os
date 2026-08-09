"use server"

import { db } from "@/lib/db"
import { projects, costPackages, invoiceLineItems } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"

function slugify(name: string) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

const DEFAULT_PACKAGES: Array<{ code: string; name: string }> = [
  { code: "01", name: "Preliminaries" },
  { code: "02", name: "Groundworks & Foundations" },
  { code: "03", name: "Superstructure - Frame" },
  { code: "04", name: "External Walls & Cladding" },
  { code: "05", name: "Roofing" },
  { code: "06", name: "Windows & External Doors" },
  { code: "07", name: "Internal Walls & Partitions" },
  { code: "08", name: "First Fix Carpentry" },
  { code: "09", name: "Plumbing & Heating" },
  { code: "10", name: "Electrical" },
  { code: "11", name: "Plastering & Drylining" },
  { code: "12", name: "Second Fix Carpentry" },
  { code: "13", name: "Kitchens" },
  { code: "14", name: "Bathrooms & Sanitaryware" },
  { code: "15", name: "Decoration" },
  { code: "16", name: "Flooring" },
  { code: "17", name: "External Works & Landscaping" },
  { code: "18", name: "Drainage" },
  { code: "19", name: "Insulation" },
]

export type CreateProjectInput = {
  name: string
  location: string | null
  status: string
  homes: number | null
  buildAreaSqft: number | null
  originalBuildBudget: number | null
  developmentFacility: number | null
  remainingDrawdown: number | null
  expectedGdv: number | null
  seedCostPackages: boolean
}

export async function createProject(input: CreateProjectInput) {
  const name = input.name.trim()
  if (!name) throw new Error("A project name is required.")

  let slug = slugify(name)
  const existing = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1)
  if (existing[0]) slug = `${slug}-${Date.now().toString().slice(-4)}`

  const [project] = await db
    .insert(projects)
    .values({
      slug,
      name,
      location: input.location,
      status: input.status,
      homes: input.homes,
      buildAreaSqft: input.buildAreaSqft,
      originalBuildBudget: input.originalBuildBudget == null ? null : String(input.originalBuildBudget),
      developmentFacility: input.developmentFacility == null ? null : String(input.developmentFacility),
      remainingDrawdown: input.remainingDrawdown == null ? null : String(input.remainingDrawdown),
      expectedGdv: input.expectedGdv == null ? null : String(input.expectedGdv),
    })
    .returning()

  if (input.seedCostPackages) {
    await db.insert(costPackages).values(
      DEFAULT_PACKAGES.map((p) => ({
        projectId: project.id,
        code: p.code,
        name: p.name,
      })),
    )
  }

  revalidatePath("/projects")
  revalidatePath("/")
  return { slug: project.slug }
}

export async function setPackageBudget(costPackageId: number, budget: number | null) {
  await db
    .update(costPackages)
    .set({ originalBudget: budget == null ? null : String(budget) })
    .where(eq(costPackages.id, costPackageId))
  revalidatePath("/commercial")
}

export async function addCostPackage(projectId: number, code: string | null, name: string) {
  const trimmed = name.trim()
  if (!trimmed) throw new Error("Package name required")
  await db.insert(costPackages).values({ projectId, code: code?.trim() || null, name: trimmed })
  revalidatePath("/commercial")
}

/** Reassign a committed line item to a different cost package. */
export async function assignLineItemToPackage(lineItemId: number, costPackageId: number | null) {
  await db
    .update(invoiceLineItems)
    .set({ costPackageId })
    .where(eq(invoiceLineItems.id, lineItemId))
  revalidatePath("/commercial")
}
