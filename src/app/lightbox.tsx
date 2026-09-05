"use client";

import { useEffect } from "react";

/**
 * Full-size image viewer.
 *
 * The confirmation step asks a marketer to decide which photograph the model
 * must reproduce faithfully, and a 72px thumbnail is not enough to tell a
 * packshot from a lifestyle crop or to read the label. This makes that decision
 * possible.
 *
 * Escape closes, the backdrop closes, body scroll is locked while open, and
 * focus is not stolen from the trigger.
 */
export function Lightbox({
  src,
  caption,
  onClose,
}: {
  src: string;
  caption?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={caption ?? "Enlarged image"}
      onClick={onClose}
    >
      <button className="lightbox-close" type="button" onClick={onClose}>
        Close ✕
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={caption ?? "Enlarged image"}
        // Clicking the image itself must not dismiss — only the backdrop.
        onClick={(event) => event.stopPropagation()}
      />
      {caption && <div className="lightbox-caption">{caption}</div>}
    </div>
  );
}
