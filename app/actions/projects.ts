"use server"

import { db } from "@/lib/db"
import { projects, costPackages, invoiceLineItems } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { STANDARD_COST_PLAN } from "@/lib/cost-plan"

function slugify(name: string) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

// The standard Gilbert OS cost plan a new project is seeded with. Shared with
// the classification engine (lib/cost-plan.ts) so project-independent
// classification targets exactly the packages a standard project will have.
const DEFAULT_PACKAGES = STANDARD_COST_PLAN

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
