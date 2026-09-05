# Architecture Decision Record — Minimalist Ad Generator

Status: **proposed**, awaiting sign-off.
Scope: infrastructure and data model only. Creative strategy, prompt design and
the rubric contents are deliberately out of scope and land in later iterations.

---

## 0. The decision that actually matters

Infrastructure is not the risky part of this project. Railway, Postgres, Node vs
Python, queue library — all of it is recoverable. Pick wrong, spend a week,
recover.

There is exactly one decision here that is not recoverable, and it is upstream of
every infrastructure choice:

> **Is a generated ad an image, or is it a data structure that renders to images?**

Everything below follows from answering **data structure**. If you answer
"image" — one prompt into a generative image model, PNG out — then no
infrastructure saves the product, for reasons set out in §1.

---

## 1. Generation strategy

### The three options

| | A. Pure generative | B. Pure deterministic | C. Hybrid (**recommended**) |
|---|---|---|---|
| How | prompt → image model → PNG | LLM emits typed spec → HTML/CSS template → Chromium → PNG | LLM emits typed spec; generative model produces **background/scene only**; renderer composites real product cutout + all text |
| Text fidelity | Unreliable at pixel level | Exact | Exact |
| Product fidelity | Hallucinated packaging | Exact (real PDP photo) | Exact (real PDP photo) |
| Brand colour / logo / safe zones | No control | Exact | Exact |
| Editable after generation | No — regenerate, new random image | Yes — patch a field, re-render | Yes |
| New format (e.g. 300×600) | Full regeneration | Re-render from same spec, ~200 ms | Re-render from same spec |
| Cost per variant | $0.03–0.15 | ~$0 | $0.03–0.15 once, then ~$0 per format |
| Latency per variant | 5–20 s | 0.15–0.4 s | 5–20 s once, then 0.15–0.4 s |
| Scorer can inspect | Pixels only | Pixels **and** structured spec | Pixels **and** structured spec |
| Design ceiling | High | Bounded by template library | High |
| Build cost | Lowest | Medium (template library) | Medium-high |

### Why pure generative is disqualified, specifically for this brand

Minimalist's entire positioning is **stated ingredient concentrations** —
"Salicylic Acid 2%", "Niacinamide 10% + Zinc 1%". That is regulated claim
copy. A generative model that renders `Niacimanide 1O%` has not produced a
slightly flawed creative; it has produced a compliance incident. The same model
will cheerfully redraw the bottle with a different label, different cap, different
dropper.

Secondary but fatal: a marketer who wants "20% OFF" changed to "25% OFF" gets an
entirely different image back, and the approval cycle restarts. That single
workflow fact kills adoption regardless of output quality.

### Decision

**Adopt C.** The ad is an `AdSpec` — a versioned, schema-validated JSON document.
Images are *render targets* of that spec, not the thing itself. The generative
model is confined to the one job it is genuinely good at and where errors are
harmless: producing a background scene. Text, logo, CTA, price, legal line and
product photo are composited deterministically.

This single choice is what makes every stated requirement cheap:

- *"extensible across formats"* → new format is a config row + template variant, re-render existing specs
- *"minimal latency"* → re-renders are ~200 ms, not a model call
- *"usable for placement"* → exact pixel dimensions and file caps are enforceable
- *"quality scorer"* → the scorer reads structured fields, not just pixels, and can emit a machine-applicable fix
- *"store past analysis for self-improvement"* → specs are diffable and joinable to outcomes; images are not

---

## 2. Language and runtime

### Decision: **TypeScript on Node 22, everywhere.** Keep the existing scaffold.

Python is the reflexive choice for anything with "vision model" in it. It is
wrong here.

**For TypeScript**

- Every heavy ML operation in this system is an HTTP call to a hosted model. We
  are an orchestrator, not a trainer. Python's ML ecosystem advantage is
  irrelevant to callers of `POST /v1/messages`.
