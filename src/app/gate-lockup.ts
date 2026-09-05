import type { BrandLockupClasses } from "./brand-lockup";
import styles from "./gate.module.css";

/**
 * The gate's class map for <BrandLockup>.
 *
 * Its own module so that a server component (src/app/login/page.tsx) can import
 * the map without pulling the client component's module graph into the server
 * bundle, and so the keys page can use the identical lockup later without
 * copying the object.
 */
export const GATE_LOCKUP: BrandLockupClasses = {
  root: styles.brand,
  wordmark: styles.wordmark,
  by: styles.by,
  slot: styles.logoSlot,
  logo: styles.logo,
  fallback: styles.logoFallback,
};
