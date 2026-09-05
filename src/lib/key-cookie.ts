import { KEY_OVERRIDE_CONTEXT, base64url, fromBase64url, subkey } from "./auth.ts";

/**
 * The per-session Gemini key override, as it lives in a cookie.
 *
 * The value here is a live credential that spends money, so it is sealed with
 * AES-GCM rather than merely signed: signing would keep it honest but leave it
 * readable by anything that can see the cookie jar — a browser extension, a
 * shared machine, a screenshot of devtools. GCM also authenticates, so a
 * tampered cookie fails to open instead of decrypting to garbage that would be
 * sent to Google as a key.
 *
 * The sealing key is derived from APP_PASSWORD, which means rotating the app
 * password invalidates outstanding overrides along with outstanding sessions.
 * That is the correct behaviour: both are "everyone signs in again".
 */

export const KEY_COOKIE = "nudge_gemini_key";

/** Matches the session lifetime; an override should not outlive the login. */
export const KEY_COOKIE_TTL_SECONDS = 60 * 60 * 24 * 30;

const SEAL_VERSION = "v1";
const IV_BYTES = 12;

/**
 * Generous but bounded. Real keys are well under this; the cap exists so a
 * pasted essay cannot be pushed into a cookie header on every request.
 */
const MAX_KEY_LENGTH = 400;

async function aesKey(): Promise<CryptoKey> {
  const secret = await subkey(KEY_OVERRIDE_CONTEXT);
  return crypto.subtle.importKey(
    "raw",
    secret,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealKey(plaintext: string): Promise<string> {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(),
    new TextEncoder().encode(plaintext),
  );
  return `${SEAL_VERSION}.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

/** Null for anything that is not a cookie this server sealed. */
export async function openKey(sealed: string | undefined | null): Promise<string | null> {
  if (!sealed) return null;

  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== SEAL_VERSION) return null;

  const iv = fromBase64url(parts[1]);
  const body = fromBase64url(parts[2]);
  if (!iv || iv.length !== IV_BYTES || !body) return null;

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      await aesKey(),
      body,
    );
    const value = new TextDecoder().decode(plaintext).trim();
    return value.length > 0 ? value : null;
  } catch {
    // Wrong password, rotated secret, or a forged cookie. All three mean the
    // same thing to the caller: there is no usable override.
    return null;
  }
}

export type KeyVerdict =
  | { ok: true; key: string }
  | { ok: false; message: string };

/**
 * Shape checks only, on purpose. Whether the key actually works is a question
 * for Google, and answering it here would mean spending a request to find out.
 */
export function validateKey(input: string): KeyVerdict {
  const key = input.trim();
  if (key.length === 0) {
    return { ok: false, message: "Paste a key first." };
  }
  if (key.length > MAX_KEY_LENGTH) {
    return { ok: false, message: `That is longer than ${MAX_KEY_LENGTH} characters — check you pasted only the key.` };
  }
  if (!/^[\x21-\x7e]+$/.test(key)) {
    return {
      ok: false,
      message: "That contains spaces or line breaks. Paste the key on its own.",
    };
  }
  return { ok: true, key };
}

/**
 * The only representation of a key this app will ever render.
 *
 * Four trailing characters is enough to answer "is this the key I meant?" and
 * useless to anyone who does not already have it. A key too short to mask is
 * shown as nothing rather than as itself.
 */
export function maskKey(key: string | undefined | null): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= 4) return "…";
  return `…${trimmed.slice(-4)}`;
}
