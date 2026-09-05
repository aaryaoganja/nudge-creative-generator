"use client";

import { useState } from "react";

/**
 * Generation flow: URL → confirm → brief → creatives.
 *
 * The confirmation step is deliberate and blocking. Resolving costs nothing;
 * generating costs $0.134 per image. Letting a human check the scraped facts
 * first is the difference between a wrong creative and a wrong creative you
 * paid for. It also surfaces the claim-bearing values — the regulated numbers
 * that get printed — before anything prints them.
 */

const IMAGE_COST_USD = 0.134;
const USD_TO_INR = 88; // display only; billing is in USD

interface Claims {
  concentrations: string[];
  priceDisplay: string | null;
  compareAtDisplay: string | null;
  discountPct: number | null;
}

interface Snapshot {
  title: string;
  productType: string | null;
  descriptionText: string | null;
  images: { src: string; width: number | null; height: number | null }[];
  concentrations: number[];
}

interface Placement {
  id: string;
  label: string;
  width: number;
  height: number;
}

interface PolicyFinding {
  ruleId: string;
  severity: "blocking" | "major" | "minor";
  field: string;
  evidence: string;
  message: string;
}

interface Result {
  concept: { name: string; angle: string; rationale: string };
  copy: { headline: string; subhead: string; primaryText: string; cta: string };
  policy: { verdict: string; findings: PolicyFinding[] };
  prompt: string;
  image: { dataUrl: string; width: number | null; height: number | null; bytes: number } | null;
  placementCheck?: { ok: boolean; failures: string[]; warnings: string[] };
  error?: string;
}

