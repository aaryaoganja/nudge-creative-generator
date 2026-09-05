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
