"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Select } from "./select";
import { Lightbox } from "./lightbox";
import { PlacementPicker, Chips } from "./multi-select";
import { OBJECTIVES } from "./objectives";
import {
  placementsSorted,
  defaultPlacementIds,
  limitsFor,
  OFFER_PRESETS,
  ANGLE_PRESETS,
} from "../../config/placements";

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
  /* Minor units. The confirm fields divide by 100 to show rupees. */
  priceMinor: number | null;
  compareAtPriceMinor: number | null;
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
    /**
     * Where the stored bytes live, when they could be stored. Preferred over
     * dataUrl: the response no longer carries megabytes of base64, and the same
     * URL still resolves when somebody opens this run tomorrow.
     */
    url: string | null;
    /** Only when there was nowhere to store it, so the picture still appears. */
    dataUrl: string | null;
    width: number | null;
    height: number | null;
    bytes: number;
  } | null;
  placementCheck?: { ok: boolean; failures: string[]; warnings: string[] };
  error?: string;
}


/**
 * Where to load a generated creative from.
 *
 * The stored asset URL when there is one, and the inline data URL only when
 * there was nowhere to store it. Both are always accepted so a run recorded
 * before assets existed, or generated on a deployment with no database, still
 * renders its pictures.
 */
function imageSrc(image: { url: string | null; dataUrl: string | null }): string | null {
  return image.url ?? image.dataUrl;
}

/**
 * The cost of each concept count, at the CURRENT placement selection.
 *
 * A fixed table read `$0.28` for two concepts while the button beside it said
 * $0.54, because the table assumed one placement and the button knew there were
 * two. Two different prices for the same click is worse than no price.
 */
function conceptOptions(placementCount: number) {
  return [1, 2, 3, 4].map((n) => ({
    value: String(n),
    label: `${n} concept${n > 1 ? "s" : ""}`,
    hint: `$${(n * Math.max(placementCount, 1) * IMAGE_COST_USD + BRIEF_COST_USD).toFixed(2)}`,
  }));
}


/**
 * A numbered step heading, from the supplied design.
 *
 * The sections were "Product", "Confirm before generating" and "Brief", which
 * describe themselves but not the order they come in. Numbering them says the
 * thing a first-time user actually needs: there are three, you are on the
 * second, and the third is where the money is spent.
 */
function Step({
  n,
  title,
  aside,
}: {
  n: number;
  title: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="step">
      <span className="step-n" aria-hidden="true">
        {n}
      </span>
      <h2 className="step-title">{title}</h2>
      {aside && <span className="step-aside">{aside}</span>}
    </div>
  );
}


/**
 * The link to this run, and a one-click copy of it.
 *
 * The address bar already holds the URL; this exists because people do not
 * think to look there, and because "copy" has to be one click when the whole
 * point is handing the result to a colleague. `navigator.clipboard` needs a
 * secure context, which localhost and the deployment both are, and the fallback
 * is simply telling the user to copy the address bar rather than pretending.
 */
function ShareBar({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="sharebar">
      <span className="runid">{runId}</span>
      <span className="sharebar-note">
        This run has a link. Anyone who can sign in can open it.
      </span>
      <button
        type="button"
        className="ghost"
        onClick={async () => {
          const link = `${window.location.origin}/?run=${runId}`;
          try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          } catch {
            // Clipboard blocked by the browser. The URL is in the address bar
            // either way, so say that rather than failing silently.
            setCopied(false);
          }
        }}
      >
        {copied ? "Link copied" : "Copy link"}
      </button>
    </div>
  );
}

export interface GeneratePanelProps {
  /** From ?run= in the address bar. Loads that run instead of starting blank. */
  runId: string | null;
  /** Called the moment the server hands back an id, so the URL can carry it. */
  onRunId: (id: string) => void;
  onClearRunId: () => void;
}

