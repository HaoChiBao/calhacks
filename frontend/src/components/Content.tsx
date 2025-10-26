import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';
import LocationBlock from './LocationBlock';
import DestinationAutocomplete from '../components/DestinationAutocomplete';
import DurationRangePicker from '../components/DurationRangePicker';
import PeopleCounter from '../components/PeopleCounter';
import type { StrictPlanDays } from '../types/plan';
import '../css/Content.css';
import '../css/Chat.css';

type View = 'Map' | 'Calendar';
type Range = { start: Date | null; end: Date | null };

const fallbackCenter = { lat: 43.6532, lng: -79.3832 };
const MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string;
const MAP_ID = import.meta.env.VITE_GOOGLE_MAP_ID as string | undefined;

const PAGE_SIZE = 4;

type ContentProps = {
  hideContent?: boolean;

  setHideBooking: (hidden: boolean) => void;

  destination: string;
  onDestinationChange: (s: string) => void;
  onDestinationSelect?: (coords: { lat: string; lon: string }) => void;

  duration: Range;
  onDurationChange: (r: Range) => void;

  who: number;
  onWhoChange: (n: number) => void;

  planDays: StrictPlanDays;
  setPlanDays: React.Dispatch<React.SetStateAction<StrictPlanDays>>;

  coords?: { lat: string; lon: string } | null;
};

type GeocodeCacheKey = string;
type GeocodeHit = {
  lat: number;
  lng: number;
  id?: string;
  name?: string;
  address?: string;
  uri?: string;
  photoUrl?: string;
};

type DragData = { title: string; short_description: string; estimated_cost?: string };
type DropTarget = { day: number; index: number } | null;

type DragState = {
  fromDay: number;
  fromIndex: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
  key: string;
  data: DragData;
  pointerId: number;
  originEl: HTMLElement | null;
} | null;

