import { env } from "./env.ts";
import { KEY_COOKIE, maskKey, openKey } from "./key-cookie.ts";

/**
 * Which Gemini key a request should actually spend.
 *
 * The deployment carries a key in its Railway environment, but the person using
 * the app may want to spend their own — for a demo, for a client's quota, or
 * because the deployment's key is exhausted. The override lives in a sealed
 * cookie, so it is scoped to one browser session and costs no redeploy.
 *
 * The environment key stays the fallback rather than being replaced: clearing
 * the override is one click and the app keeps working.
 *
 * Both spending routes call geminiKeyForRequest() — src/app/api/generate and
 * src/app/api/score — and neither reads config.GEMINI_API_KEY any more. Their
 * 503 guard now means "no key from either source", which is the condition that
 * actually matters. If you add a third route that spends Gemini credit, it must
 * go through here too, or /keys will tell the user something untrue.
 *
 * /api/health is the deliberate exception: it is reachable without a session,
 * so it reports on the DEPLOYMENT's key. A probe that flipped to green because
 * whoever ran curl happened to carry an override cookie would be worthless.
 */

/**
 * The deployment's own key, or nothing.
 *
 * Swallows a configuration error on purpose. The one moment this module is most
 * needed is when the environment is wrong, and a throw from an unrelated
 * variable would take down the very page whose job is to supply a key by hand.
 * Every route already calls env() directly, so a real misconfiguration is still
 * reported loudly — just not from here.
 */
function environmentKey(): string | undefined {
  try {
    return env().GEMINI_API_KEY;
  } catch {
    return undefined;
  }
}

/** Minimal cookie-header parse: Next's helpers are not available to plain Requests. */
function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** The sealed override cookie as it arrived, or undefined. */
export function overrideCookieFrom(request: Request): string | undefined {
  return cookieValue(request.headers.get("cookie"), KEY_COOKIE);
}

/**
 * The effective key for this request: the session override if one is present
 * and opens, otherwise the deployment's own key. Undefined when there is
 * neither — callers already handle that with a 503.
 */
export async function geminiKeyForRequest(
  request: Request,
): Promise<string | undefined> {
  const override = await openKey(overrideCookieFrom(request));
  if (override) return override;
  return environmentKey();
}

export interface KeyStatus {
  source: "override" | "environment" | "none";
  /** Last four characters only — never the key. */
  masked: string | null;
  /** True when the deployment has a key of its own to fall back to. */
  environmentPresent: boolean;
}

/**
 * What to tell the user about the key in effect, given the raw sealed cookie.
 *
 * Takes the cookie value rather than a Request so a server component can pass
 * what `cookies()` gave it. Returns a mask and a source and nothing else: the
 * page has no legitimate need for the key itself, and a value that is never
 * assembled into HTML cannot leak through one.
 */
export async function describeKey(
  sealedCookie: string | undefined | null,
): Promise<KeyStatus> {
  const fromEnvironment = environmentKey();
  const override = await openKey(sealedCookie);

  if (override) {
    return {
      source: "override",
      masked: maskKey(override),
      environmentPresent: Boolean(fromEnvironment),
    };
  }

  return {
    source: fromEnvironment ? "environment" : "none",
    masked: maskKey(fromEnvironment),
    environmentPresent: Boolean(fromEnvironment),
  };
}
