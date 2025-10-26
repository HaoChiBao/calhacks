// CONTENT.TSX — @react-google-maps/api + AdvancedMarkerElement + Map ID (TS)

import { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';
import LocationBlock from './LocationBlock';
import DestinationAutocomplete from '../components/DestinationAutocomplete';
import DurationRangePicker from '../components/DurationRangePicker';
import PeopleCounter from '../components/PeopleCounter';
import '../css/Content.css';
import '../css/Chat.css'; // reuse dropdown/input styles so it matches Chat

type View = 'Map' | 'Calendar';
type Range = { start: Date | null; end: Date | null };

const fallbackCenter = { lat: 43.6532, lng: -79.3832 }; // Toronto

const MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string;
const MAP_ID = import.meta.env.VITE_GOOGLE_MAP_ID as string | undefined;

type ContentProps = {
  hideContent?: boolean;

  // shared booking state (controlled, from App)
  destination: string;
  onDestinationChange: (s: string) => void;
  onDestinationSelect?: (coords: { lat: string; lon: string }) => void;

  duration: Range;
  onDurationChange: (r: Range) => void;

  who: number;
  onWhoChange: (n: number) => void;

  // optional: current coordinates from destination selection
  coords?: { lat: string; lon: string } | null;
};

const Content: React.FC<ContentProps> = ({
  hideContent,

  destination,
  onDestinationChange,
  onDestinationSelect,

  duration,
  onDurationChange,

  who,
  onWhoChange,

  coords,
}) => {
  // dropdown state
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<View>('Map');
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // map state
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);

  // computed center from coords (fallback to Toronto)
  const center = useMemo(() => {
    if (coords?.lat && coords?.lon) {
      const lat = parseFloat(coords.lat);
      const lng = parseFloat(coords.lon);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
    return fallbackCenter;
  }, [coords]);

  // load Maps JS API + 'marker' library (needed for AdvancedMarkerElement)
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: MAPS_API_KEY,
    libraries: ['marker'],
  });

  // close dropdown on outside click / Esc
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

  // create/update an Advanced Marker when ready and view is Map
  useEffect(() => {
    if (!isLoaded || !map || view !== 'Map') return;

    if (!MAP_ID) {
      console.warn(
        'AdvancedMarkerElement requires a vector map with a Map ID. Set VITE_GOOGLE_MAP_ID in your .env and pass options.mapId.'
      );
      return;
    }

    const { AdvancedMarkerElement } = google.maps.marker;

    // create once
    if (!markerRef.current) {
      markerRef.current = new AdvancedMarkerElement({
        map,
        position: center,
        title: destination || 'Selected location',
      });
    } else {
      markerRef.current.position = center;
      markerRef.current.title = destination || 'Selected location';
      markerRef.current.map = map;
    }

    // pan/fit to center on change
    map.panTo(center);

    return () => {
      // keep marker; it will be reused while map is mounted
    };
  }, [isLoaded, map, view, center, destination]);

  // nights label for the top bar (optional)
  const nights =
    duration.start && duration.end
      ? Math.max(0, Math.round((+duration.end - +duration.start) / (1000 * 60 * 60 * 24)))
      : 0;

  const label = view === 'Map' ? 'Map View' : 'Calendar View';

  return (
    <div className={`content-hub ${hideContent ? 'hidden' : ''}`}>
      {/* top filter bar (shared components & controlled values) */}
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
      </div>

      <div className="content-area">
        {/* top menu */}
        <div className="menu">
          <div className="view">
            <p>
              {nights > 0 ? `Day 1 of ${nights}` : 'Select dates'}
            </p>
            <button aria-label="previous day">{'<'}</button>
            <button aria-label="next day">{'>'}</button>
          </div>

          {/* dropdown toggle */}
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
                  <button
                    className="toggle-item"
                    onClick={() => {
                      setView('Calendar');
                      setIsOpen(false);
                    }}
                  >
                    Calendar View
                  </button>
                </li>
              </ul>
            )}
          </div>
        </div>

        {/* body under menu */}
        <div className="view-preview">
          {/* current selected day of events */}
          <div className="location-list">
            <LocationBlock />
            <LocationBlock />
            <LocationBlock />
            <LocationBlock />
          </div>

          {view === 'Map' ? (
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
                    setMap(null);
                    if (markerRef.current) {
                      markerRef.current.map = null;
                      markerRef.current = null;
                    }
                  }}
                  options={{
                    mapTypeControl: false,
                    fullscreenControl: false,
                    streetViewControl: false,
                    // IMPORTANT: AdvancedMarkerElement needs a vector basemap with a Map ID
                    ...(MAP_ID ? { mapId: MAP_ID } : {}),
                  }}
                />
              )}
            </div>
          ) : (
            <div className="calendar-preview">calendar view goes here</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Content;
