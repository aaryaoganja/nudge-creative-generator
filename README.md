# Ad Studio

Paste a Minimalist product URL and get ad creatives sized for the Meta and
Google placements you picked. Or upload any creative, ours or a competitor's,
and get it scored against the brand's identity and India's advertising rules.

Every run has a link. Copy it from the address bar and send it to someone; they
sign in and see exactly what you saw.

Built on Next.js 16 and Postgres, deployed on Railway, running entirely on one
Gemini key.

---

## What it does, in order

**1. Reads the product.** You paste a URL. It fetches the product from
Shopify's own JSON endpoints for the hard facts (price, concentrations, images)
and reads the rendered page for the substance (ingredients, how to use, the
FAQ). Nothing is invented, and nothing goes through a third-party scraper.

**2. Shows you what it read, and lets you correct it.** Price, compare-at
price and concentrations appear in editable fields. Whatever is in those fields
is what the creative may state, and nothing else. This step is free.

**3. Writes a brief.** Gemini 3.7 Flash writes concepts and copy against the
brand's voice, the campaign objective, the angle you chose and the placements
you ticked. One brief per frame shape, because a plan for a tall story is not a
plan for a landscape banner.

**4. Checks the copy before spending anything.** A deterministic gate reads
every headline, every line of body copy and every string destined to be drawn
into the image. A percentage or rupee figure that is not in the product data or
in the offer you typed is blocked outright. This runs before any image is paid
for, because catching a bad claim in text is free and catching it after nine
generations is not.

**5. Generates the images.** Nano Banana Pro renders each surviving concept
into each selected placement, using the product's own photograph as a reference
so the packaging is reproduced rather than reimagined.

**6. Keeps the run.** Everything above is stored under one id: the inputs, the
copy, the exact prompt sent to the image model, the policy verdicts, the cost
and the images. That is what the shared link opens.

---

## The two things this is strict about

### Claims

The brand prints active concentrations on the front of the pack. Those are
regulated figures under the ASCI code, and a cosmetic that claims to treat a
disease becomes a drug under the Drugs and Cosmetics Rules 1945. So the model
is never trusted with a number.

It is handed the exact concentrations and prices from the product data and told
they are the only numeric claims permitted. Then a pure function checks that it
complied. Any percentage or rupee figure the model produced that is not on that
list is a blocking finding, and the concept is dropped before an image is
generated.

The one addition to that list is the offer field. A promotion is a fact about
your campaign, not about the product page, so a figure you type there is a
claim you have authorised and is printed exactly as written. Only the exact
figures you typed, never their neighbours: authorising "20% off" does not
license the model to write 25%.

### Punctuation

The product renders no em dashes and no ellipses, anywhere. Not in the
interface, not in the prompts, and not in generated ad copy. Instructing a
model not to use a character works most of the time, and most of the time is
not good enough when the failure gets drawn into a 2K image that cannot be
edited afterwards. So model output passes through a transform that rewrites
them, and a browser test asserts nothing on screen carries one.

---

## Reading the product page

There are two sources, doing different jobs.

Shopify's JSON endpoints give the **hard facts**: title, price, compare-at
price, images, tags. These are parsed numbers, and a parsed number beats a
number recovered from prose, so every claim traces back here.

The rendered page gives the **substance**: ingredient breakdowns, how to use,
why it works, and the FAQ. That material is what a brief needs in order to
answer an objection or explain a mechanism. A Shopify theme renders all of it
into the HTML the server returns, so it is read directly, through the same
guarded fetcher everything else uses. No key, no third-party scraper, nothing
to configure.

There was a Firecrawl integration here and removing it fixed a bug rather than
causing one. Enrichment used to be Firecrawl-only and returned "no page, no
warning" whenever the call failed or no key was set, so a brief asking the model
to answer an objection had one sentence of product description to work from and
nothing said so.

Now, if the page cannot be read, the run still works from the product JSON
alone and the interface says so plainly. That distinction matters more than it
sounds: a thin brief and a model ignoring its brief look identical from the
outside.

To check it from inside the deployment, which is the only place the answer
counts:

    railway run npm run scrape -- page https://beminimalist.co/products/<handle>

---

## How a creative is composed

Three layers, in `config/`, and the distinction between them is why generations
stopped looking like generic skincare ads.

**Voice** is what may be said: register, vocabulary, the things this brand
never does.

**Visual identity** is what the creative may be made of: palette, typography,
photography, and a hard list of things never to depict. All of it true of any
frame, from a 1200x628 banner to a 1080x1920 story.

**Creative grammar** is how the brand actually assembles those parts, derived
from three banners it is currently running. Four layout archetypes, five props,
six graphic devices with construction rules, and a restraint list that caps a
creative at two devices.

The third layer exists because every constraint in the first two could be
satisfied by a tasteful product shot on white that still looked nothing like
the ads on the site. The real ones are closer to a spec sheet than a
photograph: a type stack, a cluster on white pedestals, hairline leader lines
out to small-caps labels.

Wiring matters as much as content. The brief model does not describe a layout
in prose, it names one from the archetypes that can be built in the frame it
was given, and the construction rules are expanded from that name into the
image prompt.

The angle works the same way. It is not a suggestion weighed against the
objective. It decides what the creative argues, the objective decides how hard
it asks for the sale, and the offer is demoted to a supporting line. Both
models are told, so the picture and the words argue the same thing.

---

## Scoring

Upload any creative. Four layers run, cheapest and most certain first: file
format and dimensions, then banned phrases over the text read out of the image,
then a vision review of brand fit and composition, then a weighted score with
hard gates that cannot be averaged away.

