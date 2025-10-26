import React, { useEffect, useMemo, useRef, useState } from "react";
import '../css/DestinationAutocomplete.css';

type Place = {
  id: string;
  label: string;
  lat: string;
  lon: string;
};

type Props = {
  value: string;
  onChange: (val: string) => void;
  onSelect?: (place: Place) => void;
  placeholder?: string;
  disabled?: boolean;
};

const debounce = (fn: (...a: any[]) => void, ms = 250) => {
  let t: number | undefined;
  return (...args: any[]) => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  };
};

const DestinationAutocomplete: React.FC<Props> = ({
  value,
  onChange,
  onSelect,
  placeholder = "Where you going?",
  disabled,
}) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Place[]>([]);
  const [active, setActive] = useState<number>(-1);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listId = useMemo(() => `list-${Math.random().toString(36).slice(2)}`, []);

  // Fetch suggestions (debounced)
  const doSearch = useMemo(
    () =>
      debounce(async (q: string) => {
        if (!q.trim()) {
          setResults([]);
          setOpen(false);
          return;
        }
        setLoading(true);
        try {
          const url = new URL("https://nominatim.openstreetmap.org/search");
          url.searchParams.set("format", "jsonv2");
          url.searchParams.set("addressdetails", "1");
          url.searchParams.set("limit", "8");
          url.searchParams.set("q", q);

          const res = await fetch(url.toString(), {
            headers: {
              // Some browsers block custom UA; ok to omit.
              // Nominatim ToS asks for identifiable UA in production.
            },
          });
          const data = (await res.json()) as any[];
          const mapped: Place[] = data.map((d) => ({
            id: d.place_id?.toString() ?? crypto.randomUUID(),
            label: d.display_name as string,
            lat: d.lat,
            lon: d.lon,
          }));
          setResults(mapped);
          setOpen(mapped.length > 0);
          setActive(mapped.length ? 0 : -1);
        } catch {
          setResults([]);
          setOpen(false);
          setActive(-1);
        } finally {
          setLoading(false);
        }
      }, 250),
    []
  );

  useEffect(() => {
    doSearch(value);
  }, [value, doSearch]);

  // Close on outside click
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const handleKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      setOpen(results.length > 0);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : -1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0 && results[active]) {
        const p = results[active];
        onChange(p.label);
        onSelect?.(p);
        setOpen(false);
      } else if (results[0]) {
        const p = results[0];
        onChange(p.label);
        onSelect?.(p);
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const select = (p: Place) => {
    onChange(p.label);
    onSelect?.(p);
    setOpen(false);
  };

  return (
    <div className="auto-wrap" ref={wrapRef}>
      <input
        type="text"
        className="auto-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
      />
      {open && (
        <div className="auto-dropdown">
          {loading && <div className="auto-status">Searching…</div>}
          {!loading && results.length === 0 && (
            <div className="auto-status">No matches</div>
          )}
          {!loading && results.length > 0 && (
            <ul id={listId} role="listbox" className="auto-list">
              {results.map((r, i) => (
                <li
                  key={r.id}
                  role="option"
                  aria-selected={i === active}
                  className={`auto-item ${i === active ? "active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    // prevent input blur before click
                    e.preventDefault();
                    select(r);
                  }}
                >
                  <span className="auto-primary">{r.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default DestinationAutocomplete;
