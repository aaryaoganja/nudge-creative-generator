"use client";

import { useState } from "react";
import { GeneratePanel } from "./generate-panel";
import { ScorePanel } from "./score-panel";

export default function Home() {
  const [tab, setTab] = useState<"generate" | "score">("generate");

  return (
    <div className="shell">
      <header className="masthead">
        <h1>Minimalist Ad Studio</h1>
        <p className="sub">
          Paste a product URL. Everything else is read from the page.
        </p>
        <div className="tabs" role="tablist">
          <button
            className="tab"
            role="tab"
            aria-selected={tab === "generate"}
            onClick={() => setTab("generate")}
          >
            Generate
          </button>
          <button
            className="tab"
            role="tab"
            aria-selected={tab === "score"}
            onClick={() => setTab("score")}
          >
            Score a creative
          </button>
        </div>
      </header>

      {tab === "generate" ? <GeneratePanel /> : <ScorePanel />}
    </div>
  );
}