const Content: React.FC<ContentProps> = ({
  hideContent,
  setHideBooking,
  destination,
  onDestinationChange,
  onDestinationSelect,
  duration,
  onDurationChange,
  who,
  onWhoChange,
  planDays,
  setPlanDays,
  coords,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<View>('Map');
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  const [currentDay, setCurrentDay] = useState<number>(0);
  const [pageStart, setPageStart] = useState<number>(0);

  const [map, setMap] = useState<google.maps.Map | null>(null);
  const markerRefs = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const geocodeCache = useRef<Map<GeocodeCacheKey, GeocodeHit>>(new Map());
  const [photoByKey, setPhotoByKey] = useState<Record<string, string | undefined>>({});

  // ----- Absolute drag state -----
  const [drag, setDrag] = useState<DragState>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);

  // All drop-slot refs for hit-testing
  const slotRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const setSlotRef =
    (day: number, index: number) =>
    (el: HTMLDivElement | null): void => {
      slotRefs.current.set(`${day}:${index}`, el);
    };

  // Update target from pointer
  const updateDropTargetFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      let best: DropTarget | any = null;
      let bestScore = Infinity;

      slotRefs.current.forEach((el, key) => {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const withinX = clientX >= rect.left && clientX <= rect.right;
        const dy = Math.abs(clientY - (rect.top + rect.height / 2));
        const penalty = withinX ? 0 : 40;
        const score = dy + penalty;

        if (score < bestScore) {
          const [d, i] = key.split(':').map((n) => Number.parseInt(n, 10));
          if (!Number.isNaN(d) && !Number.isNaN(i)) {
            bestScore = score;
            best = { day: d, index: i };
          }
        }
      });

      if (best && (dropTarget?.day !== best.day || dropTarget?.index !== best.index)) {
        setDropTarget(best);
      }
    },
    [dropTarget]
  );

  const onPointerDownItem =
    (realDayIdx: number, itemIdx: number, data: DragData) =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (view !== 'Calendar') return;
      e.preventDefault();

      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();

      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      const key = `${data.title}__${data.short_description}`;

      // capture pointer on the wrapper so it gets all move events
      el.setPointerCapture?.(e.pointerId);

      setDrag({
        fromDay: realDayIdx,
        fromIndex: itemIdx,
        width: rect.width,
        height: rect.height,
        offsetX,
        offsetY,
        x: e.clientX,
        y: e.clientY,
        key,
        data,
        pointerId: e.pointerId,
        originEl: el,
      });

      // global listeners so mouse up outside still drops
      const handleWinMove = (me: PointerEvent) => {
        setDrag((d) => (d ? { ...d, x: me.clientX, y: me.clientY } : d));
        updateDropTargetFromPointer(me.clientX, me.clientY);
      };
      const handleWinUp = () => {
        onGlobalPointerUp();
      };
      window.addEventListener('pointermove', handleWinMove);
      window.addEventListener('pointerup', handleWinUp, { once: true });

      // stash cleanup on element
      (el as any).__dragCleanup = () => {
        window.removeEventListener('pointermove', handleWinMove);
        window.removeEventListener('pointerup', handleWinUp);
      };
    };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const nx = e.clientX;
    const ny = e.clientY;
    setDrag((d) => (d ? { ...d, x: nx, y: ny } : d));
    updateDropTargetFromPointer(nx, ny);
  };

  // Called by window listener, ensures cleanup and move logic
  const onGlobalPointerUp = () => {
    if (!drag) return;

    // cleanup listeners/capture
    try {
      drag.originEl?.releasePointerCapture?.(drag.pointerId);
    } catch {}
    const all = document.querySelectorAll('.draggable-wrapper');
    all.forEach((node: any) => {
      if (node && node.__dragCleanup) {
        try {
          node.__dragCleanup();
          node.__dragCleanup = undefined;
        } catch {}
      }
    });

    // compute final target + update plan
    const finalTarget = computeFinalTarget(drag, dropTarget, planDays);
    const crossDay = finalTarget.day !== drag.fromDay;

    if (crossDay) {
      // ✅ TRUE MOVE across days (remove from source, insert into target)
      performCrossDayMove(
        { day: drag.fromDay, index: drag.fromIndex },
        finalTarget,
        drag.data
      );
    } else {
      // Same-day reorder
      performReorder(drag.fromDay, drag.fromIndex, finalTarget.index);
    }

    // If we dropped into another day page, snap currentDay to that page start (nice UX)
    if (view === 'Calendar' && finalTarget.day !== currentDay) {
      const aligned = Math.floor(finalTarget.day / PAGE_SIZE) * PAGE_SIZE;
      setPageStart(aligned);
    }

    setDrag(null);
    setDropTarget(null);
  };

  const onPointerUp = () => {
    // If global already handled, drag is null and this is a no-op
    if (drag) onGlobalPointerUp();
  };

  useEffect(() => {
    if (drag) {
      const prev = document.body.style.userSelect;
      document.body.style.userSelect = 'none';
      return () => {
        document.body.style.userSelect = prev;
      };
    }
  }, [drag]);

  const center = useMemo(() => {
    if (coords?.lat && coords?.lon) {
      const lat = parseFloat(coords.lat);
      const lng = parseFloat(coords.lon);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
    return fallbackCenter;
  }, [coords]);

  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: MAPS_API_KEY,
    libraries: ['marker'],
  });

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const nights =
    duration.start && duration.end
      ? Math.max(0, Math.round((+duration.end - +duration.start) / (1000 * 60 * 60 * 24)))
      : 0;

  const totalDays = planDays.length;

  useEffect(() => {
    if (currentDay > 0 && currentDay >= totalDays) {
      setCurrentDay(Math.max(0, totalDays - 1));
    }
  }, [totalDays, currentDay]);

  useEffect(() => {
    if (view === 'Calendar') {
      const aligned = Math.floor(currentDay / PAGE_SIZE) * PAGE_SIZE;
      if (aligned !== pageStart) setPageStart(aligned);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, currentDay]);

  useEffect(() => {
    const lastStart = Math.max(0, Math.floor(Math.max(0, totalDays - 1) / PAGE_SIZE) * PAGE_SIZE);
    if (pageStart > lastStart) setPageStart(lastStart);
  }, [pageStart, totalDays]);

  // ---- Map geocoding + pins ----
  useEffect(() => {
    if (!isLoaded || !map || view !== 'Map') return;
    if (!planDays || planDays.length === 0) return;

    const day = planDays[currentDay] || [];
    if (day.length === 0) {
      markerRefs.current.forEach((m) => (m.map = null));
      markerRefs.current = [];
      return;
    }

    let isCancelled = false;
    const centerBias = coords
      ? {
          lat: parseFloat(coords.lat),
          lng: parseFloat(coords.lon),
          radiusMeters: 2500,
        }
      : undefined;

    markerRefs.current.forEach((m) => (m.map = null));
    markerRefs.current = [];

    const createMarker = (position: google.maps.LatLngLiteral, label: string) => {
      const el = document.createElement('div');
      el.className = 'map-pin';
      el.textContent = label;

      const marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position,
        content: el,
        title: label,
      });
      markerRefs.current.push(marker);
      return marker;
    };

    const fitBounds = () => {
      if (markerRefs.current.length === 0) return;
      const b = new google.maps.LatLngBounds();
      markerRefs.current.forEach((m) => {
        const p = (m.position as google.maps.LatLngLiteral) || null;
        if (p) b.extend(p);
      });
      if (!b.isEmpty()) map.fitBounds(b, 64);
    };

    (async () => {
      for (let i = 0; i < day.length; i++) {
        const activity = day[i];
        const key: GeocodeCacheKey = `${activity.title}__${activity.short_description}`;
        let hit = geocodeCache.current.get(key);

        if (!hit) {
          const q =
            destination && destination.length > 0
              ? `${activity.title} ${destination}`
              : activity.title;

          try {
            const res = await fetch('http://localhost:8080/api/places/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query: q,
                locationBias: centerBias,
                maxResults: 2,
              }),
            });
            if (res.ok) {
              const { place } = (await res.json()) as {
                place?: {
                  id?: string;
                  displayName?: { text?: string };
                  formattedAddress?: string;
                  location?: { latitude: number; longitude: number };
                  googleMapsUri?: string;
                  photoUrl?: string;
                };
              };
              if (place?.location?.latitude && place?.location?.longitude) {
                hit = {
                  lat: place.location.latitude,
                  lng: place.location.longitude,
                  id: place.id,
                  name: place.displayName?.text,
                  address: place.formattedAddress,
                  uri: place.googleMapsUri,
                  photoUrl: place.photoUrl,
                };
                geocodeCache.current.set(key, hit);

                if (place.photoUrl) {
                  setPhotoByKey((prev) => {
                    if (prev[key] === place.photoUrl) return prev;
                    return { ...prev, [key]: place.photoUrl };
                  });
                }
              }
            }
          } catch {
            // ignore
          }
        } else {
          if (hit.photoUrl) {
            setPhotoByKey((prev) => {
              if (prev[key] === hit!.photoUrl) return prev;
              return { ...prev, [key]: hit!.photoUrl };
            });
          }
        }

        if (isCancelled) return;
        if (hit) {
          createMarker({ lat: hit.lat, lng: hit.lng }, String(i + 1));
          if (i === day.length - 1) fitBounds();
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [isLoaded, map, view, planDays, currentDay, coords, destination]);

  const label = view === 'Map' ? 'Map View' : 'Calendar View';

  const pageEnd = Math.min(pageStart + PAGE_SIZE, totalDays);
  const daysForPage = planDays.slice(pageStart, pageEnd);

  const canPrev = view === 'Map' ? currentDay > 0 : pageStart > 0;
  const canNext = view === 'Map' ? currentDay < totalDays - 1 : pageEnd < totalDays;

  const onPrev = () => {
    if (view === 'Map') {
      setCurrentDay((d) => Math.max(0, d - 1));
    } else {
      setPageStart((prev) => {
        const ns = Math.max(0, prev - PAGE_SIZE);
        setCurrentDay(ns);
        return ns;
      });
    }
  };

  const onNext = () => {
    if (view === 'Map') {
      setCurrentDay((d) => Math.min(Math.max(0, totalDays - 1), d + 1));
    } else {
      setPageStart((prev) => {
        const maxStart = Math.max(0, Math.floor(Math.max(0, totalDays - 1) / PAGE_SIZE) * PAGE_SIZE);
        const ns = Math.min(maxStart, prev + PAGE_SIZE);
        setCurrentDay(ns);
        return ns;
      });
    }
  };

  const switchToCalendar = () => {
    const aligned = Math.floor(currentDay / PAGE_SIZE) * PAGE_SIZE;
    setPageStart(aligned);
    setCurrentDay(aligned);
    setView('Calendar');
    setIsOpen(false);
  };

  const headerText =
    view === 'Map'
      ? totalDays > 0
        ? `Day ${currentDay + 1} of ${totalDays}`
        : nights > 0
        ? `Select a day (0/${nights})`
        : 'Select dates'
      : totalDays > 0
      ? `Days ${pageStart + 1}–${pageEnd} of ${totalDays}`
      : nights > 0
      ? `Select days (0/${nights})`
      : 'Select dates';

  // ---- Mutators ----
  // Same-day reorder (remove & insert)
  const performReorder = (day: number, fromIndex: number, toIndex: number) => {
    setPlanDays((prev) => {
      const copy = prev.map((d) => d.slice());
      if (!copy[day]) return prev;
      if (fromIndex < 0 || fromIndex >= copy[day].length) return prev;

      const [moved] = copy[day].splice(fromIndex, 1);
      const clamped = Math.max(0, Math.min(toIndex, copy[day].length));
      copy[day].splice(clamped, 0, moved);
      return copy;
    });
  };

  // ✅ Cross-day TRUE MOVE (remove from source, insert into target)
  const performCrossDayMove = (
    from: { day: number; index: number },
    to: { day: number; index: number },
    data: DragData
  ) => {
    setPlanDays((prev) => {
      const copy = prev.map((d) => d.slice());
      const src = copy[from.day];
      const dst = copy[to.day];
      if (!src || !dst) return prev;
      if (from.index < 0 || from.index >= src.length) return prev;

      // remove from source
      const [moved] = src.splice(from.index, 1);
      const insertIndex = Math.max(0, Math.min(to.index, dst.length));
      // insert moved item into destination
      dst.splice(insertIndex, 0, moved ?? { ...data });
      return copy;
    });
  };

  // Compute a safe final drop target if none/invalid
  const computeFinalTarget = (
    d: NonNullable<DragState>,
    t: DropTarget,
    days: StrictPlanDays
  ): { day: number; index: number } => {
    const fallback = { day: d.fromDay, index: d.fromIndex };
    if (!t) return fallback;
    const maxDay = Math.max(0, days.length - 1);
    const day = Math.max(0, Math.min(t.day, maxDay));
    const maxIndex = days[day] ? days[day].length : 0;
    const index = Math.max(0, Math.min(t.index, maxIndex));
    return { day, index };
  };

  const loadBookings = () => {
    setHideBooking(false);
  }

  return (
    <div className={`content-hub ${hideContent ? 'hidden' : ''}`}>
      <div className="info-bar">
        <div className="info">
          <p>Destination</p>
          <DestinationAutocomplete
            value={destination}
            onChange={onDestinationChange}
            onSelect={(p) => onDestinationSelect?.({ lat: p.lat, lon: p.lon })}
            placeholder="Where you going?"
          />
        </div>

        <div className="info">
          <p>Duration</p>
          <DurationRangePicker
            value={duration}
            onChange={onDurationChange}
            placeholder="How long you staying?"
          />
        </div>

        <div className="info">
          <p>Who</p>
          <PeopleCounter value={who} onChange={onWhoChange} min={1} max={16} />
        </div>

        <div className="booking">
          <p onClick = {loadBookings}>{"book your stay >"}</p>
        </div>
      </div>

      <div className="content-area" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <div className="menu">
          <div className="view">
            <p>{headerText}</p>
            <button aria-label="previous" onClick={onPrev} disabled={!canPrev}>
              {'<'}
            </button>
            <button aria-label="next" onClick={onNext} disabled={!canNext}>
              {'>'}
            </button>
          </div>

          <div className="toggle" ref={dropdownRef}>
            <button
              className="toggle-btn"
              aria-haspopup="listbox"
              aria-expanded={isOpen}
              onClick={() => setIsOpen((o) => !o)}
            >
              {label} <span className="chev">{isOpen ? '▲' : '▼'}</span>
            </button>

            {isOpen && (
              <ul className="toggle-menu" role="listbox" aria-label="Select view">
                <li role="option" aria-selected={view === 'Map'}>
                  <button
                    className="toggle-item"
                    onClick={() => {
                      setView('Map');
                      setIsOpen(false);
                    }}
                  >
                    Map View
                  </button>
                </li>
                <li role="option" aria-selected={view === 'Calendar'}>
                  <button className="toggle-item" onClick={switchToCalendar}>
                    Calendar View
                  </button>
                </li>
              </ul>
            )}
          </div>
        </div>

        <div className="view-preview">
          {view === 'Map' ? (
            <>
              <div className="location-list">
                {(planDays[currentDay] ?? []).length === 0 ? (
                  <p className="no-locations">No locations planned yet.</p>
                ) : (
                  planDays[currentDay].map((activity, index) => {
                    const key = `${activity.title}__${activity.short_description}`;
                    const img = photoByKey[key];
                    return (
                      <LocationBlock
                        key={index}
                        name={activity.title}
                        description={activity.short_description}
                        estimatedCost={activity.estimated_cost}
                        imageUrl={img}
                      />
                    );
                  })
                )}
              </div>

              <div className="map-container">
                {loadError ? (
                  <div className="map-el">failed to load map</div>
                ) : !isLoaded ? (
                  <div className="map-el">loading map…</div>
                ) : (
                  <GoogleMap
                    mapContainerClassName="map-el"
                    center={center}
                    zoom={12}
                    onLoad={(m) => setMap(m)}
                    onUnmount={() => {
                      markerRefs.current.forEach((mk) => (mk.map = null));
                      markerRefs.current = [];
                      geocodeCache.current.clear();
                      setMap(null);
                    }}
                    options={{
                      mapTypeControl: false,
                      fullscreenControl: false,
                      streetViewControl: false,
                      ...(MAP_ID ? { mapId: MAP_ID } : {}),
                    }}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="calendar-preview">
              {daysForPage.length === 0 ? (
                <div className="calendar-empty">No days to show.</div>
              ) : (
                <div className="calendar-grid">
                  {daysForPage.map((day, idx) => {
                    const dayNumber = pageStart + idx + 1;
                    const realDayIdx = pageStart + idx;

                    const renderSlot = (insertIndex: number) => {
                      const active =
                        dropTarget?.day === realDayIdx &&
                        dropTarget?.index === insertIndex;
                      return (
                        <div
                          ref={setSlotRef(realDayIdx, insertIndex)}
                          key={`slot-${realDayIdx}-${insertIndex}`}
                          className={`drop-slot ${active ? 'active' : ''}`}
                        />
                      );
                    };

                    return (
                      <div key={dayNumber} className="calendar-day">
                        <h4>Day {dayNumber}</h4>
                        <div className="calendar-day-list">
                          {renderSlot(0)}
                          {day.length === 0 ? (
                            <p className="no-locations">No locations planned.</p>
                          ) : (
                            day.map((activity, i) => {
                              const key = `${activity.title}__${activity.short_description}`;
                              const img = photoByKey[key];
                              const hidden =
                                !!drag &&
                                drag.fromDay === realDayIdx &&
                                drag.fromIndex === i;

                              return (
                                <div key={`row-${realDayIdx}-${i}`}>
                                  <div
                                    className={`draggable-wrapper ${hidden ? 'dragging' : ''}`}
                                    onPointerDown={onPointerDownItem(realDayIdx, i, activity)}
                                  >
                                    <div style={{ visibility: hidden ? 'hidden' : 'visible' }}>
                                      <LocationBlock
                                        name={activity.title}
                                        description={activity.short_description}
                                        estimatedCost={activity.estimated_cost}
                                        imageUrl={img}
                                      />
                                    </div>
                                  </div>
                                  {/* Drop-slot BETWEEN items */}
                                  {renderSlot(i + 1)}
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {drag && (
                <div
                  className="drag-layer"
                  style={{
                    width: drag.width,
                    height: drag.height,
                    left: drag.x - drag.offsetX,
                    top: drag.y - drag.offsetY,
                  }}
                >
                  <LocationBlock
                    name={drag.data.title}
                    description={drag.data.short_description}
                    estimatedCost={drag.data.estimated_cost}
                    imageUrl={photoByKey[drag.key]}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Content;
