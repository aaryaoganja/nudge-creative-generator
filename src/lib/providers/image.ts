/**
 * Image generation provider abstraction.
 *
 * Capability and pricing in this category move monthly, so nothing above this
 * interface may name a vendor. The bake-off in docs/ARCHITECTURE.md §24.4 runs
 * the same prompts through every implementation of this interface and compares
 * the results; that is only possible because the seam exists.
 */

export type AspectRatio =
  | "1:1"
  | "3:2"
  | "2:3"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9"
  | "1:4"
  | "4:1"
  | "1:8"
  | "8:1";

/**
 * Placements are grouped into families. One generation per family, then every
 * exact placement size inside that family is derived by deterministic crop and
 * resize — three generations covering ~10 placements instead of ten.
 */
export type AspectFamily = "square" | "vertical" | "horizontal" | "banner";

export interface ReferenceImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface GenerateImageRequest {
  prompt: string;
  aspectRatio: AspectRatio;
  /** Provider-normalised: "1K" | "2K" | "4K". Not every provider honours it. */
  resolution?: "1K" | "2K" | "4K";
  /**
   * Product photography conditioning. Supplying the real packshot is what keeps
   * the model from inventing packaging — see docs/ARCHITECTURE.md §1.
   */
  referenceImages?: ReferenceImage[];
  /** Transparent output, where the provider supports it. Useful for cutouts. */
  transparentBackground?: boolean;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
  provider: string;
  model: string;
  /** Populated when the provider reports it; the renderer measures otherwise. */
  width: number | null;
  height: number | null;
  latencyMs: number;
}

export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  readonly supportedAspectRatios: readonly AspectRatio[];
  generate(request: GenerateImageRequest): Promise<GeneratedImage>;
}

export class ImageProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  /** Retrying the same call may succeed (timeout, 429, 5xx). */
  readonly retryable: boolean;

  constructor(
    provider: string,
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "ImageProviderError";
    this.provider = provider;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export class ImageProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageProviderUnavailableError";
  }
}

const FAMILY_RATIOS: Record<AspectFamily, AspectRatio> = {
  square: "1:1",
  vertical: "4:5",
  horizontal: "16:9",
  banner: "8:1",
};

/** The generation ratio to use for a target placement size. */
export function familyForSize(width: number, height: number): AspectFamily {
  const ratio = width / height;
  if (ratio > 2.5) return "banner";
  if (ratio < 0.4) return "banner"; // 160x600 and friends — extreme the other way
  if (ratio >= 1.25) return "horizontal";
  if (ratio <= 0.8) return "vertical";
  return "square";
}

export function ratioForFamily(
  family: AspectFamily,
  width: number,
  height: number,
): AspectRatio {
  if (family !== "banner") return FAMILY_RATIOS[family];
  return width >= height ? "8:1" : "1:8";
}

/**
 * Groups target placement sizes by family so the pipeline knows how many
 * generations it actually needs.
 */
export function planGenerations(
  sizes: ReadonlyArray<{ width: number; height: number }>,
): Map<AspectFamily, Array<{ width: number; height: number }>> {
  const plan = new Map<AspectFamily, Array<{ width: number; height: number }>>();
  for (const size of sizes) {
    const family = familyForSize(size.width, size.height);
    const bucket = plan.get(family);
    if (bucket) bucket.push(size);
    else plan.set(family, [size]);
  }
  return plan;
}

export function parseAspectRatio(ratio: AspectRatio): {
  w: number;
  h: number;
} {
  const [w, h] = ratio.split(":").map(Number);
  return { w, h };
}
