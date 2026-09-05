/**
 * Placement catalogue — Meta and Google.
 *
 * Config-as-data, as docs/ARCHITECTURE.md §20 requires: adding a placement is a
 * row here, never a deploy. Each entry carries the pixel spec AND the copy
 * limits for its platform, because a headline that fits Meta at 40 characters
 * is truncated by Google at 30, and discovering that at upload time is too late.
 *
 * Verified against current 2026 platform guidance. Two changes worth knowing:
 * Instagram's scrollable Explore feed was removed in January 2026 and that
 * inventory now delivers through Reels, and Stories/Reels safe zones were
 * unified in March 2026 so they no longer need separate treatment.
 *
 * Sizes are MINIMUMS on both platforms — larger renders are accepted and
 * preferred, which is why a 2K generation needs no downscale.
 */

export type Platform = "meta" | "google";

/** Character ceilings differ per platform and are enforced before render. */
export interface CopyLimits {
  headline: number;
  /** Meta calls this "primary text"; Google's nearest equivalent is description. */
  primaryText: number;
  description: number;
  /** Google responsive display only. */
  longHeadline?: number;
}

export const COPY_LIMITS: Record<Platform, CopyLimits> = {
  // Primary text truncates at "see more" around 125 characters.
  meta: { headline: 40, primaryText: 125, description: 30 },
  // Short headline 30, long headline 90, description 90.
  google: { headline: 30, primaryText: 90, description: 90, longHeadline: 90 },
};

export interface PlacementSpec {
  id: string;
  platform: Platform;
  label: string;
  /** Where it runs, in the words a marketer uses. */
  surface: string;
  width: number;
  height: number;
  ratio: string;
  maxBytes: number;
  /** Ordered so the most-used placements sit at the top of the picker. */
  priority: number;
  /** Shown as a hint; explains why you'd pick this one. */
  note?: string;
  /** Vertical formats lose the top and bottom to platform chrome. */
  safeZone?: string;
}

const MB = 1024 * 1024;

export const PLACEMENTS: PlacementSpec[] = [
  // ── Meta ───────────────────────────────────────────────────────────────
  {
    id: "meta_feed_4x5",
    platform: "meta",
    label: "Meta Feed",
    surface: "Facebook & Instagram feed",
    width: 1080,
    height: 1350,
    ratio: "4:5",
    maxBytes: 30 * MB,
    priority: 1,
    note: "Meta's primary recommendation — takes the most mobile screen",
  },
  {
    id: "meta_feed_1x1",
    platform: "meta",
    label: "Meta Feed square",
    surface: "Facebook & Instagram feed",
    width: 1080,
    height: 1080,
    ratio: "1:1",
    maxBytes: 30 * MB,
    priority: 3,
    note: "Safe everywhere, but loses roughly a third of the screen against 4:5",
  },
  {
    id: "meta_story_9x16",
    platform: "meta",
    label: "Stories & Reels",
    surface: "Instagram and Facebook, full screen",
    width: 1080,
    height: 1920,
    ratio: "9:16",
    maxBytes: 30 * MB,
    priority: 2,
    note: "Explore inventory now delivers through Reels, so vertical matters more",
    safeZone: "Keep text clear of the top 14% and bottom 20% — platform chrome",
  },
  {
    id: "meta_carousel_1x1",
    platform: "meta",
    label: "Carousel card",
    surface: "Facebook & Instagram carousel",
    width: 1080,
    height: 1080,
    ratio: "1:1",
    maxBytes: 30 * MB,
    priority: 5,
    note: "Every card must be square and read on its own",
  },
  {
    id: "threads_4x5",
    platform: "meta",
    label: "Threads",
    surface: "Threads feed",
    width: 1080,
    height: 1350,
    ratio: "4:5",
    maxBytes: 30 * MB,
    priority: 7,
    note: "Rolled out globally in 2026; specs follow Instagram feed",
  },

  // ── Google ─────────────────────────────────────────────────────────────
  {
    id: "google_landscape",
    platform: "google",
    label: "Display landscape",
    surface: "Responsive display & Performance Max",
    width: 1200,
    height: 628,
    ratio: "1.91:1",
    maxBytes: 5 * MB,
    priority: 4,
    note: "Required asset for responsive display",
  },
  {
    id: "google_square",
    platform: "google",
    label: "Display square",
    surface: "Responsive display & Performance Max",
    width: 1200,
    height: 1200,
    ratio: "1:1",
    maxBytes: 5 * MB,
    priority: 6,
    note: "Required asset alongside landscape",
  },
  {
    id: "google_portrait",
    platform: "google",
    label: "Display portrait",
    surface: "Responsive display & Performance Max",
    width: 1200,
    height: 1500,
    ratio: "4:5",
    maxBytes: 5 * MB,
    priority: 8,
    note: "Optional, but widens where the ad can serve",
  },
];

export const PLACEMENTS_BY_ID: Record<string, PlacementSpec> =
  Object.fromEntries(PLACEMENTS.map((p) => [p.id, p]));

export function placementsSorted(): PlacementSpec[] {
  return [...PLACEMENTS].sort((a, b) => a.priority - b.priority);
}

/**
 * The tightest limits across a multi-platform selection.
 *
 * Generating one set of copy for both platforms means writing to whichever is
 * stricter — Google's 30-character headline, not Meta's 40 — or the Google
 * version arrives truncated.
 */
export function limitsFor(placementIds: string[]): CopyLimits & {
  platforms: Platform[];
} {
  const platforms = [
    ...new Set(
      placementIds
        .map((id) => PLACEMENTS_BY_ID[id]?.platform)
        .filter((p): p is Platform => Boolean(p)),
    ),
  ];

  if (platforms.length === 0) {
    return { ...COPY_LIMITS.meta, platforms: ["meta"] };
  }

  return platforms.reduce<CopyLimits & { platforms: Platform[] }>(
    (tightest, platform) => {
      const limits = COPY_LIMITS[platform];
      return {
        headline: Math.min(tightest.headline, limits.headline),
        primaryText: Math.min(tightest.primaryText, limits.primaryText),
        description: Math.min(tightest.description, limits.description),
        platforms,
      };
    },
    {
      headline: Infinity,
      primaryText: Infinity,
      description: Infinity,
      platforms,
    },
  );
}

/**
 * Preset briefs, so the offer and angle fields start populated rather than
 * blank. A blank field asks the marketer to invent a prompt; a chip they can
 * click and then edit asks them to react to one, which is a much easier job.
 */
export const OFFER_PRESETS = [
  "20% off this week",
  "Buy 2, get 1 free",
  "Free shipping over ₹499",
  "Launch price",
  "Bundle and save",
];

export const ANGLE_PRESETS = [
  "Lead with the active and its concentration",
  "Answer the single biggest objection",
  "Show the routine step this replaces",
  "Seasonal — monsoon, summer, winter skin",
  "First-time buyer, no prior knowledge",
  "Compare against the reader's current routine",
];
