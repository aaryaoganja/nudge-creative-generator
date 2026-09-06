# The submission

Four deliverables, in the order the brief asks for them.

| # | Deliverable | Read this |
| --- | --- | --- |
| 1 | The working app | [`01-RUNNING-IT.md`](01-RUNNING-IT.md) |
| 2 | Build record | The repo's commit history, plus the agent transcript submitted separately |
| 3 | Decision doc | [`02-DECISION-DOC.pdf`](02-DECISION-DOC.pdf), one page |
| 4 | Failure modes | [`03-FAILURE-MODES.pdf`](03-FAILURE-MODES.pdf) |

## Why there are PDFs

The brief caps the decision doc at one page. Markdown has no pages, so on its own
"one page" is a hope about whichever exporter the reader happens to open it in.

The markdown files are the readable source of truth and the thing to review in a
diff. The PDFs are rendered from `*.print.html` by Chromium, which paginates
identically everywhere, and `scripts/print-doc.mjs` fails the build if the
decision doc comes out longer than one page. The constraint is therefore checked
rather than asserted:

    npm run docs:pdf

The content of each PDF is identical to its markdown counterpart. Only the
typography differs.

## The rest of the documentation

- [`../README.md`](../README.md) is the product: what it does and why it is
  strict about the two things it is strict about.
- [`../AGENTS.md`](../AGENTS.md) is how to change it without breaking those.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`PLAN.md`](PLAN.md) are working
  documents from the build, kept rather than tidied away.
