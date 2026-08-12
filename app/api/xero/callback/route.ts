import { randomUUID } from "node:crypto"
import { type NextRequest, NextResponse } from "next/server"
import { exchangeCodeForTokens, persistConnection, redeemState, resolveTenants } from "@/lib/xero/oauth"

/**
 * Xero OAuth callback. Redeems the single-use `state`, exchanges the
 * authorisation `code` for tokens (PKCE verifier included), resolves which
 * organisation(s) were authorised, and persists the connection. GET only —
 * this is Xero redirecting the browser back after consent, not an
 * accounting write. No POST/PUT to any Xero endpoint happens here or
 * anywhere reachable from here.
 *
 * THIS ROUTE IS UNAUTHENTICATED. It is reachable by anyone, so it assumes
 * every query parameter is hostile: nothing from the query string is echoed
 * into a response, no internal error text is returned, and the tenant that
 * comes back from Xero is checked against this deployment's pinned
 * organisation before anything is persisted (see `persistConnection`).
 *
 * The `code` and `state` parameters are never logged. They are single-use
 * credentials; a log line containing a live authorisation code is as good as
 * the code itself for the seconds before it is redeemed.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store, private")
  response.headers.set("X-Robots-Tag", "noindex, nofollow")
  // The success body is text/plain and contains an organisation name that
  // originates upstream — stop any content sniffing turning that into markup.
  response.headers.set("X-Content-Type-Options", "nosniff")
  return response
}

/**
 * Clamps an upstream-supplied organisation name to an allowlist of characters
 * before it goes in a response body — an organisation name is chosen by
 * whoever owns the Xero org, not by us. Allowlisting rather than blocklisting
 * means control characters and markup are both gone by construction.
 */
function safeName(name: string | null): string {
  if (!name) return "unnamed organisation"
  const cleaned = name.replace(/[^\p{L}\p{N} .,'&()/-]/gu, "").trim().slice(0, 100)
  return cleaned || "unnamed organisation"
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  const error = searchParams.get("error")
  if (error) {
    // `error` and `error_description` are attacker-controllable query
    // parameters — reflecting them back would let anyone serve arbitrary text
    // from this origin. The detail is logged, not echoed.
    console.error("[xero/callback] Xero reported an authorisation error:", safeName(error))
    return noStore(NextResponse.json({ ok: false, error: "Xero rejected the authorisation request." }, { status: 400 }))
  }

  const code = searchParams.get("code")
  const state = searchParams.get("state")
  if (!code || !state) {
    return noStore(NextResponse.json({ ok: false, error: "Missing code or state on Xero callback." }, { status: 400 }))
  }

  try {
    const { codeVerifier } = await redeemState(state)
    const tokens = await exchangeCodeForTokens(code, codeVerifier)
    const tenants = await resolveTenants(tokens.access_token)

    if (tenants.length === 0) {
      return noStore(
        NextResponse.json({ ok: false, error: "Xero returned no authorised organisations for this connection." }, { status: 502 }),
      )
    }

    // Persist every organisation Xero actually authorised — never assume
    // which one "is" Gilbert Build Co LTD if more than one were granted.
    // `persistConnection` refuses any tenant this deployment is not pinned
    // to, so a stranger completing this flow against their own Xero org
    // cannot take the connection over.
    for (const tenant of tenants) {
      await persistConnection(tenant, tokens)
    }

    const names = tenants.map((tenant) => safeName(tenant.tenantName)).join(", ")
    return noStore(
      new NextResponse(`Xero connected: ${names}. You can close this tab.`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    )
  } catch (err) {
    // Generic to the caller, detailed in the logs. The underlying errors name
    // environment variables and tenant ids, and this route is public.
    const reference = randomUUID()
    console.error(`[xero/callback] failed (ref ${reference}):`, (err as Error)?.message ?? err)
    return noStore(
      NextResponse.json(
        { ok: false, error: "Could not complete the Xero connection. Check the server logs.", reference },
        { status: 500 },
      ),
    )
  }
}
