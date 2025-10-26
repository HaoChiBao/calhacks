import React, { useEffect, useMemo, useRef, useState } from "react";
import '../css/DurationRangePicker.css';

type Range = { start: Date | null; end: Date | null };

type Props = {
  value: Range;
  onChange: (next: Range) => void;
  placeholder?: string;
  disabled?: boolean;
  minDate?: Date; // default: today
};

const fmt = (d: Date) =>
  d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

const addMonths = (d: Date, m: number) => {
  const nd = new Date(d);
  nd.setMonth(nd.getMonth() + m);
  return nd;
};

const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const isBetween = (d: Date, a: Date, b: Date) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const s = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const e = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return x > s && x < e;
};

const daysInMonthMatrix = (month: Date) => {
  const start = startOfMonth(month);
  const end = endOfMonth(month);
  const startWeekday = (start.getDay() + 6) % 7; // make Monday=0, Airbnb-ish
  const totalDays = end.getDate();

  const cells: (Date | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let day = 1; day <= totalDays; day++) {
    cells.push(new Date(month.getFullYear(), month.getMonth(), day));
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const rows: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
};

const nightsBetween = (a: Date, b: Date) =>
  Math.max(0, Math.round((+b - +a) / (1000 * 60 * 60 * 24)));

const DurationRangePicker: React.FC<Props> = ({
  value,
  onChange,
  placeholder = "How long you staying?",
  disabled,
  minDate,
}) => {
  const today = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);
  const min = useMemo(() => (minDate ? new Date(minDate) : today), [minDate, today]);

  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<Date>(startOfMonth(today)); // month shown on left
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // close on outside click
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const commit = (start: Date | null, end: Date | null) => {
    onChange({ start, end });
  };

  const clickDay = (d: Date) => {
    if (d < min) return;
    const { start, end } = value;
    if (!start || (start && end)) {
      // start a new range
      commit(d, null);
      return;
    }
    // we have start but no end
    if (d < start) {
      // swap so start <= end
      commit(d, start);
    } else if (sameDay(d, start)) {
      // single day not allowed -> do nothing, or set end=start+1
      const next = new Date(d);
      next.setDate(d.getDate() + 1);
      commit(start, next);
    } else {
      commit(start, d);
      setOpen(false);
    }
  };

  const label = useMemo(() => {
    const { start, end } = value;
    if (start && end) {
      const nights = nightsBetween(start, end);
      return `${fmt(start)} – ${fmt(end)} · ${nights} night${nights === 1 ? "" : "s"}`;
    }
    return "";
  }, [value]);

  const Month = ({ base }: { base: Date }) => {
    const rows = daysInMonthMatrix(base);
    const monthLabel = base.toLocaleDateString(undefined, { month: "long", year: "numeric" });

    return (
      <div className="drp-month">
        <div className="drp-month-h">{monthLabel}</div>
        <div className="drp-grid drp-dow">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="drp-dow-cell">{d}</div>
          ))}
        </div>
        <div className="drp-grid">
          {rows.flatMap((row, ri) =>
            row.map((cell, ci) => {
              if (!cell) return <div key={`e-${ri}-${ci}`} className="drp-cell empty" />;
              const disabledCell = cell < min;
              const isStart = value.start && sameDay(cell, value.start);
              const isEnd = value.end && sameDay(cell, value.end);
              const inRange =
                value.start && value.end ? isBetween(cell, value.start, value.end) : false;

              const cls = [
                "drp-cell",
                disabledCell ? "disabled" : "",
                isStart ? "start" : "",
                isEnd ? "end" : "",
                inRange ? "inrange" : "",
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <button
                  key={`d-${ri}-${ci}`}
                  type="button"
                  className={cls}
                  disabled={disabledCell}
                  onClick={() => clickDay(cell)}
                >
                  {cell.getDate()}
                </button>
              );
            })
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="auto-wrap" ref={wrapRef}>
      <input
        type="text"
        className="auto-input"
        placeholder={placeholder}
        value={label}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        readOnly
        disabled={disabled}
        aria-expanded={open}
      />
      {open && (
        <div className="auto-dropdown drp-dropdown">
          <div className="drp-head">
            <button
              type="button"
              className="drp-nav"
              onClick={() => setCursor((c) => addMonths(c, -1))}
              aria-label="Previous month"
            >
              ‹
            </button>
            <div className="drp-spacer" />
            <button
              type="button"
              className="drp-nav"
              onClick={() => setCursor((c) => addMonths(c, 1))}
              aria-label="Next month"
            >
              ›
            </button>
          </div>

          <div className="drp-months">
            <Month base={cursor} />
            <Month base={addMonths(cursor, 1)} />
          </div>

          <div className="drp-footer">
            <button
              type="button"
              className="drp-clear"
              onClick={() => commit(null, null)}
            >
              Clear
            </button>
            <div className="drp-summary">
              {value.start && !value.end && "Select checkout date"}
              {value.start && value.end && `${nightsBetween(value.start, value.end)} night(s)`}
              {!value.start && !value.end && "Select dates"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DurationRangePicker;
