// routers/hotels.ts
import express, { type RequestHandler } from "express";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" }); // load local env if present

/**
 * Request body for /api/hotels/nearby
 */
interface NearbyHotelsBody {
  lat: number;              // required
  lon: number;              // required
  city?: string;            // optional bias text, e.g. "Tokyo"
  checkIn?: string;         // "YYYY-MM-DD" (optional)
  checkOut?: string;        // "YYYY-MM-DD" (optional)
  currency?: string;        // e.g., "USD" (optional, default "USD")
  hl?: string;              // UI language, default "en"
  gl?: string;              // country/market, default "us"
  limit?: number;           // number of hotels to return, default 5
}

/**
 * Normalized hotel record returned to the client
 */
interface Hotel {
  name: string;
  address?: string;
  rating?: number;
  userRatingsTotal?: number;
  price?: number;           // nightly lowest price (if available)
  currency?: string;
  lat?: number;
  lon?: number;
  thumbnail?: string;       // small image if present
  serpApiHotelId?: string;  // SerpApi's property_id (if any)
  providerLink?: string;    // booking/provider link if present
}

/**
 * Env:
 * - SERPAPI_API_KEY (required)
 * - SERPAPI_TIMEOUT_MS (optional, defaults to 15_000)
 */
const SERP_KEY = process.env.SERPAPI_API_KEY;
const SERP_TIMEOUT = Number(process.env.SERPAPI_TIMEOUT_MS || 15_000);

if (!SERP_KEY) {
  // eslint-disable-next-line no-console
  console.warn("[hotels] Missing SERPAPI_API_KEY. /api/hotels/nearby will return 500 until set.");
}

const router = express.Router();

/**
 * POST /api/hotels/nearby
 * Body:
 * {
 *   lat: number,
 *   lon: number,
 *   city?: string,
 *   checkIn?: "YYYY-MM-DD",
 *   checkOut?: "YYYY-MM-DD",
 *   currency?: string,   // default "USD"
 *   hl?: string,         // default "en"
 *   gl?: string,         // default "us"
 *   limit?: number       // default 5
 * }
 *
 * Response:
 * {
 *   query: { lat, lon, city, checkIn, checkOut, currency, limit },
 *   hotels: Hotel[]
 * }
 */
const postNearby: RequestHandler<
  Record<string, never>,
  { query: NearbyHotelsBody; hotels: Hotel[] } | { error: string },
  NearbyHotelsBody
> = async (req, res) => {
  try {
    const {
      lat,
      lon,
      city = "",
      checkIn,
      checkOut,
      currency = "USD",
      hl = "en",
      gl = "us",
      limit = 5,
    } = req.body || {};

    if (typeof lat !== "number" || typeof lon !== "number" || Number.isNaN(lat) || Number.isNaN(lon)) {
      return res.status(400).json({ error: "Provide numeric 'lat' and 'lon' in the body." });
    }
    if (!SERP_KEY) {
      return res.status(500).json({ error: "Server missing SERPAPI_API_KEY." });
    }

    // Build SerpApi query
    // Docs: https://serpapi.com/google-hotels-api
    const params = new URLSearchParams();
    params.set("api_key", SERP_KEY);
    params.set("engine", "google_hotels");

    // Query bias
    const qText = city ? `Hotels near ${city}` : "Hotels near me";
    params.set("q", qText);

    // Location bias: @lat,lon,zoom
    params.set("ll", `@${lat},${lon},15z`);

    // Optional dates
    if (checkIn) params.set("check_in_date", checkIn);
    if (checkOut) params.set("check_out_date", checkOut);

    // UX & currency
    params.set("hl", hl);
    params.set("gl", gl);
    params.set("currency", currency);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SERP_TIMEOUT);

    const url = `https://serpapi.com/search?${params.toString()}`;
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return res.status(resp.status).json({ error: `SerpApi request failed: ${txt}` });
    }

    const json: any = await resp.json();
    if (json?.error) {
      return res.status(502).json({ error: `SerpApi error: ${json.error}` });
    }

    // SerpApi returns an array in "properties"
    const properties: any[] = Array.isArray(json?.properties) ? json.properties : [];
    if (!properties.length) {
      return res.json({ query: req.body || {}, hotels: [] });
    }

    // Map to our normalized Hotel[] and limit
    const hotels: Hotel[] = properties.slice(0, Math.max(1, Math.min(20, limit))).map((p) => {
      const coords = p?.gps_coordinates || {};
      const price =
        p?.extracted_price ??
        p?.rate_per_night?.extracted_lowest ??
        undefined;

      // Try to surface a small image/thumbnail if SerpApi provides it
      const thumb =
        p?.images?.[0]?.thumbnail ||
        p?.images?.[0]?.original ||
        p?.thumbnail ||
        undefined;

      // Provider link can be in multiple places; pick something stable if present
      const providerLink =
        p?.book_link ||
        p?.link ||
        p?.booking_link ||
        undefined;

      return {
        name: String(p?.name || ""),
        address: p?.address,
        rating: typeof p?.rating === "number" ? p.rating : undefined,
        userRatingsTotal:
          typeof p?.reviews === "number" ? p.reviews :
          typeof p?.user_ratings_total === "number" ? p.user_ratings_total :
          undefined,
        price: typeof price === "number" ? price : undefined,
        currency,
        lat: typeof coords?.latitude === "number" ? coords.latitude : undefined,
        lon: typeof coords?.longitude === "number" ? coords.longitude : undefined,
        thumbnail: thumb,
        serpApiHotelId: p?.property_id,
        providerLink,
      };
    });

    return res.json({
      query: {
        lat,
        lon,
        city,
        checkIn,
        checkOut,
        currency,
        hl,
        gl,
        limit,
      },
      hotels,
    });
  } catch (e: any) {
    const msg =
      e?.name === "AbortError"
        ? "SerpApi request timed out"
        : e?.message || "hotels.nearby server error";
    return res.status(500).json({ error: msg });
  }
};

router.post("/nearby", postNearby);

export const hotels = router;
