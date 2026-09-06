"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Dropdown rendered inside the page.
 *
 * A native <select> draws its option list with the operating system, so it
 * ignores the app's palette entirely and looks pasted-on — especially in dark
 * mode, where macOS and Windows render a light popup over a dark page.
 *
 * Keyboard and screen-reader behaviour is implemented rather than inherited:
 * ArrowUp/Down move the active option, Enter and Space commit, Escape cancels,
 * Home and End jump, and the trigger carries the listbox relationship. Anything
 * less would be a downgrade on the native control it replaces.
 */

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

export interface SelectProps {
  id?: string;
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function Select({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
}: SelectProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const listId = `${controlId}-listbox`;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((option) => option.value === value),
    ),
  );
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function commit(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (disabled) return;

    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (event.key) {
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
      case "ArrowDown":
        event.preventDefault();
        setActive((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(active);
        break;
    }
  }

  return (
    <div className="field">
      <label id={`${controlId}-label`} htmlFor={controlId}>
        {label}
      </label>
      <div className="select" ref={rootRef}>
        <button
          type="button"
          id={controlId}
          className="select-trigger"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-haspopup="listbox"
          aria-labelledby={`${controlId}-label ${controlId}`}
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            setActive(
              Math.max(
                0,
                options.findIndex((option) => option.value === value),
              ),
            );
            setOpen((v) => !v);
          }}
          onKeyDown={onKeyDown}
        >
          <span>{selected?.label ?? "Select"}</span>
          {selected?.hint && <span className="select-hint">{selected.hint}</span>}
          <span className="select-caret" aria-hidden="true" />
        </button>

        {open && (
          <ul className="select-list" id={listId} role="listbox" tabIndex={-1}>
            {options.map((option, index) => (
              <li
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                className={`select-option${index === active ? " active" : ""}`}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(index);
                }}
              >
                <span>{option.label}</span>
                {option.hint && <span className="select-hint">{option.hint}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
