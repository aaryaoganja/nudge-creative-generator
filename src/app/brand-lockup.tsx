"use client";

import { useState } from "react";

/**
 * "Ad Studio by ⟨Nudge⟩" — the one lockup, rendered in two places.
 *
 * It lives in its own file because the nav and the gate had drifted apart: the
 * gate put the mark before the wordmark and inverted it, the nav put it after
 * and did not, so the same two words and the same PNG made two different
 * lockups with two different polarities. The order and the failure behaviour
 * are defined once here; only the class names differ, because the gate is a CSS
 * module that deliberately does not depend on the app's global stylesheet.
 *
 * The mark is fetched from nudge.new at render time. That host can be down,
 * blocked by a corporate proxy, or serving a moved file, and none of those
 * should leave a broken-image glyph where the attribution goes — hence the
 * text fallback.
 */

export interface BrandLockupClasses {
  root: string;
  wordmark: string;
  by: string;
  slot: string;
  logo: string;
  fallback: string;
}

export const LOGO_SRC = "https://nudge.new/images/logo.png";

export function BrandLockup({ classes }: { classes: BrandLockupClasses }) {
  const [broken, setBroken] = useState(false);

  /*
   * onError alone is not enough, and the login page proved it.
   *
   * That page is server-rendered, so the browser starts fetching the mark from
   * the HTML long before React hydrates. When the fetch fails in that window
   * the error event has already come and gone by the time onError is attached,
   * and the fallback never fires — the page sat there showing a broken-image
   * glyph and the alt text. The nav looked fine only because reaching it by
   * client navigation meant hydration had already happened.
   *
   * A callback ref runs at attach time and can ask the element directly: an
   * image that has finished loading with no intrinsic width did not load.
   */
  const checkAlreadyFailed = (element: HTMLImageElement | null) => {
    if (element && element.complete && element.naturalWidth === 0) setBroken(true);
  };

  return (
    <span className={classes.root}>
      <span className={classes.wordmark}>Ad Studio</span>
      <span className={classes.by}>by</span>
      {/*
       * Text first, mark last. The asset is cross-origin and has no width until
       * it decodes, so at the end of the row a late load pushes nothing that is
       * already painted; the reserved slot absorbs what is left.
       *
       * A plain img, not next/image: the optimiser would need nudge.new in
       * next.config.ts's remotePatterns, and a 20px mark is not worth an
       * allowlist entry.
       */}
      <span className={classes.slot}>
        {broken ? (
          <span className={classes.fallback}>Nudge</span>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            ref={checkAlreadyFailed}
            className={classes.logo}
            src={LOGO_SRC}
            alt="Nudge"
            height={20}
            onError={() => setBroken(true)}
          />
        )}
      </span>
    </span>
  );
}
