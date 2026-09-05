import { NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/auth";
import {
  KEY_COOKIE,
  KEY_COOKIE_TTL_SECONDS,
  sealKey,
  validateKey,
} from "@/lib/key-cookie";
import { describeKey } from "@/lib/runtime-key";

export const dynamic = "force-dynamic";

/**
 * Set or clear the per-session Gemini key override.
 *
 * Note the path: this lives under /api/keys, NOT under /api/auth, because the
 * gate lets /api/auth through unauthenticated. An endpoint that plants a
 * credential in a cookie belongs firmly behind the password.
 *
 * The response never contains the key — only the mask the page is allowed to
 * render, so a value the user just typed does not come straight back down the
 * wire into a place it could be logged.
 */

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const raw = (body as { key?: unknown }).key;
  if (typeof raw !== "string") {
    return NextResponse.json({ error: "Expected { key: string }" }, { status: 422 });
  }

  const verdict = validateKey(raw);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.message }, { status: 422 });
  }

  const sealed = await sealKey(verdict.key);
  const response = NextResponse.json({ status: await describeKey(sealed) });
  response.cookies.set(KEY_COOKIE, sealed, sessionCookieOptions(KEY_COOKIE_TTL_SECONDS));
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ status: await describeKey(null) });
  response.cookies.set(KEY_COOKIE, "", sessionCookieOptions(0));
  return response;
}
