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

export function checkPolicy(brief: ConceptBrief, claims: Claims): PolicyResult {
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
  findings.push(...checkClaimIntegrity(brief, claims));

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
 * snapshot is a number the model invented. Under the ASCI substantiation
 * requirement that is an unsubstantiable claim, not a typo.
 */
export function checkClaimIntegrity(
  brief: ConceptBrief,
  claims: Claims,
): Finding[] {
  const findings: Finding[] = [];
  const allowedPercents = new Set(claims.concentrations);
  if (claims.discountPct !== null) {
    allowedPercents.add(`${claims.discountPct}%`);
  }

  const allowedMoney = new Set(
    [claims.priceDisplay, claims.compareAtDisplay].filter(
      (v): v is string => v !== null,
    ),
  );

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
            `"${normalised}" does not appear in the product data. Permitted: ` +
            `${[...allowedPercents].join(", ") || "none"}. A concentration or ` +
            `discount the product does not state is an unsubstantiable claim.`,
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
