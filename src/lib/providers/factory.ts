import { env } from "../env.ts";
import { GeminiImageProvider } from "./gemini-image.ts";
import { OpenAIImageProvider } from "./openai-image.ts";
import {
  ImageProviderUnavailableError,
  type ImageProvider,
} from "./image.ts";

/**
 * Resolves the configured image provider, or explains precisely what is missing.
 *
 * Nothing here throws at import time. A missing key must not break the health
 * check or the deterministic half of the pipeline — image generation is the
 * flakiest dependency in the system and the design assumes it can be absent
 * (docs/ARCHITECTURE.md §19).
 */

export function imageProvider(): ImageProvider | null {
  const {
    IMAGE_PROVIDER,
    GEMINI_API_KEY,
    OPENAI_API_KEY,
    GEMINI_IMAGE_MODEL,
    OPENAI_IMAGE_MODEL,
  } = env();

  if (IMAGE_PROVIDER === "gemini") {
    return GEMINI_API_KEY
      ? new GeminiImageProvider(GEMINI_API_KEY, GEMINI_IMAGE_MODEL)
      : null;
  }
  if (IMAGE_PROVIDER === "openai") {
    return OPENAI_API_KEY
      ? new OpenAIImageProvider(OPENAI_API_KEY, OPENAI_IMAGE_MODEL)
      : null;
  }

  if (GEMINI_API_KEY) {
    return new GeminiImageProvider(GEMINI_API_KEY, GEMINI_IMAGE_MODEL);
  }
  if (OPENAI_API_KEY) {
    return new OpenAIImageProvider(OPENAI_API_KEY, OPENAI_IMAGE_MODEL);
  }
  return null;
}

export function requireImageProvider(): ImageProvider {
  const provider = imageProvider();
  if (provider) return provider;

  const wanted = env().IMAGE_PROVIDER;
  throw new ImageProviderUnavailableError(
    wanted
      ? `IMAGE_PROVIDER is "${wanted}" but ${wanted === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"} is not set.`
      : "No image provider configured. Set GEMINI_API_KEY or OPENAI_API_KEY.",
  );
}

/** Every configured provider — the bake-off runs across all of them. */
export function allImageProviders(): ImageProvider[] {
  const { GEMINI_API_KEY, OPENAI_API_KEY, GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL } =
    env();
  const providers: ImageProvider[] = [];
  if (GEMINI_API_KEY) {
    providers.push(new GeminiImageProvider(GEMINI_API_KEY, GEMINI_IMAGE_MODEL));
  }
  if (OPENAI_API_KEY) {
    providers.push(new OpenAIImageProvider(OPENAI_API_KEY, OPENAI_IMAGE_MODEL));
  }
  return providers;
}
