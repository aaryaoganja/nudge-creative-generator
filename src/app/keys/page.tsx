import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { KEY_COOKIE } from "@/lib/key-cookie";
import { describeKey } from "@/lib/runtime-key";
import styles from "../gate.module.css";
import { Nav } from "../nav";
import { KeysForm } from "./keys-form";

export const metadata: Metadata = {
  title: "API key, Ad Studio by Nudge",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Bring your own Gemini key.
 *
 * Deliberately one field and one button. The page used to lead with a status
 * panel that explained which of three key sources was in effect and what each
 * of them meant, which is a paragraph of internal plumbing standing in front of
 * the one thing anybody opens this page to do. All it needs to say is whether a
 * key of your own is currently in use, and that fits beside the field.
 *
 * The key never reaches the browser. `describeKey` resolves the status on the
 * server and hands down four characters of mask, so the value is not in the
 * HTML, not in a prop and not in the RSC stream.
 */
export default async function KeysPage() {
  const sealed = (await cookies()).get(KEY_COOKIE)?.value;
  const status = await describeKey(sealed);

  return (
    <>
      <Nav current="keys" />
      <main className={`${styles.gate} ${styles.top}`}>
        <section className={styles.panel}>
          <h1 className={styles.title}>Gemini API key</h1>
          <p className={styles.lede}>
            Use your own key in this browser instead of the one the deployment
            is configured with.
          </p>

          <KeysForm initial={status} />
        </section>

        {/*
          No sign-out here any more: it lives in the top nav, which this page
          renders like every other route behind the gate. Two of them, twenty
          pixels apart, is one too many.
        */}
        <p className={styles.foot}>
          <Link className={styles.link} href="/">
            Back to the studio
          </Link>
        </p>
      </main>
    </>
  );
}
