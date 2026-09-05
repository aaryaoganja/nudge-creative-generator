import {
  ImageProviderError,
  type AspectRatio,
  type GenerateImageRequest,
  type GeneratedImage,
  type ImageProvider,
} from "./image.ts";

/**
 * Gemini image generation ("Nano Banana").
 *
 * ── Verification status ───────────────────────────────────────────────────
 * The supported ASPECT RATIOS and RESOLUTIONS below are verified against
 * Google's published capability documentation:
 *
 *   Gemini 3 Pro Image      1:1 3:2 2:3 3:4 4:3 4:5 5:4 9:16 16:9 21:9
 *   Gemini 3.1 Flash Image  the above, PLUS 1:4 4:1 1:8 8:1
 *   resolutions             1K, 2K, 4K (3.1 Flash also 512px)
 *
 * The extreme ratios matter: 8:1 is the only practical route to a leaderboard
 * placement from a generative model, and OpenAI's models cannot express it.
 *
 * The REQUEST/RESPONSE WIRE SHAPE below (generateContent, the
 * generationConfig.imageConfig placement, and the inlineData response path)
 * follows the standard Gemini content API and is high but not verified
 * confidence — the reference page was unreachable from the authoring
 * environment. If the first live call returns 400, this file is the only place
 * to correct; nothing above the ImageProvider interface depends on it.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const PRO_RATIOS = [
  "1:1",
  "3:2",
  "2:3",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const satisfies readonly AspectRatio[];

const FLASH_EXTRA_RATIOS = ["1:4", "4:1", "1:8", "8:1"] as const satisfies
  readonly AspectRatio[];

function supportsExtremeRatios(model: string): boolean {
  return /flash/i.test(model);
}

export class GeminiImageProvider implements ImageProvider {
  readonly name = "gemini";
  readonly model: string;
  readonly supportedAspectRatios: readonly AspectRatio[];

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    apiKey: string,
    model = "gemini-3-pro-image-preview",
    baseUrl = API_BASE,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.supportedAspectRatios = supportsExtremeRatios(model)
      ? [...PRO_RATIOS, ...FLASH_EXTRA_RATIOS]
      : PRO_RATIOS;
  }

  async generate(request: GenerateImageRequest): Promise<GeneratedImage> {
    const startedAt = Date.now();

    if (!this.supportedAspectRatios.includes(request.aspectRatio)) {
      throw new ImageProviderError(
        this.name,
        `Model ${this.model} does not support aspect ratio ${request.aspectRatio}. ` +
          `Supported: ${this.supportedAspectRatios.join(", ")}`,
      );
    }

    const parts: GeminiPart[] = [{ text: request.prompt }];
    for (const ref of request.referenceImages ?? []) {
      parts.push({
        inline_data: {
          mime_type: ref.mimeType,
          data: Buffer.from(ref.bytes).toString("base64"),
        },
      });
    }

    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: {
          aspectRatio: request.aspectRatio,
          ...(request.resolution ? { imageSize: request.resolution } : {}),
        },
      },
    };

    const response = await fetch(
      `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ImageProviderError(
        this.name,
        `HTTP ${response.status}: ${text.slice(0, 500)}`,
        {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        },
      );
    }

    const payload = (await response.json()) as GeminiResponse;
    const image = extractInlineImage(payload);

    if (!image) {
      // A safety block returns 200 with no image part; say so plainly rather
      // than reporting an empty response.
      const reason =
        payload.promptFeedback?.blockReason ??
        payload.candidates?.[0]?.finishReason ??
        "no inline image part in response";
      throw new ImageProviderError(
        this.name,
        `No image returned (${reason})`,
        { retryable: false },
      );
    }

    return {
      bytes: Buffer.from(image.data, "base64"),
      mimeType: image.mimeType,
      provider: this.name,
      model: this.model,
      width: null, // Gemini does not report dimensions; measured at render time.
      height: null,
      latencyMs: Date.now() - startedAt,
    };
  }
}

export function extractInlineImage(
  payload: GeminiResponse,
): { mimeType: string; data: string } | null {
  for (const candidate of payload.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      // The API has used both camelCase and snake_case for this field across
      // versions; accept either rather than silently returning "no image".
      const inline = part.inlineData ?? part.inline_data;
      if (inline?.data) {
        return {
          mimeType: inline.mimeType ?? inline.mime_type ?? "image/png",
          data: inline.data,
        };
      }
    }
  }
  return null;
}

interface GeminiInlineData {
  mimeType?: string;
  mime_type?: string;
  data?: string;
}

interface GeminiPart {
  text?: string;
  inlineData?: GeminiInlineData;
  inline_data?: GeminiInlineData;
}

export interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}
