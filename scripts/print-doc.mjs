/**
 * Render a print-styled HTML document to PDF and assert its page count.
 *
 *   node scripts/print-doc.mjs docs/decision-doc.print.html docs/02-DECISION-DOC.pdf 1
 *
 * The decision doc is capped at one page by the assignment brief. Markdown has
 * no pages, so "one page" is otherwise a hope about whichever exporter the
 * reader happens to use. This renders it in Chromium, which paginates the same
 * way every time, and exits non-zero if the result is longer than the cap. That
 * turns the constraint into something checkable rather than something asserted.
 *
 * Page counting reads the PDF's own page tree rather than shelling out to
 * pdfinfo, which is not installed here. A linearised Chromium PDF always writes
 * an explicit /Count on the root Pages node, and the /Type /Page objects are a
 * second reading of the same number; disagreement means the assumption broke and
 * is worth failing on rather than guessing through.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

// Same resolution as scripts/ui-smoke.mjs: the bundled build Playwright expects
// is not always the build that is installed, and downloading another copy of
// Chromium to render one page of A4 is not a reasonable trade.
const CHROMIUM =
  process.env.CHROMIUM_PATH ??
  ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));

const [input, output, maxPagesRaw] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node scripts/print-doc.mjs <input.html> <output.pdf> [maxPages]");
  process.exit(2);
}
const maxPages = Number(maxPagesRaw ?? 0) || null;

function countPages(buffer) {
  const text = buffer.toString("latin1");
  const counts = [...text.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)].map((m) =>
    Number(m[1]),
  );
  const leaves = [...text.matchAll(/\/Type\s*\/Page[^s]/g)].length;
  const declared = counts.length ? Math.max(...counts) : null;
  if (declared !== null && leaves > 0 && declared !== leaves) {
    throw new Error(`page count is ambiguous: /Count says ${declared}, ${leaves} page objects found`);
  }
  const pages = declared ?? leaves;
  if (!pages) throw new Error("could not determine the page count from the PDF");
  return pages;
}

const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(input).href, { waitUntil: "networkidle" });
  const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    // Margins live in the document's own @page rule, so the two cannot drift.
    preferCSSPageSize: true,
  });
  await writeFile(output, pdf);

  const pages = countPages(await readFile(output));
  const size = (pdf.byteLength / 1024).toFixed(0);
  console.log(`${output}: ${pages} page(s), ${size}KB`);

  if (maxPages && pages > maxPages) {
    console.error(`FAIL: ${pages} pages, limit is ${maxPages}. Tighten the layout.`);
    process.exit(1);
  }
  if (maxPages) console.log(`OK: within the ${maxPages}-page limit.`);
} finally {
  await browser.close();
}
