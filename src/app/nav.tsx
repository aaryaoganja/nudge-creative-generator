"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BrandLockup, type BrandLockupClasses } from "./brand-lockup";

/**
 * Top navigation — the one piece of chrome on every route behind the gate.
 *
 * It carries only real navigations. An earlier version also rendered Generate
 * and Score as `#generate` / `#score` anchors, which pointed at ids that do not
 * exist anywhere in the app: clicking them changed the URL and nothing else,
 * while the working tab strip sat twenty pixels below in the masthead. Two tab
 * strips, one of them dead, is worse than one — so the view switch stays where
 * the state lives (src/app/page.tsx) and this bar stops pretending to own it.
 */

/**
 * The login page draws its own centred branding and must not sit under a bar
 * that links to pages the visitor cannot open. The root layout is a server
 * component and cannot read the path, so the decision is made here.
 */
const BARE_ROUTES = new Set(["/login"]);

const NAV_LOCKUP: BrandLockupClasses = {
  root: "topnav-lockup",
  wordmark: "topnav-wordmark",
  by: "topnav-by",
  slot: "topnav-logo-slot",
  logo: "topnav-logo",
  fallback: "topnav-logo-fallback",
};

export function Nav() {
  const pathname = usePathname();

  if (BARE_ROUTES.has(pathname)) return null;

  return (
    <header className="topnav">
      <div className="topnav-inner">
        <Link className="topnav-brand" href="/" aria-label="Ad Studio by Nudge — home">
          <BrandLockup classes={NAV_LOCKUP} />
        </Link>

        <nav className="topnav-links" aria-label="Primary">
          <Link
            className="topnav-link"
            href="/keys"
            aria-current={pathname === "/keys" ? "page" : undefined}
          >
            API key
          </Link>
          <SignOut />
        </nav>
      </div>
    </header>
  );
}

/**
 * Sign out, reachable from every page rather than only from /keys.
 *
 * A gate you can enter but not leave is a gate with one working half. POST
 * because the endpoint is POST-only — with SameSite=Lax that is what stops
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
         * destinations — correct in general, wrong for the one navigation
         * whose entire purpose is to discard client state.
         */
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/login");
      }}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
