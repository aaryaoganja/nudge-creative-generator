# Deliverable 3: Decision doc

## The brand rules, and how I derived them

Four layers, all data in `config/`, so a rule change is a row and not a deploy.

**Voice**, from the site and the packaging. The positioning is not "clean
skincare", it is that the concentration is printed on the front of the pack. So:
state the active and its exact strength, let the number be the proof.

**Compliance**, six rule families, severity-tagged, each with a written
rationale. The ASCI code requires substantiation on demand for any objectively
ascertainable claim, which kills "clinically proven product" and leaves
"clinically studied ingredient" standing. Under the Drugs and Cosmetics Rules
1945 a cosmetic claiming to treat a disease becomes a drug. The rationale
matters more than the patterns: it lets a reviewer argue with the rule, not the
score.

**Creative grammar**, the layer I would defend hardest, because it changed the
output and came from iteration rather than authorship. My first visual rules
were written from the brand's stated aesthetic, and every generation came back a
tasteful bottle on warm sand: every constraint satisfied, nothing like the
brand. I did not fix that by rewriting instructions in the abstract. I put real
generations beside three banners Minimalist is currently running and rewrote the
rules against the gap. Flat white, not warm sand. The product on white geometric
pedestals. Hairline leader lines to small-caps labels. Closer to a spec sheet
than a photograph. That became four named archetypes and six devices, and the
brief model must *name* one rather than describe a layout, so the image prompt
expands its construction rules deterministically.

**Platform** is a property of every placement, not a preset: a 40-character
headline that fits Meta is cut by Google at 30, and mixing them writes copy to
the tighter limit.

These are my reading of the brand, not its guidelines.

## What I cut, and why

**Performance prediction.** No outcome data exists, so a predicted CTR is a
confident number with nothing behind it: the failure this brief warns about,
dressed as a feature.

**The reviewer workflow**: comments, sign-off, Slack. The stated pain and the
hardest cut. A workflow around a bad standard routes bad decisions faster.

**Firecrawl**, started with to dodge bot protection, then removed entirely.
Removing it fixed a bug: enrichment was Firecrawl-only and returned "no page, no
warning" on failure, so a brief ran on one line of description and nothing said
so. A thin brief and a model ignoring its brief look identical from outside.
Shopify serves the ingredients and FAQ in the HTML anyway.

**Video, multi-variant testing, international compliance.** Scope.

**Deliberation on three things I took rather than decided**, because calling
them evaluations would be invented rigour. Nano Banana Pro was picked on
reputation: quality was the constraint, cost was not, it worked, I stopped
looking. Railway collapses hosting, Postgres and secrets into one place. One
password covers everything, because every action behind it spends a live key.

One note on the brief: it calls the delay reviewer disagreement, then asks for a
scorer. Those do not meet. Scoring makes one reviewer faster; disagreement is a
question of who decides. So the scorer is loud on compliance, advisory on taste.

## The decision I was least sure about

Whether the image model should render the pack at all.

It is given the real photograph as a reference, so the packaging is reproduced
rather than invented. Reproduced is not composited. The model redraws the
bottle, and on this brand the printed concentration *is* the claim. A
regenerated label reading 12% on a 10% pack is a false regulated claim, and it
passes every gate I built, because the claim gate reads the copy layer and not
the pixels of the bottle.

The safe answer is compositing the real photograph into an HTML or SVG layout. I
did not, because this brand's real ads are constructed rather than photographed,
and a composite pipeline needs a layout engine per archetype per aspect ratio,
which is where the whole build would have gone. So I moved the risk rather than
removing it: the claim gate runs on text, before any image is paid for, so the
words are verified free. The pixels are not. The fix is OCR on the render
against the product data. I did not build it, and I would not put spend behind
this until it exists.
