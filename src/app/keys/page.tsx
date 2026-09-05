import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { KEY_COOKIE } from "@/lib/key-cookie";
import { describeKey } from "@/lib/runtime-key";
import styles from "../gate.module.css";
import { KeysForm } from "./keys-form";

export const metadata: Metadata = {
  title: "API key — Ad Studio by Nudge",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Bring your own Gemini key.
 *
 * The status is resolved on the server and handed down already masked, so the
 * key itself is never part of the payload the browser receives — not in the
 * HTML, not in a prop, not in the RSC stream. The page can say which key is in
 * effect without ever being able to show it.
 */
export default async function KeysPage() {
  const sealed = (await cookies()).get(KEY_COOKIE)?.value;
  const status = await describeKey(sealed);

  return (
    <main className={`${styles.gate} ${styles.top}`}>
      <section className={`${styles.panel} ${styles.wide}`}>
        <h1 className={styles.title}>API key</h1>
        <p className={styles.lede}>
          Generation and scoring spend a Gemini key. Paste one here to use it
          instead of the deployment&rsquo;s own, for this browser only.
        </p>

        <KeysForm initial={status} />
      </section>

      {/*
        No sign-out here any more: it lives in the top nav, which this page now
        renders like every other route behind the gate. Two of them, twenty
        pixels apart, is one too many.
      */}
      <p className={styles.foot}>
        <Link className={styles.link} href="/">
          Back to the studio
        </Link>
      </p>
    </main>
  );
}
