import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { KEY_COOKIE } from "@/lib/key-cookie";

export const dynamic = "force-dynamic";

/**
 * Signing out drops the key override with the session.
 *
 * Leaving a sealed key behind on a machine whose user has explicitly said "I am
 * done" is the wrong default — the next person to open the app would be
 * spending a credential they never entered.
 *
 * POST only: with SameSite=Lax a cross-site POST carries no cookie, so nobody
 * else's page can sign this browser out.
 */
export async function POST() {
  const response = NextResponse.json({ ok: true });
  // Expire rather than delete, so the flags match the cookies that were set and
  // the browser reliably replaces them.
  response.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  response.cookies.set(KEY_COOKIE, "", sessionCookieOptions(0));
  return response;
}
