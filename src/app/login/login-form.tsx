"use client";

import { useState } from "react";
import styles from "../gate.module.css";

/**
 * One field, one button.
 *
 * The password is posted as JSON rather than as a form submission on purpose:
 * a cross-site form POST is something a browser will send, whereas a
 * cross-origin JSON fetch is not — which, together with SameSite=Lax on the
 * cookie, means no other site can sign this browser in.
 */
export function LoginForm({ next }: { next: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, next }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        next?: string;
      };

      if (!response.ok) {
        // The server's copy is the copy: it distinguishes a wrong password from
        // a rate limit, and this component should not second-guess which.
        setError(body.error ?? "That password is not right.");
        setPassword("");
        setBusy(false);
        return;
      }

      // A full page load, not a client navigation. The cookie has only just
      // been set, and the destination's HTML has to be fetched with it — a
      // router push would replay a router cache filled while signed out.
      window.location.assign(body.next ?? next);
    } catch {
      setError("That didn't reach the server. Check the connection and retry.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <label className={styles.label} htmlFor="password">
        Password
      </label>
      <input
        id="password"
        className={styles.input}
        type="password"
        name="password"
        value={password}
        autoFocus
        autoComplete="current-password"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "password-error" : undefined}
        onChange={(event) => setPassword(event.target.value)}
        disabled={busy}
      />

      <button className={styles.button} type="submit" disabled={busy || !password}>
        {busy ? "Checking…" : "Enter"}
      </button>

      {error && (
        <p className={styles.error} id="password-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
