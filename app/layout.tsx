import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Sidebar } from "@/components/sidebar"
import { getInvoiceSummary } from "@/lib/queries"
import "./globals.css"

export const dynamic = "force-dynamic"

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
})

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
})

export const metadata: Metadata = {
  title: "Gilbert OS — Development Operating System",
  description:
    "Gilbert OS is the internal development operating system for Gilbert Build Co, managing projects, commercial cost plans, procurement and land appraisals.",
  applicationName: "Gilbert OS",
}

export const viewport: Viewport = {
  themeColor: "#0f1b2e",
  width: "device-width",
  initialScale: 1,
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Sitewide count for the sidebar's "Review" badge — every project, no
  // filters. A single indexed count query, cheap enough to run on every
  // navigation alongside the rest of this already-dynamic app.
  const reviewSummary = await getInvoiceSummary({ needsReview: true })

  return (
    <html lang="en" className="bg-background">
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
        <div className="flex min-h-screen flex-col lg:flex-row">
          <Sidebar reviewCount={reviewSummary.count} />
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        </div>
      </body>
    </html>
  )
}
