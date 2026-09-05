import type { Metadata } from "next";
import { Figtree, Outfit } from "next/font/google";
import "./globals.css";
import { Nav } from "./nav";

/*
 * Outfit for display, Figtree for body — the two faces the client's own site
 * runs. next/font fetches them from Google Fonts at build time and serves the
 * woff2 from our origin, so a person using the tool never makes a request to
 * fonts.gstatic.com and the page never blocks on a third-party stylesheet.
 *
 * `fallback` is a real stack, not decoration: it is what the browser paints
 * during the swap, and what it keeps painting if the font files 404. Both
 * families are variable fonts, so no weight list is needed — the whole axis
 * ships in one file.
 */
const outfit = Outfit({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  fallback: ["Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
});

const figtree = Figtree({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
  fallback: [
    "ui-sans-serif",
    "system-ui",
    "-apple-system",
    "Segoe UI",
    "Roboto",
    "Helvetica Neue",
    "Arial",
    "sans-serif",
  ],
});

export const metadata: Metadata = {
  title: "Ad Studio by Nudge",
  description: "Generate and score ad creatives from a product URL.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${outfit.variable} ${figtree.variable}`}>
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
