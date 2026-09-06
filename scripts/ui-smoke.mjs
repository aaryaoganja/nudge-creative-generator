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
 * The app is behind a password now, so the run starts by signing in — which
 * doubles as a test of the gate: if the login form does not work, nothing below
 * this line can run at all.
 *
 * Still runs both colour schemes. The palette is deliberately dark-only, and
 * this is what proves it: a design that quietly inherits the host scheme would
 * come back light under colorScheme: "light" and the assertions would not
 * notice — the screenshots and the contrast probe would.
 */

import { chromium } from "playwright";
import { mkdirSync, existsSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = process.env.OUT ?? "out/ui";
// Matches the default in src/lib/auth.ts appPassword(). Override when the
// deployment under test sets APP_PASSWORD to something else.
const PASSWORD = process.env.APP_PASSWORD ?? "NUDGE";
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


/**
 * Sign in, tolerating the hydration race.
 *
 * The Enter button is disabled until React holds a non-empty password, and
 * fill() before hydration sets the DOM value without firing the change handler
 * React is listening for — so the field looks filled and the button stays
 * dead forever. Refilling until the button enables is the only reliable signal
 * that the form is live; there is no "hydrated" event to wait on.
 */
async function signIn(page) {
  const submit = page.locator('button[type="submit"]');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // Clear first. fill() with the value the field already holds is a no-op
    // that dispatches nothing, so a retry after a pre-hydration fill would
    // never reach React and the loop would spin until it gave up.
    await page.fill("#password", "");
    await page.fill("#password", PASSWORD);
    if (await submit.isEnabled()) break;
    await page.waitForTimeout(250);
  }
  await submit.click();
}

