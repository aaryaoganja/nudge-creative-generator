# nudge-creative-generator

Next.js 16 (App Router) + Postgres, packaged for Railway.

Paste a Minimalist product URL, get ad creatives sized for the Meta and Google
placements you picked. Upload any creative — ours or anyone's — and get it
scored against the brand's identity and India's advertising rules.

Both halves are real: the product is read from Shopify's own JSON, the brief and
the copy come from Gemini 3.7 Flash, the images from Nano Banana Pro, and a
deterministic policy gate runs over the copy **before** any image is paid for.

## Stack

| Piece | Choice |
| --- | --- |
| Framework | Next.js 16.3.4, App Router, `output: "standalone"` |
| Runtime | Node 22 |
| Database | Postgres via Prisma 7 with the `@prisma/adapter-pg` driver adapter |
| Build | Dockerfile (multi-stage) |
| Platform config | Railway Infrastructure as Code (`.railway/railway.ts`) |

## Local development

```bash
npm install
cp .env.example .env.local        # then set DATABASE_URL
npx prisma migrate dev            # apply migrations
npm run dev
```

Verify:

```bash
curl localhost:3000/api/health          # open, and deliberately terse when signed out
```

Everything else is behind the password gate — open http://localhost:3000 and
sign in. See **The gate** below.

## Scraper

Product data comes from Shopify's own JSON endpoints — no scraping service, no
headless browser, no API key:

```
GET /products.json?limit=250&page=N   the whole catalogue, paginated
GET /products/<handle>.js             one product
```

The CLI runs on plain Node with no build step, so the same command works
locally, in CI and inside the Railway container:

```bash
npm run scrape -- product https://beminimalist.co/products/<handle>
npm run scrape -- catalog --limit 5 --pages 1     # quick smoke test
npm run scrape -- catalog --json > catalogue.json
npm run scrape -- brand                           # fonts, colours, logo
```

**Verifying it works where it actually has to run.** A scrape that succeeds on a
laptop proves nothing about the container's egress, so run it in the deployed
environment:

```bash
railway run npm run scrape -- catalog --limit 5 --pages 1
```

Exit codes: `0` success, `1` fetch failure, `2` rejected input (not a product
URL, host not allowlisted).

### Two things the scraper gets right on purpose

**Money units differ between the endpoints.** `/products.json` returns
`"810.00"` (major units); `/products/<handle>.js` returns `81000` (minor units).
Reading the second as rupees prices the product at ₹81,000. Both are normalised
to integer minor units in `src/lib/scrape/shopify.ts` and nowhere else.

**Both product URL forms are valid.** Shopify serves a product at
`/products/<handle>` *and* at `/collections/<collection>/products/<handle>` —
the second is what people copy out of the address bar. Canonicalisation strips
`utm_*`, `fbclid` and `gclid` but **preserves `?variant=`**, because variants
carry different prices and images.

### Outbound fetch safety

Every fetch of a user-supplied URL goes through `src/lib/http/safe-fetch.ts`:
https only, DNS resolved and checked against private/loopback/link-local ranges
before connecting (169.254.169.254 is the cloud metadata endpoint), every
redirect hop re-validated, responses size-capped while streaming, and a host
allowlist from `STORE_ALLOWED_HOSTS`.

## Reading the product page

Two readers, tried in order:

1. **`src/lib/scrape/page-text.ts`**, the default. Fetches the product page
   through the same SSRF-guarded fetcher everything else uses and extracts
   readable text with no dependency, no key and no third party. A Shopify theme
   renders the ingredient blocks, the how-to-use section and the FAQ into the
   HTML the server returns, so there is nothing to render in a browser.
2. **Firecrawl**, if `FIRECRAWL_API_KEY` is set, for a storefront where that is
   not true, or when the direct read comes back empty or refused.

Both failing is a stated warning on screen, not silence. That distinction
matters more than it sounds: enrichment used to be skipped without comment
whenever no Firecrawl key was configured, so a brief asking the model to
"answer the single biggest objection" had one sentence of product description
to reason from, and the resulting offer-led creative looked like the model
ignoring the brief rather than the brief having nothing in it.

