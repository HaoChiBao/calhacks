// src/components/HotelBooking.tsx
import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import '../css/HotelBooking.css';

interface HotelBookingProps {
  hidden?: boolean;
  setHidden: (hidden: boolean) => void;
  destination: string;
  coords: { lat: string; lon: string } | null; // strings coming from parent; we'll parse as numbers
  duration: { start: Date | null; end: Date | null };
  who: number; // number of guests
}

type NearbyHotelsResponse = {
  hotels: Hotel[];
};

type Hotel = {
  name: string;
  address?: string;
  rating?: number;
  userRatingsTotal?: number;
  price?: number;
  currency?: string;
  lat?: number;
  lon?: number;
  thumbnail?: string;
  serpApiHotelId?: string;
  providerLink?: string;
};

// const API_BASE = 'http://localhost:8080';
const API_BASE = import.meta.env.VITE_API_BASE;

function fmtYMD(d: Date): string {
  // YYYY-MM-DD
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const HotelBooking: React.FC<HotelBookingProps> = ({
  hidden,
  setHidden,
  destination,
  coords,
  duration,
  who,
}) => {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hotels, setHotels] = useState<Hotel[]>([]);

  // derive check-in/check-out (fallback to a sensible 1-night window two weeks from now)
  const { checkIn, checkOut } = useMemo(() => {
    if (duration.start && duration.end) {
      return { checkIn: fmtYMD(duration.start), checkOut: fmtYMD(duration.end) };
    }
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() + 14);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { checkIn: fmtYMD(start), checkOut: fmtYMD(end) };
  }, [duration.start, duration.end]);

  const resolveLatLon = useCallback(async (): Promise<{ lat: number; lon: number; city?: string }> => {
    // 1) prefer coords from props
    const latNum = coords ? parseFloat(coords.lat) : NaN;
    const lonNum = coords ? parseFloat(coords.lon) : NaN;
    if (!Number.isNaN(latNum) && !Number.isNaN(lonNum)) {
      return { lat: latNum, lon: lonNum, city: destination || undefined };
    }

    // 2) fallback: browser geolocation
    const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not supported'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
      });
    });

    return {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      city: destination || undefined,
    };
  }, [coords, destination]);

  const onTestClick = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setHotels([]);

    try {
      const { lat, lon, city } = await resolveLatLon();
      console.log('[hotels.test] resolved lat/lon =>', { lat, lon, city });

      const resp = await fetch(`${API_BASE}/api/hotels/nearby`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat,
          lon,
          city: (destination || city || '').trim(),
          checkIn,              // ALWAYS include to avoid SerpApi error
          checkOut,             // ALWAYS include to avoid SerpApi error
          currency: 'USD',
          hl: 'en',
          gl: 'us',
          guests: who,          // not used by backend yet, but useful for future pricing
          limit: 5,
        }),
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`Nearby hotels request failed: ${resp.status} ${txt}`);
      }

      const json = (await resp.json()) as NearbyHotelsResponse | { error: string };
      if ('error' in json) {
        throw new Error(json.error || 'Unknown hotels error');
      }

      console.log('[hotels.test] results =>', (json as NearbyHotelsResponse).hotels);
      setHotels((json as NearbyHotelsResponse).hotels || []);
    } catch (e: any) {
      console.error('[hotels.test] error', e);
      setErr(e?.message || 'Failed to fetch hotels');
    } finally {
      setLoading(false);
    }
  }, [resolveLatLon, destination, checkIn, checkOut, who]);

  // Re-run searches when the booking panel becomes visible
  const prevHiddenRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevHiddenRef.current === null) {
      prevHiddenRef.current = !!hidden;
      return;
    }
    const wasHidden = prevHiddenRef.current;
    const isHidden = !!hidden;

    if (wasHidden && !isHidden) {
      if (!loading) onTestClick();
    }

    prevHiddenRef.current = isHidden;
  }, [hidden, onTestClick, loading]);

  return (
    <div className={`hotel-booking ${hidden ? 'hidden' : ''}`}>
      <div className="modal">
        <div className="hb-header">
          <h3>Hotel Booking</h3>
          <button className="hb-close" onClick={() => setHidden(true)} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="hb-controls">
          <div className="hb-destination">
            <label>Destination</label>
            <input value={destination} readOnly placeholder="Where to?" />
          </div>

          <div className="hb-dates">
            <label>Dates</label>
            <input value={checkIn} readOnly />
            <span style={{ margin: '0 6px' }}>→</span>
            <input value={checkOut} readOnly />
          </div>

          <div className="hb-guests">
            <label>Guests</label>
            <input value={who} readOnly />
          </div>

          <button className="hb-test-btn" onClick={onTestClick} disabled={loading}>
            {loading ? 'Searching…' : 'Refresh results'}
          </button>
        </div>

        {err && <div className="hb-error">{err}</div>}

        <div className="hb-results">
          {hotels.length === 0 && !loading ? (
            <p className="hb-empty">No results yet. Click the button above.</p>
          ) : (
            hotels.map((h, i) => (
              <div className="hb-card" key={`${h.name}-${i}`}>
                {h.thumbnail && (
                  <div className="hb-thumb">
                    {/* eslint-disable-next-line jsx-a11y/alt-text */}
                    <img src={h.thumbnail} />
                  </div>
                )}
                <div className="hb-meta">
                  <div className="hb-title">{h.name}</div>
                  {!!h.address && <div className="hb-sub">{h.address}</div>}
                  <div className="hb-row">
                    {typeof h.rating === 'number' && <span>⭐ {h.rating}</span>}
                    {typeof h.userRatingsTotal === 'number' && (
                      <span>· {h.userRatingsTotal.toLocaleString()} reviews</span>
                    )}
                  </div>
                  <div className="hb-row">
                    {typeof h.price === 'number' && (
                      <strong>{h.currency || 'USD'} ${h.price}</strong>
                    )}
                    {h.providerLink && (
                      <a href={h.providerLink} target="_blank" rel="noreferrer" className="hb-link">
                        View
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default HotelBooking;
