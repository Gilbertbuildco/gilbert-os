import { PageHeader } from "@/components/page-header"
import { CreateProjectForm } from "@/components/create-project-form"

export const metadata = { title: "New Project — Gilbert OS" }

export default function NewProjectPage() {
  return (
    <>
      <PageHeader
        title="New Project"
        description="Create a development. Standard cost packages are added automatically so you can start assigning spend immediately."
      />
      <div className="px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-2xl">
          <CreateProjectForm />
        </div>
      </div>
    </>
  )
}
