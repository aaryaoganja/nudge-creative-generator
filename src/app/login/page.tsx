import type { Metadata } from "next";
import { safeNextPath } from "@/lib/auth";
import styles from "../gate.module.css";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in, Ad Studio",
  // The gate should never be indexed, and a signed-out crawler hitting any
  // route is redirected here, so this is where the instruction has to live.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The password gate.
 *
 * The destination is read from the query string on the server and normalised
 * here rather than in the browser: `next` arrives from a redirect the
 * middleware wrote, but a link to /login?next=… can be written by anyone, and
 * an unchecked value is an open redirect on the one page where a user is about
 * to type a password.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested = params.next;
  const next = safeNextPath(typeof requested === "string" ? requested : null);

  return (
    <main className={styles.gate}>
      {/* The same wordmark the top nav carries, so the two cannot drift apart. */}
      <span className={styles.wordmark}>Ad Studio</span>

      <section className={styles.panel}>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.lede}>
          Ad Studio is password protected. Everything behind this page spends a
          live API key.
        </p>
        <LoginForm next={next} />
      </section>
    </main>
  );
}
