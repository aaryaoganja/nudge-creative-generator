"use client";

import { useEffect, useState } from "react";
import { Select } from "./select";
import { placementsSorted } from "../../config/placements";
import { OBJECTIVES } from "./objectives";

/**
 * Ad quality scorer. Accepts any creative, ours or not.
 *
 * Three inputs beyond the file, all optional, and all of them change the
 * review rather than decorating it:
 *
 *  - the product URL, without which product claims come back marked unverified
 *    rather than silently passing, because "I could not check this" and "this
 *    is fine" are different answers;
 *  - the placement it was made for, which the panel used to hardcode as
 *    meta_feed_4x5, so a perfectly good 1080x1080 square was measured against a
 *    4:5 spec nobody had chosen and came back blocked for a craft failure it
 *    had not committed;
 *  - the objective it was written to, so stopping power is judged against the
 *    job the creative actually had.
 */

interface Finding {
  severity: "blocking" | "major" | "minor";
  dimension: string;
  observation: string;
  action: string;
  verified: boolean;
}

interface ScoreResponse {
  runId?: string;
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
  placement: { label: string; width: number; height: number } | null;
  objective: string | null;
  image?: { url: string | null } | null;
}

const DIMENSION_LABELS: Record<string, string> = {
  brand_fit: "Brand fit",
  compliance: "Compliance",
  clarity: "Clarity",
  craft: "Craft",
  stopping_power: "Stopping power",
};

export interface ScorePanelProps {
  runId: string | null;
  onRunId: (id: string) => void;
}

/** "Not stated" is a real answer here, and the default one. */
const ANY_PLACEMENT = "any";

export function ScorePanel({ runId, onRunId }: ScorePanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [productUrl, setProductUrl] = useState("");
  const [placementId, setPlacementId] = useState(ANY_PLACEMENT);
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [score, setScore] = useState<ScoreResponse | null>(null);
  // Initialised from the prop rather than raised inside the effect: a
  // synchronous setState in an effect body cascades an extra render, and the
  // answer is already known at first render.
  const [loadingRun, setLoadingRun] = useState(Boolean(runId));

  const placements = placementsSorted();

  /** Open a score somebody sent you. */
  useEffect(() => {
    if (!runId) return;
    let live = true;

    fetch(`/api/runs?id=${encodeURIComponent(runId)}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not open that run.");
        return body.run as {
          inputs: Record<string, unknown>;
          payload: Record<string, unknown> | null;
        };
      })
      .then((run) => {
        if (!live) return;
        setError(null);
        if (!run?.payload) return;
        const inputs = (run.inputs ?? {}) as Record<string, never>;
        setScore(run.payload as unknown as ScoreResponse);
        setPlacementId(
          typeof inputs.placementId === "string" ? inputs.placementId : ANY_PLACEMENT,
        );
        setObjective(typeof inputs.objective === "string" ? inputs.objective : "");
        setProductUrl(typeof inputs.productUrl === "string" ? inputs.productUrl : "");
        // The stored image, so a shared score shows the creative it is about.
        const stored = (run.payload as { image?: { url?: string | null } }).image;
        if (stored?.url) setPreview(stored.url);
      })
      .catch((cause) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (live) setLoadingRun(false);
      });

    return () => {
      live = false;
    };
  }, [runId]);

  function pick(selected: File | null) {
    setFile(selected);
    setScore(null);
    setError(null);
    // Only object URLs we created need revoking; a stored asset URL is an
    // ordinary path and revoking it would be a no-op at best.
    if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview);
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
      // Only when actually chosen. Sending a placement the user did not pick is
      // how a square creative ends up judged against a 4:5 spec.
      if (placementId !== ANY_PLACEMENT) form.append("placementId", placementId);
      if (objective) form.append("objective", objective);
      if (productUrl.trim()) form.append("productUrl", productUrl.trim());

      const response = await fetch("/api/score", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Scoring failed");
      setScore(data);
      if (data.runId) onRunId(data.runId);
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

      {loadingRun && (
        <div className="notice">
          <span className="spin" />
          Opening {runId}
        </div>
      )}

      <div className="masthead">
        <h1>Score a creative</h1>
        <p className="sub">
          Upload any ad, ours or anyone else&rsquo;s. Everything below the file
          is optional and each one sharpens the review.
        </p>
      </div>

      <form className="card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="file">Creative, PNG or JPEG</label>
          <input
            id="file"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
        </div>

        <div className="field">
          <label htmlFor="purl">
            Product URL, optional. Without it, product claims cannot be verified.
          </label>
          <input
            id="purl"
            type="url"
            placeholder="https://beminimalist.co/products/..."
            value={productUrl}
            onChange={(e) => setProductUrl(e.target.value)}
          />
        </div>

        <div className="row">
          <Select
            id="score-placement"
            label="Made for"
            value={placementId}
            onChange={setPlacementId}
            options={[
              {
                value: ANY_PLACEMENT,
                label: "Not stated",
                hint: "no size or ratio check",
              },
              ...placements.map((placement) => ({
                value: placement.id,
                label: placement.label,
                hint: `${placement.width}x${placement.height}`,
              })),
            ]}
          />
          <Select
            id="score-objective"
            label="Written for"
            value={objective}
            onChange={setObjective}
            options={[
              { value: "", label: "Not stated", hint: "judged generally" },
              ...OBJECTIVES,
            ]}
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
            {busy ? "Reviewing" : "Score creative"}
          </button>
          <span className="cost">
            {loadingRun ? "Opening a saved run" : "About $0.006, vision review"}
          </span>
        </div>
      </form>

      {score && (
        <>
          <section className="card">
            <div className="score-hero">
              <div className="score-stack">
                <div className="big-score">
                  {score.overall}
                  <span className="big-score-out-of"> / 100</span>
                </div>
                <span className={`badge ${verdictClass}`}>
                  {score.verdict.replace("_", " ")}
                </span>
                {(score.runId ?? runId) && (
              <span className="runid">{score.runId ?? runId}</span>
            )}
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

            {/* What it was judged against, so the spec is never an invisible
                assumption. A blocked verdict that came from a ratio check is
                only fair if the ratio was one the uploader chose. */}
            <p className="sub" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
              {score.placement
                ? `Judged as ${score.placement.label}, ${score.placement.width}x${score.placement.height}.`
                : "No placement stated, so size and aspect ratio were not judged."}
              {score.objective ? ` Written for ${score.objective}.` : ""}
            </p>

            {!score.productVerified && (
              <div className="notice" style={{ marginTop: "1rem", marginBottom: 0 }}>
                <span className="badge unverified">unverified</span>{" "}
                {score.productUrlWarning ?? score.note}
              </div>
            )}
          </section>

          {/*
            Each card renders only if it has something in it. A wrong-brand
            upload deliberately clears doLess — there is one action available
            and it is "upload the right file" — and an empty bordered box
            headed "Do less of this" reads as a panel that failed to load.
          */}
          {(score.doMore.length > 0 || score.doLess.length > 0) && (
            <div className="results">
              {score.doMore.length > 0 && (
                <section className="card">
                  <h2>Do more of this</h2>
                  <ul className="plain">
                    {score.doMore.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </section>
              )}
              {score.doLess.length > 0 && (
                <section className="card">
                  <h2>Do less of this</h2>
                  <ul className="plain">
                    {score.doLess.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}

          <section className="card">
            <h2>Findings, most severe first</h2>
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
                <span className="action">{finding.action}</span>
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
