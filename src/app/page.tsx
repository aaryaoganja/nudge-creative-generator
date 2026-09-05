"use client";

import { useState } from "react";
import { GeneratePanel } from "./generate-panel";
import { ScorePanel } from "./score-panel";

type Tab = "generate" | "score";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "generate", label: "Generate" },
  { id: "score", label: "Score a creative" },
];

export default function Home() {
  const [tab, setTab] = useState<Tab>("generate");

  return (
    <div className="shell">
      {/*
        A div, not a <header>: the top nav is already this document's banner
        landmark, and a second one turns "jump to the banner" into a choice.

        The heading names the BRAND this studio makes ads for. It used to read
        "Minimalist Ad Studio", which put a third product name on screen beside
        "Ad Studio" in the nav and "Ad Studio by Nudge" in the tab — three names
        for two things.
      */}
      <div className="masthead">
        <h1>Minimalist</h1>
        <p className="sub">
          Paste a product URL. Everything else is read from the page.
        </p>
        {/*
          A real tablist: role="tab" without aria-controls and a matching
          role="tabpanel" announces "tab, 1 of 2" and then leaves the user with
          no way to find what it selected. tabIndex follows the roving pattern —
          only the selected tab is in the sequential tab order, and Left/Right
          move between them, which is what a screen-reader user is told to
          expect the moment the role is applied.
        */}
        <div className="tabs" role="tablist" aria-label="Studio mode">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              className="tab"
              role="tab"
              id={`tab-${id}`}
              type="button"
              aria-selected={tab === id}
              aria-controls={`panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const at = TABS.findIndex((t) => t.id === tab);
                const step = event.key === "ArrowRight" ? 1 : -1;
                const next = TABS[(at + step + TABS.length) % TABS.length];
                setTab(next.id);
                document.getElementById(`tab-${next.id}`)?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/*
        No tabIndex: the APG puts a tabpanel in the tab sequence only when it
        holds nothing focusable, and both of these open on a form field.
      */}
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "generate" ? <GeneratePanel /> : <ScorePanel />}
      </div>
    </div>
  );
}
