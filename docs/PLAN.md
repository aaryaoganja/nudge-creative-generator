# Build Plan — Gemini-only stack

Companion to `docs/ARCHITECTURE.md`, which holds the decisions. This holds the
sequence, the UI surface, and the numbers.

---

## 1. Cost reality, and why it reorders everything

Verified rates:

| Item | Rate |
|---|---|
| `gemini-3.7-flash` input | $0.75 / MTok (intro, to 31 Dec 2026; $1.50 after) |
| `gemini-3.7-flash` output | $3.75 / MTok (intro; $7.50 after) |
| `gemini-3-pro-image` (Nano Banana Pro) | **~$0.134 per image** |

Worked per-run cost:

| Stage | Tokens / count | Cost |
|---|---|---|
| Brief + copy | ~3.5K in, ~1.2K out | $0.007 |
| Score one creative | ~4.5K in (incl. image), ~700 out | $0.006 |
| **Generate one image** | — | **$0.134** |

| Run shape | Cost |
|---|---|
| 2 concepts, square only | **$0.29** |
| 3 concepts × 3 aspect families | **$1.27** |

**Image generation is ~95% of run cost.** Four consequences, all of which change
what gets built first:

1. **Deriving beats generating.** Every placement produced by crop/resize from
   an existing generation saves $0.134. This is no longer an optimisation; it is
   the primary cost lever, and it is why `planGenerations()` already exists.
2. **Confirm-before-spend is mandatory, not polish.** A wrong scrape that
   produces nine images costs $1.27 and a redo.
3. **Default concept count is 2, not 5.**
4. **The per-job budget guard protects real money**, not a hypothetical.

---

## 2. The pipeline — a fixed DAG, no agent

| # | Stage | Does | Latency | Cost | Status |
|---|---|---|---|---|---|
| 1 | `resolve` | URL → verify → Shopify `.js` → snapshot | ~0.5 s | $0 | **built** |
| 2 | `confirm` | Human checks facts, picks reference image | — | $0 | UI |
| 3 | `brief` | Snapshot + brand config → creative brief + copy | ~3 s | $0.007 | to build |
| 4 | `copy-gate` | Policy/lexicon regex over generated copy | ~10 ms | $0 | to build |
| 5 | `imagine` | Brief → image prompt per concept | — | in 3 | to build |
| 6 | `generate` | Prompt + reference image → Nano Banana Pro | 3–5 s | $0.134 ea | to build |
| 7 | `compose` | Exact pixels, file caps, per-placement crop | ~0.3 s | $0 | to build |
| 8 | `verify` | Deterministic checks + bounded repair | ~50 ms | $0 | to build |
| 9 | `score` | Vision + rubric | ~4 s | $0.006 ea | to build |
| 10 | `deliver` | Store, present, export | — | $0 | to build |

Stage 4 sits **before** any image spend. That placement is the point: catching a
banned claim in text costs nothing; catching it after nine generations costs
$1.27.

---

## 3. The one risk the Gemini-only stack creates

`gemini-3.7-flash` both writes the copy and scores the creative. **The judge
shares the generator's blind spots.** If the generator is disposed to think a
borderline claim reads fine, so is the judge, and the score will not catch it.

Mitigations, in order of how much they actually help:

1. **Deterministic layers carry the weight.** Layer 1 (dimensions, contrast,
   safe zones, file size) and layer 3 (banned-phrase lexicon) are pure
   functions. They are model-independent and therefore immune to this. Weight
   them accordingly and let hard gates sit entirely in layer 3.
2. **The golden set matters more, not less.** It is the only external check on a
   self-consistent loop.
3. **Judge on a different model tier than you generate on** where one is
   available — not independence, but not literally the same weights either.
4. The provider seam means a second-opinion judge is config, not code, if a
   second key ever appears.

---

## 4. The UI — what we ask, and when

Design rule throughout: **ask for one thing, prove we understood it, then ask
for the rest.** And never spend money before the human has confirmed the facts.

### Step 1 — One field

Product URL. Nothing else on screen. The URL determines most of what we need.

### Step 2 — Confirmation card (~0.5 s, $0)

Appears as soon as the scrape returns. This is the money-guard: everything after
it spends.

