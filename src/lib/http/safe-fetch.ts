import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outbound HTTP for URLs that originate from user input.
 *
 * A marketer pastes a product URL into the UI and the worker fetches it. That
 * makes every fetch here a server-side request to an attacker-influenced host,
 * so this module exists to make SSRF impractical rather than to be convenient:
 *
 *   - https only
 *   - DNS is resolved *before* connecting and every resolved address is checked
 *     against the private/loopback/link-local ranges (169.254.169.254 is the
 *     cloud metadata endpoint and is the reason this is not optional)
 *   - redirects are followed manually so every hop is re-validated; a public
 *     host that 302s to 127.0.0.1 is the classic bypass
 *   - responses are size-capped while streaming, not after
 *   - host allowlist, because this tool serves exactly one brand
 */

export class FetchRejectedError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "FetchRejectedError";
    this.reason = reason;
  }
}

export interface SafeFetchOptions {
  /** Hostnames permitted, matched exactly or as a parent domain. */
  allowedHosts: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string | null;
  body: string;
  bytes: number;
}

export interface SafeFetchBinaryResult {
  url: string;
  status: number;
  contentType: string | null;
  data: Uint8Array;
  bytes: number;
}

const DEFAULTS = {
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 5,
} as const;

// Shopify serves products.json to ordinary clients but some edge configurations
// reject requests with no User-Agent outright, which reads as a 403 and sends
// you hunting for an auth problem that does not exist.
const USER_AGENT =
  "Mozilla/5.0 (compatible; nudge-creative-generator/0.1; +https://github.com/aaryaoganja/nudge-creative-generator)";

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return true;

  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;

  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0];
  if (addr === "::1" || addr === "::") return true;

  // IPv4-mapped (::ffff:10.0.0.1) inherits the IPv4 verdict. Checked before the
  // blanket "::" rule below, which would otherwise swallow it.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isPrivateIPv4(mapped[1]);

  if (addr.startsWith("::")) return true; // remaining ::/96 reserved space

  const group = Number.parseInt(addr.split(":")[0] || "", 16);
  if (Number.isNaN(group)) return true;
  if ((group & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((group & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true; // not an IP literal at all — refuse rather than guess
}

export function hostIsAllowed(
  hostname: string,
  allowedHosts: readonly string[],
): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some((allowed) => {
    const a = allowed.toLowerCase().replace(/^\./, "");
    return host === a || host.endsWith(`.${a}`);
  });
}

/** Throws unless the URL is https, on an allowed host, and resolves publicly. */
export async function assertUrlIsFetchable(
  raw: string,
  allowedHosts: readonly string[],
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRejectedError("malformed_url", `Not a valid URL: ${raw}`);
  }

  if (url.protocol !== "https:") {
    throw new FetchRejectedError(
      "scheme_not_allowed",
      `Only https is allowed, got "${url.protocol}"`,
    );
  }

  if (!hostIsAllowed(url.hostname, allowedHosts)) {
    throw new FetchRejectedError(
      "host_not_allowed",
      `Host "${url.hostname}" is not in the allowlist`,
    );
  }

  // An IP literal never reaches DNS, so check it directly.
  if (isIP(url.hostname) !== 0) {
    if (isPrivateAddress(url.hostname)) {
      throw new FetchRejectedError(
        "private_address",
        `Host "${url.hostname}" resolves to a private address`,
      );
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new FetchRejectedError(
      "dns_failure",
      `Could not resolve "${url.hostname}"`,
    );
  }

  if (addresses.length === 0) {
    throw new FetchRejectedError(
      "dns_failure",
      `No addresses for "${url.hostname}"`,
    );
  }

  // Every address, not just the first — a host with one public and one private
  // A record must not pass.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new FetchRejectedError(
        "private_address",
        `Host "${url.hostname}" resolves to private address ${address}`,
      );
    }
  }

  return url;
}

/**
 * Same guarantees as safeFetch, but returns raw bytes.
 *
 * Product photography lives on the Shopify CDN, so fetching a reference image
 * crosses to a different host than the storefront. That host still goes through
 * the allowlist — see IMAGE_CDN_HOSTS — rather than being trusted because a
 * storefront response happened to mention it.
 */
export async function safeFetchBinary(
  raw: string,
  options: SafeFetchOptions,
): Promise<SafeFetchBinaryResult> {
  const result = await fetchWithGuards(raw, options);
  return {
    url: result.url,
    status: result.status,
    contentType: result.contentType,
    data: result.data,
    bytes: result.data.byteLength,
  };
}

export async function safeFetch(
  raw: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const result = await fetchWithGuards(raw, options);
  const body = Buffer.from(result.data).toString("utf8");
  return {
    url: result.url,
    status: result.status,
    contentType: result.contentType,
    body,
    bytes: result.data.byteLength,
  };
}

async function fetchWithGuards(
  raw: string,
  options: SafeFetchOptions,
): Promise<{
  url: string;
  status: number;
  contentType: string | null;
  data: Uint8Array;
}> {
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = raw;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const url = await assertUrlIsFetchable(current, options.allowedHosts);

      const response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: options.accept ?? "*/*",
          "accept-language": "en-IN,en;q=0.9",
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new FetchRejectedError(
            "redirect_without_location",
            `${response.status} with no Location header at ${url.href}`,
          );
        }
        // Re-validated on the next iteration. That is the whole point.
        current = new URL(location, url).href;
        continue;
      }

      return {
        url: url.href,
        status: response.status,
        contentType: response.headers.get("content-type"),
        data: await readCapped(response, maxBytes, url.href),
      };
    }

    throw new FetchRejectedError(
      "too_many_redirects",
      `Exceeded ${maxRedirects} redirects starting at ${raw}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(
  response: Response,
  maxBytes: number,
  href: string,
): Promise<Uint8Array> {
  // Trust the header when present, but never *only* the header — a lying or
  // absent Content-Length must not get past the cap.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new FetchRejectedError(
      "response_too_large",
      `${href} declares ${declared} bytes, cap is ${maxBytes}`,
    );
  }

  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchRejectedError(
        "response_too_large",
        `${href} exceeded ${maxBytes} bytes while streaming`,
      );
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}
