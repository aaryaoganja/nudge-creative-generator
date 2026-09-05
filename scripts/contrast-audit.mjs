/**
 * Contrast audit — measures what the browser actually painted.
 *
 *   APP_PASSWORD=NUDGE BASE=http://localhost:3000 node scripts/contrast-audit.mjs
 *
 * The palette comment in globals.css states a ratio for every token pairing,
 * but a stated ratio is a claim about two hex values, not about the page: it
 * says nothing about which pairs actually meet on screen, about a colour set
 * inline in a component, or about text that ends up over a surface the token
 * table never anticipated. This walks the rendered DOM instead and computes the
 * ratio for every element that carries a visible word, resolving the effective
 * background by climbing ancestors until it finds one that is not transparent.
 *
 * WCAG 2.2: 4.5:1 for body text, 3:1 for text at 24px, or 18.66px bold.
 * Disabled controls are exempt — they are reported, not failed.
 */

import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const PASSWORD = process.env.APP_PASSWORD ?? "NUDGE";
const PRODUCT =
  process.env.PRODUCT_URL ??
  "https://beminimalist.co/products/hair-growth-anti-grey-actives-15-6-hair-serum";
const CHROMIUM =
  process.env.CHROMIUM_PATH ??
  ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));

/** Runs in the page. Returns one row per element carrying its own text. */
const AUDIT = () => {
  const parse = (colour) => {
    const m = /rgba?\(([^)]+)\)/.exec(colour);
    if (!m) return null;
    const [r, g, b, a = "1"] = m[1].split(",").map((v) => parseFloat(v));
    return { r, g, b, a };
  };

  const luminance = ({ r, g, b }) => {
    const channel = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };

  /** src over dst, both opaque-backed. */
  const over = (src, dst) => ({
    r: src.r * src.a + dst.r * (1 - src.a),
    g: src.g * src.a + dst.g * (1 - src.a),
    b: src.b * src.a + dst.b * (1 - src.a),
    a: 1,
  });

  const ratio = (fg, bg) => {
    const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  };

  /** The colour actually behind an element: climb until something is opaque. */
  const backdrop = (element) => {
    let node = element;
    let stack = [];
    while (node) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) {
        stack.push(bg);
        if (bg.a === 1) break;
      }
      node = node.parentElement;
    }
    // No opaque layer found: the canvas is whatever the root paints.
    let result = stack.pop() ?? { r: 255, g: 255, b: 255, a: 1 };
    while (stack.length > 0) result = over(stack.pop(), result);
    return result;
  };

  const rows = [];
  for (const element of document.querySelectorAll("body *")) {
    // Only elements with their OWN text; a wrapper inherits its child's report.
    const own = [...element.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent.trim())
      .join(" ")
      .trim();
    if (!own) continue;

    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;

    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.opacity === "0") continue;

    const fg = parse(style.color);
    if (!fg || fg.a === 0) continue;

    const bg = backdrop(element);
    const effective = fg.a < 1 ? over(fg, bg) : fg;
    const size = parseFloat(style.fontSize);
    const weight = parseInt(style.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);

    rows.push({
      text: own.slice(0, 46),
      selector: `${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? `.${element.className.trim().split(/\s+/).join(".")}` : ""}`.slice(0, 60),
      ratio: Math.round(ratio(effective, bg) * 100) / 100,
      need: large ? 3 : 4.5,
      size,
      weight,
      disabled: element.matches(":disabled") || element.closest("[disabled]") !== null,
    });
  }
  return rows;
};

const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage();

const failures = [];
const exempt = [];
let measured = 0;

async function audit(label) {
  const rows = await page.evaluate(AUDIT);
  measured += rows.length;
  for (const row of rows) {
    if (row.ratio >= row.need) continue;
    (row.disabled ? exempt : failures).push({ ...row, page: label });
  }
  console.log(`  ${label}: ${rows.length} text elements measured`);
}

await page.goto(BASE, { waitUntil: "networkidle" });
await audit("login");

await page.fill("#password", PASSWORD);
await page.click('button[type="submit"]');
await page.waitForSelector(".shell", { timeout: 20000 });
await audit("generate (empty)");

await page.fill("#url", PRODUCT);
await page.click('button.primary[type="submit"]');
await page.waitForSelector(".claimbar", { timeout: 20000 });
await audit("generate (confirm)");

await page.locator("button.primary", { hasText: /Generate/ }).click();
await page.waitForSelector(".adcard", { timeout: 90000 });
await page.locator("details summary").first().click();
await audit("results");

await page.locator('[role="tab"]', { hasText: "Score" }).click();
await page.waitForSelector("#file", { timeout: 10000 });
await audit("score");

await page.goto(`${BASE}/keys`, { waitUntil: "networkidle" });
await audit("keys");

await browser.close();

console.log(`\n${measured} text elements measured across 6 views\n`);

if (exempt.length > 0) {
  console.log("Exempt (disabled controls — WCAG does not require contrast):");
  for (const row of exempt) {
    console.log(`  ${row.ratio}:1  ${row.page}  ${row.selector}  "${row.text}"`);
  }
  console.log("");
}

if (failures.length === 0) {
  console.log("PASS — every visible word meets its WCAG AA threshold.");
  process.exit(0);
}

console.log(`FAIL — ${failures.length} element(s) below threshold:`);
for (const row of failures) {
  console.log(
    `  ${row.ratio}:1 (needs ${row.need}:1)  ${row.page}  ${row.size}px/${row.weight}  ${row.selector}  "${row.text}"`,
  );
}
process.exit(1);