export function GeneratePanel({
  runId,
  onRunId,
  onClearRunId,
}: GeneratePanelProps) {
  const [url, setUrl] = useState("");
  const [resolving, setResolving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [claims, setClaims] = useState<Claims | null>(null);
  /*
   * The opening selection comes from the catalogue, not from a literal here.
   * config/placements.ts already owns which rows exist and which two a marketer
   * actually buys; a hardcoded "meta_feed_4x5" in this file meant renaming a row
   * would leave the picker opening on an id that no longer exists — and it made
   * defaultPlacementIds() a function nothing called.
   */
  const [placementIds, setPlacementIds] = useState<string[]>(defaultPlacementIds);
  const allPlacements = placementsSorted();

  // Confirmation-step corrections. Empty means "use what was scraped".
  const [editTitle, setEditTitle] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editCompareAt, setEditCompareAt] = useState("");
  const [editConcentrations, setEditConcentrations] = useState("");

  const [brandMark, setBrandMark] = useState("on_pack_only");
  const [priceDisplay, setPriceDisplay] = useState("price_only");

  /**
   * Whether the user has touched the offer or the angle.
   *
   * Both get a default seeded from the resolved product, and re-reading a URL
   * re-seeds every other confirmation field. Without this, clearing the angle
   * and then fixing a typo in the URL would silently put the default back, and
   * a default you cannot get rid of is not a default.
   */
  const briefTouched = useRef({ offer: false, angle: false });

  /**
   * Run ids this panel minted itself.
   *
   * Adopting an id writes it into the URL, which changes the `runId` prop,
   * which would otherwise fire the "open a shared run" effect against the run
   * we are already showing. That round trip overwrote the defaults seeded a
   * moment earlier with the empty values of a run that had only been resolved,
   * so the offer and angle appeared for one frame and then vanished. Rehydrate
   * only ids that arrived from somewhere else.
   */
  const mintedHere = useRef(new Set<string>());
  // Initialised from the prop rather than raised inside the effect: a
  // synchronous setState in an effect body cascades an extra render, and the
  // answer is already known at first render.
  const [loadingRun, setLoadingRun] = useState(Boolean(runId));

  // Ordered: the first entry is the primary reference the model anchors on.
  const [refIndexes, setRefIndexes] = useState<number[]>([0]);
  const [zoomed, setZoomed] = useState<{ src: string; caption: string } | null>(
    null,
  );

  const [objective, setObjective] = useState("conversion");
  const [concepts, setConcepts] = useState(2);
  const [offer, setOffer] = useState("");
  const [angleHint, setAngleHint] = useState("");
  /*
   * Who the ad is for. The API has accepted this and the prompt has printed it
   * since the first version; there was simply no control, so the line never
   * appeared. Optional, and empty by default: an invented audience is worse
   * than none, because the model will write to it.
   */
  const [audience, setAudience] = useState("");

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
    setBlocked([]);
    setCost(null);
    // A new read is a new run. Leaving the old id in the URL would give the
    // next link the previous product's payload.
    onClearRunId();
    setResolving(true);
    try {
      const response = await fetch("/api/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not read that page");
      applySnapshot(data.snapshot, data.claims);
      seedBrief(data.snapshot, data.claims);
      // The id exists from here, so the address bar can carry it before a
      // rupee is spent. Generating fills this same run in rather than opening
      // a second one.
      if (data.runId) {
        mintedHere.current.add(data.runId);
        onRunId(data.runId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(false);
    }
  }

  /** Everything the confirmation step shows, from a snapshot. */
  const applySnapshot = useCallback((snap: Snapshot, resolved: Claims) => {
    setSnapshot(snap);
    setClaims(resolved);
    setEditTitle(snap.title ?? "");
    setEditPrice(
      snap.priceMinor != null ? String(Math.round(snap.priceMinor / 100)) : "",
    );
    setEditCompareAt(
      snap.compareAtPriceMinor != null
        ? String(Math.round(snap.compareAtPriceMinor / 100))
        : "",
    );
    setEditConcentrations((snap.concentrations ?? []).join(", "));
    // The first product image is the packshot on practically every Shopify
    // storefront, so it is the default reference.
    setRefIndexes([0]);
  }, []);

  /**
   * Fill the brief so the next click can be Generate.
   *
   * Both defaults are derived from what was actually scraped, which is not
   * fussiness: the deterministic claim gate blocks any percentage or rupee
   * figure that is not in the product's own claims or typed by the operator, so
   * a hardcoded "20% off this week" would produce a blocked concept and a
   * wasted brief on every product that is not discounted by exactly 20%. The
   * one discount string the gate is guaranteed to accept is the product's own.
   *
   * The angle carries no such risk: it enters the prompt as a steer rather than
   * as copy, and the gate never inspects it. It is defaulted unconditionally,
   * with the variant chosen by whether the product actually states a
   * concentration to lead with.
   */
  const seedBrief = useCallback((snap: Snapshot, resolved: Claims) => {
    if (!briefTouched.current.offer) {
      setOffer(resolved.discountPct !== null ? `${resolved.discountPct}% off` : "");
    }
    if (!briefTouched.current.angle) {
      setAngleHint(
        (snap.concentrations ?? []).length > 0
          ? "Lead with the active and its concentration"
          : "Answer the single biggest objection",
      );
    }
    // A discount worth printing is a discount worth showing struck through.
    if (resolved.discountPct !== null) setPriceDisplay("was_now");
  }, []);

  /**
   * Open a run somebody sent you.
   *
   * The stored payload is the response the generator returned, so redrawing is
   * a matter of putting it back into the same state the live path fills. A run
   * that only got as far as the confirmation step redraws as the confirmation
   * step, which is why the payload carries `stage`.
   */
  useEffect(() => {
    if (!runId) return;
    // Already on screen, and fresher than anything the server could return.
    if (mintedHere.current.has(runId)) return;
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
        const payload = run.payload as Record<string, never>;
        const inputs = (run.inputs ?? {}) as Record<string, never>;

        if (payload.snapshot) {
          applySnapshot(payload.snapshot, payload.claims);
        }
        if (typeof inputs.url === "string") setUrl(inputs.url);
        if (Array.isArray(inputs.placementIds)) setPlacementIds(inputs.placementIds);
        if (typeof inputs.objective === "string") setObjective(inputs.objective);
        if (typeof inputs.concepts === "number") setConcepts(inputs.concepts);
        if (typeof inputs.brandMark === "string") setBrandMark(inputs.brandMark);
        if (typeof inputs.priceDisplay === "string") setPriceDisplay(inputs.priceDisplay);
        // Whatever the run actually used, including "nothing", which is why
        // these are set unconditionally rather than only when truthy: a run
        // with no offer must not inherit the current session's offer.
        setOffer(typeof inputs.offer === "string" ? inputs.offer : "");
        setAngleHint(typeof inputs.angleHint === "string" ? inputs.angleHint : "");
        setAudience(typeof inputs.audience === "string" ? inputs.audience : "");
        briefTouched.current = { offer: true, angle: true };
        if (Array.isArray(inputs.referenceImageIndexes)) {
          setRefIndexes(inputs.referenceImageIndexes);
        }

        if (Array.isArray(payload.results)) setResults(payload.results);
        if (Array.isArray(payload.blocked)) setBlocked(payload.blocked);
        if (payload.cost) setCost(payload.cost);
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
    // Deliberately keyed on the id alone. applySnapshot is stable and adding it
    // would only re-run this when React decided to rebuild the callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

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
          // Fill in the run the confirmation step opened, rather than starting
          // a second one, so the link already in the address bar is the link to
          // the finished creatives.
          runId: runId ?? undefined,
          placementIds,
          objective,
          concepts,
          offer: offer || undefined,
          angleHint: angleHint || undefined,
          audience: audience || undefined,
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
      if (data.runId) {
        mintedHere.current.add(data.runId);
        onRunId(data.runId);
      }
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

  /**
   * The corrections a human made, as an override object.
   *
   * Two things here are easy to get wrong and were:
   *
   * CLEARING a field has to mean something. Emptying the concentrations box on
   * a product whose page states a wrong concentration is the correction that
   * matters most, and the old code ignored an empty parse and printed the
   * scraped figure anyway. An empty box now sends an empty list, so the claim
   * disappears from the permitted set and the model cannot use it.
   *
   * MINOR UNITS are integers. A price typed as "810.50" became 81050.0000001
   * territory through `price * 100`, and the route's `z.number().int()` sent
   * the whole request back as a 422 with nothing on screen to explain why.
   */
  function buildOverrides() {
    const overrides: Record<string, unknown> = {};
    if (snapshot && editTitle && editTitle !== snapshot.title) {
      overrides.title = editTitle;
    }

    const price = Number(editPrice);
    if (editPrice && Number.isFinite(price)) {
      overrides.priceMinor = Math.round(price * 100);
    }

    const compareAt = Number(editCompareAt);
    if (editCompareAt && Number.isFinite(compareAt)) {
      overrides.compareAtPriceMinor = Math.round(compareAt * 100);
    } else if (editCompareAt === "") {
      overrides.compareAtPriceMinor = null;
    }

    const parsedConc = editConcentrations
      .split(/[,\s]+/)
      .map((v) => Number(v.replace("%", "")))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (parsedConc.length > 0) {
      overrides.concentrations = parsedConc;
    } else if (editConcentrations.trim() === "") {
      overrides.concentrations = [];
    }

    return Object.keys(overrides).length > 0 ? overrides : undefined;
  }

  return (
    <>
      <h1 className="sr-only">Generate a creative</h1>

      {error && <div className="error">{error}</div>}

      {loadingRun && (
        <div className="notice">
          <span className="spin" />
          Opening {runId}
        </div>
      )}

      {/*
        Visible from the first click, not from the first invoice.
        The id is minted by the free resolve step precisely so there is
        something to send somebody before any money is spent.
      */}
      {runId && !loadingRun && <ShareBar runId={runId} />}

      <form className="card" onSubmit={resolve}>
        <Step n={1} title="Product URL" />
        <div className="field">
          <label htmlFor="url">Product URL</label>
          <input
            id="url"
            type="url"
            required
            placeholder="https://beminimalist.co/products/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="actions">
          <button className="primary" type="submit" disabled={resolving || !url}>
            {resolving && <span className="spin" />}
            {resolving ? "Reading page" : "Read product"}
          </button>
          <span className="cost">Free. Nothing is generated yet.</span>
        </div>
      </form>

      {snapshot && claims && (
        <>
          <section className="card">
            <Step
              n={2}
              title="What we read"
              aside="Edit anything before you run"
            />
            <div className="confirm-head">
              <strong>{snapshot.title}</strong>
              <span className="price">
                {claims.priceDisplay ?? "not stated"}
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
                <strong>{claims.concentrations.join(", ")}</strong>. These are
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
                <label htmlFor="e-was">Was (₹), blank for none</label>
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
              creative may state, and nothing else.
            </p>

            <div className="field" style={{ marginTop: "0.9rem" }}>
              <label>
                Reference photograph. Pick up to {MAX_REFERENCES}, and click the arrows to
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
                  ? "1 reference selected. The model matches this packaging exactly."
                  : `${refIndexes.length} references selected. Badge 1 is the primary anchor.`}
              </p>
            </div>
          </section>

          <section className="card">
            <Step n={3} title="Brief" />
            <PlacementPicker
              placements={allPlacements}
              selected={placementIds}
              onChange={setPlacementIds}
            />
            {limits.platforms.length > 1 && (
              <p className="edit-note">
                Mixed platforms, so copy is written to the tightest limits in
                the selection: headline {limits.headline}, primary text{" "}
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
                options={conceptOptions(placementIds.length)}
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
                <label htmlFor="offer">Offer, printed verbatim</label>
                <input
                  id="offer"
                  type="text"
                  placeholder="e.g. Buy 2 get 1 free"
                  value={offer}
                  onChange={(e) => {
                    briefTouched.current.offer = true;
                    setOffer(e.target.value);
                  }}
                />
                <Chips
                  options={OFFER_PRESETS}
                  active={offer}
                  onPick={(value) => {
                    briefTouched.current.offer = true;
                    setOffer(value);
                  }}
                />
                <p className="sub">
                  Any figure you type here is treated as a claim you have
                  authorised, and is printed exactly as written. Leave it empty
                  if there is no promotion.
                </p>
              </div>
              <div className="field">
                <label htmlFor="angle">Angle, steers the creative direction</label>
                <input
                  id="angle"
                  type="text"
                  placeholder="e.g. lead with SPF 50, monsoon skin"
                  value={angleHint}
                  onChange={(e) => {
                    briefTouched.current.angle = true;
                    setAngleHint(e.target.value);
                  }}
                />
                <Chips
                  options={ANGLE_PRESETS}
                  active={angleHint}
                  onPick={(value) => {
                    briefTouched.current.angle = true;
                    setAngleHint(value);
                  }}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="audience">Audience, optional</label>
              <input
                id="audience"
                type="text"
                placeholder="e.g. first-time buyers in their twenties, oily skin"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
              />
            </div>
            <div className="actions">
              <button className="primary" onClick={generate} disabled={generating}>
                {generating && <span className="spin" />}
                {generating
                  ? "Generating"
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
                      <strong>{finding.ruleId}</strong>: &ldquo;{finding.evidence}
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
          src={imageSrc(result.image)!}
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
              src: imageSrc(result.image!)!,
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
              href={imageSrc(result.image)!}
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
              <strong>{finding.ruleId}</strong>: &ldquo;{finding.evidence}&rdquo;
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

