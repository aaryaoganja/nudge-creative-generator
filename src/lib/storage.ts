import { createHash } from "node:crypto";
import { getPrisma } from "./db.ts";
import { hasDatabase } from "./env.ts";

/**
 * Where image bytes live.
 *
 * An interface with one implementation looks like ceremony until you read
 * docs/ARCHITECTURE.md, which is unambiguous that bytes belong in object
 * storage and equally clear about the compromise: Postgres bytea is acceptable
 * to get this moving, bytea WITHOUT this interface is not. The difference is
 * whether swapping in a Railway Bucket later is one new file or a rewrite of
 * every call site.
 *
 * Content addressing does real work here, it is not a flourish:
 *
 *  - The same creative regenerated for a second placement, or a shared run
 *    opened by five people, is one row. Nano Banana Pro returns 1 to 3 MB per
 *    2K image and a run can produce many of them.
 *  - The key IS the hash, so `GET /api/assets/<sha>` cannot be talked into
 *    serving bytes it does not name, and the response is immutable by
 *    construction. That is what lets it carry a one-year cache header.
 *  - Deduplication is free and needs no bookkeeping: a second put of identical
 *    bytes is a no-op.
 *
 * Every method degrades rather than throwing when there is no database. The
 * whole app is built to boot without Postgres, and a missing image should cost
 * a picture, never a page.
 */

export interface StoredAsset {
  sha256: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  byteSize: number;
}

export interface AssetBytes extends StoredAsset {
  data: Uint8Array;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Only a 64-character lowercase hex string can be an asset id. */
export function isAssetId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export interface Storage {
  put(
    bytes: Uint8Array,
    meta: { mimeType: string; width?: number | null; height?: number | null },
  ): Promise<StoredAsset | null>;
  get(sha256: string): Promise<AssetBytes | null>;
  /** Bytes not referenced by any surviving run. Returns how many were removed. */
  prune(keepShas: string[]): Promise<number>;
}

/**
 * The URL the browser fetches an asset from.
 *
 * Ours, not a third party's: the request goes through the same middleware that
 * gates everything else, so an image is exactly as private as the run it
 * belongs to. A presigned bucket URL would leak past the password.
 */
export function assetUrl(sha256: string): string {
  return `/api/assets/${sha256}`;
}

class PostgresStorage implements Storage {
  async put(
    bytes: Uint8Array,
    meta: { mimeType: string; width?: number | null; height?: number | null },
  ): Promise<StoredAsset | null> {
    const sha256 = sha256Hex(bytes);
    const record = {
      sha256,
      mimeType: meta.mimeType,
      width: meta.width ?? null,
      height: meta.height ?? null,
      byteSize: bytes.byteLength,
    };

    try {
      await (await getPrisma()).runAsset.upsert({
        where: { sha256 },
        // Identical bytes produce an identical hash, so there is nothing to
        // update. The upsert exists only to make a concurrent put safe.
        update: {},
        create: { ...record, data: Buffer.from(bytes) },
      });
      return record;
    } catch (error) {
      warnOnce("put", error);
      return null;
    }
  }

  async get(sha256: string): Promise<AssetBytes | null> {
    if (!isAssetId(sha256)) return null;
    try {
      const row = await (await getPrisma()).runAsset.findUnique({ where: { sha256 } });
      if (!row) return null;
      return {
        sha256: row.sha256,
        mimeType: row.mimeType,
        width: row.width,
        height: row.height,
        byteSize: row.byteSize,
        data: row.data,
      };
    } catch (error) {
      warnOnce("get", error);
      return null;
    }
  }

  async prune(keepShas: string[]): Promise<number> {
    try {
      const { count } = await (await getPrisma()).runAsset.deleteMany({
        where: { sha256: { notIn: keepShas } },
      });
      return count;
    } catch (error) {
      warnOnce("prune", error);
      return 0;
    }
  }
}

/** No database: assets are simply unavailable, and callers keep working. */
class NullStorage implements Storage {
  async put(): Promise<StoredAsset | null> {
    return null;
  }
  async get(): Promise<AssetBytes | null> {
    return null;
  }
  async prune(): Promise<number> {
    return 0;
  }
}

const warned = new Set<string>();

/**
 * One line per failing operation per process.
 *
 * Storage failures are degradations, not incidents: the caller has already
 * decided to carry on without the asset. Logging every occurrence would bury
 * the log of a real problem under one line per image.
 */
function warnOnce(operation: string, error: unknown): void {
  if (warned.has(operation)) return;
  warned.add(operation);
  console.warn(
    `[storage] ${operation} failed, continuing without persisted assets:`,
    error instanceof Error ? error.message : error,
  );
}

export function storage(): Storage {
  return hasDatabase() ? new PostgresStorage() : new NullStorage();
}

/** Test seam: forget which operations have already warned. */
export function resetStorageWarnings(): void {
  warned.clear();
}