- The rendering path — HTML/CSS → Chromium, or Satori → SVG — is JS-native.
  Doing this from Python means shelling out to Node anyway.
- The marketer-facing editor is React. One language means the `AdSpec` **Zod
  schema is literally the same object** in the database, the API handler, the
  renderer and the browser editor. One source of truth for the most important
  type in the system. This compounds.
- Already scaffolded, already deploying, already has CI.

**Against TypeScript (honest)**

- Image manipulation libraries are thinner than PIL/OpenCV. Mitigated: `sharp`
  covers resize/composite/format/colour, and background removal is a hosted API
  call.
- Eval/experiment tooling is more mature in Python.

**Carve-out.** If real local ML becomes necessary — a LoRA fine-tuned on
Minimalist packaging, local SDXL, in-house CLIP embeddings — that becomes a
**separate Railway service in Python behind an HTTP boundary**, not a rewrite.
Postgres is the contract between the two. Design for that seam now; do not build
it now.

---

## 3. Topology on Railway

```
                    ┌──────────────────────────────────────┐
   marketer ──────► │  web        (Next.js 16, API + UI)   │
                    │             SSE progress stream       │
                    └───┬──────────────────────────┬───────┘
                        │ enqueue (pg-boss)        │ read
                        ▼                          ▼
                    ┌───────────────┐        ┌──────────────┐
                    │  worker       │◄──────►│  Postgres    │
                    │  pipeline     │        │  + pgvector  │
                    └───┬───────┬───┘        └──────────────┘
                        │       │
              render    │       │  fetch / LLM / image-gen
                        ▼       ▼
                 ┌────────────┐   ┌─────────────────────────┐
                 │ renderer   │   │ external: Anthropic,    │
                 │ Playwright │   │ image model, bg-removal │
                 │ page pool  │   └─────────────────────────┘
                 └─────┬──────┘
                       ▼
                 ┌────────────────────┐
                 │ Object storage     │
                 │ (R2 / S3-compat)   │
                 └────────────────────┘
```

Four Railway services: `web`, `worker`, `renderer`, `postgres`.

### Why `renderer` is split out

| For splitting | Against splitting |
|---|---|
| Chromium's memory profile (~150 MB per page, spiky) is nothing like the API's; independent scaling | A 4th service to deploy, monitor, pay for |
| Keeps the `web` image small → fast cold starts and fast deploys | Extra network hop, ~5–15 ms |
| A renderer OOM does not take down the API | More moving parts before first revenue |
| Renderer is stateless and horizontally scalable — the one thing that will need to scale first | |

Judgment call, not gospel. The cheap fallback: start with the renderer
**in-process inside `worker`** behind an interface (`Renderer.render(spec,
format)`). Splitting it out later is a deploy config change, because the
interface already forces the boundary. Merging two services is easy; untangling
one is not — so the interface is mandatory, the separate service is optional.

### Why `worker` is split from `web`

Non-negotiable. Generation takes 20–60 s. Running that inside a request handler
on the same service that serves the UI means one busy generation degrades page
loads, and a deploy mid-generation kills in-flight jobs. Separate service, separate
scaling, graceful shutdown that drains jobs.

---

## 4. Queue: pg-boss on the existing Postgres

**Not** Redis + BullMQ. Not on day one.

| | pg-boss (Postgres) | BullMQ (Redis) | Cloud queue (SQS etc.) |
|---|---|---|---|
| Extra infrastructure | **None** | Redis service | Vendor + IAM |
| Transactional with app data | **Yes** — enqueue in the same tx that writes the job row | No — dual-write, can drift | No |
| Throughput ceiling | ~1k jobs/s | ~50k jobs/s | Very high |
| Job history / audit | **In your DB, joinable, queryable in SQL** | Ephemeral | External |
| Operational burden | Zero extra | Redis memory, eviction policy, persistence config | IAM, region |

