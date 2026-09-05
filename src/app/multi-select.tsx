"use client";

import type { PlacementSpec } from "../../config/placements";

/**
 * Placement picker.
 *
 * Rendered as a grouped checkbox list rather than a dropdown: a marketer needs
 * to see the whole inventory and its trade-offs at once, and every selection
 * multiplies cost by one image. Hiding that behind a collapsed control makes
 * the expensive choice the invisible one.
 *
 * Grouped by platform because the two have genuinely different constraints —
 * Google's 30-character headline governs the copy the moment a Google placement
 * is in the selection.
 */
export function PlacementPicker({
  placements,
  selected,
  onChange,
}: {
  placements: PlacementSpec[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const groups: Array<{ platform: string; label: string; items: PlacementSpec[] }> = [
    {
      platform: "meta",
      label: "Meta",
      items: placements.filter((p) => p.platform === "meta"),
    },
    {
      platform: "google",
      label: "Google",
      items: placements.filter((p) => p.platform === "google"),
    },
  ];

  function toggle(id: string) {
    if (selected.includes(id)) {
      // At least one placement must remain — an empty selection has nothing
      // to render and no sensible default at this point in the flow.
      if (selected.length === 1) return;
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  }

  return (
    <fieldset className="picker">
      <legend>Placements — each adds one image per concept</legend>
      {groups.map((group) => (
        <div className="picker-group" key={group.platform}>
          <p className="picker-platform">{group.label}</p>
          <div className="picker-items">
            {group.items.map((placement) => {
              const on = selected.includes(placement.id);
              return (
                <label
                  className={`picker-item${on ? " on" : ""}`}
                  key={placement.id}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(placement.id)}
                  />
                  <span className="picker-body">
                    <span className="picker-label">
                      {placement.label}
                      <span className="picker-dims">
                        {placement.width}×{placement.height} · {placement.ratio}
                      </span>
                    </span>
                    <span className="picker-note">{placement.surface}</span>
                    {placement.note && (
                      <span className="picker-note dim">{placement.note}</span>
                    )}
                    {placement.safeZone && (
                      <span className="picker-safe">{placement.safeZone}</span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </fieldset>
  );
}

/**
 * One-click presets that fill a field the user can then edit.
 *
 * A blank input asks someone to invent a brief from nothing; a chip asks them
 * to react to one, which is a far easier job and produces better input.
 */
export function Chips({
  options,
  onPick,
  active,
}: {
  options: readonly string[];
  onPick: (value: string) => void;
  active?: string;
}) {
  return (
    <div className="chips">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={`chip${active === option ? " on" : ""}`}
          onClick={() => onPick(active === option ? "" : option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
