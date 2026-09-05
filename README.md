# nudge-creative-generator

Next.js 16 (App Router) + Postgres, packaged for Railway.

This repository is currently an **infrastructure scaffold**. The deploy path,
database wiring, migrations, health checks and CI are real and verified; the
creative-generation logic itself is a stub in
`src/app/api/generate/route.ts`.

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
curl localhost:3000/api/health
curl -X POST localhost:3000/api/generate \
  -H 'content-type: application/json' \
  -d '{"prompt":"win back lapsed users","channel":"push"}'
```

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

## Tests

```bash
npm test          # unit + integration, fixture-backed, no network, no key
npm run smoke     # whole pipeline offline against a stubbed transport
npm run ui:smoke  # drives the real UI in a real browser
```

`npm test` uses Node's built-in runner against TypeScript directly — no test
framework and no transpiler. It never touches the network, so CI is
deterministic and needs no API key.

`npm run ui:smoke` needs a server running against the offline stub:

```bash
GEMINI_API_KEY=offline-smoke \
NODE_OPTIONS="--import ./scripts/dev-stub-transport.ts" \
npx next dev -p 3000 &

BASE=http://localhost:3000 npm run ui:smoke
```

It caught two real defects on its first run — a single result stretching to full
container width and rendering a thousand-pixel-tall image, and blocked concepts
being returned by the API but dropped by the UI.

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

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Railway health probe. `200` when Postgres answers `SELECT 1`, `503` otherwise. |
| `GET` | `/api/generate` | 50 most recent creatives. |
| `POST` | `/api/generate` | Create one. `422` on invalid body. Generation is stubbed. |

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

`.railway/railway.ts` sets a pre-deploy command:

```
node node_modules/prisma/build/index.js migrate deploy
```

It runs after the build and before traffic shifts, so a failed migration aborts
the deploy instead of serving a broken app. The full path is deliberate: Next's
standalone output prunes `node_modules` to what the app imports at runtime, and
nothing imports the Prisma CLI, so the Dockerfile copies it in explicitly.

### Secrets

`ANTHROPIC_API_KEY` is declared as `preserve()` — set it once in the Railway
dashboard and IaC will never overwrite it or pull it into git.

## CI

`.github/workflows/ci.yml` runs lint, typecheck, `next build`, and a
`docker build` of the exact image Railway builds.

`.github/workflows/claude.yml` runs `anthropics/claude-code-action@v1` on
`@claude` mentions in issues, PR comments and reviews. It needs a repository
secret named `ANTHROPIC_API_KEY`.