At this workload — tens to low thousands of generations per day — Postgres
`SELECT … FOR UPDATE SKIP LOCKED` is comfortably sufficient, and the
transactional-enqueue property is a genuine correctness win: no orphaned jobs, no
jobs enqueued for rows that rolled back.

Revisit if sustained throughput exceeds ~500 jobs/s, or when you need cross-instance
rate limiting and reach for Redis for that anyway.

---

## 5. Storage

### Postgres for metadata. Object storage for bytes. **Never Railway volumes for creatives.**

Railway volumes attach to a single service instance, block horizontal scaling,
are not CDN-fronted, and back up poorly. They are for caches and scratch, not
deliverables.

| | Cloudflare R2 (**recommended**) | AWS S3 | Railway volume |
|---|---|---|---|
| Egress cost | **$0** | ~$0.09/GB | n/a |
| API | S3-compatible (`@aws-sdk/client-s3` unchanged) | Native | Filesystem |
| CDN | Built in | Needs CloudFront | None |
| Horizontal scaling | Yes | Yes | **No** |
| Extra vendor | Yes | Yes | No |

Egress is the deciding factor. Marketers download creatives in bulk, the scorer
re-fetches images, and the UI renders thumbnail grids. R2's zero egress removes
an entire cost variable. Migration risk is near zero because the API is
S3-compatible — put it behind a `Storage` interface and the swap is a config
change.

**Content-addressed keys.** Storage key = `sha256(bytes)`. Identical renders
dedupe for free, cache invalidation becomes trivial, and re-rendering an unchanged
spec costs nothing.

---

## 6. Data model

### The rule for relational vs JSONB

- **Relational columns** for anything you filter, join, sort, aggregate or
  constrain: ids, foreign keys, status, timestamps, scores, format, version
  pointers.
- **JSONB** for payloads whose shape changes weekly: ad spec content, rubric
  definition, findings arrays, raw scrape.
- **Never a foreign key inside JSONB.** `content->>'product_id'` cannot be
  constrained, cannot be indexed usefully by the planner, and will rot.
- GIN indexes only on JSONB columns you actually query into.

### Core tables

```
brand                 one row per brand; owned domains (scoping + SSRF allowlist)
brand_profile      ▲  VERSIONED. tone, voice, lexicon, banned claims, colour
                      tokens, fonts, logo asset ids, legal lines, locale.
                      Note: beminimalist.co and global.beminimalist.co are
                      separate storefronts → separate profiles, separate currency.

product               one row per canonicalised PDP URL
product_snapshot      VERSIONED scrape. name, price, currency, concentrations,
                      ingredients, claims[], image asset ids, html_hash,
                      fetched_at. Prices change; the ad was made against ₹599.

asset                 EVERY image byte. content-addressed.
                      kind: source_photo | cutout | background | render | upload
                      sha256, storage_key, w, h, mime, bytes, exif_stripped

ad_spec            ★  THE central object. IMMUTABLE.
                      schema_version, content JSONB (Zod-validated),
                      parent_id (edit history + variant tree),
                      product_snapshot_id, brand_profile_id,
                      prompt_template_id, model, seed
                      → edits create a new revision, never an UPDATE

render                (ad_spec_id, format_id, asset_id, renderer_version)
                      one spec → many renders

format_spec        ▲  CONFIG-AS-DATA. w, h, max_bytes, mime, safe_zones,
                      min_font_px, platform, placement
                      → new ad format = INSERT, not a deploy

generation_job        state machine, input, PINNED config version ids,
                      per-stage timings, token/image cost, error

rubric             ▲  VERSIONED. dimensions, weights, anchored score-band
                      descriptions, hard-gate rules
policy_rule        ▲  VERSIONED. banned phrases, required disclaimers,
                      substantiation requirements
prompt_template    ▲  VERSIONED.

score                 (target render_id | asset_id, rubric_version_id, model,
                      overall, dimensions JSONB, findings JSONB[], verdict,
                      latency_ms, cost)

feedback           ◆  accepted | rejected | edited_then_shipped, by whom,
                      edit diff; later: platform CTR / CPA / spend joined by a
                      creative_id stamped into filename + export manifest
```

