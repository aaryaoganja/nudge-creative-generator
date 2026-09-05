import { z } from "zod";

/**
 * Fail fast on misconfiguration at boot rather than on the first request.
 *
 * Kept lazy so that `next build` (and `prisma generate`) do not require a real
 * environment — the schema is only evaluated when a request actually needs it.
 */
const schema = z.object({
  DATABASE_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${detail}`);
  }

  cached = parsed.data;
  return cached;
}
