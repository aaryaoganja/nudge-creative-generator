# Deliverable 4: Failure modes

Three ways a **correctly functioning** version of this tool produces a bad
outcome. None of these are bugs. Fixing the bugs makes all three worse, because
a tool that is wrong often gets checked.

---

## 1. The claim gate is precise about numbers, so people stop reading the words

**What happens.** The gate is genuinely good at one thing: no percentage or
rupee figure reaches a creative unless it came from the product data or from an
offer a human typed. It is right every time, visibly, run after run. Within a
few weeks the marketing team learns that "policy: pass" means the ad is clean.

It does not mean that. The gate verifies arithmetic, not truth. It cannot tell
that the offer someone typed was never approved by anyone. It cannot tell that
"10% Niacinamide" has been attached to the wrong SKU in a carousel. And it is
weakest exactly where the regulatory risk is highest: an implied efficacy claim
carrying no number at all. "Clears breakouts" has no digits in it, and the
pattern list catches it only if I thought of that phrasing.

So the tool trains the humans out of the review it was built to accelerate, and
the claim that ships is the one nobody looked at. This is the expensive failure
in the brief: publishing something wrong, arrived at through a tool working
exactly as designed.

**What I would do.** Stop reporting a pass. Every creative gets an explicit
*not checked* list beside the verdict, naming what the gate cannot see:
non-numeric efficacy claims, whether the offer is authorised, whether the
concentration belongs to this product. A reviewer reading "3 claims verified, 2
claim types not checkable" behaves differently from one reading "pass".

**Before launch.** The not-checked list is a rendering change over data the
gate already produces. Shipping the gate without it is shipping the failure.
The human sign-off field on export, and the audit log behind it, can follow.

---

## 2. The image model redraws a regulated label, and every text gate misses it

**What happens.** The generator conditions on the real product photograph, so
the pack comes back looking right. Looking right is the problem. The model
redraws the bottle rather than compositing it, and on this brand the number
printed on the front of the pack is the regulated claim. A 10% Niacinamide pack
rendered with a 12% label is a false claim on a real product, published at
media spend, and it passes everything I built: the claim gate reads the copy
layer, and the pixels of the bottle are not copy.

The scorer's vision pass may catch a gross error. It will not reliably catch a
one-digit change, which is the version that actually ships, because a creative
that looks correct is the one a reviewer approves fastest.

This is the failure most specific to Minimalist. A brand whose entire position
is that it does not misrepresent things, misrepresenting its own pack, using a
tool bought to protect it.

**What I would do.** A pixel-level claim gate: OCR the rendered creative, pull
every number and unit off the depicted packaging, and compare against the
product data with the same rule already applied to copy. A mismatch blocks,
identically to a bad headline. If that proves unreliable at small type, the
fallback is structural rather than clever: composite the real photograph and
let the model generate only the environment around it.

**Before launch.** This one is a hard gate on going live at all. Until it
exists I would run the tool with the pack held below legible size, or with
generated creatives treated as internal comps that a designer rebuilds before
spend. I did not build this check, and I would not put spend behind the tool
without it.

---

## 3. The standard freezes, keeps sounding authoritative, and gets routed around

**What happens.** The rules were derived at one moment from one reading of the
site, the packaging and three running banners. The brand then does what brands
do: launches a product at a concentration the rules do not know, runs a festive
campaign in a register the voice rules call off-brand, gets new legal guidance.

Nothing in the system knows any of that happened. The scorer keeps returning 84
out of 100 with a confident rationale, and a number with a rationale reads as an
institutional standard rather than as one person's judgment from a date. The
damage is not the wrong score. It is that the scorer starts blocking legitimate
new work, the team learns to override it, and overriding becomes the habit,
including on the compliance findings where it was right. The tool loses
authority precisely where it had value, and it loses it quietly.

This is also the brief's own problem returning. Reviewers were disagreeing
before this tool existed. Encoding one view of the brand does not resolve the
disagreement; it hides it, and the disagreement comes back as override
behaviour that nobody is reading.

**What I would do.** Version and date the ruleset, and print the version on
every score, so the standard is legibly a document with an author rather than a
fact. Then make disagreement a first-class input: an override on any finding
that requires a reason, captured. Overrides are the only signal that will ever
tell you which rules are wrong, and they are free to collect.

**Before launch.** The version stamp, because it is a string and it changes how
every report is read. Override capture and a standing rule review after, once
there is enough traffic for the overrides to say something.

---

## The one I am least able to defend

Failure mode 2 is not hypothetical and I did not mitigate it. Everything else
here is a thing I would improve; that one is a thing I would gate the launch
on.
