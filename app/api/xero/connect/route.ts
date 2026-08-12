import { randomUUID } from "node:crypto"
import { type NextRequest, NextResponse } from "next/server"
import { buildAuthorisationUrl } from "@/lib/xero/oauth"

/**
 * Starts the Xero OAuth connect flow: builds a fresh PKCE + signed
 * single-use state authorisation URL and redirects the browser to Xero's
 * own consent screen. GET only. This never writes anything to Xero — it
 * only begins the authorisation handshake; the actual token exchange
 * happens at the callback below.
 *
 * THIS ROUTE IS UNAUTHENTICATED and deployed on a public URL. Anyone on the
 * internet can hit it. Every request costs one `xero_oauth_state` row, so it
 * is rate limited per client and capped in the database
 * (`MAX_PENDING_STATES`). Neither is a substitute for the application
 * authentication layer Gilbert OS does not yet have — see the report in
 * `GILBERT_OS_HANDOVER.md`.
 */

// Never cached: a cached redirect would hand the same single-use `state` to
// every subsequent visitor, and the second one to arrive would find it spent.
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Per-client attempts allowed within `RATE_WINDOW_MS`. Generous for a human clicking "connect", useless for a flood. */
const RATE_LIMIT = 5
const RATE_WINDOW_MS = 10 * 60 * 1000

/**
 * In-memory, per-instance and best effort — it resets on cold start and does
 * not span Vercel instances, exactly like the Xero pacing counter in
 * `lib/xero/client.ts`. It raises the cost of a flood; it does not prevent
 * one. The database-side cap is the real bound.
 */
const attempts = new Map<string, number[]>()

function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")
  const ip = forwarded?.split(",")[0]?.trim()
  return ip || request.headers.get("x-real-ip") || "unknown"
}

function rateLimited(request: NextRequest): boolean {
  const key = clientKey(request)
  const now = Date.now()
  const recent = (attempts.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS)
  if (recent.length >= RATE_LIMIT) {
    attempts.set(key, recent)
    return true
  }
  recent.push(now)
  attempts.set(key, recent)
  // Opportunistic sweep so the map cannot grow without bound across many source IPs.
  if (attempts.size > 5000) {
    for (const [k, times] of attempts) {
      if (times.every((at) => now - at >= RATE_WINDOW_MS)) attempts.delete(k)
    }
  }
  return false
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store, private")
  response.headers.set("X-Robots-Tag", "noindex, nofollow")
  return response
}

export async function GET(request: NextRequest) {
  if (rateLimited(request)) {
    return noStore(
      NextResponse.json({ ok: false, error: "Too many Xero connection attempts. Try again later." }, { status: 429 }),
    )
  }

  try {
    const url = await buildAuthorisationUrl()
    return noStore(NextResponse.redirect(url))
  } catch (err) {
    // The detail stays server-side. These errors name environment variables
    // (XERO_CLIENT_ID, XERO_TOKEN_ENCRYPTION_KEY) and can carry database text;
    // on a public unauthenticated URL that is free reconnaissance. The caller
    // gets a reference to quote instead.
    const reference = randomUUID()
    console.error(`[xero/connect] failed (ref ${reference}):`, (err as Error)?.message ?? err)
    return noStore(
      NextResponse.json(
        { ok: false, error: "Could not start the Xero connection. Check the server logs.", reference },
        { status: 500 },
      ),
    )
  }
}
