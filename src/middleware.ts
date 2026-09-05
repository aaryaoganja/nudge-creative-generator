import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  safeNextPath,
  sessionCookieOptions,
  verifySessionToken,
} from "@/lib/auth";

/**
 * The gate. Nothing reaches a page or an API route without a valid session
 * cookie — which matters here more than on most apps, because the thing behind
 * it is a Gemini key that spends money per request.
 *
 * Enforced in middleware rather than per route so that adding a route cannot
 * accidentally add a hole: the default is closed, and the exemptions are the
 * short list below.
 *
 * Next 16 prints a deprecation notice for this file convention and points at
 * `proxy.ts`. It is a rename, not a behaviour change — the codemod is
 * `npx @next/codemod@canary middleware-to-proxy .` — and it is deliberately not
 * taken here: the gate is worth landing as the documented, widely understood
 * convention first, and moving it is a one-file change whenever the deprecation
 * turns into a removal.
 */

/**
 * Static assets are matched out entirely — the gate has nothing to protect in
 * a hashed build artefact, and running the signature check on every chunk would
 * put a PBKDF2-derived HMAC in front of the page's own CSS.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};

/**
 * Open by necessity, and only these:
 *  - /login, or nobody can ever sign in;
 *  - /api/auth/*, which is the sign-in itself (and sign-out, which only deletes
 *    a cookie — there is nothing there to protect);
 *  - /api/health, because Railway's prober has no cookie jar and Railway
 *    withholds traffic from a deployment whose probe fails. This one is a pass
 *    THROUGH, not an answer: the middleware used to reply 200 {status:"ok"}
 *    itself, which meant the probe was green whether or not the app behind it
 *    could render anything at all — a route that failed to load still produced
 *    a passing health check. The route does its own redaction for anonymous
 *    callers; see src/app/api/health/route.ts.
 *  - the favicon, which the browser requests while rendering the login page.
 */
function isPublic(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/api/health" ||
    pathname === "/icon.svg" ||
    pathname === "/favicon.ico"
  );
}

/**
 * Drop a cookie that failed verification.
 *
 * `cookies.delete(name)` sets no Path, so the browser defaults the deletion
 * cookie's path to the current directory — a delete issued from /api/generate
 * is scoped to /api and never matches the session cookie, which was set at "/".
 * Expiring it with the SAME options it was written with is the only form that
 * reliably replaces it.
 */
function clearSession(response: NextResponse): NextResponse {
  response.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const signedIn = await verifySessionToken(token);

  if (pathname === "/login") {
    // Already signed in: skip the form rather than asking for a password the
    // user has evidently already given. The destination goes through
    // safeNextPath because `/\evil.example` is a browser-legal way to write an
    // absolute URL — a "starts with /" check here would be an open redirect.
    if (signedIn) {
      const target = safeNextPath(request.nextUrl.searchParams.get("next"));
      return NextResponse.redirect(new URL(target, request.nextUrl));
    }
    return NextResponse.next();
  }

  if (isPublic(pathname) || signedIn) return NextResponse.next();

  // An API call gets a status code it can act on. Redirecting it to HTML would
  // surface in the UI as a JSON parse error rather than as "you are signed out".
  if (pathname.startsWith("/api/")) {
    const response = NextResponse.json(
      { error: "Not signed in. Open /login and enter the password." },
      { status: 401 },
    );
    return token ? clearSession(response) : response;
  }

  // Cloned from nextUrl rather than built from request.url: behind Railway's
  // proxy the request URL is the internal http one, and redirecting to it would
  // bounce the user through http:// on the way back to their own page.
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  login.searchParams.set("next", `${pathname}${search}`);
  const response = NextResponse.redirect(login);

  // A cookie that failed verification is expired, forged, or was signed under a
  // previous APP_PASSWORD. Dropping it stops the browser replaying it on every
  // subsequent request for the next thirty days.
  return token ? clearSession(response) : response;
}
