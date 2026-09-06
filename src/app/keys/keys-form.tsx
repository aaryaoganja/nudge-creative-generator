"use client";

import { useState } from "react";
import type { KeyStatus } from "@/lib/runtime-key";
import styles from "../gate.module.css";

/**
 * One field, one button, and one line saying whether your key is in use.
 *
 * The panel this replaces carried a three-state status block explaining the
 * difference between "your key", "environment" and "no key", plus a conditional
 * paragraph about what clearing an override would leave behind. That is the
 * implementation talking. A person here wants to paste a key and be told it
 * took, and the only distinction that changes what they should do next is
 * whether their own key is currently in effect.
 *
 * State is seeded from the server and then replaced by whatever /api/keys
 * returns, so the line always reflects the cookie the server actually holds
 * rather than what this component believes it just sent. The input is cleared
 * on success: leaving a live credential in a DOM node that a screenshot, a bug
 * report or a session recording can read is exactly the exposure the sealed
 * cookie exists to prevent.
 */
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
        setError(body.error ?? "That did not work. Try again.");
        return;
      }

      setStatus(body.status);
      setKey("");
      setDone(success);
    } catch {
      setError("That did not reach the server. Check the connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  const usingOwnKey = status.source === "override";

  return (
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
        placeholder="AIza..."
        autoComplete="off"
        spellCheck={false}
        aria-describedby="key-help"
        onChange={(event) => setKey(event.target.value)}
        disabled={busy}
      />

      <p className={styles.note} id="key-help">
        {usingOwnKey ? (
          <>
            In use: <span className={styles.suffix}>{status.masked}</span>. Held
            in an encrypted cookie and never shown back to you. It goes away
            when you sign out.
          </>
        ) : (
          <>
            Held in an encrypted cookie and never shown back to you. It goes
            away when you sign out.
          </>
        )}
      </p>

      <div className={styles.actions}>
        <button className={styles.ghost} type="submit" disabled={busy || !key.trim()}>
          {busy ? "Saving" : "Use this key"}
        </button>
        {usingOwnKey && (
          <button
            className={styles.ghost}
            type="button"
            disabled={busy}
            onClick={() =>
              void send({ method: "DELETE" }, "Cleared. Back to the configured key.")
            }
          >
            Clear
          </button>
        )}
      </div>

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
    </form>
  );
}
