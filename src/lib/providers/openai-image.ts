import {
  ImageProviderError,
  parseAspectRatio,
  type AspectRatio,
  type GenerateImageRequest,
  type GeneratedImage,
  type ImageProvider,
} from "./image.ts";

/**
 * OpenAI image generation.
 *
 * Wire shape verified against the published API reference:
 *   POST /v1/images/generations   — prompt → image
 *   POST /v1/images/edits         — prompt + reference image(s) → image
 *   response: { data: [ { b64_json } ] }   (b64_json is the default for the
 *   GPT image models; `url` is dall-e-only and unsupported here)
 *
 * Size handling differs by model generation and this is the sharp edge:
 *   gpt-image-1  — a fixed set: 1024x1024, 1024x1536, 1536x1024, auto
 *   gpt-image-2  — arbitrary WIDTHxHEIGHT, both divisible by 16, aspect ratio
 *                  between 1:3 and 3:1, max 3840x2160
 *
 * Neither can express a 728x90 leaderboard (8.09:1, and 90 is not divisible by
 * 16), which is why the deterministic resize/crop step downstream is not
 * optional. See docs/ARCHITECTURE.md §24.1.
 */

const API_BASE = "https://api.openai.com/v1";

const FIXED_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
type FixedSize = (typeof FIXED_SIZES)[number];

/** gpt-image-1 and older accept only the fixed set. */
function nearestFixedSize(ratio: AspectRatio): FixedSize {
  const { w, h } = parseAspectRatio(ratio);
  const target = w / h;
  let best: FixedSize = "1024x1024";
  let bestDelta = Infinity;
  for (const size of FIXED_SIZES) {
    const [sw, sh] = size.split("x").map(Number);
    const delta = Math.abs(sw / sh - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = size;
    }
  }
  return best;
}

const RESOLUTION_LONG_EDGE = { "1K": 1024, "2K": 2048, "4K": 3840 } as const;

/** gpt-image-2 accepts arbitrary sizes within its constraints. */
export function arbitrarySize(
  ratio: AspectRatio,
  resolution: "1K" | "2K" | "4K" = "1K",
): string | null {
  const { w, h } = parseAspectRatio(ratio);
  const aspect = w / h;
  // Outside 1:3..3:1 the model refuses; fall back to the fixed path.
  if (aspect > 3 || aspect < 1 / 3) return null;

  const longEdge = RESOLUTION_LONG_EDGE[resolution];
  let width: number;
  let height: number;
  if (aspect >= 1) {
    width = longEdge;
    height = Math.round(longEdge / aspect);
  } else {
    height = longEdge;
    width = Math.round(longEdge * aspect);
  }

  const round16 = (n: number) => Math.max(16, Math.round(n / 16) * 16);
  width = Math.min(round16(width), 3840);
  height = Math.min(round16(height), 2160);
  return `${width}x${height}`;
}

function modelSupportsArbitrarySizes(model: string): boolean {
  return /^gpt-image-(?:[2-9]|\d{2,})/.test(model);
}

export class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai";
  readonly model: string;
  readonly supportedAspectRatios: readonly AspectRatio[] = [
    "1:1",
    "3:2",
    "2:3",
    "3:4",
    "4:3",
    "4:5",
    "5:4",
    "16:9",
    "9:16",
  ];

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, model = "gpt-image-1", baseUrl = API_BASE) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async generate(request: GenerateImageRequest): Promise<GeneratedImage> {
    const startedAt = Date.now();
    const size = this.sizeFor(request);

    const response = request.referenceImages?.length
      ? await this.edit(request, size)
      : await this.create(request, size);

    const b64 = response?.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || b64.length === 0) {
      throw new ImageProviderError(
        this.name,
        "Response contained no image data at data[0].b64_json",
      );
    }

    const [width, height] = size.includes("x")
      ? size.split("x").map(Number)
      : [null, null];

    return {
      bytes: Buffer.from(b64, "base64"),
      mimeType: "image/png",
      provider: this.name,
      model: this.model,
      width: Number.isFinite(width) ? (width as number) : null,
      height: Number.isFinite(height) ? (height as number) : null,
      latencyMs: Date.now() - startedAt,
    };
  }

  private sizeFor(request: GenerateImageRequest): string {
    if (modelSupportsArbitrarySizes(this.model)) {
      const size = arbitrarySize(request.aspectRatio, request.resolution);
      if (size) return size;
    }
    return nearestFixedSize(request.aspectRatio);
  }

  private async create(
    request: GenerateImageRequest,
    size: string,
  ): Promise<OpenAIImageResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      prompt: request.prompt,
      n: 1,
      size,
    };
    if (request.transparentBackground) {
      body.background = "transparent";
      body.output_format = "png";
    }

    return this.post("/images/generations", body, request.signal);
  }

  private async edit(
    request: GenerateImageRequest,
    size: string,
  ): Promise<OpenAIImageResponse> {
    const form = new FormData();
    form.append("model", this.model);
    form.append("prompt", request.prompt);
    form.append("n", "1");
    form.append("size", size);
    if (request.transparentBackground) {
      form.append("background", "transparent");
      form.append("output_format", "png");
    }

    for (const [i, ref] of (request.referenceImages ?? []).entries()) {
      form.append(
        "image[]",
        new Blob([ref.bytes as unknown as ArrayBuffer], { type: ref.mimeType }),
        `reference-${i}.${ref.mimeType.includes("png") ? "png" : "jpg"}`,
      );
    }

    const response = await fetch(`${this.baseUrl}/images/edits`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: request.signal,
    });

    return this.unwrap(response);
  }

  private async post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<OpenAIImageResponse> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    return this.unwrap(response);
  }

  private async unwrap(response: Response): Promise<OpenAIImageResponse> {
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ImageProviderError(
        this.name,
        `HTTP ${response.status}: ${text.slice(0, 500)}`,
        {
          status: response.status,
          // 429 and 5xx are worth one retry; 4xx otherwise is a bad request.
          retryable: response.status === 429 || response.status >= 500,
        },
      );
    }
    return (await response.json()) as OpenAIImageResponse;
  }
}

interface OpenAIImageResponse {
  data?: Array<{ b64_json?: string }>;
}