```
  Hair Growth + Anti-Grey 15.6% Hair Serum
  ₹810   was ₹899   −10%
  Hair Care · 6 images

  ⚠ Claim-bearing values detected:  15.6%
     These will be printed exactly as shown and cannot be model-authored.

  Reference image:  [1] [2] [3] [4] [5] [6]   ← pick, default [1]
  Not right?  ⬆ Upload your own packshot
```

Surfacing concentrations explicitly is deliberate — they are the regulated
numbers, and the marketer should see what will be printed before it is printed.

### Step 3 — The brief

**Required**

| Field | Control | Why |
|---|---|---|
| Placements | Multi-select chips + custom W×H | Drives generation count directly |
| Objective | Awareness / Consideration / Conversion / Retargeting | Materially changes copy strategy |
| Concepts | 1–5, **default 2** | Direct cost multiplier |

Live cost readout beside the button, so spend is visible before commit:

```
  3 placements → 2 generations × 2 concepts = 4 images
  Estimated:  ₹48   (~$0.55)              [ Generate ]
```

**Optional**

| Field | Notes |
|---|---|
| Offer / promo | "20% off", "Buy 2 Get 1" — printed exactly, never paraphrased |
| Angle hint | "monsoon hair fall", "lead with anti-grey" |
| Audience | Free text or preset |
| Reference ad | Upload a past creative to match style |

### Step 4 — Generation (streaming)

Stage-by-stage progress. Concepts appear as they land rather than all at the
end, each with its score badge attached.

### Step 5 — Review, per creative

Preview · score breakdown by dimension · findings with severity and suggested
fix · **verdict badge separate from the number** · actions: regenerate this
concept, edit copy, download.

### Step 6 — Scorer, standalone

Its own entry point, as specified: upload a creative → choose placement and
rubric → score, findings, verdict. Works on creatives this tool never made.

---

## 5. What is pre-populated

Seeded as versioned `config` rows, reviewed before activation — not hardcoded,
not asked of the user:

| Row | Contents |
|---|---|
| `brand_voice` | Transparency-first, education-led, clinical register, no fear-marketing, no celebrity endorsement, concentrations stated plainly |
| `policy` | ASCI substantiation requirement; Drugs & Cosmetics Rules (no cure/treat-disease claims); banned phrase list; competitor brand or foreign logo ⇒ **blocked**; HUL-tier claim governance |
| `rubric` | Dimensions, weights, anchored score-band descriptions |
| `format_spec` | Placement matrix: exact pixels, file-size caps, safe zones, min font size |
| `prompt` | Brief template, image-prompt template, scoring template |

---

## 6. Build order

**Phase 0 — prove the chain (~$0.15, one sitting)**

```bash
railway run npm run models     # confirm both model IDs against the real key
railway run npm run try -- <product-url>
```

`try` does the whole thing once, end to end, to disk: real product → brief →
image prompt → **one** image → save. One image, $0.134. Smallest thing that
proves every integration at once, before any schema work.

**Phase 1** — schema: replace `Creative`; add `product_snapshot`, `asset`,
`ad_spec`, `render`, `format_spec`, `generation_job`, `score`, `cost_event`,
`config`. Seed the config rows.

**Phase 2** — pipeline as a module: stages 3–8, pure functions, no route
dependency.

**Phase 3** — SSE route + UI (steps 1–5 above).

**Phase 4** — scorer layers 1–3, then 4; standalone upload endpoint.

**Phase 5** — pg-boss and a worker service, when concurrency or durability
demands it.

### Revision: the queue moves later

`ARCHITECTURE.md` §3 argued for a separate worker from day one. For a
single-user internal tool, an SSE route running the pipeline inline is adequate
for v0 and materially faster to build. The condition that makes this safe to
defer is unchanged from the renderer argument: **the pipeline must be a module
with no route dependencies**, so moving it behind pg-boss later is a call-site
change rather than a rewrite.

---

## 7. Open decisions

1. **Placements for v0** — which actually matter first? Every extra aspect
   family is +$0.134 per concept.
2. **Path A vs B** — Nano Banana Pro claims best-in-class text rendering. Rather
   than a formal bake-off, build path A (model renders everything), generate
   10–15 real creatives, and inspect whether concentrations and prices come out
   exactly right. ~$2 to find out, and it avoids building the deterministic type
   layer speculatively. Add B only if A misses.
3. **Confirm step** — keep it, or is it friction? Recommendation: keep. It is
   the only thing standing between a bad scrape and $1.27 of wrong images.
4. **Concept default** — 2 proposed.