Hard product facts never come from either reader. Price, concentrations and
images come from the structured Shopify JSON, because a parsed number beats a
number recovered from prose.

## How a creative is composed

`config/brand.ts` holds three layers, and the distinction between them is the
whole reason generations stopped looking like generic skincare ads:

- `BRAND_VOICE` — what may be **said**.
- `BRAND_VISUAL` — what the creative may be **made of**: palette, typography,
  photography, and a hard list of things never to depict. Placement-independent,
  every rule true of a 1200×628 banner and a 1080×1920 story alike.
- `CREATIVE_GRAMMAR` — how the brand actually **assembles** those parts, derived
  from three banners the client is currently running. Four layout archetypes,
  five props, six graphic devices with construction rules, two CTA treatments,
  and a restraint list that caps a creative at two devices.

The third layer exists because every constraint in the first two could be
satisfied by a tasteful product shot on white that still looked nothing like the
ads on the site. The live creatives are closer to a spec sheet than a
photograph: a type stack, a cluster on white pedestals, hairline leader lines
out to small-caps labels, thin-bordered callout boxes.

Wiring matters as much as content. The brief model does not describe a layout in
prose — it **names** one, from the archetypes that can be built in the frame it
was given, and `renderImagePrompt` expands that entry plus exactly the devices
it uses into the image prompt. Archetypes declare which orientations they work
in and carry a stacked rearrangement for tall frames, so a 9:16 story is no
longer briefed as a left-right banner. `tests/grammar.test.ts` asserts the
grammar reaches the model, because the first version of it was imported by
nothing at all.

## Tests

```bash
npm test             # unit + integration, fixture-backed, no network, no key
npm run smoke        # whole pipeline offline against a stubbed transport
npm run ui:smoke     # drives the real UI in a real browser
npm run ui:contrast  # measures the contrast the browser actually painted
```

`npm test` uses Node's built-in runner against TypeScript directly — no test
framework and no transpiler. It never touches the network, so CI is
deterministic and needs no API key.

`npm run ui:smoke` needs a server running against the offline stub:

```bash
GEMINI_API_KEY=offline-smoke \
APP_PASSWORD=NUDGE \
NODE_OPTIONS="--import ./scripts/dev-stub-transport.ts" \
npx next dev -p 3000 &

BASE=http://localhost:3000 npm run ui:smoke
BASE=http://localhost:3000 npm run ui:contrast
```

It signs in first, so a broken gate fails the whole run rather than being
mistaken for a broken app. It has caught real defects on every pass so far: a
single result stretching to full container width and rendering a
thousand-pixel-tall image; blocked concepts returned by the API and dropped by
the UI; and a logo whose `onError` fallback never fired on the server-rendered
login page, because the fetch failed before React hydrated and attached the
handler.

`ui:contrast` is separate because it asks a different question. The palette
comment in `globals.css` states a ratio for every token pairing, which is a claim
about hex values — not about the page. This walks the rendered DOM across six
views, resolves each element's real backdrop through transparent ancestors, and
computes what a reader actually gets. Disabled controls are reported but not
failed, since WCAG exempts them.

## Verifying the live providers

Everything above runs offline. To confirm the request shapes are actually
accepted by Google and Firecrawl:

```bash
railway run npm run models            # what the key can see
railway run npm run verify            # free: key, text round-trip, vision, Firecrawl
railway run npm run verify -- --image # adds one real generation (~$0.134)
```

A failing check names the single file to correct.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | open | Railway probe. Always `200` while the app can render; signed-out callers get `{status, authenticated:false}` and nothing else. Postgres is reported, never fatal — no user-facing route queries it, and a `503` over an unused dependency would pull the whole UI out of rotation. |
| `POST` | `/api/generate` | gated | Product URL → brief → policy gate → one image per selected placement. `422` for a non-product URL or a body that fails the schema, `503` when no Gemini key is available from either source. |
| `POST` | `/api/score` | gated | Score any creative. `multipart/form-data` with an `image` file, or JSON with base64 `image`. `productUrl` is optional; without it product claims come back `verified: false` rather than silently passing. |
| `GET` | `/api/runs` | gated | Recent generation and scoring runs, by run id. |
| `POST` | `/api/resolve` | gated | Read a product page without generating anything. Free. |
| `POST`/`DELETE` | `/api/keys` | gated | Set or clear the per-browser Gemini key override. Never returns the key — only a four-character mask. |
| `POST` | `/api/auth/login` | open | Exchange the password for a session cookie. Rate limited per client and globally. |
| `POST` | `/api/auth/logout` | open | Drops the session **and** the key override. |

