# Deliverable 1: The working app

**Ad Studio**, a Minimalist ad generator and pre-flight quality scorer.

Stack: Next.js 16 (App Router), TypeScript, Postgres via Prisma 7, deployed on
Railway. One model provider: Gemini 3.7 Flash writes and scores, Nano Banana Pro
(gemini-3-pro-image) renders. Built with Claude Code (Opus).

---

## The fast path: the hosted app

    URL:      <PASTE THE RAILWAY URL HERE>
    Password: NUDGE

The whole app sits behind one password because everything behind it spends a
live API key per request.

**You will need to supply your own Gemini key.** Go to `/keys`, paste one, and
it is sealed into an encrypted cookie for your session only. It overrides the
deployment's key, it is never shown back to you, and it goes away when you sign
out. I would rather you spend your own key than have me leave mine reachable
behind a password published in a README.

Without a key, everything up to and including the free product read still works,
and the app says plainly which parts are unavailable rather than failing.

### A two-minute tour

1. **Generate.** The product URL is pre-filled and the offer, angle, objective
   and placements are pre-selected, so **Generate creatives** is one click.
   Click **Read product** first if you want to see what it pulled and correct it.
2. **Score.** Drag any image onto the drop zone. It does not have to be one of
   ours. Try a competitor's ad, and try one of ours with a fake percentage
   painted on it.
3. **History.** Every run, with cost and outcome. Every row is a shareable link.

Two things worth doing deliberately, because they are the design:

- On the Generate tab, type `50% off` into the offer field, then generate. The
  figure prints, and the policy panel shows it as an authorised claim. The model
  is permitted *that* figure and no other, so `55%` would be blocked. Whether a
  given run tempts the model into inventing a statistic is luck; what is not
  luck is that the check runs on every concept before any image is paid for.
  The blocked case is covered in `tests/policy.test.ts` if no run produces one.
- On the Score tab, upload a clearly branded competitor ad. It should score
  **0**, not 62, because there is no partial credit for craft that belongs to
  someone else. The gate is deliberately narrow and fires only on a confident
  identification, so an unbranded or ambiguous creative gets a normal review
  instead. That is the intended behaviour, not a miss.

---

## Running it locally

Node 22. A Gemini key. Postgres is optional.

    git clone <repo> && cd nudge-creative-generator
    npm ci
    npx prisma generate
    GEMINI_API_KEY=<your key> APP_PASSWORD=NUDGE npm run dev

Open http://localhost:3000 and sign in with `NUDGE`.

`npm ci` is the slow step, around a minute or two on a warm cache. Everything
after it is seconds. Add `DATABASE_URL=postgresql://...` if you have a Postgres
to hand; without one the app runs fine and tells you on screen that history is
in memory and shared links will not open for anyone else.

### Seeing it work without spending anything

There is an offline stub that serves a realistic Shopify product page and fake
model responses, so the full pipeline runs with no network and no spend:

    GEMINI_API_KEY=offline-smoke APP_PASSWORD=NUDGE \
      NODE_OPTIONS="--import ./scripts/dev-stub-transport.ts" npm run dev

The creatives it produces are placeholder pixels. Everything around them, the
page read, the brief, the claim gate, the run store, the shared link, is real.

### The checks

    npm test                                  # 245 unit tests
    npx tsc --noEmit && npx eslint .
    BASE=http://localhost:3000 npm run ui:smoke      # 81 browser checks
    BASE=http://localhost:3000 npm run ui:contrast   # WCAG AA on rendered DOM

---

## Where the actual substance lives

The brief says the prompts are the substance of the work. They are not buried:

| What | Where |
| --- | --- |
| Brand voice, vocabulary, what the brand never does | `config/brand.ts` → `BRAND_VOICE` |
| Visual identity: palette, photography, never-depict list | `config/brand.ts` → `BRAND_VISUAL` |
| Creative grammar: 4 layout archetypes, 6 devices, restraint rules | `config/brand.ts` → `CREATIVE_GRAMMAR` |
| Compliance rules, severity-tagged, each with a written rationale | `config/brand.ts` → `POLICY_RULES` |
| Placements and their per-platform copy limits | `config/placements.ts` |
| The brief-writing prompt, and the image prompt renderer | `src/lib/pipeline/brief.ts` |
| The scorer's prompt, dimensions, weights and hard gates | `src/lib/pipeline/score.ts` |
| The deterministic claim gate, which is not a prompt | `src/lib/policy/check.ts` |

That last row is the point of the whole thing. The prompt asks for compliance;
`checkPolicy` verifies it afterwards with a pure function, and disagrees with
the model often enough to justify existing.

---

## What I know does not work

- **The live storefront fetch is unverified from my sandbox.** The proxy here
  returns 403 for beminimalist.co, so I could not prove the real page read end
  to end. The parser is tested against captured and synthetic Shopify HTML, and
  `npm run scrape -- page <url>` exists to check it from inside a deployment.
  Assume this is the first thing to break.
- **Generated packaging is not verified against the real pack.** See failure
  mode 2. This is the largest known gap and it is not a bug, it is missing work.
- **The scorer reads text out of the image with the vision model.** Small type
  at the bottom of a 1080x1920 story is where that will fail first.
- **One brand, one language.** Nothing here handles international variants,
  and the compliance rules are India-only.
