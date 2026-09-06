"use client";

import Link from "next/link";
import { useState } from "react";
import { BrandLockup, type BrandLockupClasses } from "./brand-lockup";
import { VIEWS, VIEW_LABELS, viewHref, type View } from "./view";

/**
 * Top navigation, and the view switcher.
 *
 * The switcher lives here rather than in the page because that is where the
 * supplied design puts it, and because it is the only control on screen that is
 * true of every view. It is a segmented control of real links: each one is a URL
 * a person can bookmark, open in a new tab or send to someone, which a set of
 * buttons holding React state is not.
 *
 * An earlier version of this bar carried Generate and Score as `#generate` and
 * `#score` anchors pointing at ids that existed nowhere, twenty pixels above
 * the working tab strip. Every link here now goes somewhere real.
 */

const NAV_LOCKUP: BrandLockupClasses = {
  root: "topnav-lockup",
  wordmark: "topnav-wordmark",
  by: "topnav-by",
  slot: "topnav-logo-slot",
  logo: "topnav-logo",
  fallback: "topnav-logo-fallback",
};

export interface NavProps {
  /**
   * The view currently on screen. Present only on the studio, where the
   * switcher belongs; on /keys it would be three links that all navigate away
   * from the page you are reading.
   */
  view?: View;
  /** Marks the API key link when that is the page you are on. */
  current?: "keys";
}

/**
 * Rendered by the pages that want it, not by the root layout.
 *
 * The layout is a server component and cannot see which view the URL selects,
 * and the login page must not sit under a bar linking to pages a signed-out
 * visitor cannot open. Both problems disappear when the component that knows
 * the answer is the one that mounts the bar.
 */
export function Nav({ view, current }: NavProps) {
  const onStudio = view !== undefined;

  return (
    <header className="topnav">
      <div className="topnav-inner">
        <Link className="topnav-brand" href="/" aria-label="Ad Studio by Nudge, home">
          <BrandLockup classes={NAV_LOCKUP} />
        </Link>

        {onStudio && (
          <nav className="switcher" aria-label="Studio view">
            {VIEWS.map((id) => (
              <Link
                key={id}
                className={`switcher-tab${view === id ? " on" : ""}`}
                href={viewHref({ view: id, runId: null })}
                aria-current={view === id ? "page" : undefined}
                // The whole view swaps, so a client-side transition would
                // repaint everything anyway. scroll:false keeps the page where
                // the user left it rather than jumping to the top.
                scroll={false}
              >
                {VIEW_LABELS[id]}
              </Link>
            ))}
          </nav>
        )}

        <div className="topnav-links">
          <Link
            className="topnav-link"
            href="/keys"
            aria-current={current === "keys" ? "page" : undefined}
          >
            API key
          </Link>
          <SignOut />
        </div>
      </div>
    </header>
  );
}

/**
 * Sign out, reachable from every page rather than only from /keys.
 *
 * A gate you can enter but not leave is a gate with one working half. POST
 * because the endpoint is POST-only: with SameSite=Lax that is what stops
 * another site signing this browser out with an image tag.
 */
function SignOut() {
  const [busy, setBusy] = useState(false);

  return (
    <button
      className="topnav-link quiet"
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        /*
         * A hard navigation, not router.replace(). The client router cache
         * still holds pages rendered for the session that was just destroyed;
         * a soft navigation leaves that cache in place, and a back button that
         * re-renders a signed-in page from memory looks exactly like a gate
         * that did not close. router.refresh() races the replace and is not a
         * guarantee. The lint rule below prefers the router for internal
         * destinations, which is correct in general and wrong for the one
         * navigation whose entire purpose is to discard client state.
         */
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/login");
      }}
    >
      {busy ? "Signing out" : "Sign out"}
    </button>
  );
}