▲ = versioned config, immutable rows, `status` pointer flip to activate.
★ = the object the whole system exists to produce.
◆ = the only ground truth.

### Why config is versioned rows and not env vars or code constants

The requirement is "runtime configurability" **and** "store past analysis for
self-improvement". Those are the same requirement, and versioning is what joins
them:

1. Every job and every score **pins the exact config version ids it used**. Six
   weeks later, when average scores drift, you can answer *what changed*.
   Without version pins you cannot, and the self-improvement loop is decoration.
2. Rollback is a pointer flip, not a redeploy.
3. You can A/B two rubric versions against live traffic.

Cache the active config in-process with a 30–60 s TTL plus a Postgres
`LISTEN/NOTIFY` bust, so config reads cost nothing per request.

### pgvector: enable on day one, use later

`CREATE EXTENSION vector` costs nothing now. You will want it for:

- retrieving *"specs that scored 90+ for a similar product"* as few-shot exemplars
- near-duplicate creative detection
- retrieval over historical findings

Enabling it later is trivial; **designing the tables as though it exists** is
free today and awkward to retrofit.

### On the current scaffold's schema

`Creative { prompt, channel: email|push|sms|in_app, body: String }` models
**text nudges**, not visual ads. It is the wrong shape for this product and
should be replaced wholesale, not extended. Everything else in the scaffold —
Dockerfile, Railway IaC, health check, migration wiring, CI — is sound and stays.

---

## 7. Fetching the product page

### Tiered, cheapest-first

1. **Shopify JSON endpoint.** The site's `/collections/`, `/products/`,
   `/blogs/`, `/pages/` taxonomy is conclusive for Shopify. Appending `.js` to a
   product URL returns a structured product object — title, variants, price,
   images, body_html — with no HTML parsing and no browser. This is ~10× faster
   and ~100× more reliable than scraping. *Confidence: high on the URL taxonomy;
   the endpoint itself was not reachable from the build sandbox (egress-blocked),
   so verify once by hand before relying on it.*
2. **JSON-LD `Product` / OpenGraph / microdata** from the fetched HTML.
3. **Headless Chromium (Playwright)** — fallback only, for JS-rendered pages.
4. **LLM normalisation pass** (Haiku-class) over the cleaned text to map into the
   product schema and extract claims and concentrations.

Cache by `(canonical_url, html_hash)`. Second generation for the same product
skips the whole tier stack.

### The fetcher is a hostile-input surface

A user-supplied URL that the server fetches is textbook SSRF. Required, not
optional:

- `https` scheme only
- resolve DNS **first**, reject RFC1918, loopback, link-local (`169.254.0.0/16` —
  cloud metadata), and the IPv6 equivalents
- **re-validate at every redirect hop**, not just the first URL
- response size cap, connect and total timeouts
- fetch from the `worker`, never from a request handler
- **domain allowlist** scoped to `brand.owned_domains`. This is an internal tool
  for one brand; the allowlist is both the security control and a
  product-correctness control.

---

## 8. Rendering

| | Satori → SVG → resvg | **Playwright + Chromium (recommended)** | Skia (`@napi-rs/canvas`) |
|---|---|---|---|
| Speed (warm) | 50–150 ms | 150–400 ms | 30–100 ms |
| CSS support | **Subset** — no grid, limited filters, no blend modes | Everything | n/a — imperative draw calls |
| Web fonts | Manual | Native | Manual |
| Container weight | Light | **+~400 MB** | Light |
| Memory | Low | ~150 MB/page | Low |
| Cold start | Fast | **1–3 s** | Fast |
| Design iteration | Constrained | A designer can hand you CSS | Painful |

