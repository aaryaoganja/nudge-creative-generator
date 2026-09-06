import { POLICY_RULES, COPY_LIMITS } from "../../../config/brand.ts";
import type { ConceptBrief, Claims } from "../pipeline/types.ts";

/**
 * Deterministic policy gate — pipeline stage 4.
 *
 * Runs BEFORE any image is generated. Catching a banned claim in text costs
 * nothing; catching it after nine generations costs $1.27. Pure functions
 * throughout: no model, no network, fully auditable, and immune to the
 * shared-blind-spot problem that comes with one model both writing and scoring
 * (docs/PLAN.md §3).
 *
 * The same rules run again in the scorer, against extracted text. One engine,
 * two call sites.
 */

export type Severity = "blocking" | "major" | "minor";
export type Verdict = "pass" | "fix_required" | "blocked";

export interface Finding {
  ruleId: string;
  severity: Severity;
  field: string;
  evidence: string;
  message: string;
}

export interface PolicyResult {
  verdict: Verdict;
  findings: Finding[];
}

/** Every string the gate inspects, tagged with where it came from. */
function copyFields(brief: ConceptBrief): Array<[string, string]> {
  return [
    ["copy.headline", brief.copy.headline],
    ["copy.subhead", brief.copy.subhead],
    ["copy.primaryText", brief.copy.primaryText],
    ["copy.cta", brief.copy.cta],
    ["concept.angle", brief.concept.angle],
    // The strings the image model is told to draw are copy too. Excluding them
    // would let a banned claim through simply by being rendered rather than
    // written.
    ...brief.imagePrompt.textToRender.map(
      (t, i) => [`imagePrompt.textToRender[${i}]`, t] as [string, string],
    ),
  ];
}

/**
 * Extra numbers a HUMAN authorised, over and above what the product page says.
 *
 * The offer field is the only one of these today. It exists because a promotion
 * is a fact about the campaign, not about the product page: "Buy 2, get 1 free"
 * and "20% off this week" are true things a marketer knows and the storefront
 * JSON does not.
 *
 * This does not weaken the claim lock, it aims it correctly. The lock exists to
 * stop the MODEL inventing numbers; a figure typed by the person running the ad
 * is not an invention. What it must not do is let the model treat an authorised
 * figure as licence to invent neighbours, which is why only the exact literals
 * found in the offer are added, never a range and never a pattern.
 */
export interface AuthorisedClaims {
  /** Free text the operator asked to be printed verbatim, e.g. the offer. */
  offer?: string | null;
}

/** The percentage and rupee literals inside an operator-supplied string. */
export function literalsIn(text: string | null | undefined): {
  percents: string[];
  money: string[];
} {
  if (!text) return { percents: [], money: [] };
  return {
    // Normalised exactly as the scanners below normalise what they find, or a
    // permitted "₹1,499" would never match the "₹1499" the scanner produces.
    percents: [...text.matchAll(/\d+(?:\.\d+)?\s*%/g)].map((m) =>
      m[0].replace(/\s+/g, ""),
    ),
    money: [...text.matchAll(/₹\s*[\d,]+/g)].map((m) => m[0].replace(/[\s,]/g, "")),
  };
}

export function checkPolicy(
  brief: ConceptBrief,
  claims: Claims,
  authorised: AuthorisedClaims = {},
): PolicyResult {
  const findings: Finding[] = [];
  const fields = copyFields(brief);

  for (const rule of POLICY_RULES) {
    for (const pattern of rule.patterns) {
      const regex = new RegExp(pattern, "i");
      for (const [field, value] of fields) {
        const match = regex.exec(value);
        if (!match) continue;
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          field,
          evidence: match[0],
          message: rule.rationale,
        });
      }
    }
  }

  findings.push(...checkLengths(brief));
  findings.push(...checkClaimIntegrity(brief, claims, authorised));

  return { verdict: verdictFor(findings), findings };
}

function checkLengths(brief: ConceptBrief): Finding[] {
  const findings: Finding[] = [];
  const checks: Array<[keyof typeof COPY_LIMITS, string]> = [
    ["headline", brief.copy.headline],
    ["subhead", brief.copy.subhead],
    ["primaryText", brief.copy.primaryText],
    ["cta", brief.copy.cta],
  ];

  for (const [field, value] of checks) {
    const limit = COPY_LIMITS[field];
    if (value.length > limit) {
      findings.push({
        ruleId: "copy-length",
        severity: "minor",
        field: `copy.${field}`,
        evidence: `${value.length} chars`,
        message: `Exceeds the ${limit}-character ceiling for ${field}; will truncate or overflow.`,
      });
    }
  }
  return findings;
}

/**
 * The claim-integrity check — the reason this project holds concentrations and
 * prices separately from generated copy.
 *
 * Any percentage or rupee figure that appears in copy but NOT in the product
 * snapshot and NOT authorised by the operator is a number the model invented.
 * Under the ASCI substantiation requirement that is an unsubstantiable claim,
 * not a typo.
 *
 * The offer used to be the hole in this. The prompt told the model to print the
 * offer "verbatim, never paraphrased" while this function had never heard of
 * it, so "20% off this week" on a product with no 20% discount left the model
 * two ways out: obey the instruction and have the concept blocked, or obey the
 * claim lock and silently drop the number the marketer typed. Both broke the
 * promise on the label. Now the gate is told what the operator authorised, so
 * the instruction and the enforcement finally agree.
 */
export function checkClaimIntegrity(
  brief: ConceptBrief,
  claims: Claims,
  authorised: AuthorisedClaims = {},
): Finding[] {
  const findings: Finding[] = [];
  const offer = literalsIn(authorised.offer);

  const allowedPercents = new Set(claims.concentrations);
  if (claims.discountPct !== null) {
    allowedPercents.add(`${claims.discountPct}%`);
  }
  for (const percent of offer.percents) allowedPercents.add(percent);

  const allowedMoney = new Set(
    [claims.priceDisplay, claims.compareAtDisplay].filter(
      (v): v is string => v !== null,
    ),
  );
  for (const amount of offer.money) allowedMoney.add(amount);

  for (const [field, value] of copyFields(brief)) {
    for (const match of value.matchAll(/\d+(?:\.\d+)?\s*%/g)) {
      const normalised = match[0].replace(/\s+/g, "");
      if (!allowedPercents.has(normalised)) {
        findings.push({
          ruleId: "invented-percentage",
          severity: "blocking",
          field,
          evidence: match[0],
          message:
            `"${normalised}" does not appear in the product data or in the ` +
            `offer you typed. Permitted: ${[...allowedPercents].join(", ") || "none"}. ` +
            `A concentration or discount the product does not state is an ` +
            `unsubstantiable claim.`,
        });
      }
    }

    for (const match of value.matchAll(/₹\s*[\d,]+/g)) {
      const normalised = match[0].replace(/[\s,]/g, "");
      if (!allowedMoney.has(normalised)) {
        findings.push({
          ruleId: "invented-price",
          severity: "blocking",
          field,
          evidence: match[0],
          message:
            `"${normalised}" is not this product's price. Permitted: ` +
            `${[...allowedMoney].join(", ") || "none"}.`,
        });
      }
    }
  }

  return findings;
}

/**
 * Verdict is computed separately from any numeric score. A blocking finding is
 * never averaged away by an otherwise good creative.
 */
export function verdictFor(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === "blocking")) return "blocked";
  if (findings.some((f) => f.severity === "major")) return "fix_required";
  if (findings.length > 0) return "fix_required";
  return "pass";
}
