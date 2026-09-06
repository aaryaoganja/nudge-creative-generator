<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Working on Ad Studio

Read the README first for what the product does. This file is about how to
change it without breaking the things that matter.

## The one rule

**The model is never trusted with a number.**

Concentrations and prices are printed on this brand's packaging and are
regulated claims in India. Every figure in a creative comes from the product
data or from an offer a human typed, and a pure function verifies that after
the fact. If you are adding a feature that lets a number reach copy, it has to
go through the claim gate. There is no version of this that is fine because the
prompt asks nicely.

The related habit: any instruction to a model that must not fail is also
enforced deterministically. The prompt says what we want; the code makes sure
we got it.

## Things that look like bugs and are not

**Nothing fails hard when a dependency is missing.** No database, no API key,
an unreachable storefront: the app boots, does what it still can, and says on
screen what is degraded. Do not "fix" this by throwing at startup. A health
check that fails over an optional dependency takes a working deployment out of
rotation.

**Errors are reported, not swallowed, and reported in the interface.** The
worst class of bug this project has had is silent degradation: page enrichment
that returned "no page, no warning", a `durable` flag derived from whether a
connection string was set rather than from where the data came from, a key
override page that said it was in effect while both spending routes read the
deployment's key. All three looked fine and were not. If you catch something,
either it reaches the user or you can explain why it does not.

**The server runs migrations at boot.** `src/instrumentation.ts` calls into
`src/lib/migrate.ts`, which applies pending migrations when it finds the history
tables absent. This is normally bad practice and it is deliberate here. The
pre-deploy step in `.railway/railway.ts` is the real mechanism, but that file is
infrastructure as code and only takes effect when somebody runs `railway config
apply`, so on a service where nobody has, the tables are never created and the
failure is completely silent: the deploy succeeds, the health check passes, and
history becomes an array in memory that dies with the container. Two replicas
racing is safe because Prisma takes a Postgres advisory lock, which was verified
rather than assumed. `AUTO_MIGRATE=off` disables it. If you remove this, the
thing to replace it with is not nothing.

**Comments here argue rather than describe.** They exist to stop someone
undoing a decision without knowing it was a decision. If you change the
behaviour, change the argument too; if you disagree with one, say so in the
comment you replace it with.

## Where things live

Configuration that is data, not code, is in `config/`. Brand voice, visual
identity, creative grammar, policy rules, placements. Adding a placement or a
hook pattern is a row there, never a deploy of new logic.

The pipeline is in `src/lib/pipeline/`: brief writing, image prompt rendering,
scoring. `src/lib/policy/` is the deterministic gate. `src/lib/scrape/` reads
the storefront. `src/lib/http/safe-fetch.ts` is the only way anything reaches
the network, and it exists because a URL from a user is an SSRF vector.

Runs and images are in `src/lib/run.ts` and `src/lib/storage.ts`. Storage is an
interface with one Postgres implementation, deliberately, so moving image bytes
to object storage later is one new file rather than a rewrite of every caller.

## Before you push

Run `npm test`, `npx tsc --noEmit` and `npx eslint .`. Then run the browser
suite, because unit tests prove modules compose and the browser suite proves a
person can use the thing. It needs a dev server against the offline stub:

    GEMINI_API_KEY=offline-smoke APP_PASSWORD=NUDGE \
      NODE_OPTIONS="--import ./scripts/dev-stub-transport.ts" npx next dev

    BASE=http://localhost:3000 npm run ui:smoke
    BASE=http://localhost:3000 npm run ui:contrast

Add `DATABASE_URL=...` to that dev command if you have a Postgres to hand, and
prefer it. Without one the suite still passes, but three things go untested
because they cannot happen: images are inlined as base64 rather than served
from the asset store, history is an array in memory, and the run store's
Postgres paths are never entered. The checks adapt and say which configuration
they ran in, so a green run with no database is not the same evidence as a
green run with one.

If you change a class name that either script selects, change the script in the
same commit. They fail with a timeout rather than a clear message, which is the
one sharp edge in the suite.

## House style

No em dashes and no ellipses anywhere: not in the interface, not in prompts,
not in generated copy. `houseStyle()` in `src/lib/pipeline/types.ts` enforces
it on model output and a browser test asserts it on the rendered page. Comments
and this file are the exception, since neither is rendered.

Prose in comments, not shorthand. Say why, not what. The code already says
what.