## The gate

The whole app sits behind one password, because what is behind it spends a live
API key per request. `APP_PASSWORD` sets it; unset, it falls back to `NUDGE`.

Enforcement is in `src/middleware.ts` rather than per route, so adding a route
cannot accidentally add a hole — the default is closed and the exemptions are a
four-line list. The password is never written to the cookie: the cookie carries
an expiry and a nonce signed with a key derived from the password by PBKDF2, so
rotating `APP_PASSWORD` invalidates every outstanding session. Every comparison
of a secret is constant time.

`APP_PASSWORD` is listed in `.railway/railway.ts` as `preserve()`. It has to be:
that env block is declarative, so a variable set in the dashboard but missing
from the map is liable to be dropped by `railway config apply` — at which point
the gate silently falls back to the default published in this repository.

## Bring your own key, at `/keys`

Paste a Gemini key at `/keys` and this browser spends it instead of the
deployment's. Useful for a demo, a client's quota, or an exhausted key.

The value is sealed with AES-GCM — encrypted, not merely signed — under a
subkey derived from `APP_PASSWORD`, and kept in an http-only cookie. It is never
rendered back, not in HTML, not in a prop, not in the RSC stream: the page
receives a four-character mask and a source label, and nothing that can be
turned back into a credential. Signing out drops it with the session.

Both spending routes read the key through `geminiKeyForRequest()`; a test in
`tests/runtime-key.test.ts` asserts that neither reads `config.GEMINI_API_KEY`
directly, because for a while both did — the page said the override was in
effect while every generation quietly spent the deployment's key.

## Deploying to Railway

Platform config lives in `.railway/railway.ts`, **not** `railway.json`. Config as
Code is deprecated, new services cannot opt into it, and existing files stop
being read on 2026-12-01. IaC is applied through the CLI, not at deploy time:

```bash
npm install -g @railway/cli
railway login
railway link                     # select the project + environment
railway config plan              # read-only preview
railway config apply             # applies after confirmation
```

`railway config plan` is safe: it only reads Railway state and prints the diff.

The config declares a managed Postgres and a `web` service, injects
`DATABASE_URL` from the database into the service, and sets the health check to
`/api/health`.

### Migrations

The pre-deploy migration is written down in `.railway/railway.ts` and
deliberately commented out:

```
node node_modules/prisma/build/index.js migrate deploy
```

`prisma migrate deploy` exits non-zero without a reachable `DATABASE_URL`, and a
failing pre-deploy aborts the whole deployment — so a schema that nothing
currently reads would be able to take the UI down. Restore it in the same change
that introduces the first route which actually queries Postgres.

The full path is deliberate when it is restored: Next's standalone output prunes
`node_modules` to what the app imports at runtime, and nothing imports the Prisma
CLI, so the Dockerfile copies it in explicitly.

### Secrets

`APP_PASSWORD`, `GEMINI_API_KEY` and `FIRECRAWL_API_KEY` are declared as
`preserve()` — set each once in the Railway dashboard and IaC will never
overwrite it or pull it into git.

`APP_PASSWORD` has to be in that map even though its value is not. The env block
is declarative: a variable set in the dashboard but absent from the map is
liable to be dropped by `railway config apply`, and a dropped `APP_PASSWORD`
does not fail loudly — it silently reverts the gate to the default published in
this repository.

## CI

`.github/workflows/ci.yml` runs lint, typecheck, `next build`, and a
`docker build` of the exact image Railway builds.

`.github/workflows/claude.yml` runs `anthropics/claude-code-action@v1` on
`@claude` mentions in issues, PR comments and reviews. It needs a repository
secret named `ANTHROPIC_API_KEY`.
