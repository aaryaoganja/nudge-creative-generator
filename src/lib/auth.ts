/**
 * The password gate.
 *
 * This is the only thing between the open internet and a Gemini key that spends
 * real money, so the shape matters more than the size of the code:
 *
 *  - Web Crypto, not node:crypto. The middleware that enforces the gate runs in
 *    the Edge runtime, where node:crypto does not exist. Node 22 exposes the
 *    same API as a global, so one implementation serves both the middleware and
 *    the route handlers rather than two that can drift apart.
 *  - The password is never written to the cookie. The cookie carries an expiry
 *    and a nonce, signed with a secret derived from the password; a forged or
 *    edited cookie fails the signature check.
 *  - Every comparison of a secret is constant-time. A password this short is
 *    already guessable; it should not also be measurable.
 *
 * Rotating APP_PASSWORD changes the derived secret, which invalidates every
 * outstanding session. That is the intended way to kick everyone out.
 */

export const SESSION_COOKIE = "nudge_session";

/** Thirty days. Long enough not to be a nuisance, short enough to expire. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const TOKEN_VERSION = "v1";

/**
 * PBKDF2 salt, and the labels that separate one derived subkey from another so
 * the session signing key and the API-key sealing key are independent.
 */
const ROOT_SALT = "nudge-ad-studio/gate/v1";
const SESSION_CONTEXT = "nudge-ad-studio/session/v1";
export const KEY_OVERRIDE_CONTEXT = "nudge-ad-studio/key-override/v1";

/**
 * Deliberately high for a value derived once per process, and deliberately not
 * higher: the cookie signature is handed to the client, so an attacker who
 * collects one can grind candidate passwords offline. Stretching turns a
 * five-character password from "instant" into something with a cost, without
 * putting a visible delay on the first request of a cold container.
 */
const PBKDF2_ITERATIONS = 120_000;

/**
 * Web Crypto's BufferSource requires a view over a plain ArrayBuffer, and a
 * bare `Uint8Array` is a view over ArrayBufferLike (which includes
 * SharedArrayBuffer). Naming the concrete type once keeps every signature here
 * assignable instead of sprinkling casts at each call site.
 */
type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();

function utf8(value: string): Bytes {
  return encoder.encode(value);
}

/**
 * Read straight from process.env rather than through env().
 *
 * The middleware must not depend on the zod schema: a validation failure in an
 * unrelated variable would throw inside the gate and lock every user out of a
 * working app. It also keeps the Edge bundle free of the whole config module.
 */
export function appPassword(): string {
  const configured = process.env.APP_PASSWORD?.trim();
  return configured ? configured : "NUDGE";
}

let rootCache: { password: string; secret: Promise<Bytes> } | undefined;