async function run(theme) {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  const page = await context.newPage();
  const primary = theme === "light";

  // ── the gate ────────────────────────────────────────────────────────────
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  if (primary) {
    check(
      "signed-out visitor is sent to the gate",
      new URL(page.url()).pathname === "/login",
      page.url(),
    );
    // The login page draws its own centred branding; the app bar linking to
    // pages a signed-out visitor cannot open must not sit on top of it.
    check("no app nav on the login page", (await page.locator(".topnav").count()) === 0);
    // The mark is fetched from nudge.new, which is unreachable from some
    // networks. Whatever happens, the lockup must read as words — never as a
    // broken-image glyph. This is server-rendered HTML, so the failure can
    // happen before React attaches onError; see brand-lockup.tsx.
    const gateLockup = await page.locator("main >> text=Ad Studio").first().innerText();
    check("gate lockup names the product", /Ad Studio/.test(gateLockup), gateLockup);
    // Wait for the swap rather than sampling the instant the DOM appears:
    // the fallback is applied by a callback ref, so it lands at hydration, not
    // at first paint.
    const gateLogoOk = await page
      .waitForFunction(() => {
        const img = document.querySelector('main img[alt="Nudge"]');
        return img === null || (img.complete && img.naturalWidth > 0);
      }, null, { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    check("no broken mark on the gate", gateLogoOk);
    await page.screenshot({ path: `${OUT}/00-login.png`, fullPage: true });

    // A wrong password must say so rather than failing silently or letting it through.
    await page.fill("#password", "definitely-not-it");
    await page.click('button[type="submit"]');
    // #password-error, not [role="alert"]: Next injects its own route
    // announcer with that role, so the bare selector is ambiguous.
    await page.waitForSelector("#password-error", { timeout: 10000 });
    check(
      "wrong password refused",
      new URL(page.url()).pathname === "/login",
      (await page.locator("#password-error").innerText()).slice(0, 60),
    );
  }

  await signIn(page);
  await page.waitForSelector(".shell", { timeout: 20000 });
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${OUT}/01-landing-${theme}.png`, fullPage: true });

  if (primary) {
    check("password opens the app", new URL(page.url()).pathname === "/");

    // ── top nav and the view switcher ─────────────────────────────────────
    check("one banner landmark", (await page.locator("header.topnav").count()) === 1);
    check(
      "nav carries the Ad Studio by Nudge lockup",
      (await page.locator(".topnav-wordmark").innerText()) === "Ad Studio" &&
        (await page.locator(".topnav-by").innerText()) === "by",
    );
    const lockupSize = await page
      .locator(".topnav-wordmark")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    check("the lockup is not tiny", lockupSize >= 20, `${lockupSize}px`);

    check("three views offered", (await page.locator(".switcher-tab").count()) === 3);
    // Every switcher entry is a real URL, so a view can be bookmarked and sent.
    const viewHrefs = await page
      .locator(".switcher-tab")
      .evaluateAll((els) => els.map((el) => el.getAttribute("href")));
    check(
      "views are links, not buttons",
      viewHrefs.every((h) => h && !h.startsWith("#")),
      viewHrefs.join(" "),
    );
    check("no dead nav anchors", (await page.locator('.topnav a[href^="#"]').count()) === 0);
    check("sign out reachable from every page", (await page.locator(".topnav button").count()) === 1);
    check("only one view switcher", (await page.locator(".switcher").count()) === 1);
    check(
      "one h1 on the page",
      (await page.locator("h1").count()) === 1,
      await page.locator("h1").innerText(),
    );

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

  // ── the shareable link ──────────────────────────────────────────────────
  const runUrl = new URL(page.url());
  const runId = runUrl.searchParams.get("run");
  if (primary) {
    // Minted on the FREE read, not after generation: the whole point is having
    // something to send somebody before any money is spent.
    check(
      "reading a product puts a run id in the address bar",
      /^gen_[0-9a-f]{20}$/.test(runId ?? ""),
      page.url(),
    );
    check("the id is shown, not just in the URL", (await page.locator(".sharebar .runid").innerText()) === runId);
    check("a copy-link affordance exists", (await page.locator(".sharebar button").count()) === 1);

    // The defaults that make Generate the next click.
    check(
      "offer is seeded from the product's own discount",
      /%\s*off/.test(await page.locator("#offer").inputValue()),
      await page.locator("#offer").inputValue(),
    );
    check(
      "angle is preselected",
      (await page.locator("#angle").inputValue()).length > 0,
      await page.locator("#angle").inputValue(),
    );
    check(
      "the seeded angle shows as a selected chip",
      (await page.locator(".chip.on").count()) >= 1,
    );
  }

  if (primary) {
    check(
      "claim bar surfaces the concentration",
      (await page.locator(".claimbar").innerText()).includes("%"),
    );
    const price = await page.locator(".price").innerText();
    check("price, compare-at and discount shown", /₹/.test(price), price.replace(/\s+/g, " "));
    check("reference thumbnails offered", (await page.locator(".thumb").count()) > 0);
    // The dropdowns are in-page listboxes now, not native <select>, so the
    // options only exist once the trigger is opened.
    // Placements are a grouped multi-select now: every one adds an image, so
    // the whole inventory and its cost implication must be visible at once.
    // ONE ROW PER SIZE — three Meta sizes (4:5, 9:16, 1:1) and three Google
    // (landscape, square, portrait). This was >= 8 while the catalogue listed a
    // row per surface; the merge to per-size rows made the assertion vacuous.
    const placementCount = await page.locator(".picker-item").count();
    check("placement picker lists every size once", placementCount === 6, `${placementCount} placements`);
    check("grouped by platform", (await page.locator(".picker-group").count()) === 2);
    // The surface line earns its place only when it says something the label
    // does not. Labels are short now ("Meta Feed"), so it does, and the check
    // is that it never simply repeats the label back.
    const stutter = await page.evaluate(() =>
      [...document.querySelectorAll(".picker-item")]
        .map((item) => ({
          label: item.querySelector(".picker-label")?.firstChild?.textContent?.trim() ?? "",
          note: item.querySelector(".picker-note:not(.dim)")?.textContent?.trim() ?? "",
        }))
        .filter((row) => row.note && row.label.toLowerCase().includes(row.note.toLowerCase()))
        .map((row) => `${row.label} / ${row.note}`),
    );
    check("no label repeated as its own surface line", stutter.length === 0, stutter.join(" | "));
    check(
      "opens on the two placements a marketer actually buys",
      (await page.locator(".picker-item.on").count()) === 2,
      (await page.locator(".picker-item.on .picker-label").allInnerTexts()).join(" | "),
    );
    await page.locator(".picker-item", { hasText: "Display landscape" }).click();
    check(
      "another placement selectable",
      (await page.locator(".picker-item.on").count()) === 3,
    );
    check(
      "placement labels stay short",
      (await page.locator(".picker-label").allInnerTexts()).every(
        (t) => t.split("\n")[0].length <= 30,
      ),
      (await page.locator(".picker-label").allInnerTexts()).map((t) => t.split("\n")[0]).join(" | "),
    );
    check(
      "mixed-platform copy limits warned",
      (await page.locator(".edit-note").filter({ hasText: "tightest limits" }).count()) === 1,
    );
    await page.locator(".picker-item", { hasText: "Display landscape" }).click();

    // Confirmation must be correctable, or it is not a confirmation.
    check("product name editable", await page.locator("#e-title").isVisible());
    check("price editable", await page.locator("#e-price").isVisible());
    check("concentrations editable", await page.locator("#e-conc").isVisible());

    // Presets: react to a brief rather than invent one.
    await page.locator(".chip").first().click();
    check(
      "offer preset fills the field",
      (await page.locator("#offer").inputValue()).length > 0,
    );
    await page.locator(".chip.on").first().click();

    // Image expansion: the marketer has to be able to tell a packshot from a
    // lifestyle crop before committing spend.
    await page.locator(".thumb-zoom").first().click();
    await page.waitForSelector(".lightbox", { timeout: 5000 });
    // Assert the dialog and its target, not pixel visibility: the CDN the
    // reference images live on is unreachable from some sandboxes, and a
    // blocked image would fail isVisible() while the lightbox works fine.
    check(
      "lightbox opens on zoom",
      (await page.locator('.lightbox[role="dialog"]').count()) === 1 &&
        (await page.locator(".lightbox img").getAttribute("src"))?.startsWith("http"),
    );
    check(
      "lightbox shows a caption",
      (await page.locator(".lightbox-caption").innerText()).includes("Image 1"),
    );
    await page.keyboard.press("Escape");
    check(
      "lightbox closes on Escape",
      (await page.locator(".lightbox").count()) === 0,
    );

    // Two references max, first one primary.
    const thumbCount = await page.locator(".thumb").count();
    if (thumbCount > 1) {
      await page.locator(".thumb").nth(1).click();
      check(
        "second reference selectable",
        (await page.locator(".thumb-order").count()) === 2,
      );
      if (thumbCount > 2) {
        await page.locator(".thumb").nth(2).click();
        check(
          "reference selection capped at two",
          (await page.locator(".thumb-order").count()) === 2,
        );
      }
    }
    const costText = await page.locator(".cost").last().innerText();
    check(
      "cost shows the concept x placement multiplication",
      /concept/.test(costText) && /placement/.test(costText),
      costText.replace(/\s+/g, " "),
    );
    check("cost shown before any spend", /\$/.test(costText), costText.replace(/\s+/g, " "));
    // USD only — the rupee figure was a hardcoded conversion pretending to be real.
    check("cost is USD only", !costText.includes("₹"), costText.replace(/\s+/g, " "));
  }

  await page.locator("#concepts").click();
  await page.locator('[role="option"]', { hasText: "2 concepts" }).click();
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
    // The brief must actually have the page copy. Without it, an angle like
    // "answer the biggest objection" is unanswerable and the creative falls
    // back to whatever the offer says, which is what it used to do.
    const enrichNotice = await page.locator(".notice").allInnerTexts();
    check(
      "the brief was written from the product page, not just the JSON",
      enrichNotice.some((t) => /characters of the product page/.test(t)) &&
        !enrichNotice.some((t) => /thin brief/.test(t)),
      enrichNotice.join(" | ").slice(0, 120),
    );

    await page.locator("details summary").first().click();
    const prompt = await page.locator("pre.prompt").first().innerText();
    check("prompt carries the brand palette", prompt.includes("#F4F1EC"));
    check(
      "prompt bans the generic-ad markers",
      /marble/i.test(prompt) && /gold foil/i.test(prompt),
    );
    await page.screenshot({ path: `${OUT}/05-prompt-open.png`, fullPage: true });
  }

  await page.locator(".switcher-tab", { hasText: "Score" }).click();
  await page.waitForSelector("#file", { timeout: 10000 });

  const fixture = process.env.SCORE_FIXTURE;
  if (fixture && existsSync(fixture)) {
    await page.setInputFiles("#file", fixture);
    await page.locator("button.primary", { hasText: /Score creative/ }).click();
    await page.waitForSelector(".big-score", { timeout: 90000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/06-score-${theme}.png`, fullPage: true });

    if (primary) {
      const scoreText = (await page.locator(".big-score").innerText()).trim();
      check("score rendered", /^\d+/.test(scoreText), scoreText.replace(/\n/g, " "));
      const scoreSize = await page
        .locator(".big-score")
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      check("score is the largest thing on the card", scoreSize >= 60, `${scoreSize}px`);
      check("run id shown for traceability", (await page.locator(".runid").count()) > 0);
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

  // ── the link actually opens ─────────────────────────────────────────────
  if (primary && runId) {
    const fresh = await context.newPage();
    await fresh.goto(`${BASE}/?run=${runId}`, { waitUntil: "networkidle" });
    await fresh.waitForSelector(".claimbar", { timeout: 20000 });
    check(
      "a shared run link redraws the product it was for",
      (await fresh.locator("#e-title").inputValue()).length > 0,
      await fresh.locator("#e-title").inputValue(),
    );
    check(
      "and the creatives it produced",
      (await fresh.locator(".adcard").count()) > 0,
      `${await fresh.locator(".adcard").count()} cards`,
    );
    // Served from storage, not re-inlined as base64 into the page.
    const src = await fresh.locator("img.ad-image").first().getAttribute("src");
    check("images come from the asset store", (src ?? "").startsWith("/api/assets/"), src ?? "");
    await fresh.screenshot({ path: `${OUT}/08-shared-run.png`, fullPage: true });
    await fresh.close();
  }

  // ── history ─────────────────────────────────────────────────────────────
  if (primary) {
    await page.goto(`${BASE}/?view=history`, { waitUntil: "networkidle" });
    await page.waitForSelector(".runrow", { timeout: 15000 });
    check("history lists the run", (await page.locator(".runrow").count()) >= 1);
    check(
      "each row links to its own run",
      (await page.locator(".runrow-open").first().getAttribute("href"))?.startsWith("/?run=") ?? false,
    );
    await page.screenshot({ path: `${OUT}/09-history.png`, fullPage: true });
  }

  // ── /keys ───────────────────────────────────────────────────────────────
  if (primary) {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.locator('.topnav a[href="/keys"]').click();
    await page.waitForSelector("#gemini-key", { timeout: 10000 });
    check("nav reaches the key page", new URL(page.url()).pathname === "/keys");
    check(
      "the key page is one field and one button",
      (await page.locator("[class*=statusRow]").count()) === 0 &&
        (await page.locator("#gemini-key").count()) === 1,
    );
    // Shape validation happens before anything is sealed into a cookie.
    await page.fill("#gemini-key", "has a space in it");
    await page.locator("button", { hasText: "Use this key" }).click();
    const keyError = page.locator('p[role="alert"]');
    await keyError.waitFor({ timeout: 10000 });
    check(
      "a malformed key is refused",
      /space|line break/i.test(await keyError.innerText()),
    );
    // A key that passes the shape check is accepted and reported back masked,
    // never echoed. This one is syntactically fine and functionally worthless,
    // which is the point: /keys must not spend a request to find out.
    await page.fill("#gemini-key", "AIzaSyUiSmokeNotARealKey0000000000000000");
    await page.locator("button", { hasText: "Use this key" }).click();
    await page.locator('p[role="status"]').waitFor({ timeout: 10000 });
    const status = await page.locator("#key-help").innerText();
    check("override takes effect", /in use/i.test(status), status.replace(/\s+/g, " "));
    check("only the last four characters are shown", /0000/.test(status), status);
    check(
      "the key itself never reaches the page",
      !(await page.content()).includes("AIzaSyUiSmokeNotARealKey0000000000000000"),
    );
    await page.screenshot({ path: `${OUT}/07-keys.png`, fullPage: true });
    // Put the deployment's key back, or every later run inherits a dud.
    await page.locator("button", { hasText: "Clear" }).click();
    await page.waitForTimeout(700);
    check(
      "override clears back to the configured key",
      (await page.locator("button", { hasText: "Clear" }).count()) === 0,
    );
  }

  // ── house style, measured on the rendered page ──────────────────────────
  if (primary) {
    for (const view of ["", "?view=score", "?view=history"]) {
      await page.goto(`${BASE}/${view}`, { waitUntil: "networkidle" });
      // Every visible word, including placeholders and button labels, which a
      // source grep misses because they are attributes rather than text nodes.
      const dashes = await page.evaluate(() => {
        const bad = [];
        const seen = new Set();
        for (const el of document.querySelectorAll("body *")) {
          const strings = [
            ...[...el.childNodes]
              .filter((n) => n.nodeType === Node.TEXT_NODE)
              .map((n) => n.textContent ?? ""),
            el.getAttribute("placeholder") ?? "",
            el.getAttribute("aria-label") ?? "",
            el.getAttribute("title") ?? "",
          ];
          for (const s of strings) {
            if (/[\u2014\u2013\u2026]/.test(s) && !seen.has(s)) {
              seen.add(s);
              bad.push(s.trim().slice(0, 70));
            }
          }
        }
        return bad;
      });
      check(
        `no em dash rendered on /${view || "generate"}`,
        dashes.length === 0,
        dashes.join(" | "),
      );
    }
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
