"use client";

import { useState } from "react";
import type { KeyStatus } from "@/lib/runtime-key";
import styles from "../gate.module.css";

/**
 * The key panel.
 *
 * State is seeded from the server and then replaced by whatever /api/keys
 * returns, so the badge always reflects the cookie the server actually holds
 * rather than what this component believes it just sent. The input is cleared
 * on success: leaving a live credential sitting in a DOM node that a
 * screenshot, a bug reporter or a session recorder can read is exactly the
 * exposure the sealed cookie exists to avoid.
 */

const SOURCE_COPY: Record<KeyStatus["source"], { badge: string; line: string }> = {
  override: {
    badge: "Your key",
    line: "Requests from this browser use the key you pasted.",
  },
  environment: {
    badge: "Environment",
    line: "Requests use the key configured on the deployment.",
  },
  none: {
    badge: "No key",
    line: "Nothing is configured — generation and scoring will refuse to run.",
  },
};

export function KeysForm({ initial }: { initial: KeyStatus }) {
  const [status, setStatus] = useState(initial);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(init: RequestInit, success: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch("/api/keys", init);
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        status?: KeyStatus;
      };

      if (!response.ok || !body.status) {
        setError(body.error ?? "That didn't work. Try again.");
        return;
      }

      setStatus(body.status);
      setKey("");
      setDone(success);
    } catch {
      setError("That didn't reach the server. Check the connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  const copy = SOURCE_COPY[status.source];

  return (
    <>
      <div className={styles.status}>
        <div className={styles.statusRow}>
          <span className={styles.statusLabel}>In effect</span>
          <span
            className={`${styles.badge} ${
              status.source === "override"
                ? styles.badgeOn
                : status.source === "none"
                  ? styles.badgeOff
                  : ""
            }`}
          >
            {copy.badge}
          </span>
          {status.masked && <span className={styles.suffix}>{status.masked}</span>}
        </div>
        <p className={styles.note}>{copy.line}</p>
        {status.source === "override" && !status.environmentPresent && (
          <p className={styles.note}>
            The deployment has no key of its own, so clearing this leaves nothing
            behind it.
          </p>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !key.trim()) return;
          void send(
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ key }),
            },
            "Saved. This browser now uses your key.",
          );
        }}
        noValidate
      >
        <label className={styles.label} htmlFor="gemini-key">
          Gemini API key
        </label>
        <input
          id="gemini-key"
          className={`${styles.input} ${styles.mono}`}
          type="password"
          value={key}
          placeholder="AIza…"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="key-help"
          onChange={(event) => setKey(event.target.value)}
          disabled={busy}
        />
        <p className={styles.note} id="key-help">
          Held in an encrypted, http-only cookie. It is never shown back to you
          — only the last four characters — and it goes away when you sign out.
        </p>

        <div className={styles.actions}>
          <button className={styles.ghost} type="submit" disabled={busy || !key.trim()}>
            {busy ? "Saving…" : "Use this key"}
          </button>
          <button
            className={styles.ghost}
            type="button"
            disabled={busy || status.source !== "override"}
            onClick={() =>
              void send(
                { method: "DELETE" },
                "Override cleared. Back to the deployment's key.",
              )
            }
          >
            Clear override
          </button>
        </div>
      </form>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className={styles.done} role="status">
          {done}
        </p>
      )}
    </>
  );
}