async function stretch(password: string): Promise<Bytes> {
  const material = await crypto.subtle.importKey(
    "raw",
    utf8(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: utf8(ROOT_SALT),
      iterations: PBKDF2_ITERATIONS,
    },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Memoised on the password itself, so a rotated APP_PASSWORD takes effect
 * without a restart and a test can change it between cases.
 */
function rootSecret(): Promise<Bytes> {
  const password = appPassword();
  if (!rootCache || rootCache.password !== password) {
    rootCache = { password, secret: stretch(password) };
  }
  return rootCache.secret;
}

/** Test seam: forget the stretched secret. */
export function resetSecretCache(): void {
  rootCache = undefined;
}

async function hmacKey(secret: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmac(secret: Bytes, message: string): Promise<Bytes> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    utf8(message),
  );
  return new Uint8Array(signature);
}

/**
 * One 32-byte subkey per purpose, from the single stretched root. Cheap (one
 * HMAC), and it means a leak of the sealing key would not also forge sessions.
 */
export async function subkey(context: string): Promise<Bytes> {
  return hmac(await rootSecret(), context);
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(value: string): Bytes | null {
  // Reject anything that is not base64url before handing it to atob, which is
  // lenient enough to accept input this code should treat as tampering.
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Constant-time byte comparison. Returns false for a length mismatch, but only
 * after doing the same work either way so the answer is not timed out of it.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Password check by double HMAC.
 *
 * Comparing the strings directly would leak the shared prefix through timing,
 * and comparing lengths would leak the length. HMAC-ing both sides under a key
 * the attacker does not have turns any input into a fixed-width digest, so the
 * comparison carries no information about the password at all.
 */
export async function verifyPassword(candidate: string): Promise<boolean> {
  const blind = new Uint8Array(32);
  crypto.getRandomValues(blind);
  const [offered, expected] = await Promise.all([
    hmac(blind, candidate),
    hmac(blind, appPassword()),
  ]);
  return timingSafeEqual(offered, expected);
}

/**
 * Mint a session token: `v1.<expiry seconds>.<nonce>.<signature>`.
 *
 * The nonce exists so two sessions issued in the same second are still distinct
 * values, which keeps a stolen-then-replayed cookie from being indistinguishable
 * from the one it was copied off in a log.
 */
export async function issueSessionToken(now = Date.now()): Promise<string> {
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const payload = `${TOKEN_VERSION}.${expiresAt}.${base64url(nonce)}`;
  const signature = await hmac(await subkey(SESSION_CONTEXT), payload);
  return `${payload}.${base64url(signature)}`;
}

/**
 * True only for a token this server signed, which has not expired, and whose
 * payload is byte-for-byte what was signed.
 */
export async function verifySessionToken(
  token: string | undefined | null,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 4) return false;

  const [version, expiry, nonce, signature] = parts;
  if (version !== TOKEN_VERSION) return false;

  const offered = fromBase64url(signature);
  if (!offered) return false;

  const payload = `${version}.${expiry}.${nonce}`;
  const expected = await hmac(await subkey(SESSION_CONTEXT), payload);

  // Signature first, expiry second: an unsigned token should not be able to
  // learn anything by varying its claimed expiry.
  if (!timingSafeEqual(offered, expected)) return false;

  const expiresAt = Number(expiry);
  if (!Number.isSafeInteger(expiresAt)) return false;
  return expiresAt * 1000 > now;
}

/**
 * Cookie flags, in one place because getting one of them wrong is the whole
 * vulnerability. Secure is conditional only so that http://localhost still
 * works in development — production always gets it.
 */
export function sessionCookieOptions(maxAge = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

/**
 * Where to send someone after they sign in.
 *
 * Only same-origin, path-absolute targets are accepted. On a login page an open
 * redirect means handing a phished user to an attacker's copy of it, so this is
 * a denylist of shapes we know about only as a last resort — the actual test is
 * to RESOLVE the candidate and require the origin to come back unchanged.
 *
 * Pattern-matching alone is not enough, and this function previously proved it:
 * it rejected `//evil.example` and `/\evil.example` but accepted
 * `/<TAB>/evil.example`. The WHATWG URL parser STRIPS tab, CR and LF before
 * parsing, so the browser turns that back into `//evil.example` and navigates
 * off-origin. `%09`, `%0A` and `%0D` all decode into the same trap.
 *
 * Resolving against a sentinel origin closes the whole class: whatever the
 * browser would do with the string, we do first, and reject anything that lands
 * somewhere else.
 */
const SENTINEL_ORIGIN = "https://nudge-ad-studio.invalid";

export function safeNextPath(candidate: string | null | undefined): string {
  if (!candidate) return "/";

  // C0 controls and DEL are stripped or rejected inconsistently across parsers.
  // Nothing legitimate contains them, so refuse before any other reasoning.
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return "/";

  if (!candidate.startsWith("/")) return "/";

  let resolved: URL;
  try {
    resolved = new URL(candidate, SENTINEL_ORIGIN);
  } catch {
    return "/";
  }

  // The candidate escaped to another origin — the definition of the bug.
  if (resolved.origin !== SENTINEL_ORIGIN) return "/";

  // Bouncing back to /login would loop, and ?next= chaining is a redirect gadget.
  if (resolved.pathname === "/login" || resolved.pathname.startsWith("/login/")) {
    return "/";
  }

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
