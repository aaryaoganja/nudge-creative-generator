import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nudge Creative Generator",
  description: "Generate nudge creatives across channels.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