Three inputs beyond the file, all optional, each sharpening the review rather
than decorating it. A **product URL** lets product claims be verified against
the live page; without one they come back marked unverified rather than
silently passing. The **placement** it was made for lets size and aspect ratio
be judged; without it they are not judged at all, rather than measured against
a spec you never chose. The **objective** it was written to lets stopping power
be scored against the job the creative actually had.

A creative that belongs to another brand does not get a low score, it gets
zero. Its craft may be real, but it is not this brand's, and 62 out of 100
would read as "nearly there" about something that can never run.

---

## Sharing and history

The run id appears in the address bar the moment you click Read product, which
is before anything has been paid for. Copy that URL and it opens the run: the
product, the copy, the policy verdicts and the creatives.

History lists every run with its cost and outcome, and each row links to its
own run.

Sharing is team-scoped. Every page is behind the password, so a link works for
anyone who can sign in and for nobody else. That is deliberate, since these
links carry product strategy and spend.

Runs are stored in Postgres. Images are stored by their own content hash, so
the same creative rendered for two placements is one row, and they are served
from this app rather than a third-party URL, which makes an image exactly as
private as the run it belongs to. Images are kept for recent runs; older runs
keep their copy, prompts and verdicts, and say plainly that the pictures have
been cleared.

If Postgres is unreachable the app still runs, history falls back to memory,
and the interface says the link will not open for anyone else.

### Surviving a deploy

History lives in Postgres, which on Railway is a separate service with its own
volume, so replacing the web container does not touch it. There is exactly one
way that promise used to break, and it broke silently.

Creating the tables is a migration, and the migration is wired into
`.railway/railway.ts` as a pre-deploy step. That file is infrastructure as code,
which Railway reads when somebody runs `railway config apply`, not on every
deploy. On a service where that command has never been run, the tables are never
created. Nothing looks wrong: the deploy succeeds, the health check passes,
creatives generate, scores come back, links get minted. Every write to history
throws, gets caught, and lands in an array in memory that is thrown away with
the container.

Three things now stand between that and a lost history.

The server applies pending migrations itself at startup if it finds the tables
missing. It is a backstop, not the mechanism, and it runs the same command the
pre-deploy step runs. Two replicas starting together is safe, because Prisma
takes a Postgres advisory lock: run three at once against an empty database and
one applies the migrations while the others wait and then find nothing pending.
Set `AUTO_MIGRATE=off` to turn this off and rely on the pre-deploy step alone.

The interface stops guessing. "No database" and "the tables are missing" are
different problems with different fixes, and History now names which one it is
looking at instead of showing one badge for both. Somebody told the tables are
missing goes and applies a migration; somebody told there is no database goes
and checks a connection string, which on a deployment that has a perfectly good
Postgres attached is a wasted afternoon.

And you can ask directly, from inside the deployment, which is the only place
the answer counts:

    railway run npm run db:check

It reports whether Postgres answers, whether both tables exist, whether every
migration on disk has been applied, and how much is stored. It exits non-zero
when history would not survive, so it works in a script. `GET /api/health`
answers the same question for anyone signed in, under `history.survivesRedeploy`.

---

## The password

The whole app sits behind one password, because everything behind it spends a
live API key per request. Set `APP_PASSWORD`. Unset, it falls back to `NUDGE`,
which is published in this repository and is therefore no protection at all.

Enforcement is in middleware rather than per route, so adding a route cannot
accidentally add a hole. The password is never written to the cookie: the
cookie carries an expiry and a nonce signed with a key derived from the
password, so rotating the password signs everyone out.

Anyone signed in can paste their own Gemini key at `/keys` to spend it instead
of the deployment's, for their browser only. It is encrypted, never shown back,
and goes away when they sign out.

---

## Running it

    npm install
    cp .env.example .env.local
    npm run dev

The only variable worth setting is `DATABASE_URL`. Without it the app still
boots and tells you which features are degraded.

### Tests

    npm test             unit and integration, no network, no key
    npm run smoke        the whole pipeline offline against a stubbed transport
    npm run ui:smoke     drives the real interface in a real browser
    npm run ui:contrast  measures the contrast the browser actually painted

`npm test` uses Node's built-in runner against TypeScript directly. No test
framework, no transpiler, no network, so it needs no API key and never flakes.

The browser suite signs in first, so a broken gate fails the run rather than
looking like a broken app. It has caught real defects on every pass: a single
result stretching to full container width and rendering a thousand-pixel-tall
image, blocked concepts returned by the API and dropped by the interface, and a
logo whose fallback never fired because the image failed before React hydrated.

`ui:contrast` asks a different question from a stylesheet review. It walks the
rendered page across every view, resolves each element's real background
through transparent ancestors, and computes what a reader actually gets.

### Checking the live providers

Everything above runs offline. To confirm the real thing works from inside the
deployment:

    railway run npm run models              what the key can see
    railway run npm run verify              free: models, text, page read
    railway run npm run verify -- --image   adds one real generation, about $0.13

---

## Deploying

Platform configuration lives in `.railway/railway.ts`, not `railway.json`.
Preview it with `railway config plan` and commit it with `railway config apply`.

That file also carries the pre-deploy migration, and it has to be applied at
least once for that step to exist at all. The server now creates the tables
itself at boot if it finds them missing, so forgetting no longer costs you your
history, but the backstop is not the mechanism and `railway config apply` is
still the thing to do. Confirm either way with `railway run npm run db:check`.

Secrets are declared as `preserve()`, which means you set them once in the
Railway dashboard and infrastructure-as-code never overwrites them or pulls
them into git. `APP_PASSWORD` in particular has to stay in that list. The
environment block is declarative, so a variable set in the dashboard but absent
from the map can be dropped on the next apply, and a dropped password does not
fail loudly. It silently reverts the gate to the default published here.

Continuous integration runs lint, typecheck, the test suite, a production build
and a Docker build of the exact image Railway builds.
