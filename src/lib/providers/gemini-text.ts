/**
 * Gemini text generation — gemini-3.7-flash.
 *
 * Handles copy generation, creative direction and (later) vision scoring; the
 * model accepts image input, so one model covers all three.
 *
 * Structured output is requested via
 * `generationConfig.responseMimeType: "application/json"` plus a
 * `responseSchema`. Parsing stays defensive anyway — a model asked for JSON
 * still occasionally wraps it in a markdown fence, and losing a whole run to
 * three stray backticks is not acceptable.
 *
 * Verification status matches gemini-image.ts: the generateContent envelope and
 * the usageMetadata field names follow the standard content API and are high
 * confidence, but the reference page was unreachable from the authoring
 * environment. If a live call 400s, this file and gemini-image.ts are the only
 * two places to correct.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** gemini-3.7-flash introductory rates, USD per million tokens. */
export const TEXT_PRICING = { inputPerMTok: 0.75, outputPerMTok: 3.75 } as const;

export interface TextUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface TextResult<T> {
  value: T;
  raw: string;
  usage: TextUsage;
  latencyMs: number;
  model: string;
}

export class GeminiTextError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "GeminiTextError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export interface GenerateJsonRequest {
  system?: string;
  prompt: string;
  /** OpenAPI-subset schema the response must conform to. */
  responseSchema?: unknown;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiTextResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsage;
}

export function costOf(usage: GeminiUsage | undefined): TextUsage {
  const inputTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = usage?.candidatesTokenCount ?? 0;
  return {
    inputTokens,
    outputTokens,
    costUsd:
      (inputTokens / 1_000_000) * TEXT_PRICING.inputPerMTok +
      (outputTokens / 1_000_000) * TEXT_PRICING.outputPerMTok,
  };
}

/**
 * Strips a markdown fence if the model added one, then parses.
 * Cheap insurance against a whole run lost to formatting.
 */
export function parseJsonLoosely(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Last resort: the outermost balanced object in the string.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new GeminiTextError(
      `Response was not JSON: ${candidate.slice(0, 200)}…`,
    );
  }
}

export class GeminiTextClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, model = "gemini-3.7-flash", baseUrl = API_BASE) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async generateJson<T>(
    request: GenerateJsonRequest,
    validate: (value: unknown) => T,
  ): Promise<TextResult<T>> {
    const startedAt = Date.now();

    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: request.prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: request.temperature ?? 0.9,
        maxOutputTokens: request.maxOutputTokens ?? 8192,
        ...(request.responseSchema
          ? { responseSchema: request.responseSchema }
          : {}),
      },
    };

    if (request.system) {
      body.systemInstruction = { parts: [{ text: request.system }] };
    }

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
      throw new GeminiTextError(`HTTP ${response.status}: ${text.slice(0, 500)}`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const payload = (await response.json()) as GeminiTextResponse;

    const blocked =
      payload.promptFeedback?.blockReason ??
      (payload.candidates?.[0]?.finishReason === "SAFETY" ? "SAFETY" : null);
    if (blocked) {
      throw new GeminiTextError(`Request was blocked (${blocked})`);
    }

    const raw = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");

    if (raw.trim().length === 0) {
      throw new GeminiTextError(
        `Empty response (finishReason: ${
          payload.candidates?.[0]?.finishReason ?? "unknown"
        })`,
      );
    }

    return {
      value: validate(parseJsonLoosely(raw)),
      raw,
      usage: costOf(payload.usageMetadata),
      latencyMs: Date.now() - startedAt,
      model: this.model,
    };
  }
}
