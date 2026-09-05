"use client";

import { useState } from "react";
import { Select } from "./select";
import { Lightbox } from "./lightbox";
import { PlacementPicker, Chips } from "./multi-select";
import { placementsSorted, limitsFor, OFFER_PRESETS, ANGLE_PRESETS } from "../../config/placements";

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
const BRIEF_COST_USD = 0.008;
const MAX_REFERENCES = 2;

interface Claims {
  concentrations: string[];
  priceDisplay: string | null;
  compareAtDisplay: string | null;
  discountPct: number | null;
}

interface ProductImage {
  src: string;
  width: number | null;
  height: number | null;
}

interface Snapshot {
  title: string;
  productType: string | null;
  descriptionText: string | null;
  images: ProductImage[];
  concentrations: number[];
}

interface PolicyFinding {
  ruleId: string;
  severity: "blocking" | "major" | "minor";
  field: string;
  evidence: string;
  message: string;
}

interface Result {
  placement?: {
    id: string;
    label: string;
    width: number;
    height: number;
    ratio: string;
    platform: string;
  };
  concept: { name: string; angle: string; rationale: string };
  copy: { headline: string; subhead: string; primaryText: string; cta: string };
  policy: { verdict: string; findings: PolicyFinding[] };
  prompt: string;
  image: {
    dataUrl: string;
    width: number | null;
    height: number | null;
    bytes: number;
  } | null;
  placementCheck?: { ok: boolean; failures: string[]; warnings: string[] };
  error?: string;
}

const OBJECTIVES = [
  { value: "awareness", label: "Awareness", hint: "introduce the active" },
  { value: "consideration", label: "Consideration", hint: "why this formula" },
  { value: "conversion", label: "Conversion", hint: "outcome + offer" },
  { value: "retargeting", label: "Retargeting", hint: "assumes awareness" },
];

const CONCEPT_OPTIONS = [1, 2, 3, 4].map((n) => ({
  value: String(n),
  label: `${n} concept${n > 1 ? "s" : ""}`,
  hint: `$${(n * IMAGE_COST_USD + BRIEF_COST_USD).toFixed(2)}`,
}));

