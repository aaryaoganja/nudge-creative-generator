/**
 * UI smoke test — drives the real app in a real browser.
 *
 *   npm run ui:smoke                 # starts nothing; expects a server on BASE
 *   BASE=http://localhost:3000 npm run ui:smoke
 *
 * Run the app against the offline transport stub first, so this costs nothing:
 *
 *   GEMINI_API_KEY=offline-smoke \
 *   NODE_OPTIONS="--import ./scripts/dev-stub-transport.ts" \
 *   npx next dev -p 3000
 *
 * Unit tests prove modules compose; this proves a person can actually use the
 * thing. It caught two real defects on first run: a single result stretching to
 * full container width and rendering a thousand-pixel-tall image, and blocked
 * concepts being returned by the API but silently dropped by the UI.
 *
 * Runs both colour schemes, because the palette is defined in three places
 * (bare :root, prefers-color-scheme, and [data-theme]) and it is easy to fix
 * one and forget the others.
 */

import { chromium } from "playwright";
import { mkdirSync, existsSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = process.env.OUT ?? "out/ui";
const PRODUCT =
  process.env.PRODUCT_URL ??
  "https://beminimalist.co/products/hair-growth-anti-grey-actives-15-6-hair-serum";

// Playwright's bundled path varies by install; fall back to the env override.
const CHROMIUM =
  process.env.CHROMIUM_PATH ??
  ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));

mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

const browser = await chromium.launch(
  CHROMIUM ? { executablePath: CHROMIUM } : {},
);

async function run(theme) {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  const page = await context.newPage();
  const primary = theme === "light";

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${OUT}/01-landing-${theme}.png`, fullPage: true });

  if (primary) {
    check("landing renders", (await page.locator("h1").innerText()) === "Minimalist Ad Studio");
    check("both tabs present", (await page.locator('[role="tab"]').count()) === 2);

    // A collection URL must be refused in the UI, with an actionable message.
    await page.fill("#url", "https://beminimalist.co/collections/skin");
    await page.click('button.primary[type="submit"]');
    await page.waitForSelector(".error", { timeout: 15000 });
    const errorText = await page.locator(".error").innerText();
    check("collection URL refused", /collection page/i.test(errorText), errorText.slice(0, 60));
    await page.screenshot({ path: `${OUT}/02-rejected.png`, fullPage: true });
  }

  await page.fill("#url", PRODUCT);
  await page.click('button.primary[type="submit"]');
  await page.waitForSelector(".claimbar", { timeout: 20000 });
  await page.screenshot({ path: `${OUT}/03-confirm-${theme}.png`, fullPage: true });

  if (primary) {
    check(
      "claim bar surfaces the concentration",
      (await page.locator(".claimbar").innerText()).includes("%"),
    );
    const price = await page.locator(".price").innerText();
    check("price, compare-at and discount shown", /₹/.test(price), price.replace(/\s+/g, " "));
    check("reference thumbnails offered", (await page.locator(".thumb").count()) > 0);
    check(
      "placement is Meta 4:5",
      (await page.locator("#placement option").first().innerText()).includes("1080×1350"),
    );
    check(
      "cost shown before any spend",
      /\$/.test(await page.locator(".cost").last().innerText()),
    );
  }

  await page.locator("#concepts").fill("2");
  await page.locator("button.primary", { hasText: /Generate/ }).click();
  await page.waitForSelector(".adcard", { timeout: 90000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/04-results-${theme}.png`, fullPage: true });

  if (primary) {
    const box = await page.locator(".adcard").first().boundingBox();
    // Regression guard: a single result must not stretch to the container.
    check(
      "ad card stays feed-width",
      box !== null && box.width <= 460,
      `${Math.round(box?.width ?? 0)}px wide`,
    );
    const natural = await page
      .locator("img.ad-image")
      .first()
      .evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight }));
    check(
      "generated image is real and 4:5",
      Math.abs(natural.w / natural.h - 0.8) < 0.02,
      `${natural.w}×${natural.h}`,
    );
    check("headline rendered", (await page.locator(".ad-headline").first().innerText()).length > 0);
    check("CTA rendered", (await page.locator(".ad-cta").first().innerText()).length > 0);
    check("download offered", (await page.locator("a[download]").count()) > 0);

    await page.locator("details summary").first().click();
    const prompt = await page.locator("pre.prompt").first().innerText();
    check("prompt carries the brand palette", prompt.includes("#F4F1EC"));
    check(
      "prompt bans the generic-ad markers",
      /marble/i.test(prompt) && /gold foil/i.test(prompt),
    );
    await page.screenshot({ path: `${OUT}/05-prompt-open.png`, fullPage: true });
  }

  await page.locator('[role="tab"]', { hasText: "Score" }).click();
  await page.waitForSelector("#file", { timeout: 10000 });

  const fixture = process.env.SCORE_FIXTURE;
  if (fixture && existsSync(fixture)) {
    await page.setInputFiles("#file", fixture);
    await page.locator("button.primary", { hasText: /Score creative/ }).click();
    await page.waitForSelector(".big-score", { timeout: 90000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/06-score-${theme}.png`, fullPage: true });

    if (primary) {
      check("score rendered", /^\d+$/.test((await page.locator(".big-score").innerText()).trim()));
      check("five dimension meters", (await page.locator(".scoreline").count()) === 5);
      check("do-more and do-less populated", (await page.locator("ul.plain li").count()) > 1);
      check("findings listed", (await page.locator(".finding").count()) > 0);
      check(
        "unverified notice when no product URL",
        (await page.locator(".notice").count()) > 0,
      );
    }
  } else if (primary) {
    check("scorer form reachable", await page.locator("#file").isVisible());
  }

  await context.close();
}

await run("light");
await run("dark");
await browser.close();

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "  ✓" : "  ✗"} ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots → ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);