export function GeneratePanel() {
  const [url, setUrl] = useState("");
  const [resolving, setResolving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [claims, setClaims] = useState<Claims | null>(null);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [placementId, setPlacementId] = useState("meta_feed_4x5");
  const [refIndex, setRefIndex] = useState(0);

  const [objective, setObjective] = useState("conversion");
  const [concepts, setConcepts] = useState(2);
  const [offer, setOffer] = useState("");
  const [angleHint, setAngleHint] = useState("");

  const [results, setResults] = useState<Result[] | null>(null);
  const [cost, setCost] = useState<{ totalUsd: number } | null>(null);

  async function resolve(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setResults(null);
    setSnapshot(null);
    setResolving(true);
    try {
      const response = await fetch("/api/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not read that page");
      setSnapshot(data.snapshot);
      setClaims(data.claims);
      setPlacements(data.placements);
      setRefIndex(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(false);
    }
  }

  async function generate() {
    setError(null);
    setGenerating(true);
    setResults(null);
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          placementId,
          objective,
          concepts,
          offer: offer || undefined,
          angleHint: angleHint || undefined,
          referenceImageIndex: refIndex,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Generation failed");
      setResults(data.results);
      setCost(data.cost);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  const estimate = concepts * IMAGE_COST_USD + 0.008;

  return (
    <>
      {error && <div className="error">{error}</div>}

      <form className="card" onSubmit={resolve}>
        <h2>Product</h2>
        <div className="field">
          <label htmlFor="url">Product URL</label>
          <input
            id="url"
            type="url"
            required
            placeholder="https://beminimalist.co/products/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="actions">
          <button className="primary" type="submit" disabled={resolving || !url}>
            {resolving && <span className="spin" />}
            {resolving ? "Reading page…" : "Read product"}
          </button>
          <span className="cost">Free — nothing is generated yet</span>
        </div>
      </form>

      {snapshot && claims && (
        <>
          <section className="card">
            <h2>Confirm before generating</h2>
            <div className="confirm-head">
              <strong>{snapshot.title}</strong>
              <span className="price">
                {claims.priceDisplay ?? "—"}
                {claims.compareAtDisplay && (
                  <span className="was">{claims.compareAtDisplay}</span>
                )}
                {claims.discountPct !== null && (
                  <span className="off">−{claims.discountPct}%</span>
                )}
              </span>
            </div>
            <p className="sub" style={{ marginTop: "0.25rem" }}>
              {snapshot.productType ?? "Uncategorised"} · {snapshot.images.length} images
            </p>

            {claims.concentrations.length > 0 && (
              <div className="claimbar">
                Claim-bearing values detected:{" "}
                <strong>{claims.concentrations.join(", ")}</strong> — these are
                regulated figures. They will be printed exactly as shown and the
                model cannot author others.
              </div>
            )}

            <div className="field">
              <label>Reference photograph — the real product the model must match</label>
              <div className="thumbs">
                {snapshot.images.slice(0, 8).map((image, index) => (
                  <button
                    key={image.src}
                    type="button"
                    className="thumb"
                    aria-pressed={refIndex === index}
                    onClick={() => setRefIndex(index)}
                    title={`Image ${index + 1}`}
                    style={{
                      backgroundImage: `url(${image.src})`,
                      backgroundSize: "cover",
                      backgroundPosition: "center",
                    }}
                  />
                ))}
              </div>
            </div>
          </section>

          <section className="card">
            <h2>Brief</h2>
            <div className="row">
              <div className="field">
                <label htmlFor="placement">Placement</label>
                <select
                  id="placement"
                  value={placementId}
                  onChange={(e) => setPlacementId(e.target.value)}
                >
                  {placements.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} · {p.width}×{p.height}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="objective">Objective</label>
                <select
                  id="objective"
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                >
                  <option value="awareness">Awareness</option>
                  <option value="consideration">Consideration</option>
                  <option value="conversion">Conversion</option>
                  <option value="retargeting">Retargeting</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="concepts">Concepts</label>
                <input
                  id="concepts"
                  type="number"
                  min={1}
                  max={4}
                  value={concepts}
                  onChange={(e) => setConcepts(Number(e.target.value))}
                />
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor="offer">Offer — printed verbatim (optional)</label>
                <input
                  id="offer"
                  type="text"
                  placeholder="20% off"
                  value={offer}
                  onChange={(e) => setOffer(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="angle">Angle hint (optional)</label>
                <input
                  id="angle"
                  type="text"
                  placeholder="lead with the anti-grey benefit"
                  value={angleHint}
                  onChange={(e) => setAngleHint(e.target.value)}
                />
              </div>
            </div>
            <div className="actions">
              <button className="primary" onClick={generate} disabled={generating}>
                {generating && <span className="spin" />}
                {generating ? "Generating…" : `Generate ${concepts} creative${concepts > 1 ? "s" : ""}`}
              </button>
              <span className="cost">
                ≈ ${estimate.toFixed(2)} (₹{Math.round(estimate * USD_TO_INR)}) ·{" "}
                {concepts} image{concepts > 1 ? "s" : ""} at ${IMAGE_COST_USD}
              </span>
            </div>
          </section>
        </>
      )}

      {results && (
        <>
          {cost && (
            <div className="notice">
              Spent ${cost.totalUsd.toFixed(4)} on this run.
            </div>
          )}
          <div className="results">
            {results.map((result, index) => (
              <AdCard key={index} result={result} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** Renders the creative the way it will appear in a Meta feed. */
function AdCard({ result }: { result: Result }) {
  const verdictClass =
    result.policy.verdict === "pass"
      ? "pass"
      : result.policy.verdict === "blocked"
        ? "blocked"
        : "fix";

  return (
    <article className="adcard">
      <div className="ad-meta">
        <div className="avatar">M</div>
        <div>
          <div className="brandline">Minimalist</div>
          <div className="sponsored">Sponsored</div>
        </div>
      </div>

      <div className="ad-primary">{result.copy.primaryText}</div>

      {result.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="ad-image" src={result.image.dataUrl} alt={result.concept.name} />
      ) : (
        <div className="ad-image" style={{ display: "grid", placeItems: "center" }}>
          <span className="sub" style={{ padding: "1rem", textAlign: "center" }}>
            {result.error ?? "No image"}
          </span>
        </div>
      )}

      <div className="ad-foot">
        <div>
          <div className="ad-headline">{result.copy.headline}</div>
          <div className="ad-sub">{result.copy.subhead}</div>
        </div>
        <div className="ad-cta">{result.copy.cta}</div>
      </div>

      <div className="adcard-foot">
        <span className={`badge ${verdictClass}`}>{result.policy.verdict}</span>
        <span className="cost">{result.concept.name}</span>
        {result.image && (
          <>
            <span className="cost">
              {result.image.width}×{result.image.height} ·{" "}
              {(result.image.bytes / 1024).toFixed(0)}KB
            </span>
            <a
              className="ghost"
              href={result.image.dataUrl}
              download={`${result.concept.name.replace(/\W+/g, "-").toLowerCase()}.png`}
              style={{ textDecoration: "none" }}
            >
              Download
            </a>
          </>
        )}
      </div>

      {result.placementCheck && !result.placementCheck.ok && (
        <div className="adcard-foot" style={{ display: "block" }}>
          {result.placementCheck.failures.map((failure) => (
            <div className="finding blocking" key={failure}>
              {failure}
            </div>
          ))}
        </div>
      )}

      {result.policy.findings.length > 0 && (
        <div className="adcard-foot" style={{ display: "block" }}>
          {result.policy.findings.map((finding, i) => (
            <div className={`finding ${finding.severity}`} key={i}>
              <strong>{finding.ruleId}</strong> — &ldquo;{finding.evidence}&rdquo;
              <span className="action">{finding.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="adcard-foot" style={{ display: "block" }}>
        <details>
          <summary>Prompt sent to the image model</summary>
          <pre className="prompt">{result.prompt}</pre>
        </details>
      </div>
    </article>
  );
}
