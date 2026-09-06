# Deliverable 3: Decision doc

## The brand rules, and where they came from

Three layers, all in `config/brand.ts`, deliberately separated because they fail
differently.

**Voice** is what may be said, read off the site's product pages and packaging.
The positioning is not "clean skincare", it is that the concentration is printed
on the front of the pack. So the rule is: state the active and its exact
strength, let the number be the proof, never the adjective.

**Compliance** is six rule families, severity-tagged, each carrying a written
rationale. Two sources: the ASCI code requires substantiation on demand for any
objectively ascertainable claim, which kills "clinically proven product" while
leaving "clinically studied ingredient" standing; and under the Drugs and
Cosmetics Rules 1945 a cosmetic that claims to treat a disease becomes a drug.
The rationale field matters more than the patterns. It lets a reviewer argue
with the rule rather than with the score.

**Creative grammar** is the layer I would defend hardest, because it is the one
that changed the output. I first wrote the visual rules from the brand's stated
aesthetic, and every generation came back a tasteful bottle on warm sand,
satisfying every constraint and looking nothing like the brand. So I rewrote it
against three banners Minimalist is currently running. The real ads sit on flat
white, the product stands on white geometric pedestals, and the frame carries
hairline leader lines to small-caps labels. They are closer to a spec sheet than
a photograph. That became four named archetypes and six devices with
construction rules, and the brief model must *name* one rather than describe a
layout in prose, so the image prompt expands its rules deterministically.

These are my reading of the brand, not its guidelines. Everything is data in
`config/`, so disagreeing is a row, not a deploy.

## What I cut

**Performance prediction.** No outcome data exists here, so a predicted CTR
would be a confident number with nothing behind it. That is the exact failure
this brief warns about, dressed as a feature.

**The reviewer workflow**: comments, sign-off, Slack. This is the stated pain,
and cutting it was the hardest call. A workflow around a bad standard routes bad
decisions faster. I spent the time on the standard.

**Video, multi-variant testing, international compliance.** Scope.

A note on the brief: it describes the delay as reviewers disagreeing and ads
bouncing for days, then asks for a scorer. Those do not meet. Scoring makes one
reviewer faster; disagreement is a question of who decides. A scorer that
arbitrates taste will be overridden until it is ignored, including on the
compliance calls where it is right. I built the scorer to be loud about
compliance and advisory about taste for that reason.

## The decision I was least sure about

Whether the image model should render the pack at all.

Nano Banana Pro is given the real product photograph as a reference, so the
packaging is reproduced rather than invented. But reproduced is not composited.
The model redraws the bottle, and on this brand the printed concentration *is*
the claim. A regenerated label reading 12% on a 10% pack is a false regulated
claim, and it passes every gate I built, because the claim gate reads the copy
layer and not the pixels of the bottle.

The safe answer is compositing the real photograph into an HTML or SVG layout.
I did not, because the brand's real ads are constructed rather than
photographed, and a composite pipeline needs a layout engine per archetype per
aspect ratio. That is where the whole build would have gone.

I resolved it by moving the risk rather than removing it: the claim gate runs on
text, before any image is paid for, so the words are verified for free. The
pixels are not. The correct fix is OCR on the rendered image compared against
the product data, a pixel-level claim gate. I did not build it, and I would not
put this in front of spend until it exists.