Chromium wins because the constraint that matters is **design ceiling**, not
milliseconds. 200 ms versus 100 ms is invisible next to a 20 s image-generation
call; "you cannot use blend modes or CSS grid" is a permanent tax on every
creative the tool will ever produce.

Requirements: warm page pool (3–5), fonts baked into the image (never fetched at
render time — non-determinism and a network dependency in the hot path),
`--font-render-hinting=none` for reproducibility, and `renderer_version` pinned
on every `render` row so visual regressions are detectable.

---

## 9. Latency

### Honest budget, cold path

| Stage | Time |
|---|---|
| PDP fetch + parse (JSON endpoint) | 0.3–1 s |
| PDP fetch + parse (headless fallback) | 5–15 s |
| Copy + creative direction (Sonnet-class) | 2–6 s |
| Background generation, per image | 4–15 s |
| Background removal on product photo | 1–3 s |
| Render one format (warm Chromium) | 0.15–0.4 s |
| Vision scoring, per creative | 3–8 s |
| **Full set: 3 concepts × 8 formats** | **20–60 s** |

That cannot live in one HTTP request. Hence async jobs.

### The levers that actually reduce it — in order of impact

1. **Progressive delivery.** Stream the spec to the UI the moment copy lands
   (~4 s), render an immediate preview against a template background, backfill the
   generated hero. Perceived latency: **45 s → ~4 s.** This is the single largest
   win and it is a UX decision, not an infrastructure one.
2. **Two tiers.** *Instant* = deterministic template + PDP data + cached cutout,
   zero generative image calls, **2–4 s to a usable ad**. *Crafted* = adds
   generated backgrounds. Marketers get something immediately, always.
3. **Cache the cutout.** Background removal is content-addressed by source image
   hash. One product, 40 variants, **one** cutout. Enormous.
4. **Parallelise.** Copy and backgrounds are independent — run concurrently.
   All N formats render concurrently against the page pool.
5. **Prompt caching** on the brand profile + rubric + exemplar block. Large,
   stable, sent on every call — cache it. Real savings in both cost and TTFT.
6. Only then worry about queue latency, which is ~1 ms and irrelevant.

---

## 10. API shape

REST + JSON, versioned, async-first. OpenAPI generated from the Zod schemas
(`zod-to-openapi`) so the contract cannot drift from the validators.

```
POST   /api/v1/products:resolve      { url } → product snapshot (cached, fast)
POST   /api/v1/generations           → 202 + job id
GET    /api/v1/generations/:id       → status + partial results
GET    /api/v1/generations/:id/events→ SSE progress stream
PATCH  /api/v1/ad-specs/:id          → new revision (never mutates)
POST   /api/v1/ad-specs/:id/renders  → render N formats
POST   /api/v1/assets                → upload (product photo or creative)
POST   /api/v1/scores                → score a render OR an upload
POST   /api/v1/exports               → ZIP + manifest
GET    /api/v1/config/*              → brand profile, rubric, formats
PUT    /api/v1/config/*              → new config version
```

**SSE, not WebSockets.** Progress is one-directional, SSE traverses Railway's
proxy without special handling, reconnects natively with `Last-Event-ID`, and
needs no extra infrastructure. WebSockets buy nothing here and cost sticky
sessions.

**Idempotency keys on every POST.** A retried generation must not burn a second
round of image-model spend. This is real money and a real bug, not hygiene.

**REST, not tRPC, for the public contract.** tRPC is genuinely pleasant given
TypeScript on both ends, but it makes the API awkward to call from n8n, a Python
script, or an agency's tooling — all of which will happen. Use tRPC *internally*
for the app's own UI over the same service layer if you want; keep the external
contract REST.

---

## 11. The scorer

