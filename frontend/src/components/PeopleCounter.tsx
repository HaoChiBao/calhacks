import React, { useEffect, useMemo, useRef, useState } from "react";
import '../css/PeopleCounter.css';

type Props = {
  value: number;
  onChange: (n: number) => void;
  min?: number; // default 1
  max?: number; // default 16
  disabled?: boolean;
  placeholder?: string; // shown when value is falsy
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const PeopleCounter: React.FC<Props> = ({
  value,
  onChange,
  min = 1,
  max = 16,
  disabled,
  placeholder = "How many people staying?",
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const display = useMemo(() => {
    if (!Number.isFinite(value) || value <= 0) return "";
    return `${value} guest${value === 1 ? "" : "s"}`;
  }, [value]);

  // close on outside click
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const step = (delta: number) => {
    if (disabled) return;
    const base = Number.isFinite(value) && value > 0 ? value : min;
    onChange(clamp(base + delta, min, max));
  };

  return (
    <div className="auto-wrap" ref={wrapRef}>
      {/* Readonly summary input opens the dropdown */}
      <input
        type="text"
        className="auto-input"
        readOnly
        disabled={disabled}
        placeholder={display || placeholder}
        value={display}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-haspopup="listbox"
      />

      {open && (
        <div className="auto-dropdown qty-pop">
          <div className="qty-row">
            <div className="qty-label">
              Guests
              <span className="qty-sub">Ages 13+</span>
            </div>

            <div className="qty-ctrls">
              <button
                type="button"
                className="qty-btn"
                aria-label="Decrease guests"
                onClick={() => step(-1)}
                disabled={disabled || (Number.isFinite(value) && value <= min)}
              >
                –
              </button>

              <div className="qty-count" aria-live="polite">
                {Number.isFinite(value) && value > 0 ? value : min}
              </div>

              <button
                type="button"
                className="qty-btn"
                aria-label="Increase guests"
                onClick={() => step(+1)}
                disabled={disabled || (Number.isFinite(value) && value >= max)}
              >
                +
              </button>
            </div>
          </div>

          <div className="qty-footer">
            <button
              type="button"
              className="drp-clear"
              onClick={() => onChange(min)}
              disabled={disabled}
            >
              Reset
            </button>
            <button
              type="button"
              className="qty-done"
              onClick={() => setOpen(false)}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PeopleCounter;
