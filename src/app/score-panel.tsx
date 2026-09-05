"use client";

import { useState } from "react";

/**
 * Ad quality scorer — accepts any creative, ours or not.
 *
 * The product URL is optional and its absence is reported, not hidden. When it
 * is missing, product-specific findings come back marked unverified rather than
 * silently passing, because "I could not check this" and "this is fine" are
 * different answers.
 */

interface Finding {
  severity: "blocking" | "major" | "minor";
  dimension: string;
  observation: string;
  action: string;
  verified: boolean;
}

interface ScoreResponse {
  overall: number;
  verdict: "pass" | "fix_required" | "blocked";
  dimensionScores: Record<string, number>;
  findings: Finding[];
  doMore: string[];
  doLess: string[];
  summary: string;
  extractedText: string[];
  productVerified: boolean;
  productUrlWarning: string | null;
  note: string | null;
  product: { title: string } | null;
}

const DIMENSION_LABELS: Record<string, string> = {
  brand_fit: "Brand fit",
  compliance: "Compliance",
  clarity: "Clarity",
  craft: "Craft",
  stopping_power: "Stopping power",
};

export function ScorePanel() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [productUrl, setProductUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [score, setScore] = useState<ScoreResponse | null>(null);

  function pick(selected: File | null) {
    setFile(selected);
    setScore(null);
    setError(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(selected ? URL.createObjectURL(selected) : null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setScore(null);
    try {
      const form = new FormData();
      form.append("image", file);
      form.append("placementId", "meta_feed_4x5");
      if (productUrl.trim()) form.append("productUrl", productUrl.trim());

      const response = await fetch("/api/score", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Scoring failed");
      setScore(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const verdictClass =
    score?.verdict === "pass" ? "pass" : score?.verdict === "blocked" ? "blocked" : "fix";

  return (
    <>
      {error && <div className="error">{error}</div>}

      <form className="card" onSubmit={submit}>
        <h2>Score any creative</h2>

        <div className="field">
          <label htmlFor="file">Creative — PNG or JPEG</label>
          <input
            id="file"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
        </div>

        <div className="field">
          <label htmlFor="purl">
            Product URL — optional, but without it product claims cannot be verified
          </label>
          <input
            id="purl"
            type="url"
            placeholder="https://beminimalist.co/products/…"
            value={productUrl}
            onChange={(e) => setProductUrl(e.target.value)}
          />
        </div>

        {preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt="Creative to be scored"
            style={{
              maxWidth: "220px",
              borderRadius: "4px",
              border: "1px solid var(--line)",
              marginBottom: "0.85rem",
              display: "block",
            }}
          />
        )}

        <div className="actions">
          <button className="primary" type="submit" disabled={!file || busy}>
            {busy && <span className="spin" />}
            {busy ? "Reviewing…" : "Score creative"}
          </button>
          <span className="cost">≈ $0.006 · vision review</span>
        </div>
      </form>

      {score && (
        <>
          <section className="card">
            <div className="confirm-head">
              <div>
                <div className="big-score">{score.overall}</div>
                <span className={`badge ${verdictClass}`}>
                  {score.verdict.replace("_", " ")}
                </span>
              </div>
              <div style={{ flex: 1, minWidth: "16rem" }}>
                {Object.entries(score.dimensionScores).map(([key, value]) => (
                  <div className="scoreline" key={key}>
                    <span className="name">{DIMENSION_LABELS[key] ?? key}</span>
                    <span className="meter">
                      <i style={{ width: `${value}%` }} />
                    </span>
                    <span className="num">{value}</span>
                  </div>
                ))}
              </div>
            </div>

            <p style={{ marginBottom: 0, marginTop: "1rem" }}>{score.summary}</p>

            {!score.productVerified && (
              <div className="notice" style={{ marginTop: "1rem", marginBottom: 0 }}>
                <span className="badge unverified">unverified</span>{" "}
                {score.productUrlWarning ?? score.note}
              </div>
            )}
          </section>

          <div className="results">
            <section className="card">
              <h2>Do more of this</h2>
              <ul className="plain">
                {score.doMore.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </section>
            <section className="card">
              <h2>Do less of this</h2>
              <ul className="plain">
                {score.doLess.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </section>
          </div>

          <section className="card">
            <h2>Findings — most severe first</h2>
            {score.findings.length === 0 && <p className="sub">Nothing flagged.</p>}
            {score.findings.map((finding, i) => (
              <div className={`finding ${finding.severity}`} key={i}>
                <strong>{DIMENSION_LABELS[finding.dimension] ?? finding.dimension}</strong>
                {!finding.verified && (
                  <>
                    {" "}
                    <span className="badge unverified">unverified</span>
                  </>
                )}
                <div>{finding.observation}</div>
                <span className="action">→ {finding.action}</span>
              </div>
            ))}
          </section>

          {score.extractedText.length > 0 && (
            <section className="card">
              <h2>Text read from the creative</h2>
              <ul className="plain">
                {score.extractedText.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