export function GeneratePanel() {
  const [url, setUrl] = useState("");
  const [resolving, setResolving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [claims, setClaims] = useState<Claims | null>(null);
  const [placementIds, setPlacementIds] = useState<string[]>(["meta_feed_4x5"]);
  const allPlacements = placementsSorted();

  // Confirmation-step corrections. Empty means "use what was scraped".
  const [editTitle, setEditTitle] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editCompareAt, setEditCompareAt] = useState("");
  const [editConcentrations, setEditConcentrations] = useState("");

  const [brandMark, setBrandMark] = useState("on_pack_only");
  const [priceDisplay, setPriceDisplay] = useState("price_only");
  const [runId, setRunId] = useState<string | null>(null);

  // Ordered: the first entry is the primary reference the model anchors on.
  const [refIndexes, setRefIndexes] = useState<number[]>([0]);
  const [zoomed, setZoomed] = useState<{ src: string; caption: string } | null>(
    null,
  );

  const [objective, setObjective] = useState("conversion");
  const [concepts, setConcepts] = useState(2);
  const [offer, setOffer] = useState("");
  const [angleHint, setAngleHint] = useState("");

  const [results, setResults] = useState<Result[] | null>(null);
  const [blocked, setBlocked] = useState<
    { name: string; policy: { findings: PolicyFinding[] } }[]
  >([]);
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
      setEditTitle(data.snapshot.title ?? "");
      setEditPrice(
        data.snapshot.priceMinor != null
          ? String(Math.round(data.snapshot.priceMinor / 100))
          : "",
      );
      setEditCompareAt(
        data.snapshot.compareAtPriceMinor != null
          ? String(Math.round(data.snapshot.compareAtPriceMinor / 100))
          : "",
      );
      setEditConcentrations((data.snapshot.concentrations ?? []).join(", "));
      // The first product image is the packshot on practically every Shopify
      // storefront, so it is the default reference.
      setRefIndexes([0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(false);
    }
  }

  function toggleReference(index: number) {
    setRefIndexes((current) => {
      if (current.includes(index)) {
        // Never leave the selection empty — the model needs an anchor.
        return current.length === 1 ? current : current.filter((i) => i !== index);
      }
      if (current.length >= MAX_REFERENCES) {
        // Drop the oldest, keeping selection order meaningful.
        return [...current.slice(1), index];
      }
      return [...current, index];
    });
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
          placementIds,
          objective,
          concepts,
          offer: offer || undefined,
          angleHint: angleHint || undefined,
          referenceImageIndexes: refIndexes,
          brandMark,
          priceDisplay,
          overrides: buildOverrides(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Generation failed");
      setResults(data.results);
      setBlocked(data.blocked ?? []);
      setCost(data.cost);
      setRunId(data.runId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  // Every placement is another image per concept — the multiplication has to
  // be visible before the button is pressed, not discovered on the invoice.
  const imageCount = concepts * placementIds.length;
  const estimate = imageCount * IMAGE_COST_USD + BRIEF_COST_USD;
  const limits = limitsFor(placementIds);

  function buildOverrides() {
    const overrides: Record<string, unknown> = {};
    if (snapshot && editTitle && editTitle !== snapshot.title) {
      overrides.title = editTitle;
    }
    const price = Number(editPrice);
    if (editPrice && Number.isFinite(price)) overrides.priceMinor = price * 100;
    const compareAt = Number(editCompareAt);
    if (editCompareAt && Number.isFinite(compareAt)) {
      overrides.compareAtPriceMinor = compareAt * 100;
    } else if (editCompareAt === "") {
      overrides.compareAtPriceMinor = null;
    }
    const parsedConc = editConcentrations
      .split(/[,\s]+/)
      .map((v) => Number(v.replace("%", "")))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (parsedConc.length > 0) overrides.concentrations = parsedConc;
    return Object.keys(overrides).length > 0 ? overrides : undefined;
  }

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
              {snapshot.productType ?? "Uncategorised"} · {snapshot.images.length}{" "}
              images
            </p>

            {claims.concentrations.length > 0 && (
              <div className="claimbar">
                Claim-bearing values detected:{" "}
                <strong>{claims.concentrations.join(", ")}</strong> — these are
                regulated figures. They will be printed exactly as shown and the
                model cannot author others.
              </div>
            )}

            <div className="editable">
              <div>
                <label htmlFor="e-title">Product name</label>
                <input
                  id="e-title"
                  type="text"
                  className={editTitle !== snapshot.title ? "edited" : ""}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="e-price">Price (₹)</label>
                <input
                  id="e-price"
                  type="number"
                  min={0}
                  value={editPrice}
                  onChange={(e) => setEditPrice(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="e-was">Was (₹) — blank for none</label>
                <input
                  id="e-was"
                  type="number"
                  min={0}
                  value={editCompareAt}
                  onChange={(e) => setEditCompareAt(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="e-conc">Concentrations (%)</label>
                <input
                  id="e-conc"
                  type="text"
                  placeholder="15.6, 10"
                  value={editConcentrations}
                  onChange={(e) => setEditConcentrations(e.target.value)}
                />
              </div>
            </div>
            <p className="edit-note">
              Correct anything the scrape got wrong. Whatever is here is what the
              creative may state — nothing else.
            </p>

            <div className="field" style={{ marginTop: "0.9rem" }}>
              <label>
                Reference photograph — pick up to {MAX_REFERENCES}. Click ⤢ to
                enlarge.
              </label>
              <div className="thumbs">
                {snapshot.images.map((image, index) => {
                  const order = refIndexes.indexOf(index);
                  return (
                    <div className="thumb-wrap" key={image.src}>
                      <button
                        type="button"
                        className="thumb"
                        aria-pressed={order !== -1}
                        aria-label={`Use image ${index + 1} as reference`}
                        onClick={() => toggleReference(index)}
                        style={{ backgroundImage: `url(${image.src})` }}
                      />
                      {order !== -1 && (
                        <span className="thumb-order">{order + 1}</span>
                      )}
                      <button
                        type="button"
                        className="thumb-zoom"
                        aria-label={`Enlarge image ${index + 1}`}
                        onClick={() =>
                          setZoomed({
                            src: image.src,
                            caption: `Image ${index + 1} of ${snapshot.images.length}${
                              image.width && image.height
                                ? ` · ${image.width}×${image.height}`
                                : ""
                            }`,
                          })
                        }
                      >
                        ⤢
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="sub" style={{ marginTop: "0.4rem" }}>
                {refIndexes.length === 1
                  ? "1 reference selected — the model matches this packaging exactly."
                  : `${refIndexes.length} references selected — badge 1 is the primary anchor.`}
              </p>
            </div>
          </section>

          <section className="card">
            <h2>Brief</h2>
            <PlacementPicker
              placements={allPlacements}
              selected={placementIds}
              onChange={setPlacementIds}
            />
            {limits.platforms.length > 1 && (
              <p className="edit-note">
                Mixed platforms — copy is written to the tightest limits in the
                selection: headline {limits.headline}, primary text{" "}
                {limits.primaryText}.
              </p>
            )}
            <div className="row">
              <Select
                id="objective"
                label="Objective"
                value={objective}
                onChange={setObjective}
                options={OBJECTIVES}
              />
              <Select
                id="concepts"
                label="Concepts"
                value={String(concepts)}
                onChange={(v) => setConcepts(Number(v))}
                options={CONCEPT_OPTIONS}
              />
              <Select
                id="brandmark"
                label="Brand mark"
                value={brandMark}
                onChange={setBrandMark}
                options={[
                  { value: "on_pack_only", label: "On pack only", hint: "recommended" },
                  { value: "wordmark", label: "Add wordmark", hint: "small, corner" },
                  { value: "none", label: "No mark", hint: "unbranded test" },
                ]}
              />
              <Select
                id="pricedisplay"
                label="Price"
                value={priceDisplay}
                onChange={setPriceDisplay}
                options={[
                  { value: "price_only", label: "Price only", hint: "quiet, last read" },
                  { value: "was_now", label: "Was / now", hint: "shows discount" },
                  { value: "none", label: "No price", hint: "let the claim carry" },
                ]}
              />
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor="offer">Offer — printed verbatim, never paraphrased</label>
                <input
                  id="offer"
                  type="text"
                  placeholder="e.g. 20% off, Buy 2 Get 1"
                  value={offer}
                  onChange={(e) => setOffer(e.target.value)}
                />
                <Chips options={OFFER_PRESETS} active={offer} onPick={setOffer} />
              </div>
              <div className="field">
                <label htmlFor="angle">Angle — steer the creative direction</label>
                <input
                  id="angle"
                  type="text"
                  placeholder="e.g. lead with SPF 50, monsoon skin"
                  value={angleHint}
                  onChange={(e) => setAngleHint(e.target.value)}
                />
                <Chips
                  options={ANGLE_PRESETS}
                  active={angleHint}
                  onPick={setAngleHint}
                />
              </div>
            </div>
            <div className="actions">
              <button className="primary" onClick={generate} disabled={generating}>
                {generating && <span className="spin" />}
                {generating
                  ? "Generating…"
                  : `Generate ${imageCount} creative${imageCount > 1 ? "s" : ""}`}
              </button>
              <span className="cost">
                ≈ ${estimate.toFixed(2)} · {concepts} concept
                {concepts > 1 ? "s" : ""} × {placementIds.length} placement
                {placementIds.length > 1 ? "s" : ""} = {imageCount} image
                {imageCount > 1 ? "s" : ""}
              </span>
            </div>
          </section>
        </>
      )}

      {results && (
        <>
          {cost && (
            <div className="notice">
              {runId && <span className="runid">{runId}</span>}{" "}
              Spent ${cost.totalUsd.toFixed(4)} on this run
              {blocked.length > 0 &&
                ` · ${blocked.length} concept${blocked.length > 1 ? "s" : ""} blocked before generation, so no image spend on ${blocked.length > 1 ? "those" : "that one"}`}
              .
            </div>
          )}

          {/* Blocked concepts are shown, not silently dropped — the marketer
              needs to see what the gate caught and why. */}
          {blocked.length > 0 && (
            <section className="card">
              <h2>Blocked before generation</h2>
              {blocked.map((item, index) => (
                <div key={index} style={{ marginBottom: "0.75rem" }}>
                  <span className="badge blocked">blocked</span>{" "}
                  <strong>{item.name}</strong>
                  {item.policy.findings.map((finding, i) => (
                    <div className={`finding ${finding.severity}`} key={i}>
                      <strong>{finding.ruleId}</strong> — &ldquo;{finding.evidence}
                      &rdquo; in <code>{finding.field}</code>
                      <span className="action">{finding.message}</span>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )}

          <div className="results">
            {results.map((result, index) => (
              <AdCard key={index} result={result} onZoom={setZoomed} />
            ))}
          </div>
        </>
      )}

      {zoomed && (
        <Lightbox
          src={zoomed.src}
          caption={zoomed.caption}
          onClose={() => setZoomed(null)}
        />
      )}
    </>
  );
}

/** Renders the creative the way it will appear in a Meta feed. */
function AdCard({
  result,
  onZoom,
}: {
  result: Result;
  onZoom: (image: { src: string; caption: string }) => void;
}) {
  const verdictClass =
    result.policy.verdict === "pass"
      ? "pass"
      : result.policy.verdict === "blocked"
        ? "blocked"
        : "fix";

  // Prefer the placement spec; fall back to the image's own dimensions so a
  // result from an older response shape still renders uncropped.
  const frameRatio = result.placement
    ? `${result.placement.width} / ${result.placement.height}`
    : result.image?.width && result.image?.height
      ? `${result.image.width} / ${result.image.height}`
      : "4 / 5";

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
        <img
          className="ad-image"
          src={result.image.dataUrl}
          alt={result.concept.name}
          style={{
            cursor: "zoom-in",
            // The frame takes the PLACEMENT's ratio, not a hardcoded 4:5, and
            // contains rather than covers. A 1:1 Google asset shown in a 4:5
            // cover frame loses a third of the creative — usually the headline.
            aspectRatio: frameRatio,
            objectFit: "contain",
          }}
          onClick={() =>
            onZoom({
              src: result.image!.dataUrl,
              caption: `${result.concept.name} · ${result.image!.width}×${result.image!.height}`,
            })
          }
        />
      ) : (
        <div
          className="ad-image"
          style={{
            display: "grid",
            placeItems: "center",
            aspectRatio: frameRatio,
          }}
        >
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
        {result.placement && (
          <span className="cost">
            {result.placement.label} · {result.placement.ratio}
          </span>
        )}
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