`POST /api/v1/scores` accepts a `render_id`, an `asset_id` from an upload, or a
multipart file. Optional `rubric_version` (defaults to active), `placement`, and
`context`.

### Layered, cheapest-and-most-certain first

| Layer | What | Cost | Latency | Reliability |
|---|---|---|---|---|
| 1. Deterministic | exact dimensions vs `format_spec`, file size vs cap, aspect ratio, text-area ratio, min font px, WCAG contrast, logo presence + safe zone, ΔE colour deviation from brand tokens | free | 10–50 ms | **100 %** |
| 2. Text extraction | for a render, copy is **known exactly from the spec** — zero OCR error; for an upload, OCR | ~free | 0–500 ms | high |
| 3. Rule / lexicon | banned claims, missing disclaimers, superlatives, competitor mentions, substantiation requirements — regex + phrase lists from versioned `policy_rule` | free | <10 ms | **100 %, auditable** |
| 4. Vision judgment | brand tone match, visual hierarchy, product-as-hero, copy–image coherence, aesthetic quality, scroll-stopping power — Sonnet-class vision, **structured output only** | ~$0.01 | 3–8 s | noisy |
| 5. Aggregation | weighted rubric → 0–100, **plus independent hard gates** | free | <1 ms | — |

**Never ask an LLM what 1080 × 1080 is.** Layers 1 and 3 are pure functions, and
being deterministic makes them defensible to legal in a way a model score never
is.

### Score and verdict are separate fields

A policy violation must not be averaged away by a beautiful picture. Return
`verdict: pass | fix_required | blocked` independently of the numeric score. A
creative with a banned claim is **`blocked` at score 88**.

### Every finding is actionable and typed

```ts
{
  dimension, severity, evidence,          // what and where (bbox when visual)
  suggested_fix,                          // human-readable
  auto_fixable: boolean,
  spec_patch?: JsonPatch                  // ← the payoff of spec-first design
}
```

For a creative we generated, `spec_patch` means "Apply fix" mutates the spec and
re-renders in ~300 ms. For an upload we can only advise. **That asymmetry is a
feature** — it pulls marketers toward generating in-tool rather than scoring
elsewhere.

### LLM judges are noisy — mitigate explicitly

- temperature 0, structured output via tool use
- rubric with **anchored descriptions per score band**, not bare adjectives
- few-shot exemplars retrieved from past human-labelled scores (pgvector)
- **a golden set of ~50 human-scored creatives, re-run on every rubric or prompt
  change.** Without it you cannot tell whether a rubric edit made scoring better
  or worse, and every "improvement" is superstition.

---

## 12. Output: "usable for placement"

This is where tools like this usually fail. A folder of PNGs is not a
deliverable.

**Required in the export:**

- Exact platform sizes as `format_spec` rows — Meta feed 1:1 and 4:5,
  Stories/Reels 9:16, Google Display's IAB set (300×250, 336×280, 728×90,
  300×600, 160×600, 320×50, 970×250), responsive display assets (1.91:1, 1:1,
  logo 1:1 and 4:1). *Verify current numbers against each platform's live spec
  sheet before seeding — platform specs churn, which is precisely why they are
  config rows and not constants.*
- File-size and MIME constraints enforced at render, not discovered at upload.
- Consistent naming: `{product}_{concept}_{format}_{v}.jpg`
- **A CSV/XLSX manifest** mapping every file to headline, primary text,
  description, CTA type, destination URL and UTM parameters.

The manifest is the part that makes it usable. Meta Ads Manager and Google Ads
Editor take bulk uploads with text fields; without the manifest the marketer
retypes copy for every creative and the tool has saved nothing.

**Design the export layer as an interface now** — `Exporter` with a `zip`
implementation today, `meta_marketing_api` and `google_ads_asset_library` later.
That keeps direct-push out of the v1 scope without making it a rewrite.

---

## 13. LLM orchestration

