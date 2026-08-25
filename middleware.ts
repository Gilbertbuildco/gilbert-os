import { NextResponse, type NextRequest } from "next/server"

/**
 * Password gate for the deployed app.
 *
 * WHY THIS EXISTS. Gilbert OS has no authentication layer and its GitHub repo
 * is public. Everything it shows — supplier invoices, the lender's schedule,
 * bank balances, what the owner pays himself — is commercially sensitive. On
 * localhost that was tolerable because only this Mac could reach it. On a
 * public URL it is not, so nothing is served without the password.
 *
 * HTTP Basic auth deliberately: it needs no session store, no cookie handling
 * and no login page, so there is very little of it to get wrong. It is not a
 * real auth layer and does not pretend to be — it is a lock on the door until
 * one exists.
 *
 * SITE_PASSWORD is read from the environment and is never committed. If it is
 * unset the gate FAILS CLOSED — an unset password locks everyone out rather
 * than letting everyone in, because the alternative is a public site nobody
 * realises is public.
 */
export function middleware(req: NextRequest) {
  const expected = process.env.SITE_PASSWORD
  if (!expected) {
    return new NextResponse(
      "SITE_PASSWORD is not set on this deployment, so access is closed. Set it in the Vercel project's environment variables and redeploy.",
      { status: 503 },
    )
  }

  const header = req.headers.get("authorization")
  if (header?.startsWith("Basic ")) {
    // atob is available in the edge runtime; Buffer is not.
    const decoded = atob(header.slice(6))
    const password = decoded.slice(decoded.indexOf(":") + 1)
    // Constant-time-ish comparison: compare every character regardless of
    // where the first difference falls, so response timing does not leak the
    // password one character at a time.
    if (password.length === expected.length) {
      let diff = 0
      for (let i = 0; i < expected.length; i++) diff |= password.charCodeAt(i) ^ expected.charCodeAt(i)
      if (diff === 0) return NextResponse.next()
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Gilbert OS", charset="UTF-8"' },
  })
}

export const config = {
  // Everything except Next's own static assets and the favicon. API routes ARE
  // included: /api/xero/* and /api/cron/* must not be reachable unauthenticated.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
