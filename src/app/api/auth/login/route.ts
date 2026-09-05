import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  issueSessionToken,
  safeNextPath,
  sessionCookieOptions,
  verifyPassword,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * The one endpoint the gate lets through unauthenticated, which makes it the
 * only surface an attacker can work against — so it is also the only place in
 * the app that counts failures.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;

/**
 * In-process, deliberately.
 *
 * A shared store would survive restarts and span replicas, and is the right
 * answer for an app with real accounts. This one runs as a single Railway
 * service in front of one password: an in-memory counter costs nothing, has no
 * dependency that can fail closed, and still turns an online brute force from
 * minutes into years. A restart resets it — which an attacker cannot cause.
 */
const failures = new Map<string, { count: number; firstAt: number }>();

/**
 * Which client is this, for rate-limiting purposes.
 *
 * The FIRST x-forwarded-for hop is entirely client-supplied — a proxy appends
 * the real address, it does not replace what arrived. Keying on it meant an
 * attacker rotating `x-forwarded-for: 10.0.0.N` never hit the limit at all, and
 * a client already blocked escaped simply by adding a hop. Measured: 12 wrong
 * passwords with a rotating header produced twelve 401s and no 429.
 *
 * The LAST hop is the one the nearest trusted proxy wrote, so it is the only
 * entry a caller cannot forge.
 */
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const hops = forwarded?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  const ip = hops.length > 0 ? hops[hops.length - 1] : undefined;
  return ip || request.headers.get("x-real-ip") || "unknown";
}

/**
 * Backstop for the case the per-client key cannot cover: a distributed attempt
 * from many real addresses. Against a five-character default password, the
 * per-IP limit alone is not the control it appears to be.
 */
const GLOBAL_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_MAX_FAILURES = 60;
let globalFailures = { count: 0, firstAt: 0 };

function globalExhausted(now: number): boolean {
  if (now - globalFailures.firstAt > GLOBAL_WINDOW_MS) return false;
  return globalFailures.count >= GLOBAL_MAX_FAILURES;
}

function recordGlobalFailure(now: number): void {
  if (now - globalFailures.firstAt > GLOBAL_WINDOW_MS) {
    globalFailures = { count: 1, firstAt: now };
    return;
  }
  globalFailures.count += 1;
}

function attemptsLeft(key: string, now: number): number {
  const record = failures.get(key);
  if (!record || now - record.firstAt > WINDOW_MS) return MAX_FAILURES;
  return Math.max(0, MAX_FAILURES - record.count);
}

function recordFailure(key: string, now: number): void {
  // Bounded so a spray of forged x-forwarded-for values cannot grow the map
  // without limit. Oldest-first eviction: entries expire on their own anyway.
  if (failures.size > 5000) {
    for (const [existing, record] of failures) {
      if (now - record.firstAt > WINDOW_MS) failures.delete(existing);
    }
    if (failures.size > 5000) failures.clear();
  }

  const record = failures.get(key);
  if (!record || now - record.firstAt > WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: now });
    return;
  }
  record.count += 1;
}

export async function POST(request: Request) {
  const now = Date.now();
  const key = clientKey(request);

  if (attemptsLeft(key, now) === 0 || globalExhausted(now)) {
    const record = failures.get(key);
    const minutes = record
      ? Math.max(1, Math.ceil((WINDOW_MS - (now - record.firstAt)) / 60_000))
      : 1;
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const payload = body as { password?: unknown; next?: unknown };
  const password = typeof payload.password === "string" ? payload.password : "";
  const next = safeNextPath(typeof payload.next === "string" ? payload.next : null);

  if (!(await verifyPassword(password))) {
    recordFailure(key, now);
    recordGlobalFailure(now);
    return NextResponse.json(
      { error: "That password is not right." },
      { status: 401 },
    );
  }

  failures.delete(key);

  const response = NextResponse.json({ ok: true, next });
  response.cookies.set(SESSION_COOKIE, await issueSessionToken(now), sessionCookieOptions());
  return response;
}