**No LangChain.** For a handful of well-defined typed calls it adds indirection,
version churn and debugging pain for no benefit. Write a ~200-line `llm/` module:
provider client, retry with jitter, timeout, token and cost accounting,
structured-output helper via tool use, `PromptTemplate` loaded from the versioned
config table.

Routing:

| Job | Model class |
|---|---|
| Concept ideation (only if quality demands) | Opus-class |
| Copy generation, creative direction | **Sonnet-class** |
| Vision scoring | **Sonnet-class, vision, structured output** |
| PDP normalisation, claim tagging | Haiku-class |
| Background / scene generation | **Behind an `ImageProvider` interface** |

Image generation is the one genuinely open call. Candidates span Google's Gemini
image models, OpenAI's image model, Ideogram (strongest text rendering, though we
are not relying on it for text) and Flux via fal.ai or Replicate. **Benchmark on
actual Minimalist product photos before committing, and never hardcode a
vendor** — capability and pricing in this category move monthly.

---

## 14. Cost

Per full generation set (1 product, 3 concepts, 8 formats):

| Item | Cost |
|---|---|
| Copy + direction | ~$0.02 |
| 3 generated backgrounds | $0.10–0.30 |
| Background removal | ~$0.01 |
| 24 renders | ~$0 |
| Scoring 8 creatives | ~$0.08 |
| **Total** | **$0.20–0.50** |

Infrastructure at low volume: `web` $5–10, `worker` $5, `renderer` $10–20
(memory-bound), Postgres $5–20 → **~$30–60/month**.

This is cheap. Do not spend engineering time optimising it. Spend it on output
quality and on the feedback loop.

---

## 15. Explicitly rejected

| Rejected | Because |
|---|---|
| Prompt → image, no spec | Text and product fidelity; non-editable; no structured record. §1 |
| Python rewrite | No local ML; renderer is JS-native; loses the shared Zod schema |
| MongoDB / document DB for specs | JSONB covers it, and the job/score/feedback graph needs relational integrity |
| Redis on day one | pg-boss on existing Postgres; transactional enqueue is a correctness win |
| Railway volumes for creatives | Single-instance, no CDN, blocks horizontal scaling |
| LangChain | Indirection and churn for no benefit at this call count |
| Unstructured LLM score output | Unparseable, undiffable, untrackable |
| Skipping the `feedback` table | Then "self-improvement" is the LLM grading its own homework |
| Formats hardcoded in code | Every new placement becomes a deploy |
| tRPC as the external contract | Blocks n8n / Python / agency integration |

---

## 16. Build order

1. **Replace the `Creative` schema** with the model in §6. `asset`, `product`,
   `product_snapshot`, `ad_spec`, `render`, `format_spec`, `generation_job`,
   `score`, `feedback`, versioned config tables. Enable `pgvector`.
2. **Storage + Zod `AdSpec` v1.** Content-addressed R2 behind a `Storage`
   interface. The `AdSpec` schema is the most important artifact in the repo —
   spend real time on it.
3. **Renderer**: 2–3 templates, one format, Playwright page pool. Prove
   spec → pixel-exact PNG end to end before anything touches a model.
4. **Fetcher**: Shopify JSON tier + SSRF guard + snapshot caching.
5. **Generation pipeline**: pg-boss worker, LLM copy → spec, instant tier only.
   No generative images yet.
6. **SSE + UI**: paste URL → watch spec stream in → preview.
7. **Scorer layers 1–3** (deterministic + rules). Fully useful before any vision
   model is involved.
8. **Scorer layer 4** (vision) + golden set.
9. **Generative backgrounds** behind `ImageProvider`; crafted tier.
10. **Export**: ZIP + manifest.
11. **Feedback capture**, then platform-performance join.

Steps 1–7 deliver a genuinely useful tool with zero generative image spend and
almost no latency risk. That ordering is deliberate: it front-loads the parts
that are certain to work and defers the parts that are certain to need iteration.
